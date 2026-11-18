import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

// How fast the game runs as a player has it: opened without the test flags, at window sizes people use, left to run by itself.
// For each size it is measured lying still, with the camera dragged round, and under way; what is kept is the time between
// frames (not an average of rates), what the engine says the frame cost the GPU, and where the main thread spent its time.
const root = path.resolve('output/space-frigate');
const out = path.join(root, 'frames');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const SIZES = (process.env.FRAME_SIZES ?? '1280x720@1,1920x1080@1,1920x1080@1.5').split(',').map((s) => { const [wh, dpr] = s.split('@'); const [w, h] = wh.split('x').map(Number); return { w, h, dpr: Number(dpr ?? 1) }; });
const query = process.env.FRAME_QUERY ?? '';
await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, process.env.SPACE_WEB ?? 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = [];

for (const size of SIZES) {
    const tag = `${size.w}x${size.h}@${size.dpr}`;
    const page = await browser.newPage({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: size.dpr });
    const said = [];
    // The graphics choices a player would have made in the settings panel, if the run is given any.
    if (process.env.FRAME_STORE) await page.addInitScript((choices) => { try { localStorage.setItem('space-frigate:graphics', choices); } catch { /* no storage */ } }, process.env.FRAME_STORE);
    const warned = [];
    page.on('console', (m) => { if (m.type() === 'error') said.push(m.text().slice(0, 200)); else if (m.type() === 'warning' || /\[WARN\]|Slow/.test(m.text())) warned.push(m.text().slice(0, 260)); });
    await page.goto(`http://127.0.0.1:${server.address().port}/?seed=1${query}`, { waitUntil: 'load', timeout: 300000 });
    await page.waitForFunction(() => window.__spaceHud?.ready, null, { timeout: 600000, polling: 1000 });
    await wait(8000);
    await page.evaluate(() => {
        window.__gaps = [];
        let last = performance.now();
        const tick = (now) => { window.__gaps.push(now - last); last = now; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    });
    const cdp = await page.context().newCDPSession(page);
    const take = async (name, seconds, during) => {
        await page.evaluate(() => { window.__gaps.length = 0; window.__gpu = []; window.__pend = 0; window.__meter = setInterval(() => { const f = globalThis.__spaceMeter; if (f) { window.__gpu.push([f.gpuMs, f.draws, f.bytes]); window.__pend = Math.max(window.__pend, f.pending); } }, 50); });
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
        await cdp.send('Profiler.start');
        const began = Date.now();
        await during?.(seconds);
        const left = seconds * 1000 - (Date.now() - began);
        if (left > 0) await wait(left);
        const { profile } = await cdp.send('Profiler.stop');
        const got = await page.evaluate(() => { clearInterval(window.__meter); return { gaps: window.__gaps.slice(2), gpu: window.__gpu, pending: window.__pend, graphics: { ...(globalThis.__spaceGraphics ?? {}) }, canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })() }; });
        const gaps = [...got.gaps].sort((a, b) => a - b), n = gaps.length || 1;
        const mean = gaps.reduce((s, v) => s + v, 0) / n;
        // Where the main thread's time went: self time by function, from the sampler.
        const self = new Map(), total = (profile.endTime - profile.startTime) / 1000;
        const byId = new Map(profile.nodes.map((node) => [node.id, node]));
        const deltas = profile.timeDeltas ?? [];
        profile.samples.forEach((id, i) => { const node = byId.get(id), key = `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.split('/').pop()}:${node.callFrame.lineNumber}`; self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0) / 1000); });
        const hot = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, ms]) => `${((ms / total) * 100).toFixed(1)}% ${name}`);
        const gpu = got.gpu.filter((g) => g[0] > 0);
        const line = {
            size: tag, what: name, canvas: got.canvas, graphics: { level: got.graphics.level, scale: got.graphics.scale, msaa: got.graphics.msaa, aa: got.graphics.antialiasing, ssao: got.graphics.ssao },
            frames: n, fps: +(1000 / mean).toFixed(1), frameMs: { mean: +mean.toFixed(1), p50: +gaps[Math.floor(n * 0.5)].toFixed(1), p95: +gaps[Math.floor(n * 0.95)].toFixed(1), worst: +gaps[n - 1].toFixed(1) }, over33ms: gaps.filter((g) => g > 33.4).length,
            gpuMs: gpu.length ? +(gpu.reduce((s, g) => s + g[0], 0) / gpu.length).toFixed(2) : null, draws: gpu.length ? Math.round(gpu.reduce((s, g) => s + g[1], 0) / gpu.length) : null, gpuMB: gpu.length ? Math.round(gpu[gpu.length - 1][2] / 1048576) : null,
            mostShadersCompiling: got.pending, warned: warned.splice(0).slice(0, 6),
            hot,
        };
        report.push(line);
        console.log(JSON.stringify(process.env.FRAME_QUICK ? { size: line.size, what: line.what, store: process.env.FRAME_STORE ?? 'auto', graphics: line.graphics, fps: line.fps, frameMs: line.frameMs, over33ms: line.over33ms, gpuMs: line.gpuMs, gpuMB: line.gpuMB } : { ...line, hot: line.hot.slice(0, 3) }));
    };
    const drag = async (seconds) => {
        // The view dragged round and round, as a player looking about does it.
        await page.mouse.move(size.w * 0.5, size.h * 0.45);
        await page.mouse.down();
        for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
            const t = Date.now() / 1000;
            await page.mouse.move(size.w * (0.5 + 0.22 * Math.sin(t * 1.7)), size.h * (0.45 + 0.12 * Math.sin(t * 1.1)));
            await wait(16);
        }
        await page.mouse.up();
    };
    await take('lying still', 6);
    await take('camera dragged', 6, drag);
    if (!process.env.FRAME_QUICK) {
        await page.keyboard.press('KeyW'); await page.keyboard.press('KeyW'); await page.keyboard.press('KeyW'); await page.keyboard.press('KeyW');
        await wait(3000);
        await take('under way at full speed', 6);
        await take('under way, camera dragged', 6, drag);
    }
    await page.screenshot({ path: path.join(out, `${tag.replace('@', '-x')}.png`) }).catch(() => undefined);
    if (said.length) console.log(JSON.stringify({ size: tag, errors: [...new Set(said)].slice(0, 4) }));
    await page.close();
}
await browser.close();
server.close();
await writeFile(path.join(out, `report${query.replace(/\W+/g, '-')}.json`), JSON.stringify(report, null, 1));

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

// The way down to a world, run as a player runs it: the game is stepped only to bring the planet close, and from there it runs
// by itself at the browser's own frames, with shaders compiling in the background as they do in a real window. Every error the
// page logs, whether the drawing context was lost, and whether the game is still running when she is over the ground, are kept.
const root = path.resolve('output/space-frigate');
const kinds = (process.argv[2] ?? '2,3,4,5,6').split(',').map(Number);
const seed = Number(process.argv[3] ?? 1);
const out = path.join(root, 'entry-live');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, process.env.SPACE_WEB ?? 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
for (const kind of kinds) {
    const said = [];
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => said.push(`pageerror: ${String(e).slice(0, 300)}`));
    page.on('console', (m) => { if (m.type() === 'error' || /\[ERROR\]|threw an error|context lost|CONTEXT_LOST/i.test(m.text())) said.push(`${m.type()}: ${m.text().slice(0, 400)}`); });
    const result = { kind, seed, entered: false, surface: false, lost: false, framesOverGround: 0, hudAlive: false, said };
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/?headless&seed=${seed}`, { waitUntil: 'load', timeout: 300000 });
        await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000, polling: 1000 });
        await page.waitForFunction(() => window.__spaceHud?.ready, null, { timeout: 120000 });
        const system = await page.evaluate((k) => { for (let i = 1; i < 400; i++) if (window.__spaceHud.kindAt(i) === k) return i; return -1; }, kind);
        if (system < 0) throw new Error(`no planet of kind ${kind}`);
        await page.evaluate(() => window.__estellaCooked.setPaused(true));
        const step = (n) => page.evaluate((frames) => window.__estellaCooked.step(frames), n);
        const fall = () => page.evaluate(() => { const f = window.__spaceHud.fall; return { stage: f.stage, altitude: f.altitude, cover: f.cover, heat: f.heat }; });
        const tap = async (key) => { await page.keyboard.down(key); await step(2); await page.keyboard.up(key); await step(2); };
        await step(20);
        await page.evaluate((to) => { const s = window.__spaceHud.ship; s.bound = to; s.jump = 0; s.jumps++; }, system);
        for (let frames = 0; frames < 900 && (await page.evaluate(() => window.__spaceHud.ship.jump)) >= 0; frames += 30) await step(30);
        await step(30);
        await tap('KeyW');
        await tap('KeyP');
        for (let frames = 0; frames < 60 * 240 && (await fall()).altitude > 900; frames += 60) await step(60);
        // From here it is the browser's game: unpaused, at its own frames, shaders compiling as they will.
        const frame0 = await page.evaluate(() => window.__estellaCooked.facts().frame);
        await page.evaluate(() => window.__estellaCooked.setPaused(false));
        for (const end = Date.now() + 70000; Date.now() < end;) {
            await wait(250);
            const f = await fall().catch(() => null);
            if (!f) break;
            if (f.stage === 'entry') result.entered = true;
            if (f.stage === 'surface') { result.surface = true; break; }
        }
        // Over the ground: fifteen seconds more of it running, the picture taken on the way.
        const frame1 = await page.evaluate(() => window.__estellaCooked.facts().frame);
        await wait(5000);
        await page.screenshot({ path: path.join(out, `kind-${kind}-over-ground.png`) }).catch(() => undefined);
        await wait(10000);
        const frame2 = await page.evaluate(() => window.__estellaCooked.facts().frame);
        result.framesOverGround = frame2 - frame1;
        result.framesInAll = frame2 - frame0;
        result.lost = await page.evaluate(() => { const c = document.querySelector('canvas'); const gl = c?.getContext('webgl2'); return !gl || gl.isContextLost(); });
        // The HUD is its own system: if it has thrown, its clock on the glass stops though the game runs on.
        const t0 = await page.evaluate(() => window.__spaceHud.ship.time);
        await wait(1000);
        result.hudAlive = (await page.evaluate(() => window.__spaceHud.ship.time)) > t0 && !said.some((line) => /threw an error/.test(line));
        result.final = await fall();
    } catch (err) {
        said.push(`check: ${String(err).slice(0, 300)}`);
    }
    await page.close();
    results.push(result);
    console.log(JSON.stringify({ ...result, said: [...new Set(said)].slice(0, 6) }));
}
await browser.close();
server.close();
const bad = results.filter((r) => !r.surface || r.lost || !r.hudAlive || r.said.length > 0);
console.log(JSON.stringify({ kinds: results.length, bad: bad.length }));
process.exit(bad.length > 0 ? 1 : 0);

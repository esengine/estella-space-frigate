// Does a far planet flicker? Frames one after another with the bow on a planet, lying still and under way, and how much each
// pixel changes from one frame to the next: a picture of where it changes (output/space-frigate/flicker-<kind>/), and the numbers.
//   node examples/space-frigate/tools/probe-flicker.mjs [kind=0] [seed=1]
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const { PNG } = createRequire(path.resolve('pipeline/package.json'))('pngjs');
const root = path.resolve('output/space-frigate');
const kind = Number(process.argv[2] ?? 0), seed = Number(process.argv[3] ?? 1);
const out = path.join(root, `flicker-${kind}`);
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, process.env.SPACE_WEB ?? 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const report = [];
try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    // The graphics choices she has kept (the settings panel's), to look at one level or one kind of anti-aliasing: FLICKER_STORE='{"mode":"high"}'.
    if (process.env.FLICKER_STORE) await page.addInitScript((choices) => { try { localStorage.setItem('space-frigate:graphics', choices); } catch { /* no storage */ } }, process.env.FLICKER_STORE);
    await page.goto(`http://127.0.0.1:${server.address().port}/?headless&seed=${seed}`, { waitUntil: 'load', timeout: 300000 });
    await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000, polling: 1000 });
    await page.waitForFunction(() => window.__spaceHud?.ready, null, { timeout: 300000, polling: 1000 });
    await page.evaluate(() => { window.__spaceHud.foes.peace = true; });
    const system = await page.evaluate((k) => { for (let i = 1; i < 400; i++) if (window.__spaceHud.kindAt(i) === k) return i; return -1; }, kind);
    await page.evaluate(() => window.__estellaCooked.setPaused(true));
    const step = (n) => page.evaluate((frames) => window.__estellaCooked.step(frames), n);
    const tap = async (key) => { await page.keyboard.down(key); await step(2); await page.keyboard.up(key); await step(2); };
    await page.mouse.move(960, 540);
    await step(60);
    await page.evaluate((to) => { const s = window.__spaceHud.ship; s.bound = to; s.jump = 0; s.jumps++; }, system);
    for (let frames = 0; frames < 900 && (await page.evaluate(() => window.__spaceHud.ship.jump)) >= 0; frames += 30) await step(30);
    await step(60);
    // The bow on the planet, and the eye astern looking along her at it.
    await tap('KeyP');
    await step(420);
    await page.evaluate((turn) => window.__spaceView({ yaw: Math.PI + turn, pitch: 0.12, distance: 260, height: 20, along: 0 }), Number(process.env.FLICKER_YAW ?? 0));
    await step(60);
    // `turn`: the eye is turned by that much a frame, as a pilot dragging the view round does. Everything then moves across the
    // picture, so what is measured is not how far a pixel is from the frame before but how far it is from the mean of the frames
    // either side of it: steady motion leaves that small, and what jumps about from frame to frame does not.
    const frames = async (name, between, turn = 0) => {
        const shots = [];
        for (let n = 0; n < 8; n++) {
            if (turn) await page.evaluate(([by, k]) => window.__spaceView({ yaw: Math.PI + by[0] + by[1] * k }), [[Number(process.env.FLICKER_YAW ?? 0), turn], n]);
            await step(between);
            shots.push(PNG.sync.read(await page.screenshot({ timeout: 60000 })));
        }
        const w = shots[0].width, h = shots[0].height, heat = new PNG({ width: w, height: h });
        let changed = 0, worst = 0, sum = 0;
        // The planet's face clear of the panels, where nothing but the planet is drawn.
        const box = [1150, 150, 1500, 600]; let inBox = 0;
        const rows = new Float64Array(h);
        for (let i = 0; i < w * h; i++) {
            let most = 0;
            if (turn) { for (let n = 1; n + 1 < shots.length; n++) for (let c = 0; c < 3; c++) most = Math.max(most, Math.abs(shots[n].data[i * 4 + c] - (shots[n - 1].data[i * 4 + c] + shots[n + 1].data[i * 4 + c]) / 2)); }
            else for (let n = 1; n < shots.length; n++) for (let c = 0; c < 3; c++) most = Math.max(most, Math.abs(shots[n].data[i * 4 + c] - shots[n - 1].data[i * 4 + c]));
            // The film grain and the scan lines over the picture move a pixel by a few levels; what is counted is more than that.
            if (most > 24) { changed++; rows[Math.floor(i / w)]++; }
            worst = Math.max(worst, most);
            sum += most;
            { const x = i % w, y = Math.floor(i / w); if (x >= box[0] && x < box[2] && y >= box[1] && y < box[3]) inBox += most; }
            const v = Math.min(255, most * 4);
            heat.data[i * 4] = v; heat.data[i * 4 + 1] = v; heat.data[i * 4 + 2] = v; heat.data[i * 4 + 3] = 255;
        }
        await writeFile(path.join(out, `${name}-frame.png`), PNG.sync.write(shots[shots.length - 1]));
        await writeFile(path.join(out, `${name}-change.png`), PNG.sync.write(heat));
        const f = await page.evaluate(() => { const f = window.__estellaCooked.facts(); return { planet: [Math.round(f.planetX), Math.round(f.planetY), Math.round(f.planetZ)], radius: f.planetRadius, speed: Math.round(f.speed) }; });
        report.push({ name, between, changed, share: +(changed / (w * h) * 100).toFixed(3), worst, mean: +(sum / (w * h)).toFixed(2), face: +(inBox / ((box[2] - box[0]) * (box[3] - box[1]))).toFixed(2), store: process.env.FLICKER_STORE ?? 'auto', ...f });
    };
    await tap('KeyS'); await tap('KeyS'); await tap('KeyS'); await tap('KeyS'); await tap('KeyS');
    await step(240);
    await frames('still', 1);
    await frames('turning', 1, 0.0015);
    await tap('KeyW'); await tap('KeyW'); await tap('KeyW'); await tap('KeyW'); await tap('KeyW');
    await step(240);
    await frames('under-way', 1);
} finally {
    await browser.close();
    server.close();
}
console.log(JSON.stringify(report, null, 1));

// What grows on a world, looked at: puts her low over the ground of the first world of a kind and takes pictures, with what is drawn and what a frame costs.
//   node examples/space-frigate/tools/probe-flora.mjs [kind=6] [seed=1]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const kind = Number(process.argv[2] ?? 6), seed = Number(process.argv[3] ?? 1);
const out = path.join(root, `flora-${kind}-${seed}`);
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, process.env.SPACE_WEB ?? 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const problems = [], shots = [];
try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || /worldgen|planet|shader|foliage/i.test(m.text())) problems.push(`${m.type()}: ${m.text().slice(0, 500)}`); });
    await page.goto(`http://127.0.0.1:${server.address().port}/?headless&seed=${seed}`, { waitUntil: 'load', timeout: 300000 });
    await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000, polling: 1000 });
    await page.waitForFunction(() => window.__spaceHud?.ready, null, { timeout: 300000, polling: 1000 });
    await page.evaluate(() => { window.__spaceHud.foes.peace = true; });
    const system = await page.evaluate((k) => { for (let i = 1; i < 400; i++) if (window.__spaceHud.kindAt(i) === k) return i; return -1; }, kind);
    await page.evaluate(() => window.__estellaCooked.setPaused(true));
    const step = (n) => page.evaluate((frames) => window.__estellaCooked.step(frames), n);
    const fall = () => page.evaluate(() => { const f = window.__spaceHud.fall; return { stage: f.stage, altitude: Math.round(f.altitude), ground: Math.round(f.ground), flora: f.flora }; });
    const tap = async (key) => { await page.keyboard.down(key); await step(2); await page.keyboard.up(key); await step(2); };
    const shoot = async (name) => {
        await step(2);
        await page.screenshot({ path: path.join(out, `${name}.png`), timeout: 60000 });
        const f = await page.evaluate(() => { const f = window.__estellaCooked.facts(); return { gpuMs: +f.gpuMs.toFixed(2), draws: f.gpuDraws }; });
        shots.push({ shot: name, ...(await fall()), ...f });
    };
    const until = async (test, most) => { for (let frames = 0; frames < most; frames += 15) { if (test(await fall())) return true; await step(15); } return false; };
    await page.mouse.move(960, 540);
    await step(60);
    await tap('Digit2');
    await page.evaluate((to) => { const s = window.__spaceHud.ship; s.bound = to; s.jump = 0; s.jumps++; }, system);
    for (let frames = 0; frames < 900 && (await page.evaluate(() => window.__spaceHud.ship.jump)) >= 0; frames += 30) await step(30);
    await tap('KeyW');
    await tap('KeyP');
    if (!(await until((f) => f.stage === 'surface', 60 * 400))) problems.push('never reached the surface');
    // Down to a height over the ground, by hand: the planet is moved, as flying moves it.
    const lower = (above) => page.evaluate((h) => {
        const f = window.__spaceHud.fall, c = f.centre, d = Math.hypot(c.x, c.y, c.z);
        const k = (d - (f.altitude - h)) / d;
        f.centre = { x: c.x * k, y: c.y * k, z: c.z * k };
    }, above);
    await tap('KeyZ');
    await step(120);
    for (const above of [900, 320, 130]) {
        await lower(above);
        await step(240);
        await shoot(`a-${above}`);
    }
    const view = (to) => page.evaluate((v) => window.__spaceView(v), to);
    if (process.env.FLORA_QUICK) {
        await lower(72); await step(300); await lower(72);
        // Low and level, from astern and from abeam: the ground and what stands on it fill the picture, not her.
        for (const [name, to] of [['q-astern', { yaw: 0.5, pitch: 0.06, distance: 150, height: 30, along: 0 }], ['q-abeam', { yaw: 1.9, pitch: 0.03, distance: 190, height: 20, along: 0 }], ['q-high', { yaw: 2.6, pitch: 0.5, distance: 420, height: 0, along: 0 }]]) {
            await view(to); await step(90); await shoot(name);
        }
        throw new Error('quick');
    }
    // Flying on at that height: what is laid out ahead must stand on the ground as it comes.
    for (let n = 0; n < 4; n++) {
        for (let k = 0; k < 6; k++) { await step(60); await lower(150); }
        await shoot(`b-flying-${n}`);
    }
    await tap('Digit1');
    await step(120);
    await shoot('c-view-1');
    // On round the planet to where the ground goes under the sea, and back to the shore: the planet is turned under her a little at a time.
    const turn = (angle) => page.evaluate((a) => {
        const f = window.__spaceHud.fall, c = f.centre, cos = Math.cos(a), sin = Math.sin(a);
        f.centre = { x: c.x, y: c.y * cos - c.z * sin, z: c.y * sin + c.z * cos };
    }, angle);
    let found = false;
    for (let n = 0; n < 500 && !found; n++) { await turn(0.004); await step(1); await lower(400); found = (await fall()).ground < -4; }
    for (let n = 0; n < 40 && found; n++) { await turn(-0.0006); await step(1); await lower(400); if ((await fall()).ground > 3) break; }
    if (!found) problems.push('no sea was found');
    await lower(260);
    await step(300);
    await shoot('d-shore-1');
    await tap('Digit2');
    await step(120);
    await shoot('d-shore-2');
    await tap('Digit3');
    await step(120);
    await shoot('c-view-3');
} catch (e) { if (e.message !== 'quick') throw e; } finally {
    await browser.close();
    server.close();
}
console.log(JSON.stringify({ shots, problems }, null, 1));

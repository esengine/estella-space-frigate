import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const kind = Number(process.argv[2] ?? 2);
const seed = Number(process.argv[3] ?? 1);
const out = path.join(root, `planet-${kind}-${seed}`);
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const problems = [];
const findings = [];
const timeline = [];
const expect = (what, ok, detail) => { findings.push({ what, ok }); if (!ok) problems.push(`${what}: ${JSON.stringify(detail)}`); };
try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text().slice(0, 400)); });
    await page.goto(`http://127.0.0.1:${server.address().port}/?headless&seed=${seed}`, { waitUntil: 'load', timeout: 300000 });
    await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000, polling: 1000 });
    await page.waitForFunction(() => window.__spaceHud?.ready, null, { timeout: 300000, polling: 1000 });
    await page.evaluate(() => { window.__spaceHud.foes.peace = true; });
    const system = await page.evaluate((k) => { for (let i = 1; i < 400; i++) if (window.__spaceHud.kindAt(i) === k) return i; return -1; }, kind);
    expect('the voyage has a planet of the kind', system > 0, { kind, seed });
    await page.evaluate(() => window.__estellaCooked.setPaused(true));
    const step = (n) => page.evaluate((frames) => window.__estellaCooked.step(frames), n);
    const facts = () => page.evaluate(() => window.__estellaCooked.facts());
    const fall = () => page.evaluate(() => { const f = window.__spaceHud.fall, h = window.__spaceHud.helm; return { stage: f.stage, altitude: f.altitude, distance: f.distance, cover: f.cover, heat: f.heat, ground: f.ground, body: f.body, mode: h.mode, surge: h.surge, climb: h.forward.y }; });
    const tap = async (key) => { await page.keyboard.down(key); await step(2); await page.keyboard.up(key); await step(2); };
    const drawn = () => page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const gl = canvas.getContext('webgl2');
        if (!gl) return true;
        const row = new Uint8Array(canvas.width * 4);
        gl.readPixels(0, Math.round(canvas.height * 0.4), canvas.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
        for (let i = 0; i < row.length; i += 4) if (row[i] + row[i + 1] + row[i + 2] > 12) return true;
        return false;
    });
    const shoot = async (name) => {
        for (let tries = 0; tries < 20 && !(await drawn()); tries++) await step(1);
        await page.screenshot({ path: path.join(out, `${name}.png`), timeout: 60000 });
        const f = await fall();
        timeline.push({ shot: name, time: (await facts()).time.toFixed(1), ...f, altitude: Math.round(f.altitude), distance: Math.round(f.distance) });
    };
    const until = async (what, test, most) => {
        for (let frames = 0; frames < most; frames += 15) {
            if (test(await fall())) return true;
            await step(15);
        }
        expect(what, false, await fall());
        return false;
    };
    await page.mouse.move(960, 540);
    await step(60);
    await tap('Digit2');
    await step(10);

    if (system > 0) {
        await page.evaluate((to) => { const s = window.__spaceHud.ship; s.bound = to; s.jump = 0; s.jumps++; }, system);
        await until('the jump to the planet\'s system ends', () => true, 1);
        for (let frames = 0; frames < 900 && (await page.evaluate(() => window.__spaceHud.ship.jump)) >= 0; frames += 30) await step(30);
        await step(30);
    }
    const before = await fall();
    const radius = (await facts()).planetRadius;
    expect('she is in the system she jumped to, with its planet a long way off', (await facts()).system === system && before.stage === 'space' && before.altitude > 2000, { before, system, radius });
    await shoot('0-far');

    await tap('KeyW');
    await tap('KeyP');
    const steering = await fall();
    expect('P turns the bow for the planet', steering.mode === 'planet', steering);
    await step(240);
    const turned = await fall();
    await step(300);
    const going = await fall();
    expect('and once round she runs in faster than she cruises', going.surge > 2 && turned.altitude - going.altitude > 300 * 0.12 * 0.75 * 420 / 60 * 3, { turned: turned.altitude, going });
    await shoot('1-approach');
    if (kind <= 1) {
        await until('a giant turns her away at its cloud tops', (f) => f.distance < radius * 1.04, 60 * 120);
        await step(120);
        const held = await fall();
        expect('she is held off the giant and does not enter', held.stage === 'space' && held.altitude > 0 && held.distance > radius, held);
        await shoot('2-gas-giant');
    } else {
        await until('the planet comes close enough to enter', (f) => f.altitude < 1200, 60 * 150);
        await shoot('2-close');
        await until('she enters the atmosphere', (f) => f.stage === 'entry', 60 * 60);
        await step(40);
        await shoot('3-entry-heat');
        await until('the entry covers the view as the ground is made', (f) => f.cover > 0.9, 60 * 6);
        await until('she comes out over the ground', (f) => f.stage === 'surface', 60 * 6);
        const low = await fall();
        expect('above ground at the altitude she is put at', low.altitude > 1200 && low.altitude < 2600, low);
        await step(30);
        await shoot('4-over-ground');
        await step(240);
        await shoot('5-terrain-streams-in');
        await tap('KeyQ');
        await step(200);
        await tap('KeyX');
        let least = Infinity;
        for (let frames = 0; frames < 60 * 90; frames += 30) { await step(30); const f = await fall(); least = Math.min(least, f.altitude); if (f.altitude < 260) break; }
        await tap('KeyZ');
        await step(150);
        const skim = await fall();
        expect('diving, she comes down near the ground and never below the floor over it', least < 400 && least >= 69, { least, skim });
        await shoot('6-low-pass');
        await step(300);
        await shoot('7-low-pass-later');
        await tap('KeyP');
        const ascent = await fall();
        expect('on the ground P climbs her for orbit', ascent.mode === 'planet', ascent);
        await step(600);
        await shoot('8-climbing-out');
        await until('climbing, she leaves the atmosphere', (f) => f.stage === 'exit', 60 * 240);
        await until('she is back in space', (f) => f.stage === 'space', 60 * 6);
        await step(30);
        const back = await fall();
        expect('back in space with the planet below her and the field round her again', back.stage === 'space' && back.altitude > 0 && back.altitude < 4000, back);
        await shoot('9-back-in-space');
        const f = await facts();
        expect('the planet is drawn again', f.planets[0] === '1', f.planets);
    }
} catch (err) {
    problems.push(String(err));
} finally {
    await browser.close();
    server.close();
}
console.log(JSON.stringify({ kind, seed, findings, timeline, problems: [...new Set(problems)].slice(0, 30) }, null, 1));
if (problems.length > 0) process.exitCode = 1;

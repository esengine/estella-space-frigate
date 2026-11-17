import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const out = path.join(root, 'contract');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const KEYS = { Lock: 'KeyT', Mine: 'KeyF', Close: 'KeyV', Gate: 'KeyB', Guns: 'KeyG', Orbit: 'KeyP', Engine75: 'KeyW' };
await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const problems = [];
const findings = [];
const story = [];
const expect = (what, ok, detail) => { findings.push({ what, ok, detail }); if (!ok) problems.push(`${what}: ${JSON.stringify(detail)}`); };
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => problems.push(String(e)));
    let baked = false;
    page.on('console', (m) => {
        if (m.type() === 'error') problems.push(m.text().slice(0, 400));
        if (/^\[model-bake\] \d+ model\(s\) at /.test(m.text())) baked = true;
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?headless`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000 });
    await page.waitForFunction(() => window.__spaceHud?.ready || window.__spaceHud?.error, null, { timeout: 120000 });
    await page.evaluate(() => window.__estellaCooked.setPaused(true));
    for (const until = Date.now() + 240000; !baked && Date.now() < until;) await page.waitForTimeout(500);
    await page.mouse.move(800, 450);
    const step = (n) => page.evaluate((frames) => window.__estellaCooked.step(frames), n);
    const tap = async (key) => { await page.keyboard.down(key); await step(1); await page.keyboard.up(key); await step(1); };
    const seen = () => page.evaluate(() => {
        const h = window.__spaceHud, c = h.contract;
        return { time: Math.round(h.ship.time), stage: c.stage, cue: c.cue, text: c.text, delivered: c.delivered, done: c.done, completions: c.completions, hold: h.mining.hold, total: h.mining.delivered, system: h.ship.system };
    });
    const shoot = async (name) => { await step(2); await page.screenshot({ path: path.join(out, `${name}.png`), timeout: 60000 }); };

    await step(200);
    const first = await seen();
    expect('she starts with the contract open, nothing aboard, and is told to lock a rock', first.stage === 'mine' && first.cue === 'Lock' && first.delivered === 0 && !first.done, first);
    await shoot('1-briefing');

    const shot = new Set();
    let now = first, said = '';
    const follow = async (until, seconds) => {
        for (let turn = 0; turn < seconds * 2 && !until(now); turn++) {
            if (now.text !== said) { said = now.text; story.push(`${now.time}s  hold ${now.hold}  delivered ${now.delivered}  ${now.text}`); }
            const key = KEYS[now.cue];
            if (key) await tap(key);
            await step(28);
            now = await seen();
            if (now.cue === 'Mine' && !shot.has('mine')) { shot.add('mine'); await shoot('2-in-range'); }
            if (/^MINING  /.test(now.text) && !shot.has('beam')) { shot.add('beam'); await step(40); await shoot('3-mining'); }
        }
    };
    await follow((s) => s.stage !== 'mine', 900);
    expect('pressing only the key each hint names fills the hold with the contract ore', now.stage === 'return' && now.hold + now.delivered >= 10 && now.hold > 0 && now.cue === 'Gate', now);
    await shoot('4-return');
    await follow((s) => /^ON COURSE/.test(s.text), 30);
    await step(240);
    await shoot('5-on-course');
    now = await seen();
    await follow((s) => s.done, 600);
    expect('and following them on to the gate delivers it and completes the contract', now.done && now.delivered === 10 && now.completions === 1 && now.stage === 'done' && now.hold === 0, now);
    await step(50);
    await shoot('6-complete');
    story.push(`${now.time}s  ${now.text}`);

    await step(60 * 12);
    await page.evaluate(() => { window.__spaceHud.mining.hold = 14; });
    await tap('KeyB');
    const again = await seen();
    for (let second = 0; second < 400 && (await seen()).total === again.total; second += 4) await step(240);
    await step(30);
    const later = await seen();
    expect('a later delivery is still taken, and the contract is neither reopened nor completed twice', later.total > again.total && later.done && later.completions === 1 && later.delivered === 10 && later.stage === 'done', later);
    await shoot('7-later-delivery');
} finally {
    await browser.close();
    server.close();
}
console.log(JSON.stringify({ findings, story, problems: [...new Set(problems)] }, null, 1));
if (problems.length > 0) process.exitCode = 1;

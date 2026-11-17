import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const out = path.join(root, 'refit');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const problems = [];
const findings = [];
const expect = (what, ok, detail) => { findings.push({ what, ok, detail }); if (!ok) problems.push(`${what}: ${JSON.stringify(detail)}`); };

async function voyage(name) {
    const page = await context.newPage();
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
    await page.evaluate(() => { window.__spaceHud.foes.peace = true; });
    await page.mouse.move(800, 450);
    const step = (n) => page.evaluate((frames) => window.__estellaCooked.step(frames), n);
    const tap = async (key) => { await page.keyboard.down(key); await step(1); await page.keyboard.up(key); await step(1); };
    const seen = () => page.evaluate(() => {
        const h = window.__spaceHud;
        return {
            time: Math.round(h.ship.time), done: h.contract.done, completions: h.contract.completions, cue: h.contract.cue, text: h.contract.text,
            hold: h.mining.hold, total: h.mining.delivered, capacitor: h.mining.capacitor, capacity: h.tuning.capacity, recharge: h.tuning.recharge,
            choice: h.refit.choice, installs: h.refit.installs, open: h.refit.open, picked: h.refit.picked, result: h.refit.result, spots: Object.keys(h.refitSpots), system: h.ship.system, throttle: h.ship.throttle,
        };
    });
    const shoot = async (shot) => { await step(2); await page.screenshot({ path: path.join(out, `${name}-${shot}.png`), timeout: 60000 }); };
    const toGate = async (tonnes) => {
        await page.evaluate((t) => { window.__spaceHud.mining.hold = t; }, tonnes);
        const before = (await seen()).total;
        if ((await page.evaluate(() => window.__spaceHud.helm.mode)) !== 'align') await tap('KeyB');
        for (let second = 0; second < 500 && (await seen()).total === before; second += 4) await step(240);
        await step(30);
    };
    const recharged = async () => {
        await page.evaluate(() => { window.__spaceHud.mining.capacitor = 0.1; });
        const from = await seen();
        await step(300);
        const to = await seen();
        return { gained: to.capacitor - from.capacitor, throttle: [from.throttle, to.throttle] };
    };
    return { page, step, tap, seen, shoot, toGate, recharged };
}

try {
    const a = await voyage('hold');
    await a.step(900);
    const early = await a.seen();
    await a.tap('KeyU');
    const refused = await a.seen();
    expect('before the contract is complete there is no refit to claim, and U opens nothing', !early.done && early.spots.length === 0 && !refused.open && refused.capacity === 40, { early, refused });
    const slow = await a.recharged();
    await a.toGate(10);
    const owed = await a.seen();
    expect('completing the contract puts the claim on the glass and names its key', owed.done && owed.spots.includes('entry') && owed.cue === 'Refit' && /PRESS U/.test(owed.text) && owed.choice === '', owed);
    await a.shoot('1-entry');
    await a.toGate(5);
    const kept = await a.seen();
    expect('left unclaimed it stays there, through another delivery', kept.spots.includes('entry') && kept.choice === '' && kept.installs === 0 && kept.capacity === 40, kept);
    await a.tap('KeyU');
    const opened = await a.seen();
    expect('U opens the choice of two with nothing picked', opened.open && opened.picked === '' && ['hold', 'capacitor', 'install', 'later'].every((s) => opened.spots.includes(s)), opened);
    await a.shoot('2-choice');
    await a.tap('Enter');
    const unpicked = await a.seen();
    expect('Enter with nothing picked fits nothing', unpicked.open && unpicked.installs === 0, unpicked);
    await a.tap('KeyK');
    await a.tap('KeyJ');
    const picked = await a.seen();
    expect('a pick can be changed before it is confirmed, and changes nothing by itself', picked.picked === 'hold' && picked.installs === 0 && picked.capacity === 40 && picked.recharge === early.recharge, picked);
    await a.shoot('3-picked');
    await a.tap('Enter');
    const fitted = await a.seen();
    expect('Enter fits the hold at once: 60 tonnes, the recharge as it was, the claim gone', fitted.choice === 'hold' && fitted.installs === 1 && fitted.capacity === 60 && fitted.recharge === early.recharge && !fitted.open && !fitted.spots.includes('entry') && /40 T.*60 T/.test(fitted.result) && /REFIT FITTED/.test(fitted.text), fitted);
    await a.step(40);
    await a.shoot('4-fitted');
    const same = await a.recharged();
    expect('and her capacitor recharges no faster than before', Math.abs(same.gained - slow.gained) < 1e-6, { slow, same });

    await a.page.evaluate(() => { window.__spaceHud.mining.hold = 39.5; });
    let now = await a.seen();
    for (let turn = 0; turn < 600 && now.hold <= 40; turn++) {
        const key = { Lock: 'KeyT', Mine: 'KeyF', Close: 'KeyV' }[await a.page.evaluate(() => {
            const h = window.__spaceHud, i = h.selected;
            if (i < 0 || i >= 40) return 'Lock';
            if (!h.locked) return '';
            if (h.mining.reason === 'OUT OF RANGE') return h.helm.mode === 'approach' ? '' : 'Close';
            return h.mining.armed ? '' : 'Mine';
        })];
        if (key) await a.tap(key);
        await a.step(28);
        now = await a.seen();
    }
    expect('mining on past 40 tonnes, the hold takes it', now.hold > 40 && now.hold <= 60, now);
    await a.shoot('5-over-forty');
    await a.page.evaluate(() => { window.__spaceHud.mining.hold = 58; });
    for (const key of ['KeyU', 'KeyK', 'Enter', 'KeyU', 'KeyJ', 'Enter']) await a.tap(key);
    const again = await a.seen();
    expect('the claim cannot be opened or taken a second time', again.installs === 1 && again.choice === 'hold' && again.capacity === 60 && again.recharge === early.recharge && !again.open, again);
    const home = again.system;
    await a.toGate(58);
    let far = await a.seen();
    for (let second = 0; second < 240 && far.system === home; second += 4) { await a.step(240); far = await a.seen(); }
    await a.step(400);
    far = await a.seen();
    expect('a delivery and a jump later the refit is still fitted, once, with no new claim', far.system !== home && far.capacity === 60 && far.installs === 1 && far.completions === 1 && far.spots.length === 0, far);
    await a.shoot('6-after-jump');
    await a.page.close();

    const b = await voyage('capacitor');
    await b.step(900);
    const base = await b.seen();
    const before = await b.recharged();
    await b.toGate(10);
    const click = async (name) => { const at = (await b.page.evaluate(() => window.__spaceHud.refitSpots))[name]; await b.page.mouse.move(at.x, at.y); await b.step(1); await b.page.mouse.down(); await b.step(2); await b.page.mouse.up(); await b.step(3); };
    await click('entry');
    const clicked = await b.seen();
    expect('the claim opens to a click as well, for a hand with no keyboard', clicked.open, clicked);
    await click('capacitor');
    await click('install');
    const quick = await b.seen();
    expect('picking the capacitor and confirming fits it: recharge up by half, the hold still 40 tonnes', quick.choice === 'capacitor' && quick.installs === 1 && Math.abs(quick.recharge / base.recharge - 1.5) < 1e-9 && quick.capacity === 40, quick);
    await b.step(40);
    await b.shoot('1-fitted');
    const after = await b.recharged();
    expect('at the same throttle the capacitor then comes back half again as fast', Math.abs(after.gained / before.gained - 1.5) < 0.02 && Math.abs(after.throttle[0] - before.throttle[0]) < 0.02, { before, after });
    await b.page.close();
} catch (err) {
    problems.push(String(err?.stack ?? err));
} finally {
    await browser.close();
    server.close();
}
console.log(JSON.stringify({ findings, problems: [...new Set(problems)] }, null, 1));
if (problems.length > 0) process.exitCode = 1;

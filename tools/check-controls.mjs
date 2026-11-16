import { chromium } from 'playwright';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const server = await serveHost(path.join(root, 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const problems = [];
const findings = [];
const expect = (what, ok, detail) => { findings.push({ what, ok, detail }); if (!ok) problems.push(`${what}: ${JSON.stringify(detail)}`); };
try {
    const page = await browser.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text().slice(0, 400)); });
    await page.goto(`http://127.0.0.1:${server.address().port}/?headless`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 120000 });
    await page.waitForFunction(() => window.__spaceHud, null, { timeout: 120000 });
    await page.evaluate(() => { window.__spaceHud.foes.peace = true; });
    await page.evaluate(() => window.__estellaCooked.setPaused(true));
    const step = (n) => page.evaluate((frames) => window.__estellaCooked.step(frames), n);
    const facts = () => page.evaluate(() => window.__estellaCooked.facts());
    const tap = async (key) => { await page.keyboard.down(key); await step(1); await page.keyboard.up(key); await step(1); };
    const camera = () => page.evaluate(() => { const f = window.__estellaCooked.facts(); return [f.eyeX, f.eyeY, f.eyeZ]; });
    await page.mouse.move(400, 225);

    await step(30);
    const idle = await facts();
    expect('the tour runs untouched', idle.tour === true && idle.throttle > 0.6 && idle.throttle < 0.8, [idle.tour, idle.throttle]);

    await page.keyboard.down('KeyS');
    await step(150);
    await page.keyboard.up('KeyS');
    const slow = await facts();
    expect('S eases the throttle down', slow.throttle < 0.1, slow.throttle);
    expect('the throttle alone leaves the tour running', slow.tour === true, slow.tour);

    await page.keyboard.down('KeyW');
    await step(240);
    await page.keyboard.up('KeyW');
    const fast = await facts();
    expect('W pushes it to full', fast.throttle > 0.9, fast.throttle);

    const helm = () => page.evaluate(() => { const h = window.__spaceHud.helm; return { rudder: h.rudder, elevation: h.elevation, forward: h.forward, lean: h.lean, mode: h.mode }; });
    const apart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    await tap('KeyD');
    await tap('KeyD');
    await tap('KeyD');
    const over = await helm();
    expect('D puts the rudder over a place at a time, and it stays there', Math.abs(over.rudder - 1) < 1e-6, over);
    const jets = (await facts()).jets;
    expect('and her thrusters fire to start the turn', jets.startsWith('-1.00'), jets);
    expect('steering leaves the tour running', (await facts()).tour === true, over);
    let astern = 1;
    for (let second = 0; second < 22; second++) { await step(60); astern = Math.min(astern, (await helm()).forward.z); }
    expect('left over, the rudder takes her all the way round', astern < -0.95 && (await helm()).forward.z > 0.3, astern);
    await tap('KeyX');
    await tap('KeyE');
    await tap('KeyE');
    let top = 0;
    for (let second = 0; second < 9; second++) { await step(60); top = Math.max(top, (await helm()).forward.y); }
    expect('E pitches her up, past the vertical', top > 0.95, top);
    await tap('KeyX');
    await step(240);
    const held = await helm();
    await step(600);
    const later = await helm();
    expect('with the helm amidships she keeps the attitude she has and does not come level', apart(held.forward, later.forward) < 0.01 && apart(later.forward, { x: 0, y: 0, z: 1 }) > 0.3 && later.rudder === 0 && later.elevation === 0, { held, later });

    await tap('KeyD');
    await step(240);
    await tap('KeyX');
    await step(120);
    await tap('KeyZ');
    const levelling = await helm();
    await step(60 * 45);
    const level = await helm();
    expect('Z brings her level from wherever she is, and then gives the helm back', levelling.mode === 'level' && level.mode === 'manual' && Math.abs(level.forward.y) < 0.02 && Math.abs(level.lean) < 0.02, { levelling, level });

    await tap('Digit5');
    const near = await camera();
    expect('5 jumps to the close shot', Math.abs(Math.hypot(near[0], near[1] - 7, near[2] + 15) - 36) < 0.5, near);

    await page.mouse.down();
    for (let x = 420; x <= 520; x += 20) {
        await page.mouse.move(x, 225);
        await step(1);
    }
    await page.mouse.up();
    const dragged = await camera();
    expect('a drag orbits', Math.hypot(dragged[0] - near[0], dragged[2] - near[2]) > 3, { near, dragged });

    await tap('Space');
    const back = await facts();
    expect('Space hands the camera back to the tour', back.tour === true, back);

    const guns = (f) => ({ view: f.gunView, source: f.gunSource, bearing: f.gunBearing, ready: f.gunReady, shots: f.gunShots, train: f.gunTrain, tour: f.tour });
    expect('with no target and no sight the guns are stowed fore and aft', back.gunSource === 'stowed' && back.gunBearing === 0, guns(back));
    await tap('KeyG');
    await step(320);
    const sighted = await facts();
    expect('G takes the gunnery view', sighted.gunView === true && sighted.tour === false && sighted.gunSource === 'view', guns(sighted));
    expect('and the guns that can see past the ship lay on it', sighted.gunBearing >= 3 && sighted.gunReady === sighted.gunBearing, guns(sighted));
    await page.mouse.move(360, 150);
    await page.mouse.down();
    for (let x = 380; x <= 620; x += 20) { await page.mouse.move(x, 150); await step(1); }
    await page.mouse.up();
    await step(2);
    const turning = await facts();
    expect('turning the view leaves the guns training behind it', turning.gunReady === 0 && turning.gunTrain !== sighted.gunTrain, guns(turning));
    await step(480);
    const laid = await facts();
    expect('until they come to bear again', laid.gunReady >= 3, guns(laid));
    await tap('Space');
    const one = await facts();
    expect('Space fires one turret and leaves the view alone', one.gunShots === laid.gunShots + 1 && one.gunView === true && one.tour === false, guns(one));
    await step(20);
    await tap('Space');
    await tap('Space');
    const salvo = await facts();
    expect('pressed twice at once it fires every gun that is ready', salvo.gunShots === one.gunShots + laid.gunReady - 1 && salvo.gunReady === 0, guns(salvo));
    await step(280);
    const loaded = await facts();
    expect('and they load again', loaded.gunReady >= 3, guns(loaded));
    const spots = await page.evaluate(() => window.__spaceHud.guns.spots);
    const scale = 450 / 900;
    await page.mouse.move(spots.fire.left * scale, spots.fire.top * scale);
    await page.mouse.down();
    await step(3);
    const pressed = await facts();
    await page.mouse.up();
    await step(2);
    expect('the FIRE button on the glass fires a turret, for a hand with no keyboard', pressed.gunShots === loaded.gunShots + 1, guns(pressed));
    expect('and pressing it does not swing the view', Math.hypot(pressed.eyeX - loaded.eyeX, pressed.eyeZ - loaded.eyeZ) < 0.5, [pressed.eyeX, loaded.eyeX]);
    await tap('KeyG');
    await step(30);
    const stowed = await facts();
    expect('G gives the view back and the guns stow', stowed.gunView === false && stowed.gunSource === 'stowed', guns(stowed));

    await tap('KeyT');
    await step(120);
    const tracking = await facts();
    expect('a locked target is followed by the guns, which hold their fire', tracking.gunSource === 'target' && tracking.gunShots === pressed.gunShots, guns(tracking));
    expect('fire at will is on from the start', tracking.gunAuto === true, guns(tracking));
    await tap('KeyC');
    await step(30);
    const holding = await facts();
    expect('C holds their fire', holding.gunAuto === false && holding.gunSource === 'target', guns(holding));
    await tap('KeyC');
    await step(240);
    const free = await facts();
    expect('and C again frees it, and a rock is still only followed, not shot at', free.gunAuto === true && free.gunSource === 'target' && free.gunShots === tracking.gunShots, guns(free));
    await page.close();

    const voyage = await browser.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
    voyage.on('pageerror', (e) => problems.push(String(e)));
    voyage.on('console', (m) => { if (m.type() === 'error') problems.push(m.text().slice(0, 400)); });
    await voyage.goto(`http://127.0.0.1:${server.address().port}/?headless`, { waitUntil: 'load', timeout: 120000 });
    await voyage.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 120000 });
    await voyage.evaluate(() => window.__estellaCooked.setPaused(true));
    const sail = (n) => voyage.evaluate((frames) => window.__estellaCooked.step(frames), n);
    const seen = () => voyage.evaluate(() => { const f = window.__estellaCooked.facts(); return { time: f.time, transits: f.transits, system: f.systemName, jump: f.jump, jumps: f.jumps, fov: f.fov, planets: f.planets }; });
    const home = await seen();
    expect('she starts in the first system with only its planet shown', home.system === 'KARIS' && home.planets === '100' && home.jump === -1 && home.fov === 34, home);
    let through = home;
    for (let second = 0; second < 100 && through.transits === 0; second++) { await sail(60); through = await seen(); }
    expect('left alone she flies through the gate ahead', through.transits === 1, through);
    await sail(2);
    let widest = 0, changed = -1, longest = 0, now = await seen();
    expect('and passing through it starts a jump', now.jump >= 0 && now.jumps === 1 && now.system === 'KARIS', now);
    for (let frame = 0; frame < 400 && now.jump >= 0; frame += 4) {
        widest = Math.max(widest, now.fov);
        longest = Math.max(longest, now.jump);
        if (changed < 0 && now.system !== 'KARIS') changed = now.jump;
        await sail(4);
        now = await seen();
    }
    expect('the view opens out as she accelerates', widest > 55, widest);
    expect('the system changes in the middle of the jump, behind the flash', changed > 2.2 && changed < 2.5, changed);
    expect('the jump ends, in a few seconds', now.jump === -1 && longest > 4 && longest < 4.7, { jump: now.jump, longest });
    expect('and leaves her in the next system, with its planet and the view as it was', now.system === 'VELA' && now.planets === '010' && now.fov === 34 && now.jumps === 1, now);
    await voyage.close();

    const ram = await browser.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
    ram.on('pageerror', (e) => problems.push(String(e)));
    ram.on('console', (m) => { if (m.type() === 'error') problems.push(m.text().slice(0, 400)); });
    await ram.goto(`http://127.0.0.1:${server.address().port}/?headless`, { waitUntil: 'load', timeout: 120000 });
    await ram.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 120000 });
    await ram.waitForFunction(() => window.__spaceHud?.ready || window.__spaceHud?.error, null, { timeout: 120000 });
    await ram.evaluate(() => window.__estellaCooked.setPaused(true));
    await ram.evaluate(() => { window.__spaceHud.foes.peace = true; });
    const drive = (n) => ram.evaluate((frames) => window.__estellaCooked.step(frames), n);
    const press = async (key) => { await ram.keyboard.down(key); await drive(1); await ram.keyboard.up(key); await drive(1); };
    const state = () => ram.evaluate(() => { const f = window.__estellaCooked.facts(), h = window.__spaceHud.helm; return { time: f.time, shield: f.shield, hull: f.hull, impacts: f.impacts, gap: f.gap, closest: f.closest, speed: f.speed, mode: h.mode, order: h.order, aim: h.aim ? Math.round(Math.hypot(h.aim.x, h.aim.y, h.aim.z)) : null }; });
    {
    await drive(240);
    const whole = await state();
    expect('she starts whole, with nothing touching her', whole.shield === 1 && whole.hull === 1 && whole.impacts === 0 && whole.closest > 50, whole);
    await press('KeyT');
    await drive(90);
    await press('KeyV');
    await drive(2);
    let held = await state();
    expect('T locks a rock and V turns her toward it', held.mode === 'approach' && held.aim > 200, held);
    for (let second = 0; second < 120 && held.mode !== 'manual'; second++) { await drive(60); held = await state(); }
    await drive(240);
    held = await state();
    expect('closing on a rock she stops short of it', held.mode === 'manual' && held.order === 0 && held.impacts === 0 && held.aim > 60 && held.aim <= 200 && held.speed < 60, held);
    for (let n = 0; n < 4; n++) await press('KeyW');
    let fastest = 0, struck = held;
    for (let frame = 0; frame < 2400 && struck.impacts === 0; frame += 6) { fastest = Math.max(fastest, struck.speed); await drive(6); struck = await state(); }
    expect('driven on, she hits it', struck.impacts >= 1, struck);
    expect('the blow comes off the shield and takes way off her', struck.shield < 1 && struck.hull === 1 && struck.speed < fastest - 1, { shield: struck.shield, speed: struck.speed, fastest });
    await drive(180);
    const after = await state();
    expect('and the rock is knocked away: at no moment is it inside the hull', after.closest > -0.5 && after.gap > -0.5, { closest: after.closest, gap: after.gap });
    for (let n = 0; n < 4; n++) await press('KeyS');
    await drive(60 * 9);
    const mended = await state();
    expect('left alone the shield comes back', mended.shield > after.shield && mended.impacts === after.impacts, { before: after.shield, now: mended.shield, impacts: [after.impacts, mended.impacts] });
    }
    await ram.close();

    const fight = await browser.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
    fight.on('pageerror', (e) => problems.push(String(e)));
    fight.on('console', (m) => { if (m.type() === 'error') problems.push(m.text().slice(0, 400)); });
    await fight.goto(`http://127.0.0.1:${server.address().port}/?headless`, { waitUntil: 'load', timeout: 120000 });
    await fight.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 120000 });
    await fight.waitForFunction(() => window.__spaceHud?.ready || window.__spaceHud?.error, null, { timeout: 120000 });
    await fight.evaluate(() => window.__estellaCooked.setPaused(true));
    {
        const go = (n) => fight.evaluate((frames) => window.__estellaCooked.step(frames), n);
        const hit = async (key) => { await fight.keyboard.down(key); await go(1); await fight.keyboard.up(key); await go(1); };
        const view = () => fight.evaluate(() => { const f = window.__estellaCooked.facts(), h = window.__spaceHud; return { time: f.time, foes: f.foes, kills: f.kills, foeShots: f.foeShots, stung: f.stung, berth: f.foeBerth, range: f.foeRange, shield: f.shield, hull: f.hull, shots: f.gunShots, hits: f.gunHits, selected: h.selected, auto: f.gunAuto, due: h.foes.due }; });
        await go(240);
        const calm = await view();
        expect('on the tour no raider comes', calm.foes === 0 && calm.foeShots === 0 && !(calm.due < 1e9), calm);
        await hit('KeyG');
        await go(30);
        const waiting = await view();
        expect('once she is in hand a wave is due, and not at once', waiting.foes === 0 && waiting.due > waiting.time + 10, waiting);
        await fight.evaluate(() => { window.__spaceHud.foes.due = 0; });
        await go(2);
        const met = await view();
        expect('a wave is two raiders, arriving far off', met.foes === 2 && met.range > 2000 && met.range < 2700, met);
        await hit('KeyG');
        await go(120);
        const locked = await view();
        expect('out of combat mode a raider in range is locked by itself', locked.selected >= 46, locked);
        let seen = locked, nearest = locked.range, lowest = 1, firstShot = -1, firstKill = -1;
        for (let second = 0; second < 150 && seen.kills < 2; second++) {
            await go(60);
            seen = await view();
            nearest = Math.min(nearest, seen.range);
            lowest = Math.min(lowest, seen.shield);
            if (firstShot < 0 && seen.foeShots > 0) firstShot = seen.time - locked.time;
            if (firstKill < 0 && seen.kills > 0) firstKill = seen.time - locked.time;
        }
        expect('they close and open fire', firstShot > 0 && firstShot < 45, { firstShot, shots: seen.foeShots });
        expect('some of it lands, and comes off the shield', seen.stung > 0 && lowest < 1, { stung: seen.stung, lowest });
        expect('they make their passes without ramming her', nearest > 100 && nearest < 400, nearest);
        expect('her guns, firing at will on the locked raider, hit it', seen.hits > 0, { shots: seen.shots, hits: seen.hits });
        expect('and destroy it', seen.kills >= 1, { kills: seen.kills, firstKill, foes: seen.foes });
    }
} finally {
    await browser.close();
    server.close();
}
console.log(JSON.stringify({ findings, problems: [...new Set(problems)] }, null, 1));
if (problems.length > 0) process.exitCode = 1;

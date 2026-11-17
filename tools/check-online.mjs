import { chromium } from 'playwright';
import { fork, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

// Two real game clients in one sector, on a slow link: the web export twice, against the sector server as its own
// process, with every byte between them held back ONE_WAY_MS in each direction (SECTOR_DELAY_MS, default 100: 200 ms there and back).
const ONE_WAY_MS = Number(process.env.SECTOR_DELAY_MS ?? 100);
const root = path.resolve('output/space-frigate');
const game = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'online');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const TOTAL = 10_000_000, TOP = 420 * 0.12, TURN_RATE = 0.3;
await mkdir(out, { recursive: true });
const built = spawnSync(process.execPath, [path.join(game, 'server/run.mjs'), '--build-only'], { encoding: 'utf8' });
if (built.status !== 0) throw new Error(built.stderr || built.stdout);
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const port = await freePort();
const data = path.join(await mkdtemp(path.join(tmpdir(), 'sector-online-')), 'sector.json');
let sectorServer = null;
async function startSector(extra = []) {
    const child = fork(path.join(game, '.esengine/cache/sector-server.mjs'), ['--port', String(port), '--data', data, ...extra], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
    child.gone = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => { if (/\[sector\] .* on ws:/.test(String(chunk))) resolve(); });
        child.once('exit', (code) => reject(new Error(`the sector server left with ${code}`)));
    });
    sectorServer = child;
}
const stopSector = async () => { sectorServer.send('shutdown'); await sectorServer.gone; sectorServer = null; };
const health = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
const books = async () => (await fetch(`http://127.0.0.1:${port}/pilots`)).json();

// The slow link: a relay that passes bytes on, in order, ONE_WAY_MS late in each direction, and can be cut.
const links = new Set();
const relay = net.createServer((client) => {
    const upstream = net.connect(port, '127.0.0.1');
    const pair = { client, upstream };
    links.add(pair);
    const late = (from, to) => {
        const waiting = [];
        from.on('data', (chunk) => { waiting.push(chunk); setTimeout(() => { const next = waiting.shift(); if (!to.destroyed) to.write(next); }, ONE_WAY_MS); });
        from.on('close', () => setTimeout(() => to.destroy(), ONE_WAY_MS));
        from.on('error', () => to.destroy());
    };
    late(client, upstream);
    late(upstream, client);
    client.on('close', () => links.delete(pair));
});
await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
const cut = () => { for (const pair of [...links]) { pair.client.destroy(); pair.upstream.destroy(); } };

const web = await serveHost(path.join(root, 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, recordVideo: { dir: path.join(out, 'video'), size: { width: 1280, height: 720 } } });
const problems = [];
const findings = [];
const measured = {};
const expect = (what, ok, detail) => { findings.push({ what, ok, detail }); if (!ok) problems.push(`${what}: ${JSON.stringify(detail)}`); console.log(`${ok ? 'ok  ' : 'BAD '} ${what}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const far = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const tuple = (v) => [v.x, v.y, v.z];

async function client(name, account, token) {
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`${name}: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|net::/.test(m.text())) problems.push(`${name}: ${m.text().slice(0, 300)}`); });
    const address = `http://127.0.0.1:${web.address().port}/?headless&server=${encodeURIComponent(`ws://127.0.0.1:${relay.address().port}/sector`)}&account=${account}&token=${token}`;
    let stepped = Date.now();
    const open = async () => {
        await page.goto(address, { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000 });
        await page.waitForFunction(() => window.__spaceHud?.ready || window.__spaceHud?.error, null, { timeout: 120000 });
        await page.evaluate(() => window.__estellaCooked.setPaused(true));
        stepped = Date.now();
    };
    await open();
    const step = (n) => page.evaluate((frames) => window.__estellaCooked.step(frames), n);
    // The game is stepped by hand, so it is stepped by the wall clock: a frame for each sixtieth of a second that passed, as it would run by itself.
    const pace = async () => { const now = Date.now(), frames = Math.max(1, Math.round((now - stepped) * 0.06)); stepped = now; await step(Math.min(frames, 30)); };
    const tap = async (key) => { await page.keyboard.down(key); await step(1); await page.keyboard.up(key); await step(1); };
    const seen = () => page.evaluate(() => {
        const h = window.__spaceHud, o = h.online;
        return {
            link: o.link, why: o.why, name: o.name, pos: o.pos, cargo: o.cargo, remaining: o.rock.remaining, total: o.rock.total, mining: o.mining, refusal: o.refusal,
            others: o.others.map((p) => ({ account: p.account, p: p.p, mining: p.mining, cargo: p.cargo })), pilots: h.pilots.map((p) => ({ ...p })),
            fix: { ...o.fix }, ahead: o.ahead, waiting: o.waiting, speed: h.ship.speed, throttle: h.ship.throttle, order: h.helm.order, rudder: h.helm.rudder, yawRate: h.helm.yawRate, yaw: h.helm.yaw,
            hold: h.mining.hold, firing: h.mining.firing, armed: h.mining.armed, selected: h.selected, locked: h.locked, text: h.contract.text, system: h.ship.system, jumps: h.ship.jumps,
        };
    });
    const until = async (what, test, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { await pace(); if (test(await seen())) return true; await wait(20); } problems.push(`${name}: timed out waiting for ${what}: ${JSON.stringify(await seen())}`); return false; };
    const shoot = async (shot) => { await step(2); await page.screenshot({ path: path.join(out, `${shot}.png`), timeout: 60000 }); };
    const engine = async (to) => { for (let n = 0; n < 6 && Math.abs((await seen()).order - to) > 0.01; n++) await tap((await seen()).order < to ? 'KeyW' : 'KeyS'); };
    return { name, page, open, step, pace, tap, seen, until, shoot, engine };
}
// ach looks at the games, and a look takes time in which they are not stepped: very keeps the looks few enough that the stepping stays a frame or two at a time, as a game running by itself is.
const both = async (a, b, ms, each, every = 1) => { for (let n = 0, end = Date.now() + ms; Date.now() < end; n++) { await a.pace(); await b.pace(); if (each && n % every === 0) await each(); await wait(8); } };

try {
    await startSector(['--new']);
    const a = await client('A', 'pilot-a', 'test-token-a');
    const b = await client('B', 'pilot-b', 'test-token-b');
    await a.until('A to be in the sector', (s) => s.link === 'online' && s.others.length === 1);
    await b.until('B to be in the sector', (s) => s.link === 'online' && s.others.length === 1);
    for (const c of [a, b]) await c.engine(0);
    await both(a, b, 1500);
    let sa = await a.seen(), sb = await b.seen();
    expect('two clients are in the same sector, each under her own account', sa.name === 'PILOT A' && sb.name === 'PILOT B' && sa.total === TOTAL && sa.remaining === TOTAL && sb.remaining === TOTAL, { sa, sb });
    expect('each draws the other\'s ship where the server has her', sa.pilots.length === 1 && sb.pilots.length === 1 && Math.abs(Math.hypot(sa.pilots[0].x, sa.pilots[0].y, sa.pilots[0].z) - 320) < 60 && sa.pilots[0].x > 220 && sb.pilots[0].x < -220, { a: sa.pilots, b: sb.pilots });
    await a.shoot('1-two-in-the-sector');

    // ---- The four things asked of the sector before, again: mining, the books, a reload, a restart ----
    for (const c of [a, b]) await c.tap('KeyT');
    await both(a, b, 1800);
    for (const c of [a, b]) await c.tap('KeyF');
    await a.until('A to be mining', (s) => s.mining && s.cargo > 0);
    await b.until('B to be mining', (s) => s.mining && s.cargo > 0);
    let worst = 0, samples = 0, sawB = false, sawA = false, beams = 0;
    await both(a, b, 9000, async () => {
        const la = await a.seen(), lb = await b.seen();
        sawB ||= la.others[0]?.mining === true; sawA ||= lb.others[0]?.mining === true;
        if (la.mining && lb.mining && la.firing && lb.firing) beams++;
        const h = await health();
        worst = Math.max(worst, Math.abs(h.remaining + h.held - TOTAL));
        samples++;
    });
    sa = await a.seen(); sb = await b.seen();
    expect('both mine the shared rock at once, and each sees the other mining', sa.cargo > 500000 && sb.cargo > 500000 && sawA && sawB && beams > 10, { a: sa.cargo, b: sb.cargo, sawA, sawB, beams });
    expect(`through ${samples} looks at the server's books while they mined, holds plus rock were ten tonnes every time`, worst === 0 && samples > 40, { worst, samples });
    expect('the hold each client shows is the server\'s figure for her', Math.abs(sa.hold * 1e6 - sa.cargo) < 90001 && Math.abs(sb.hold * 1e6 - sb.cargo) < 90001, { a: [sa.hold, sa.cargo], b: [sb.hold, sb.cargo] });
    await a.shoot('2-both-mining');

    const honest = (await health()).held;
    await a.page.evaluate(() => { const h = window.__spaceHud; h.mining.hold = 9999; h.online.cargo = 99_000_000; h.online.rock.remaining = 99_000_000; h.contract.delivered = 9999; h.tuning.capacity = 9999; });
    await both(a, b, 1500);
    sa = await a.seen(); sb = await b.seen();
    let now = await health();
    expect('editing the client\'s own cargo figures changes nothing: the next state puts them back', sa.cargo < TOTAL && sa.hold < 10.01 && Math.abs(sb.others[0].cargo - sa.cargo) < 400000, { shown: sa.hold, cargo: sa.cargo, seenByB: sb.others[0].cargo });
    expect('and the books still hold ten tonnes', now.remaining + now.held === TOTAL && now.held >= honest && now.held < honest + 1_200_000, { honest, now });

    for (const c of [a, b]) if ((await c.seen()).armed) await c.tap('KeyF');
    await both(a, b, 900);
    const kept = (await a.seen()).cargo;
    await a.open();
    await a.until('A to be back', (s) => s.link === 'online' && s.others.length === 1);
    sa = await a.seen();
    expect('a pilot who reloads the game is the same pilot with the same cargo, and is not mining until she asks', sa.cargo === kept && !sa.mining && sa.name === 'PILOT A', { kept, sa });
    await a.engine(0);

    const before = await health();
    await stopSector();
    await both(a, b, 1200);
    const down = await a.seen();
    await startSector();
    const again = await health();
    await a.until('A to reconnect by herself', (s) => s.link === 'online' && s.others.length === 1, 30000);
    await b.until('B to reconnect by herself', (s) => s.link === 'online' && s.others.length === 1, 30000);
    sa = await a.seen(); sb = await b.seen();
    expect('while the server is down a client says so', down.link === 'lost' && /LINK LOST/.test(down.text), down);
    expect('a server stopped and started has the same rock and the same holds, and both clients come back to them', again.remaining === before.remaining && again.held === before.held && sa.cargo === kept && sa.remaining === before.remaining && sa.cargo + sb.cargo + sa.remaining === TOTAL, { before, again, a: sa.cargo, b: sb.cargo });

    // ---- Flying, on the slow link ---------------------------------------------------------------
    // The helm answers at once: the drawn ship is turning frames after the key, long before the server has flown the order.
    const still = (await books())['pilot-a'];
    await a.tap('KeyD');
    await a.tap('KeyD');
    await a.step(4);
    const felt = await a.seen(), serverThen = (await books())['pilot-a'];
    expect(`on a ${ONE_WAY_MS * 2} ms link the helm answers in the frames the key is pressed, before the server has flown the order`, Math.abs(felt.yawRate) > 0.002 && Math.abs(serverThen.flight.yawRate) < Math.abs(felt.yawRate) && serverThen.ack <= still.ack + 2, { client: felt.yawRate, server: serverThen.flight.yawRate, ack: [still.ack, serverThen.ack] });
    await a.tap('KeyX');

    // A minute of it: A works the engine and the helm, B watches. What A's own ship was corrected by, and how B saw her move, are kept.
    const fixBefore = (await a.seen()).fix;
    const script = [[0, 'KeyW'], [0.2, 'KeyW'], [0.4, 'KeyW'], [0.6, 'KeyW'], [6, 'KeyD'], [6.3, 'KeyD'], [14, 'KeyX'], [18, 'KeyE'], [24, 'KeyX'], [28, 'KeyA'], [28.3, 'KeyA'], [28.6, 'KeyA'], [38, 'KeyX'], [41, 'KeyS'], [45, 'KeyQ'], [50, 'KeyX'], [52, 'KeyW'], [55, 'KeyD'], [58, 'KeyX']];
    const flight = { began: Date.now(), ahead: [], lead: [], seenOff: [], steps: [], back: 0, last: null, lastAt: 0 };
    let next = 0;
    const paces = { n: 0, frames: 0, most: 0 }, paced = a.pace;
    a.pace = async () => { const before = Date.now(); await paced(); paces.n++; };
    await both(a, b, 60000, async () => {
        const t = (Date.now() - flight.began) / 1000;
        while (next < script.length && script[next][0] <= t) await a.tap(script[next++][1]);
        const [la, lb, server] = [await a.seen(), await b.seen(), (await books())['pilot-a']];
        const truth = tuple(server.flight.pos);
        flight.ahead.push(la.ahead);
        flight.lead.push(far(la.pos, truth));
        if (lb.pilots[0]) {
            const drawn = [lb.pilots[0].sx, lb.pilots[0].sy, lb.pilots[0].sz], at = Date.now();
            flight.seenOff.push(far(drawn, truth));
            if (flight.last) {
                const dt = (at - flight.lastAt) / 1000, moved = far(drawn, flight.last);
                flight.steps.push(moved - TOP * dt);
                // Going astern of her own way, as seen by B: a ship that was drawn ahead and then put back.
                const way = [server.flight.pos.x - flight.truthBefore[0], server.flight.pos.y - flight.truthBefore[1], server.flight.pos.z - flight.truthBefore[2]], along = (drawn[0] - flight.last[0]) * way[0] + (drawn[1] - flight.last[1]) * way[1] + (drawn[2] - flight.last[2]) * way[2];
                if (server.flight.speed > 100 && along < -1) flight.back++;
            }
            flight.last = drawn; flight.lastAt = at; flight.truthBefore = truth;
        }
    }, 4);
    a.pace = paced;
    await a.shoot('3-a-flying');
    await b.shoot('3-b-watching-a');
    sa = await a.seen(); sb = await b.seen();
    const server = (await books())['pilot-a'];
    const most = (list) => list.reduce((m, v) => Math.max(m, v), -Infinity), mean = (list) => list.reduce((s, v) => s + v, 0) / Math.max(1, list.length);
    const fix = { count: sa.fix.count - fixBefore.count, hard: sa.fix.hard - fixBefore.hard, worst: sa.fix.worst, worstTurnDeg: (sa.fix.worstTurn * 180) / Math.PI };
    measured.flight = {
        rttMs: ONE_WAY_MS * 2, seconds: 60, stepsOfTheGameASecond: Math.round(paces.n / 60), sailed: Math.round(far(tuple(server.flight.pos), tuple(still.flight.pos))), samples: flight.lead.length,
        ownShip: { corrections: fix.count, feltCorrections: fix.hard, worstCorrectionUnits: +fix.worst.toFixed(3), worstCorrectionDegrees: +fix.worstTurnDeg.toFixed(3), ordersAheadOfServer: { mean: +mean(flight.ahead).toFixed(1), most: most(flight.ahead) }, leadOverServerUnits: { mean: +mean(flight.lead).toFixed(1), most: +most(flight.lead).toFixed(1) } },
        otherShip: { drawnOffServerUnits: { mean: +mean(flight.seenOff).toFixed(1), most: +most(flight.seenOff).toFixed(1) }, mostStepBeyondHerWayUnits: +most(flight.steps).toFixed(2), timesDrawnGoingAstern: flight.back },
        server: { ordersStarved: server.starved, ordersDropped: server.dropped },
    };
    expect('a minute of flying on that link: she sailed, turned and climbed, and her own ship was never pulled back', measured.flight.sailed > 1000 && fix.hard === 0 && fix.worst < 5 && fix.worstTurnDeg < 2, measured.flight.ownShip);
    expect('she is ahead of the server\'s ship by the link and no more', mean(flight.ahead) <= 16 && most(flight.ahead) <= 24 && most(flight.lead) < TOP * 0.8, measured.flight.ownShip);
    expect('the other pilot saw her move without a break: never further in a look than her way, never astern', most(flight.steps) < 6 && flight.back === 0 && most(flight.seenOff) < TOP * 0.6, measured.flight.otherShip);

    // ---- What a client cannot do to a flight ------------------------------------------------------
    await a.engine(1);
    await both(a, b, 4000);
    const lap = { from: (await books())['pilot-a'], at: Date.now() };
    // Her client says she is somewhere else, heading elsewhere, at a speed no frigate makes; and its clock runs ten times fast.
    await a.page.evaluate(() => { const h = window.__spaceHud; h.online.pos = [9e6, 0, 0]; h.helm.level = { x: 0, y: 1, z: 0, w: 0 }; h.helm.attitude = { x: 0, y: 1, z: 0, w: 0 }; h.ship.speed = 99999; h.ship.throttle = 50; h.helm.yawRate = 40; });
    for (const end = Date.now() + 5000; Date.now() < end;) { await a.step(20); await b.pace(); await wait(20); }
    const lapEnd = (await books())['pilot-a'], seconds = (Date.now() - lap.at) / 1000;
    const ran = far(tuple(lapEnd.flight.pos), tuple(lap.from.flight.pos));
    sa = await a.seen(); sb = await b.seen();
    measured.cheats = { seconds: +seconds.toFixed(2), ranUnits: +ran.toFixed(1), mostAFrigateCouldRun: +(TOP * seconds).toFixed(1), serverSpeed: +lapEnd.flight.speed.toFixed(1), ordersDropped: lapEnd.dropped - lap.from.dropped, clientCorrections: sa.fix.count - fix.count - fixBefore.count };
    expect('a forged place, heading and speed in the client, and a client clock ten times fast, moved the server\'s ship no further than a frigate sails', ran <= TOP * (seconds + 0.2) && ran > TOP * seconds * 0.7 && lapEnd.flight.speed <= 420 && measured.cheats.ordersDropped > 100, measured.cheats);
    expect('and the other pilot saw the server\'s ship, not the forged one', far([sb.pilots[0].sx, sb.pilots[0].sy, sb.pilots[0].sz], tuple(lapEnd.flight.pos)) < TOP * 0.8, { seenByB: sb.pilots[0], server: lapEnd.flight.pos });
    const swing = { from: (await books())['pilot-a'].flight, at: Date.now() };
    for (let n = 0; n < 3; n++) await a.tap('KeyD');
    for (const end = Date.now() + 3000; Date.now() < end;) { await a.step(20); await b.pace(); await wait(20); }
    const swung = (await books())['pilot-a'].flight, took = (Date.now() - swing.at) / 1000;
    const headingOf = (f) => { const q = f.level; return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y)); };
    let turned = Math.abs(headingOf(swung) - headingOf(swing.from));
    if (turned > Math.PI) turned = 2 * Math.PI - turned;
    measured.cheats.hardOver = { seconds: +took.toFixed(2), turnedRad: +turned.toFixed(3), mostRad: +(TURN_RATE * took).toFixed(3) };
    expect('hard over on a fast clock turned her no faster than her thrusters allow', turned > 0.15 && turned <= TURN_RATE * (took + 0.2) && Math.abs(swung.yawRate) <= TURN_RATE + 1e-9, measured.cheats.hardOver);
    await a.tap('KeyX');
    await a.engine(0.5);
    await both(a, b, 2500);

    // ---- A link that drops for a moment -----------------------------------------------------------
    const under = (await books())['pilot-a'];
    cut();
    // She redials within the second, so the moment she is without a link is looked for while it lasts.
    let dark = await a.seen();
    await both(a, b, 900, async () => { const s = await a.seen(); if (s.link === 'lost') dark = s; });
    await a.until('A to be back after the cut', (s) => s.link === 'online' && s.others.length === 1, 30000);
    await b.until('B to be back after the cut', (s) => s.link === 'online' && s.others.length === 1, 30000);
    await both(a, b, 3000);
    sa = await a.seen();
    const back = (await books())['pilot-a'];
    measured.drop = { saidWhileDown: dark.link, speedBefore: +under.flight.speed.toFixed(1), clientOffServerAfterUnits: +far(sa.pos, tuple(back.flight.pos)).toFixed(1), ordersAhead: sa.ahead, serverFlyingHerOrders: back.ack > 30 };
    expect('the link cut under way: the client says so, comes back by itself, and is flying the server\'s ship again from where it is', dark.link === 'lost' && back.here && back.ack > 30 && far(sa.pos, tuple(back.flight.pos)) < TOP * 0.8 && sa.cargo === kept, measured.drop);

    // ---- A second sign-in takes the helm ----------------------------------------------------------
    const c = await client('C', 'pilot-a', 'test-token-a');
    await c.until('the new seat to be in', (s) => s.link === 'online');
    await both(a, c, 1500);
    const ousted = await a.seen(), helmAt = (await books())['pilot-a'];
    for (let n = 0; n < 3; n++) await a.tap('KeyD');
    await a.engine(1);
    await both(a, c, 2500);
    const untouched = (await books())['pilot-a'];
    measured.oldSeat = { link: ousted.link, why: ousted.why, serverRudderRate: untouched.flight.yawRate };
    expect('signed in again elsewhere, the old window is told so and its helm moves nothing', ousted.link === 'refused' && /REPLACED/.test(ousted.why) && Math.abs(untouched.flight.yawRate) < 0.02 && untouched.flight.throttle <= helmAt.flight.throttle + 0.05, { ...measured.oldSeat, throttle: [helmAt.flight.throttle, untouched.flight.throttle] });
    await c.page.close();
    await a.open();
    await a.until('A to take her seat back', (s) => s.link === 'online' && s.others.length === 1);

    // ---- Mine it out: both come back within reach by their own helms -------------------------------
    for (const one of [a, b]) await one.engine(0);
    const reach = async () => { const p = await books(); return ['pilot-a', 'pilot-b'].map((id) => far(tuple(p[id].flight.pos), [0, 30, 700])); };
    measured.reach = (await reach()).map((d) => Math.round(d));
    for (const end = Date.now() + 240000; Date.now() < end && (await health()).remaining > 0;) {
        for (const one of [a, b]) {
            await one.pace();
            const s = await one.seen();
            if (s.selected !== 0) await one.tap('KeyT');
            else if (s.locked && /OUT OF BEAM RANGE/.test(s.text)) await one.tap('KeyV');
            else if (s.locked && /ENGINE STOPPED/.test(s.text)) await one.engine(1);
            else if (s.locked && !s.armed && /PRESS F/.test(s.text)) await one.tap('KeyF');
        }
        await wait(30);
    }
    await both(a, b, 1000);
    sa = await a.seen(); sb = await b.seen();
    now = await health();
    expect('mined out, the two holds are the whole ten tonnes and the rock is empty', now.remaining === 0 && now.held === TOTAL && sa.cargo + sb.cargo === TOTAL && sa.remaining === 0, { now, a: sa.cargo, b: sb.cargo, reach: measured.reach });
    expect('and the client says the rock is mined out and mines no more', /MINED OUT/.test(sa.text) && !sa.firing && !sb.firing, { a: sa.text, b: sb.text });
    expect('a fixed sector: nobody jumped out of it', sa.system === 0 && sb.system === 0 && sa.jumps === 0, { a: sa.system, b: sb.system });
    await a.shoot('4-mined-out');
} catch (err) {
    problems.push(String(err?.stack ?? err));
} finally {
    await context.close().catch(() => undefined);
    await browser.close();
    web.close();
    relay.close();
    cut();
    if (sectorServer) await stopSector().catch(() => undefined);
}
const report = { oneWayDelayMs: ONE_WAY_MS, findings: findings.map((f) => ({ what: f.what, ok: f.ok })), measured, problems: [...new Set(problems)] };
await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(problems.length > 0 ? 1 : 0);

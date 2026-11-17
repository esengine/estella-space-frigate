import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rename } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The sector server as its own process, with real sockets: two pilots, their ships, one rock of ten tonnes.
// SECTOR_WIRE=json runs the same checks over text frames; the default is protobuf.
const WIRE = process.env.SECTOR_WIRE === 'json' ? 'json' : 'pb';
const root = fileURLToPath(new URL('../', import.meta.url));
const engine = path.resolve(root, '../..');
const alias = { 'esengine/session': path.join(engine, 'sdk/dist/net/session/index.js') };
const serverFile = path.join(root, '.esengine/cache/sector-server.mjs');
const built = spawnSync(process.execPath, [path.join(root, 'server/run.mjs'), '--build-only'], { encoding: 'utf8' });
if (built.status !== 0) throw new Error(built.stderr || built.stdout);
const checkOut = path.join(root, '.esengine/cache/sector-check.mjs');
await build({
    stdin: { resolveDir: path.join(root, 'tools'), sourcefile: 'check-entry.ts', loader: 'ts', contents: `
        export { contract } from '../src/protocol.ts';
        export { SECTOR, GRAMS } from '../src/shared/sector.ts';
        export { FLIGHT_TICK, TURN_RATE } from '../src/shared/steer.ts';
        export { TOP_SPEED, FIELD_DRIFT } from '../src/shipState.ts';
        export { ClientSession, NetRequestError } from 'esengine/session';
        export { GameSocket } from '../../../sdk/src/net/GameSocket.ts';
    ` },
    outfile: checkOut, bundle: true, format: 'esm', platform: 'node', target: 'node20', alias, logLevel: 'warning',
});
const { contract, SECTOR, GRAMS, FLIGHT_TICK, TURN_RATE, TOP_SPEED, FIELD_DRIFT, ClientSession, GameSocket } = await import(pathToFileURL(checkOut).href);

const TOTAL = SECTOR.rock.total, TOP = TOP_SPEED * FIELD_DRIFT, TICK_MS = FLIGHT_TICK * 1000;
const checks = [];
const pass = (text) => { checks.push(text); console.log('ok  ' + text); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const until = async (what, test, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await test()) return; await wait(25); } throw new Error(`timed out waiting for ${what}`); };

const dir = await mkdtemp(path.join(tmpdir(), 'sector-check-'));
const data = path.join(dir, 'sector.json');
const port = await freePort();
const url = `ws://127.0.0.1:${port}/sector`;
const health = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
const books = async () => (await fetch(`http://127.0.0.1:${port}/pilots`)).json();

let server = null;
function launch(extra = []) {
    const child = fork(serverFile, ['--port', String(port), '--data', data, '--wire', 'pb', ...extra], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.said = '';
    child.stdout.on('data', (chunk) => { child.said += String(chunk); });
    child.stderr.on('data', (chunk) => { child.said += String(chunk); });
    child.gone = new Promise((resolve) => child.once('exit', resolve));
    return child;
}
async function start(extra = []) {
    const child = launch(extra);
    await new Promise((resolve, reject) => {
        child.stdout.on('data', () => { if (/\[sector\] .* on ws:/.test(child.said)) resolve(); });
        child.once('exit', (code) => reject(new Error(`the server left with ${code} before listening: ${child.said}`)));
    });
    server = child;
}
const stopGently = async () => { server.send('shutdown'); await server.gone; server = null; };
const kill = async () => { server.kill('SIGKILL'); await server.gone; server = null; };

const CREDS = { a: { account: 'pilot-a', token: 'test-token-a' }, b: { account: 'pilot-b', token: 'test-token-b' } };
const sums = { seen: 0, worst: 0 };
async function pilot(creds, fingerprint = contract.fingerprint) {
    const sockets = [];
    const session = new ClientSession({
        connect: () => { const socket = new GameSocket({ url }); sockets.push(socket); return socket; },
        wire: WIRE,
        credentials: () => ({ ...creds, contract: fingerprint }),
        backoff: { initialMs: 100, maxMs: 500 },
    });
    const me = { session, sockets, api: contract.client(session), state: null, states: 0, closed: '', seq: 0 };
    contract.on(session, 'state', (state) => {
        me.state = state;
        me.states++;
        // A pilot who is signed out is not in the state, though her hold still counts: those moments are checked against /healthz instead.
        if (state.others.length !== 1) return;
        const sum = state.remaining + state.cargo + state.others[0].cargo;
        sums.seen++;
        sums.worst = Math.max(sums.worst, Math.abs(sum - TOTAL));
    });
    session.onState((state, reason) => { if (state === 'closed') me.closed = reason ?? 'closed'; });
    await session.start();
    me.welcome = await me.api.enter({});
    /** At her helm for `seconds`: one numbered order a step, by the wall clock, as the game sends them. */
    me.sail = async (seconds, orders) => {
        const began = Date.now();
        for (let sent = 0; Date.now() - began < seconds * 1000;) {
            const due = Math.floor((Date.now() - began) / TICK_MS) - sent;
            if (due > 0) { sent += due; me.api.steer({ orders: Array.from({ length: Math.min(due, 30) }, () => ({ seq: ++me.seq, order: 0, rudder: 0, elevation: 0, roll: 0, ...orders })) }, { retries: 0 }).catch(() => undefined); }
            await wait(50);
        }
    };
    return me;
}
const at = (v) => [v.x, v.y, v.z];
const heading = (level) => { const q = level, x = 2 * (q.x * q.z + q.w * q.y), z = 1 - 2 * (q.x * q.x + q.y * q.y); return Math.atan2(x, z); };
const sumNow = async () => { const h = await health(); return h.remaining + h.held; };

try {
    // ---- A sector is founded on purpose -----------------------------------------
    const lost = launch();
    assert.equal(await lost.gone, 3, lost.said);
    assert.match(lost.said, /no save at .*sector\.json\. To found a new sector there, start once with --new/);
    assert.equal(existsSync(data), false);
    pass('with no save and no --new the server does not start, and creates nothing');
    await start(['--new']);
    assert.equal(existsSync(data), true, 'the new sector is written at once');
    assert.deepEqual(await health(), { ok: true, pilots: 0, remaining: TOTAL, held: 0, total: TOTAL });
    pass('founded with --new, a sector holds one rock of ten tonnes and no cargo, and is on disk before anyone arrives');

    // ---- Who may come in ----------------------------------------------------------
    await assert.rejects(pilot({ account: 'pilot-a', token: 'test-token-b' }), /UNKNOWN PILOT OR TOKEN/);
    await assert.rejects(pilot({ account: 'pilot-z', token: 'test-token-a' }), /UNKNOWN PILOT OR TOKEN/);
    await assert.rejects(pilot(CREDS.a, 'deadbeef'), /CLIENT AND SERVER DIFFER/);
    assert.equal((await health()).pilots, 0);
    pass('a wrong token, an unknown account and a client built against another contract are all turned away');

    // ---- Two pilots, one sector ---------------------------------------------------
    let a = await pilot(CREDS.a), b = await pilot(CREDS.b);
    assert.equal(a.welcome.name, 'PILOT A');
    assert.equal(a.welcome.rock.total, TOTAL);
    assert.equal(a.welcome.cargo, 0);
    assert.deepEqual(at(a.welcome.flight.p), [...SECTOR.berths[0]]);
    assert.deepEqual(at(b.welcome.flight.p), [...SECTOR.berths[1]]);
    assert.equal(a.welcome.flight.speed, 0);
    await until('each to see the other', () => a.state?.others.length === 1 && b.state?.others.length === 1);
    assert.equal(a.state.others[0].account, 'pilot-b');
    assert.deepEqual(at(a.state.others[0].p), [...SECTOR.berths[1]]);
    pass('two pilots enter the same sector at their own berths, at rest, and each sees the other');

    // ---- The server flies her -----------------------------------------------------
    await a.sail(5, { order: 1, rudder: 1 / 3 });
    await wait(300);
    const flown = a.state.flight, seenByB = b.state.others[0];
    assert.ok(flown.speed > TOP_SPEED * 0.85 && flown.speed <= TOP_SPEED, `speed ${flown.speed}`);
    assert.ok(flown.p.z > 80 && flown.p.z < TOP * 5.5, `she went ${flown.p.z}`);
    assert.ok(Math.abs(heading(flown.level)) > 0.1 && Math.abs(heading(flown.level)) < TURN_RATE * 5.5, `she turned ${heading(flown.level)}`);
    assert.ok(a.state.ack > 100 && a.state.ack <= a.seq);
    assert.ok(Math.hypot(seenByB.p.x - flown.p.x, seenByB.p.y - flown.p.y, seenByB.p.z - flown.p.z) < TOP * 0.4, 'B sees her where the server has her');
    assert.ok(Math.hypot(seenByB.v.x, seenByB.v.y, seenByB.v.z) > TOP * 0.8, 'and making way');
    pass('sent only orders, a ship gathers way and comes round as a frigate does, and the other pilot sees her go');

    // ---- What a client cannot do --------------------------------------------------
    for (const [type, payload] of [['pose', { p: { x: 9e6, y: 0, z: 0 }, q: { x: 0, y: 1, z: 0, w: 0 }, throttle: 1 }], ['move', { to: [9e6, 0, 0] }], ['flight', { speed: 99999 }]]) {
        await assert.rejects(a.session.request(type, payload, { retries: 0, timeoutMs: 1500 }));
        a.session.send(type, payload);
    }
    await a.session.request('steer', { orders: [{ seq: ++a.seq, order: 1, rudder: 0, elevation: 0, roll: 0, p: { x: 9e6, y: 0, z: 0 }, speed: 99999, level: { x: 0, y: 1, z: 0, w: 0 } }], p: { x: 9e6, y: 0, z: 0 }, flight: { speed: 99999 } }, { retries: 0, timeoutMs: 1500 }).catch(() => undefined);
    await wait(250);
    assert.ok(Math.abs(a.state.flight.p.x) < 2000 && a.state.flight.speed <= TOP_SPEED, 'she is where she sailed');
    pass('there is no request that places a ship: a pose, a move or a flight is refused, and a place slipped into her orders is not read');

    // A client running fast, flooding and repeating: the ship goes as far as the server's clock allows.
    const lap = { from: (await books())['pilot-a'].flight, at: Date.now() };
    for (let n = 0; n < 40; n++) {
        const orders = Array.from({ length: 30 }, () => ({ seq: ++a.seq, order: 1, rudder: 0, elevation: 0, roll: 0 }));
        a.api.steer({ orders }, { retries: 0 }).catch(() => undefined);
        a.api.steer({ orders }, { retries: 0 }).catch(() => undefined);
        await wait(50);
    }
    const lapEnd = (await books())['pilot-a'], seconds = (Date.now() - lap.at) / 1000;
    const ran = Math.hypot(lapEnd.flight.pos.x - lap.from.pos.x, lapEnd.flight.pos.y - lap.from.pos.y, lapEnd.flight.pos.z - lap.from.pos.z);
    assert.ok(ran <= TOP * (seconds + 0.15), `ran ${ran.toFixed(1)} in ${seconds.toFixed(2)} s; a frigate's most is ${(TOP * seconds).toFixed(1)}`);
    assert.ok(ran >= TOP * seconds * 0.8, 'and she did sail');
    assert.ok(lapEnd.flight.speed <= TOP_SPEED);
    assert.ok(lapEnd.dropped > 500, `orders dropped: ${lapEnd.dropped}`);
    assert.ok(lapEnd.waiting <= 12);
    pass(`fifteen times the orders a client should send, each sent twice, ran her ${ran.toFixed(0)} units in ${seconds.toFixed(1)} s: no more than her top speed`);

    // Hard over and more than hard over, flicked from side to side: she turns no faster than her thrusters allow.
    const turn = { from: heading((await books())['pilot-a'].flight.level), at: Date.now() };
    for (let n = 0; n < 40; n++) { a.api.steer({ orders: [{ seq: ++a.seq, order: 1, rudder: 900, elevation: 0, roll: 0 }] }, { retries: 0 }).catch(() => undefined); await wait(50); }
    const turned = (await books())['pilot-a'].flight, took = (Date.now() - turn.at) / 1000;
    let swung = Math.abs(heading(turned.level) - turn.from);
    if (swung > Math.PI) swung = 2 * Math.PI - swung;
    assert.ok(swung > 0.2 && swung <= TURN_RATE * (took + 0.15), `swung ${swung.toFixed(3)} rad in ${took.toFixed(2)} s; the most is ${(TURN_RATE * took).toFixed(3)}`);
    assert.ok(Math.abs(turned.yawRate) <= TURN_RATE + 1e-9);
    pass(`asked for nine hundred times hard over, she swung ${swung.toFixed(2)} rad in ${took.toFixed(1)} s: within her ${TURN_RATE} rad a second`);
    await a.sail(1, { order: 0 });

    // ---- Mining -------------------------------------------------------------------
    await wait(300);
    assert.equal(a.state.cargo + b.state.cargo, 0, 'nobody is paid before asking');
    const began = Date.now();
    await a.api.mine({ on: true });
    await until('A to be mining', () => a.state.mining && a.state.cargo > 0);
    await until('B to see A mining', () => b.state.others[0].mining && b.state.others[0].cargo > 0);
    assert.equal(b.state.cargo, 0);
    pass('the pilot who asks is mined for, where the server has her within reach; the other sees her beam and her hold, and gets nothing');

    for (let n = 0; n < 30; n++) await a.session.request('mine', { on: true }, { idempotencyKey: 'again', codec: undefined }).catch(() => undefined);
    await Promise.all(Array.from({ length: 20 }, () => a.api.mine({ on: true }).catch(() => undefined)));
    for (const [type, payload] of [['grant', { cargo: 99 * GRAMS }], ['cargo', { set: 99 * GRAMS }], ['mine', { on: true, grams: 99 * GRAMS, cargo: 99 * GRAMS }], ['state', { cargo: 99 * GRAMS, remaining: 0 }]]) {
        await a.session.request(type, payload, { retries: 0, timeoutMs: 1000 }).catch(() => undefined);
        a.session.send(type, payload);
    }
    await wait(400);
    const paid = a.state.cargo, mined = (Date.now() - began) / 1000;
    assert.ok(paid <= SECTOR.rate * mined + 1, `paid ${paid} g in ${mined.toFixed(2)} s at ${SECTOR.rate} g/s`);
    assert.ok(paid >= SECTOR.rate * (mined - 1.5), 'and she was paid for the time she mined');
    assert.equal(await sumNow(), TOTAL);
    pass('asking again and again, replaying a request, and asking for cargo outright pay nothing beyond the clock');

    await b.api.mine({ on: true });
    await until('both to be mining', () => a.state.mining && b.state.mining);
    await wait(1500);
    assert.ok(a.state.cargo > paid && b.state.cargo > 0);
    pass('two pilots mine the one rock at once');

    // ---- The same pilot twice: the old seat has no helm -----------------------------
    const old = a;
    const second = await pilot(CREDS.a);
    await until('the first seat to be taken', () => old.closed !== '');
    assert.match(old.closed, /replaced/);
    const helmBefore = (await books())['pilot-a'];
    await assert.rejects(old.api.steer({ orders: [{ seq: 1, order: 1, rudder: 1, elevation: 0, roll: 0 }] }, { retries: 0, timeoutMs: 1000 }));
    await assert.rejects(old.api.mine({ on: true }, { retries: 0, timeoutMs: 1000 }));
    await wait(600);
    const helmAfter = (await books())['pilot-a'];
    assert.equal(helmAfter.ack, 0, 'no order of the old seat was flown');
    assert.ok(helmAfter.flight.throttle <= helmBefore.flight.throttle + 1e-9, 'and her engine was not put ahead');
    assert.equal(second.state.mining, false, 'a new seat is not mining until it asks');
    const steady = second.state.cargo;
    await wait(600);
    assert.equal(second.state.cargo, steady);
    assert.equal(b.state.others.length, 1, 'and the sector holds her once');
    assert.equal(await sumNow(), TOTAL);
    a = second;
    await a.sail(1.5, { order: 0.5 });
    assert.ok(a.state.ack > 20 && a.state.flight.throttle > 0.3, 'the new seat does have the helm');
    await a.sail(1, { order: 0 });
    pass('signing in a second time takes the seat from the first: the old connection can neither steer nor mine, and the new one can');

    // ---- A link that drops for a moment ---------------------------------------------
    await a.sail(3, { order: 1 });
    const under = (await books())['pilot-a'];
    assert.ok(under.flight.speed > TOP_SPEED * 0.6);
    a.sockets[a.sockets.length - 1].close();
    await until('the server to see her gone', async () => !(await books())['pilot-a'].here);
    await wait(700);
    const adrift = (await books())['pilot-a'];
    assert.ok(adrift.flight.throttle < under.flight.throttle * 0.5, 'her engine was stopped when the link went');
    await until('her to redial by herself', () => a.session.state === 'ready', 15000);
    const again = await a.api.enter({});
    a.seq = 0;
    const where = (await books())['pilot-a'];
    assert.ok(Math.hypot(again.flight.p.x - where.flight.pos.x, again.flight.p.y - where.flight.pos.y, again.flight.p.z - where.flight.pos.z) < TOP * 0.3, 'she is given the ship where the server has her');
    assert.equal(again.cargo, a.state.cargo);
    await a.sail(1.5, { order: 0.75 });
    assert.ok(a.state.ack > 20, 'and her orders count from 1 again and are flown');
    await a.sail(1, { order: 0 });
    pass('a link dropped under way: the server stops her engine, she redials by herself, and takes the helm again of the same ship where it now is');

    // ---- Leaving and coming back ------------------------------------------------------
    await b.api.mine({ on: false });
    await until('B to stop', () => !b.state.mining);
    const held = { a: a.state.cargo, b: b.state.cargo, left: a.state.remaining };
    a.session.close();
    await until('B to be alone', () => b.state.others.length === 0);
    await wait(500);
    a = await pilot(CREDS.a);
    assert.equal(a.welcome.cargo, held.a);
    assert.equal(a.welcome.rock.remaining, held.left);
    pass('a pilot who signs out and in again has the cargo she left with');

    // ---- A server that is stopped and started -------------------------------------------
    await a.api.mine({ on: true });
    await wait(700);
    await a.api.mine({ on: false });
    await until('A to stop', () => !a.state.mining);
    await until('both ships to be at rest', async () => { const p = await books(); return p['pilot-a'].flight.speed < 0.5 && p['pilot-b'].flight.speed < 0.5; }, 40000);
    const before = { a: a.state.cargo, b: b.state.cargo, left: a.state.remaining, ships: await books() };
    assert.equal(before.a + before.b + before.left, TOTAL);
    await stopGently();
    const saved = JSON.parse(await readFile(data, 'utf8'));
    assert.equal(saved.rock.remaining, before.left);
    assert.equal(saved.pilots['pilot-a'].cargo, before.a);
    assert.equal(saved.pilots['pilot-b'].cargo, before.b);
    await start();
    assert.deepEqual(await health(), { ok: true, pilots: 0, remaining: before.left, held: before.a + before.b, total: TOTAL });
    const ships = await books();
    for (const id of ['pilot-a', 'pilot-b']) assert.ok(Math.hypot(ships[id].flight.pos.x - before.ships[id].flight.pos.x, ships[id].flight.pos.y - before.ships[id].flight.pos.y, ships[id].flight.pos.z - before.ships[id].flight.pos.z) < 0.5, `${id} is where she was`);
    await until('both to be back by themselves', () => a.session.state === 'ready' && b.session.state === 'ready', 15000);
    const back = { a: await a.api.enter({}), b: await b.api.enter({}) };
    a.seq = 0; b.seq = 0;
    assert.equal(back.a.cargo, before.a);
    assert.equal(back.b.cargo, before.b);
    assert.equal(back.a.rock.remaining, before.left);
    await wait(500);
    assert.equal(a.state.cargo, before.a, 'and nobody is mining because the server came back');
    pass('a server stopped and started has the rock, both holds and both ships as they were, and its pilots reconnect by themselves');

    // ---- A server that is killed --------------------------------------------------------
    await a.api.mine({ on: true });
    await b.api.mine({ on: true });
    await wait(2600);
    const atKill = { a: a.state.cargo, b: b.state.cargo };
    await kill();
    await start();
    const after = await health();
    assert.equal(after.remaining + after.held, TOTAL, 'what it had written adds up');
    assert.ok(after.held <= atKill.a + atKill.b + SECTOR.rate && after.held >= atKill.a + atKill.b - 2 * SECTOR.rate * 1.3, `held ${after.held} against ${atKill.a + atKill.b} when killed`);
    pass('a server killed in the middle of mining comes back with at most its last second missing, and still ten tonnes in all');

    // ---- To the last gram ---------------------------------------------------------------
    await until('both to be back', () => a.session.state === 'ready' && b.session.state === 'ready', 15000);
    await a.api.enter({});
    await b.api.enter({});
    await a.api.mine({ on: true });
    await b.api.mine({ on: true });
    await until('the rock to run out', () => a.state.remaining === 0 && b.state.remaining === 0, 90000);
    await wait(500);
    assert.equal(a.state.cargo + b.state.cargo, TOTAL);
    assert.equal(a.state.mining || b.state.mining, false);
    assert.equal(a.state.why, 4);
    const last = { a: a.state.cargo, b: b.state.cargo };
    await a.api.mine({ on: false });
    await a.api.mine({ on: true });
    await wait(600);
    assert.deepEqual({ a: a.state.cargo, b: b.state.cargo }, last);
    assert.deepEqual(await health(), { ok: true, pilots: 2, remaining: 0, held: TOTAL, total: TOTAL });
    pass(`mined out, the two holds are ${(last.a / GRAMS).toFixed(2)} t and ${(last.b / GRAMS).toFixed(2)} t: ten tonnes, and an empty rock gives no more`);

    assert.ok(sums.seen > 200);
    assert.equal(sums.worst, 0);
    pass(`every one of the ${sums.seen} states sent while both pilots were in added up to exactly ten tonnes`);
    a.session.close();
    b.session.close();

    // ---- A save that is lost ------------------------------------------------------------
    await stopGently();
    await rename(data, `${data}.gone`);
    for (const extra of [[], ['--new']]) {
        const child = launch(extra);
        assert.equal(await child.gone, 3, child.said);
        assert.match(child.said, /sector\.json\.bak is there: a sector lived here/);
    }
    assert.equal(existsSync(data), false);
    await rename(`${data}.gone`, data);
    await start();
    assert.deepEqual(await health(), { ok: true, pilots: 0, remaining: 0, held: TOTAL, total: TOTAL });
    pass('with its save gone the server will not start, with --new or without, and makes no new world; put back, the save is carried on');
} finally {
    if (server) await stopGently().catch(() => undefined);
}
console.log(JSON.stringify({ ok: true, wire: WIRE, checks: checks.length }));
process.exit(0);

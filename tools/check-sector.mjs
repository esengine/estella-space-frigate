import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
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
        export { FLIGHT_TICK, TURN_RATE, PITCH_RATE, turnBack } from '../src/shared/steer.ts';
        export { TOP_SPEED, FIELD_DRIFT } from '../src/shipState.ts';
        export { ClientSession, NetRequestError } from 'esengine/session';
        export { GameSocket } from '../../../sdk/src/net/GameSocket.ts';
    ` },
    outfile: checkOut, bundle: true, format: 'esm', platform: 'node', target: 'node20', alias, logLevel: 'warning',
});
const { contract, SECTOR, GRAMS, FLIGHT_TICK, TURN_RATE, PITCH_RATE, turnBack, TOP_SPEED, FIELD_DRIFT, ClientSession, GameSocket } = await import(pathToFileURL(checkOut).href);

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
function launch(extra = [], env = {}) {
    const child = fork(serverFile, ['--port', String(port), '--data', data, '--wire', 'pb', ...extra], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, SECTOR_CRASH: '', ...env } });
    child.said = '';
    child.stdout.on('data', (chunk) => { child.said += String(chunk); });
    child.stderr.on('data', (chunk) => { child.said += String(chunk); });
    child.gone = new Promise((resolve) => child.once('exit', resolve));
    return child;
}
async function start(extra = [], env = {}) {
    const child = launch(extra, env);
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
const sumNow = async () => { const h = await health(); return h.remaining + h.held + h.stored; };

try {
    // ---- A sector is founded on purpose -----------------------------------------
    const lost = launch();
    assert.equal(await lost.gone, 3, lost.said);
    assert.match(lost.said, /no save at .*sector\.json\. To found a new sector there, start once with --new/);
    assert.equal(existsSync(data), false);
    pass('with no save and no --new the server does not start, and creates nothing');
    await start(['--new']);
    assert.equal(existsSync(data), true, 'the new sector is written at once');
    assert.deepEqual(await health(), { ok: true, pilots: 0, remaining: TOTAL, held: 0, stored: 0, total: TOTAL });
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
    assert.deepEqual(await health(), { ok: true, pilots: 0, remaining: before.left, held: before.a + before.b, stored: 0, total: TOTAL });
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
    assert.deepEqual(await health(), { ok: true, pilots: 2, remaining: 0, held: TOTAL, stored: 0, total: TOTAL });
    pass(`mined out, the two holds are ${(last.a / GRAMS).toFixed(2)} t and ${(last.b / GRAMS).toFixed(2)} t: ten tonnes, and an empty rock gives no more`);

    assert.ok(sums.seen > 200);
    assert.equal(sums.worst, 0);
    pass(`every one of the ${sums.seen} states sent while both pilots were in added up to exactly ten tonnes`);

    // ==== The station: carry it, dock, and put it in a warehouse of one's own ================================
    const NONE = 1, TOO_FAR = 2, TOO_FAST = 3, NOT_DOCKED = 2, BAD_AMOUNT = 3, NOT_IN_HOLD = 4, NOT_IN_WAREHOUSE = 5;
    const ledger = [];
    /** A line in the books: where every gram is, by the server's own account, and that they are ten tonnes. */
    const note = async (event) => {
        const h = await health(), sum = h.remaining + h.held + h.stored;
        ledger.push({ at: new Date().toISOString(), event, remainingT: h.remaining / GRAMS, holdsT: h.held / GRAMS, warehousesT: h.stored / GRAMS, sumT: sum / GRAMS });
        assert.equal(sum, TOTAL, `after "${event}" the books hold ${sum} g`);
        return h;
    };
    let ops = 0;
    const op = (who) => `check-${who}-${Date.now().toString(36)}-${++ops}`;
    const mine = async (id) => (await books())[id];
    const ready = async (...who) => { await until('them to be back', () => who.every((p) => p.session.state === 'ready'), 20000); for (const p of who) { await p.api.enter({}); p.seq = 0; } await wait(300); };
    const restart = async (how, env = {}) => { if (how === 'kill') await kill(); else if (server) await stopGently(); await start([], env); };
    await note('mined out, nothing stored');

    // From where she mined: no docking, and no warehouse, whatever is sent.
    const farOff = (await mine('pilot-a')).station;
    assert.ok(farOff > SECTOR.station.dockRange + 500, `A is ${farOff} from the station`);
    assert.deepEqual(await a.api.dock({ dock: true }), { docked: false, why: TOO_FAR });
    for (const forged of [{ dock: true, docked: true, distance: 0, speed: 0, station: 'kestrel-station', p: { x: 0, y: 0, z: -1700 } }]) await a.session.request('dock', forged, { retries: 0, timeoutMs: 1500 }).catch(() => undefined);
    assert.equal((await mine('pilot-a')).docked, false);
    const remote = await a.api.transfer({ op: op('a'), withdraw: false, grams: 1 * GRAMS });
    assert.equal(remote.ok, false);
    assert.equal(remote.why, NOT_DOCKED);
    assert.equal((await a.api.transfer({ op: op('a'), withdraw: true, grams: 1 })).why, NOT_DOCKED);
    await a.session.request('transfer', { op: op('a'), withdraw: false, grams: 1 * GRAMS, docked: true, account: 'pilot-a', at: 'kestrel-station' }, { retries: 0, timeoutMs: 1500 }).catch(() => undefined);
    await note('A asks to dock and to store from where she mined: refused');
    assert.equal((await mine('pilot-a')).stored, 0);
    pass('from where she mined a ship cannot dock or reach her warehouse: asking, and saying she is docked, do nothing');

    // The run: steered there by her orders alone. A comes in at full speed and is refused until she has slowed.
    const haul = async (me, id, comeInFast) => {
        const station = SECTOR.station.at, began = Date.now();
        let refusedFast = 0, lastDock = 0;
        for (let sent = 0; Date.now() - began < 180000;) {
            const now = await mine(id), f = now.flight;
            const ahead = turnBack(f.level, { x: station[0] - f.pos.x, y: station[1] - f.pos.y, z: station[2] - f.pos.z });
            const inside = now.station <= SECTOR.station.dockRange - 30;
            if (inside && Date.now() - lastDock > 400) {
                lastDock = Date.now();
                const got = await me.api.dock({ dock: true });
                if (got.docked) return { seconds: (Date.now() - began) / 1000, refusedFast, from: null };
                if (got.why === TOO_FAST) refusedFast++;
            }
            const order = inside ? 0 : now.station > 900 || comeInFast ? 1 : 0.25;
            const rudder = -Math.max(-TURN_RATE, Math.min(TURN_RATE, Math.atan2(ahead.x, ahead.z) * 1.4)) / TURN_RATE;
            const elevation = Math.max(-PITCH_RATE, Math.min(PITCH_RATE, Math.atan2(ahead.y, Math.hypot(ahead.x, ahead.z) || 1e-6) * 1.4)) / PITCH_RATE;
            const due = Math.max(1, Math.floor((Date.now() - began) / TICK_MS) - sent);
            sent += due;
            me.api.steer({ orders: Array.from({ length: Math.min(due, 30) }, () => ({ seq: ++me.seq, order, rudder, elevation, roll: 0 })) }, { retries: 0 }).catch(() => undefined);
            await wait(60);
        }
        throw new Error(`${id} did not reach the station`);
    };
    const [runA, runB] = await Promise.all([haul(a, 'pilot-a', true), haul(b, 'pilot-b', false)]);
    assert.ok(runA.refusedFast > 0, 'A, coming in at speed, was refused for it at least once');
    assert.ok(runA.seconds > 15 && runB.seconds > 15, `the runs took ${runA.seconds.toFixed(0)} s and ${runB.seconds.toFixed(0)} s`);
    const berthA = await mine('pilot-a'), berthB = await mine('pilot-b');
    assert.ok(berthA.docked && berthB.docked && berthA.station <= SECTOR.station.dockRange && berthA.flight.speed === 0);
    await note('both ships docked at the station');
    pass(`both carried their ore to the station by their own helms (${runA.seconds.toFixed(0)} s and ${runB.seconds.toFixed(0)} s); the one that came in fast was refused ${runA.refusedFast} time(s) until she had slowed`);

    // Docked, her helm does nothing.
    await a.sail(1.5, { order: 1, rudder: 1 });
    const heldFast = await mine('pilot-a');
    assert.deepEqual(heldFast.flight.pos, berthA.flight.pos);
    assert.equal(heldFast.flight.speed, 0);
    pass('a docked ship is held: full ahead and hard over move her nowhere');

    // Into the warehouse, and back.
    const had = { a: berthA.cargo, b: berthB.cargo };
    assert.ok(had.a >= 1 * GRAMS && had.b >= 1 * GRAMS, `each brought at least a tonne: ${had.a} g and ${had.b} g`);
    const firstOp = op('a');
    const put = await a.api.transfer({ op: firstOp, withdraw: false, grams: 1_500_000 });
    assert.deepEqual(put, { op: firstOp, ok: true, why: NONE, withdraw: false, grams: 1_500_000, cargo: had.a - 1_500_000, stored: 1_500_000, repeat: false });
    await note('A stores 1.50 t');
    await until('A to see it', () => a.state.stored === 1_500_000 && a.state.cargo === had.a - 1_500_000 && a.state.docked);
    const allB = await b.api.transfer({ op: op('b'), withdraw: false, grams: had.b });
    assert.equal(allB.ok && allB.cargo === 0 && allB.stored === had.b, true);
    await note('B stores all she carried');
    pass(`each put ore in her own warehouse: A 1.50 t of ${(had.a / GRAMS).toFixed(2)} t, B all ${(had.b / GRAMS).toFixed(2)} t`);

    // Once: the same order again, one after another and all at once, and under the session's own retry key.
    for (let n = 0; n < 15; n++) assert.deepEqual(await a.api.transfer({ op: firstOp, withdraw: false, grams: 1_500_000 }), { ...put, repeat: true });
    const burst = await Promise.all(Array.from({ length: 15 }, () => a.api.transfer({ op: firstOp, withdraw: false, grams: 1_500_000 })));
    assert.ok(burst.every((r) => r.ok && r.repeat && r.stored === 1_500_000));
    assert.equal((await a.api.transfer({ op: firstOp, withdraw: true, grams: 7 })).withdraw, false, 'the same name with other words is the order that was answered');
    const sameKey = await Promise.all(Array.from({ length: 6 }, () => a.api.transfer({ op: 'check-one-key-one-order', withdraw: false, grams: 100_000 }, { idempotencyKey: 'one-click' })));
    // The session layer answers a request sent again under one key with the reply it already gave, so the order ran once and all six read alike.
    assert.ok(sameKey.every((r) => r.ok && r.stored === 1_600_000), JSON.stringify(sameKey));
    assert.equal((await mine('pilot-a')).stored, 1_600_000);
    await note('A repeats one order 36 times and clicks another six times: each done once');
    // Ten different orders at once for more than is there: the warehouse cannot be overdrawn.
    const grab = await Promise.all(Array.from({ length: 10 }, () => a.api.transfer({ op: op('a'), withdraw: true, grams: 1_000_000 })));
    assert.equal(grab.filter((r) => r.ok).length, 1);
    assert.ok(grab.filter((r) => !r.ok).every((r) => r.why === NOT_IN_WAREHOUSE));
    assert.equal((await mine('pilot-a')).stored, 600_000);
    await note('A asks ten times at once for a tonne of the 1.60 t stored: one is given');
    pass('an order is done once however often it is asked, and ten at once cannot take what is not there');

    // Amounts that are not ore she has.
    const beforeBad = await mine('pilot-a');
    for (const grams of [0, -1, -5 * GRAMS, 2 ** 40]) {
        for (const withdraw of [false, true]) { const r = await a.api.transfer({ op: op('a'), withdraw, grams }); assert.equal(r.ok, false); assert.equal(r.why, BAD_AMOUNT, `grams ${grams}`); }
    }
    for (const grams of [0.5, 1.5 * GRAMS + 0.25, 'all', null]) {
        const r = await a.session.request('transfer', { op: op('a'), withdraw: false, grams }, { retries: 0, timeoutMs: 1500 }).then((v) => v, () => ({ ok: false }));
        assert.equal(r.ok, false, `grams ${grams}`);
    }
    assert.equal((await a.api.transfer({ op: op('a'), withdraw: false, grams: beforeBad.cargo + 1 })).why, NOT_IN_HOLD);
    assert.equal((await a.api.transfer({ op: op('a'), withdraw: true, grams: beforeBad.stored + 1 })).why, NOT_IN_WAREHOUSE);
    const afterBad = await mine('pilot-a');
    assert.deepEqual([afterBad.cargo, afterBad.stored], [beforeBad.cargo, beforeBad.stored]);
    await note('A sends nothing, less than nothing, part of a gram and more than she has: all refused');
    pass('nothing, less than nothing, a part of a gram, and more than is in the hold or the warehouse are each refused');

    // Hers alone.
    const theirs = await mine('pilot-b');
    assert.equal(theirs.stored, had.b);
    const reachFor = await a.api.transfer({ op: op('a'), withdraw: true, grams: 2_000_000 });
    assert.equal(reachFor.ok, false, 'A has 0.60 t; the two tonnes she asks for are B\'s');
    await a.session.request('transfer', { op: op('a'), withdraw: true, grams: 1_000_000, account: 'pilot-b', from: 'pilot-b', pilot: 'pilot-b', playerId: 'pilot-b' }, { retries: 0, timeoutMs: 1500 }).catch(() => undefined);
    assert.equal((await mine('pilot-b')).stored, had.b);
    assert.equal((await mine('pilot-a')).stored <= 600_000, true);
    await note('A asks for more than her own warehouse holds, naming B: B\'s is untouched');
    pass('a pilot\'s orders reach her own warehouse and no other: naming the other pilot in one changes nothing');

    // A success is on the disk: said, then killed at once.
    const kept = op('a');
    const said = await a.api.transfer({ op: kept, withdraw: false, grams: 250_000 });
    assert.equal(said.ok, true);
    const atSuccess = await mine('pilot-a');
    await restart('kill');
    const afterKill = await mine('pilot-a');
    assert.deepEqual([afterKill.cargo, afterKill.stored, afterKill.docked], [said.cargo, said.stored, true]);
    assert.deepEqual(afterKill.flight.pos, atSuccess.flight.pos);
    await note('A stores 0.25 t, is told so, and the server is killed at once: it is there when the server comes back');
    await ready(a, b);
    assert.deepEqual(await a.api.transfer({ op: kept, withdraw: false, grams: 250_000 }), { ...said, repeat: true });
    pass('a move the pilot was told had succeeded is still there after the server is killed the instant it said so');

    // Stopped dead in the middle of a move, at each place it could be.
    const crashes = [];
    for (const point of ['before-write', 'mid-write', 'after-write']) {
        await restart('gently', { SECTOR_CRASH: point });
        await ready(a, b);
        const was = await mine('pilot-a'), name = op('a');
        const child = server;
        const answer = await a.api.transfer({ op: name, withdraw: true, grams: 100_000 }, { retries: 0, timeoutMs: 3000 }).then(() => 'answered', () => 'no answer');
        assert.equal(await child.gone, 86, child.said);
        server = null;
        assert.equal(answer, 'no answer', 'the pilot was told nothing');
        await start();
        const now = await mine('pilot-a');
        const landed = now.stored === was.stored - 100_000 && now.cargo === was.cargo + 100_000, untouched = now.stored === was.stored && now.cargo === was.cargo;
        assert.ok(landed || untouched, `stopped at ${point}: ${JSON.stringify({ was: [was.cargo, was.stored], now: [now.cargo, now.stored] })}`);
        assert.equal(landed, point === 'after-write', `stopped at ${point}`);
        await note(`the server is stopped dead ${point.replace('-', ' ')} of a 0.10 t move: ${landed ? 'the whole move is there' : 'none of it is'}`);
        await ready(a, b);
        // She asks again, as a client does that had no answer. It is done now if it was not, and not again if it was.
        const retry = await a.api.transfer({ op: name, withdraw: true, grams: 100_000 });
        assert.deepEqual([retry.ok, retry.repeat, retry.stored, retry.cargo], [true, landed, was.stored - 100_000, was.cargo + 100_000]);
        assert.equal((await a.api.transfer({ op: name, withdraw: true, grams: 100_000 })).repeat, true);
        const end = await mine('pilot-a');
        assert.deepEqual([end.cargo, end.stored], [was.cargo + 100_000, was.stored - 100_000]);
        await note(`she asks again under the same name: ${landed ? 'answered, not done again' : 'done, once'}`);
        crashes.push({ stoppedAt: point, onDiskAfter: landed ? 'the whole move' : 'none of it', retry: landed ? 'answered as done, moved nothing' : 'done once' });
    }
    pass('stopped dead before, during and after writing a move, the server comes back with all of it or none, never a hold debited and a warehouse not credited; asked again, the order is done exactly once');

    // Signing in again: the same ship in the same place, the same hold, the same warehouse.
    const leaving = await mine('pilot-a');
    a.session.close();
    await wait(400);
    a = await pilot(CREDS.a);
    assert.deepEqual([a.welcome.cargo, a.welcome.stored, a.welcome.docked], [leaving.cargo, leaving.stored, true]);
    assert.deepEqual(a.welcome.flight.p, leaving.flight.pos);
    assert.equal(a.welcome.station.name, SECTOR.station.name);
    await until('her state', () => a.state?.stored === leaving.stored && a.state.docked);
    pass('signed in again she has the same ship at the same berth, the same hold and the same warehouse');

    // Cast off, the warehouse is out of reach again, and she can sail.
    assert.deepEqual(await a.api.dock({ dock: false }), { docked: false, why: NONE });
    assert.equal((await a.api.transfer({ op: op('a'), withdraw: true, grams: 1 })).why, NOT_DOCKED);
    await a.sail(3, { order: 1 });
    assert.ok((await mine('pilot-a')).flight.speed > 100);
    await a.sail(1, { order: 0 });
    const closing = await note('A casts off and sails; her warehouse is out of reach again');
    pass('cast off, she sails again and her warehouse is closed to her until she docks');

    await mkdir(path.join(engine, 'output/space-frigate/sector'), { recursive: true });
    await writeFile(path.join(engine, 'output/space-frigate/sector', `ledger-${WIRE}.json`), JSON.stringify({ wire: WIRE, totalT: TOTAL / GRAMS, lines: ledger, crashes }, null, 1));
    pass(`${ledger.length} lines in the books, from mined out to cast off: every one ten tonnes (output/space-frigate/sector/ledger-${WIRE}.json)`);
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
    assert.deepEqual(await health(), { ok: true, pilots: 0, remaining: 0, held: closing.held, stored: closing.stored, total: TOTAL });
    pass('with its save gone the server will not start, with --new or without, and makes no new world; put back, the save is carried on');
} finally {
    if (server) await stopGently().catch(() => undefined);
}
console.log(JSON.stringify({ ok: true, wire: WIRE, checks: checks.length }));
process.exit(0);

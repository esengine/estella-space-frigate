import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
    const me = { session, sockets, api: contract.client(session), state: null, states: 0, closed: '', seq: 0, holds: new Set(), track: null };
    contract.on(session, 'state', (state) => {
        me.state = state;
        me.states++;
        me.holds.add(state.hold);
        // While a check is following the ships: where the server put her that step, and where she was told the other was.
        if (me.track) me.track.set(state.tick, { own: at(state.flight.p), other: state.others[0] ? at(state.others[0].p) : null, mooring: state.mooring, otherMooring: state.others[0]?.mooring ?? 0 });
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
    assert.deepEqual(await health(), { ok: true, pilots: 0, remaining: TOTAL, held: 0, stored: 0, total: TOTAL, saving: 'ok' });
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
    const usurped = a;
    const second = await pilot(CREDS.a);
    await until('the first seat to be taken', () => usurped.closed !== '');
    assert.match(usurped.closed, /replaced/);
    const helmBefore = (await books())['pilot-a'];
    await assert.rejects(usurped.api.steer({ orders: [{ seq: 1, order: 1, rudder: 1, elevation: 0, roll: 0 }] }, { retries: 0, timeoutMs: 1000 }));
    await assert.rejects(usurped.api.mine({ on: true }, { retries: 0, timeoutMs: 1000 }));
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
    assert.deepEqual(await health(), { ok: true, pilots: 0, remaining: before.left, held: before.a + before.b, stored: 0, total: TOTAL, saving: 'ok' });
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
    assert.deepEqual(await health(), { ok: true, pilots: 2, remaining: 0, held: TOTAL, stored: 0, total: TOTAL, saving: 'ok' });
    pass(`mined out, the two holds are ${(last.a / GRAMS).toFixed(2)} t and ${(last.b / GRAMS).toFixed(2)} t: ten tonnes, and an empty rock gives no more`);

    assert.ok(sums.seen > 200);
    assert.equal(sums.worst, 0);
    pass(`every one of the ${sums.seen} states sent while both pilots were in added up to exactly ten tonnes`);

    // ==== The station: carry it, dock, and put it in a warehouse of one's own ================================
    const NONE = 1, TOO_FAR = 2, TOO_FAST = 3, MANEUVERING = 6, DOCK_NOT_SAVED = 7, NOT_DOCKED = 2, BAD_AMOUNT = 3, NOT_IN_HOLD = 4, NOT_IN_WAREHOUSE = 5, EXPIRED = 8, OUT_OF_ORDER = 9, NOT_SAVED = 10;
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
    /** An order as the game gives it: under the pilot's next number, which the server says, and a name of its own. */
    const move = async (me, id, withdraw, grams, o = {}) => me.api.transfer({ seq: o.seq ?? (await mine(id)).nextMove, op: o.op ?? op(id.slice(-1)), withdraw, grams }, o.options);
    const like = (got, want, what = '') => { for (const [key, value] of Object.entries(want)) assert.deepEqual(got[key], value, `${what} ${key}: ${JSON.stringify(got)}`); };
    const ready = async (...who) => { await until('them to be back', () => who.every((p) => p.session.state === 'ready'), 20000); for (const p of who) { await p.api.enter({}); p.seq = 0; } await wait(300); };
    const restart = async (how, env = {}) => { if (how === 'kill') await kill(); else if (server) await stopGently(); await start([], env); };
    await note('mined out, nothing stored');

    // ==== Berths ==============================================================================================
    const M = { NONE: 1, ASSIGNED: 2, DOCKING: 3, DOCKED: 4, UNDOCKING: 5 };
    const BERTHS = SECTOR.station.berths, REACH = SECTOR.station.approachRange;
    const berthFor = (n) => BERTHS.find((berth) => berth.id === n);
    const berthsNow = async () => (await books()).berths.map((berth) => `${berth.id}:${berth.pilot || '-'}:${berth.mooring}`).join(' ');
    const off = (pos, to) => Math.hypot(pos.x - to[0], pos.y - to[1], pos.z - to[2]);
    const occupancy = [];
    const occupied = async (event) => { const line = await berthsNow(); occupancy.push({ at: new Date().toISOString(), event, berths: line }); return line; };
    assert.equal(await occupied('nobody has asked'), '1:-:none 2:-:none');

    // From where she mined: no warehouse, whatever is sent; and a berth asked for is only kept, not reached.
    const farOff = (await mine('pilot-a')).station;
    assert.ok(farOff > 1500, `A is ${farOff} from the station`);
    like(await move(a, 'pilot-a', false, 1 * GRAMS), { ok: false, why: NOT_DOCKED });
    const forged = await a.session.request('dock', { dock: true, docked: true, berth: 2, mooring: M.DOCKED, distance: 0, speed: 0, station: 'kestrel-station', p: { x: -74, y: 0, z: -1656 } }, { retries: 0, timeoutMs: 1500 }).catch(() => null);
    // What she added is not in the contract: one wire refuses the whole request, the other reads only what it knows. Neither puts her in a berth.
    if (forged) like(forged, { docked: false, why: NONE, berth: 1, mooring: M.ASSIGNED }, 'she said she was docked in berth 2');
    else assert.equal((await mine('pilot-a')).mooring, 'none');
    like(await a.api.dock({ dock: true }), { docked: false, why: NONE, berth: 1, mooring: M.ASSIGNED });
    like(await mine('pilot-a'), { docked: false, berth: 1, mooring: 'assigned', hold: 'TOO FAR' });
    like(await move(a, 'pilot-a', false, 1 * GRAMS), { ok: false, why: NOT_DOCKED });
    like(await move(a, 'pilot-a', true, 1), { ok: false, why: NOT_DOCKED });
    await a.session.request('transfer', { seq: (await mine('pilot-a')).nextMove, op: op('a'), withdraw: false, grams: 1 * GRAMS, docked: true, mooring: M.DOCKED, account: 'pilot-a', at: 'kestrel-station' }, { retries: 0, timeoutMs: 1500 }).catch(() => undefined);
    await note('A, where she mined, says she is docked and tries to store: refused');
    assert.equal((await mine('pilot-a')).stored, 0);
    like(await a.api.dock({ dock: false }), { docked: false, why: NONE, berth: 0, mooring: M.NONE });
    assert.equal(await occupied('A gave up the berth kept for her'), '1:-:none 2:-:none');
    pass('saying she is docked in a berth of her choosing gets a ship a berth kept for her and nothing more: no place in it, and no warehouse');

    // Both ask in the same instant, many times over: one berth each, never the same, never two.
    for (let round = 0; round < 5; round++) {
        const asked = await Promise.all([...Array.from({ length: 8 }, () => a.api.dock({ dock: true })), ...Array.from({ length: 8 }, () => b.api.dock({ dock: true }))]);
        const mineA = new Set(asked.slice(0, 8).map((r) => r.berth)), mineB = new Set(asked.slice(8).map((r) => r.berth));
        assert.ok(mineA.size === 1 && mineB.size === 1 && !mineA.has(0) && !mineB.has(0), `round ${round}: ${JSON.stringify(asked.map((r) => r.berth))}`);
        assert.notEqual([...mineA][0], [...mineB][0], `round ${round}: both were given berth ${[...mineA][0]}`);
        const now = (await books()).berths;
        assert.deepEqual(now.map((berth) => berth.pilot).sort(), ['pilot-a', 'pilot-b']);
        if (round < 4) await Promise.all([a.api.dock({ dock: false }), b.api.dock({ dock: false })]);
    }
    const lies = { a: (await mine('pilot-a')).berth, b: (await mine('pilot-b')).berth };
    // With the other's free again, asking and asking does not get her a second.
    await b.api.dock({ dock: false });
    for (let n = 0; n < 6; n++) like(await a.api.dock({ dock: true }), { berth: lies.a, mooring: M.ASSIGNED });
    assert.equal(await berthsNow(), lies.a === 1 ? '1:pilot-a:assigned 2:-:none' : '1:-:none 2:pilot-a:assigned');
    like(await b.api.dock({ dock: true }), { berth: lies.b, mooring: M.ASSIGNED });
    await occupied('both asked at once, five times over');
    pass(`asking in the same instant, eighty requests in all, two pilots are never given the same berth and neither is given two (A has ${lies.a}, B has ${lies.b})`);

    // The run: each steered to her own approach point by her orders alone. A comes in at full speed and is not taken until she has slowed.
    const haul = async (me, id, comeInFast) => {
        const lie = berthFor((await mine(id)).berth), began = Date.now();
        let passed = !comeInFast;
        for (let sent = 0; Date.now() - began < 240000;) {
            const now = await mine(id), f = now.flight;
            if (now.mooring !== 'assigned') return { seconds: (Date.now() - began) / 1000, taken: { pos: f.pos, from: off(f.pos, lie.approach) } };
            const ahead = turnBack(f.level, { x: lie.approach[0] - f.pos.x, y: lie.approach[1] - f.pos.y, z: lie.approach[2] - f.pos.z });
            const far = off(f.pos, lie.approach), askew = Math.atan2(Math.hypot(ahead.x, ahead.y), ahead.z);
            if (far <= REACH) passed = true;
            // She stops her engine where her way will carry her in, as a pilot told "slow, then stop at the approach" does.
            const order = !passed ? 1 : askew > 0.3 ? 0 : far - 15 <= f.speed * FIELD_DRIFT * 1.7 ? 0 : far > 700 ? 1 : 0.25;
            const rudder = -Math.max(-TURN_RATE, Math.min(TURN_RATE, Math.atan2(ahead.x, ahead.z) * 1.4)) / TURN_RATE;
            const elevation = Math.max(-PITCH_RATE, Math.min(PITCH_RATE, Math.atan2(ahead.y, Math.hypot(ahead.x, ahead.z) || 1e-6) * 1.4)) / PITCH_RATE;
            const due = Math.max(1, Math.floor((Date.now() - began) / TICK_MS) - sent);
            sent += due;
            me.api.steer({ orders: Array.from({ length: Math.min(due, 30) }, () => ({ seq: ++me.seq, order, rudder, elevation, roll: 0 })) }, { retries: 0 }).catch(() => undefined);
            await wait(60);
        }
        throw new Error(`${id} did not reach her approach point`);
    };
    a.holds.clear(); b.holds.clear();
    a.track = new Map(); b.track = new Map();
    const [runA, runB] = await Promise.all([haul(a, 'pilot-a', true), haul(b, 'pilot-b', false)]);
    assert.ok(a.holds.has(TOO_FAST), `A, passing her approach point at speed, was told TOO FAST: ${[...a.holds]}`);
    assert.ok(runA.seconds > 15 && runB.seconds > 15, `the runs took ${runA.seconds.toFixed(0)} s and ${runB.seconds.toFixed(0)} s`);
    assert.ok(runA.taken.from <= REACH + 20 && runB.taken.from <= REACH + 20, `taken in hand ${runA.taken.from.toFixed(0)} and ${runB.taken.from.toFixed(0)} from their approach points`);
    await occupied('both taken in hand at their approach points');
    pass(`each carried her ore to her own approach point by her own helm (${runA.seconds.toFixed(0)} s and ${runB.seconds.toFixed(0)} s) and the station took her in hand there; the one that came through at speed was told TOO FAST and not taken until she had slowed`);

    // In hand: nothing she sends moves her or stops it, and her warehouse is not open yet.
    const coming = await mine('pilot-b');
    if (coming.mooring === 'docking') {
        like(await b.api.dock({ dock: false }), { docked: false, why: MANEUVERING, berth: lies.b, mooring: M.DOCKING });
        like(await move(b, 'pilot-b', false, 1 * GRAMS), { ok: false, why: NOT_DOCKED }, 'on her way in');
    }
    await Promise.all([a.sail(4, { order: 1, rudder: 1, elevation: 1 }), b.sail(4, { order: 1, rudder: -1, elevation: -1 })]);
    await until('both to lie in their berths', async () => { const now = await books(); return now['pilot-a'].mooring === 'docked' && now['pilot-b'].mooring === 'docked'; }, 90000);
    await wait(300);
    const berthA = await mine('pilot-a'), berthB = await mine('pilot-b');
    assert.deepEqual(at(berthA.flight.pos), [...berthFor(lies.a).at]);
    assert.deepEqual(at(berthB.flight.pos), [...berthFor(lies.b).at]);
    assert.ok(berthA.docked && berthB.docked && berthA.flight.speed === 0 && berthB.flight.speed === 0);
    // What each was sent while they came in: the way is the station's, and both ends were told the same.
    const ways = { a: a.track, b: b.track };
    a.track = null; b.track = null;
    let steps = 0, nearest = Infinity, compared = 0, inHandSteps = 0;
    for (const [who, way, lie] of [['A', ways.a, berthFor(lies.a)], ['B', ways.b, berthFor(lies.b)]]) {
        for (const one of way.values()) {
            if (one.mooring !== M.DOCKING) continue;
            steps++;
            const p = one.own, over = Math.hypot(p[0] - lie.at[0], p[2] - lie.at[2]), fromApproach = Math.hypot(p[0] - lie.approach[0], p[1] - lie.approach[1], p[2] - lie.approach[2]);
            // Below the height she crosses at, she is either still coming to her approach point, out beside the wing, or straight above her berth.
            assert.ok(p[1] >= lie.over[1] - 0.01 || fromApproach <= REACH + 0.01 || over <= 0.01, `${who} was at ${p} on her way in`);
            assert.ok(p[1] >= lie.at[1] - 0.01, `${who} went below her berth: ${p}`);
        }
    }
    for (const [tick, hers] of ways.a) {
        const theirs = ways.b.get(tick);
        if (!theirs || !hers.other || !theirs.other) continue;
        compared++;
        assert.deepEqual(hers.other, theirs.own, `step ${tick}: A was told B was at ${hers.other}, B that she was at ${theirs.own}`);
        assert.deepEqual(theirs.other, hers.own, `step ${tick}`);
        assert.equal(hers.otherMooring, theirs.mooring);
        // Under their own helms nothing keeps two ships apart; from the moment the station has either, it does.
        if (hers.mooring !== M.DOCKING && hers.mooring !== M.DOCKED && theirs.mooring !== M.DOCKING && theirs.mooring !== M.DOCKED) continue;
        inHandSteps++;
        nearest = Math.min(nearest, Math.hypot(hers.own[0] - theirs.own[0], hers.own[1] - theirs.own[1], hers.own[2] - theirs.own[2]));
    }
    assert.ok(steps > 200 && compared > 400, `${steps} steps in hand, ${compared} compared`);
    assert.ok(nearest >= 147, `the two ships came within ${nearest.toFixed(1)} of one another`);
    await note('both ships lie in their berths');
    assert.equal(await occupied('both docked'), `${lies.a === 1 ? '1:pilot-a:docked 2:pilot-b:docked' : '1:pilot-b:docked 2:pilot-a:docked'}`);
    pass(`the station brought both in at once, each to the exact place of her own berth: over ${steps} steps in hand neither left the way in, from the step the first was taken they were never nearer than ${nearest.toFixed(0)} apart (a hull is 48 across, ${inHandSteps} steps), and in all ${compared} steps compared each was told the other was exactly where the other was told she was`);

    // Docked, her helm does nothing.
    await a.sail(1.5, { order: 1, rudder: 1 });
    const heldFast = await mine('pilot-a');
    assert.deepEqual(heldFast.flight.pos, berthA.flight.pos);
    assert.equal(heldFast.flight.speed, 0);
    pass('in hand and in her berth a ship is the station\'s: full ahead and hard over move her nowhere, casting off on the way in is refused, and the warehouse stays shut until she lies in her berth');

    // Into the warehouse, and back.
    const had = { a: berthA.cargo, b: berthB.cargo };
    assert.ok(had.a >= 1 * GRAMS && had.b >= 1 * GRAMS, `each brought at least a tonne: ${had.a} g and ${had.b} g`);
    const first = { seq: berthA.nextMove, op: op('a') };
    const put = await move(a, 'pilot-a', false, 1_500_000, first);
    like(put, { seq: first.seq, op: first.op, ok: true, why: NONE, withdraw: false, grams: 1_500_000, cargo: had.a - 1_500_000, stored: 1_500_000, repeat: false, next: first.seq + 1 });
    await note('A stores 1.50 t');
    await until('A to see it', () => a.state.stored === 1_500_000 && a.state.cargo === had.a - 1_500_000 && a.state.docked && a.state.nextMove === first.seq + 1);
    like(await move(b, 'pilot-b', false, had.b), { ok: true, cargo: 0, stored: had.b });
    await note('B stores all she carried');
    pass(`each put ore in her own warehouse: A 1.50 t of ${(had.a / GRAMS).toFixed(2)} t, B all ${(had.b / GRAMS).toFixed(2)} t`);

    // Once: the same order again, one after another and all at once, and under the session's own retry key.
    for (let n = 0; n < 15; n++) like(await move(a, 'pilot-a', false, 1_500_000, first), { ok: true, repeat: true, stored: 1_500_000, cargo: had.a - 1_500_000 });
    const burst = await Promise.all(Array.from({ length: 15 }, () => move(a, 'pilot-a', false, 1_500_000, first)));
    assert.ok(burst.every((r) => r.ok && r.repeat && r.stored === 1_500_000));
    like(await move(a, 'pilot-a', true, 7, first), { withdraw: false, grams: 1_500_000, repeat: true }, 'the same number and name with other words is the order that was answered');
    const one = { seq: (await mine('pilot-a')).nextMove, op: 'check-one-key-one-order' };
    const sameKey = await Promise.all(Array.from({ length: 6 }, () => move(a, 'pilot-a', false, 100_000, { ...one, options: { idempotencyKey: 'one-click' } })));
    assert.ok(sameKey.every((r) => r.ok && r.stored === 1_600_000), JSON.stringify(sameKey));
    assert.equal((await mine('pilot-a')).stored, 1_600_000);
    await note('A repeats one order 36 times and clicks another six times: each done once');
    // Ten different orders at once, each for a tonne of the 1.60 t there: they all carry the pilot's next number, and one has it.
    const number = (await mine('pilot-a')).nextMove;
    const grab = await Promise.all(Array.from({ length: 10 }, () => move(a, 'pilot-a', true, 1_000_000, { seq: number })));
    assert.equal(grab.filter((r) => r.ok).length, 1, JSON.stringify(grab.map((r) => [r.ok, r.why])));
    assert.ok(grab.filter((r) => !r.ok).every((r) => r.why === EXPIRED));
    like(await move(a, 'pilot-a', true, 1_000_000), { ok: false, why: NOT_IN_WAREHOUSE }, 'and a second tonne, asked for properly, is not there');
    like(await move(a, 'pilot-a', true, 1, { seq: (await mine('pilot-a')).nextMove + 5 }), { ok: false, why: OUT_OF_ORDER }, 'a number ahead of the next');
    assert.equal((await mine('pilot-a')).stored, 600_000);
    await note('A asks ten times at once for a tonne of the 1.60 t stored: one is given');
    pass('an order is done once however often it is asked, and ten at once cannot take what is not there');

    // Amounts that are not ore she has.
    const beforeBad = await mine('pilot-a');
    for (const grams of [0, -1, -5 * GRAMS, 2 ** 40]) {
        for (const withdraw of [false, true]) like(await move(a, 'pilot-a', withdraw, grams), { ok: false, why: BAD_AMOUNT }, `grams ${grams}`);
    }
    for (const grams of [0.5, 1.5 * GRAMS + 0.25, 'all', null]) {
        const r = await a.session.request('transfer', { seq: (await mine('pilot-a')).nextMove, op: op('a'), withdraw: false, grams }, { retries: 0, timeoutMs: 1500 }).then((v) => v, () => ({ ok: false }));
        assert.equal(r.ok, false, `grams ${grams}`);
    }
    like(await move(a, 'pilot-a', false, beforeBad.cargo + 1), { ok: false, why: NOT_IN_HOLD });
    like(await move(a, 'pilot-a', true, beforeBad.stored + 1), { ok: false, why: NOT_IN_WAREHOUSE });
    const afterBad = await mine('pilot-a');
    assert.deepEqual([afterBad.cargo, afterBad.stored], [beforeBad.cargo, beforeBad.stored]);
    await note('A sends nothing, less than nothing, part of a gram and more than she has: all refused');
    pass('nothing, less than nothing, a part of a gram, and more than is in the hold or the warehouse are each refused');

    // Hers alone.
    assert.equal((await mine('pilot-b')).stored, had.b);
    like(await move(a, 'pilot-a', true, 2_000_000), { ok: false }, 'A has 0.60 t; the two tonnes she asks for are B\'s');
    await a.session.request('transfer', { seq: (await mine('pilot-a')).nextMove, op: op('a'), withdraw: true, grams: 1_000_000, account: 'pilot-b', from: 'pilot-b', pilot: 'pilot-b', playerId: 'pilot-b' }, { retries: 0, timeoutMs: 1500 }).catch(() => undefined);
    // A's number and name, sent by B, are B's own order and touch only B.
    const bBefore = await mine('pilot-b');
    like(await move(b, 'pilot-b', true, 100_000, first), { ok: false }, 'B sending A\'s first order');
    assert.equal((await mine('pilot-b')).stored, bBefore.stored);
    assert.equal((await mine('pilot-a')).stored, 600_000);
    await note('A asks for more than her own warehouse holds, naming B: B\'s is untouched');
    pass('a pilot\'s orders reach her own warehouse and no other: naming the other pilot in one changes nothing');

    // A success is on the disk: said, then killed at once.
    const kept = { seq: (await mine('pilot-a')).nextMove, op: op('a') };
    const said = await move(a, 'pilot-a', false, 250_000, kept);
    assert.equal(said.ok, true);
    const atSuccess = await mine('pilot-a');
    await restart('kill');
    const afterKill = await mine('pilot-a');
    assert.deepEqual([afterKill.cargo, afterKill.stored, afterKill.docked, afterKill.nextMove], [said.cargo, said.stored, true, kept.seq + 1]);
    assert.equal(await occupied('the server was killed and started again with nobody signed in'), `${lies.a === 1 ? '1:pilot-a:docked 2:pilot-b:docked' : '1:pilot-b:docked 2:pilot-a:docked'}`);
    assert.deepEqual(afterKill.flight.pos, atSuccess.flight.pos);
    await note('A stores 0.25 t, is told so, and the server is killed at once: it is there when the server comes back');
    await ready(a, b);
    like(await move(a, 'pilot-a', false, 250_000, kept), { ok: true, repeat: true, cargo: said.cargo, stored: said.stored });
    pass('a move the pilot was told had succeeded is still there after the server is killed the instant it said so');

    // Stopped dead in the middle of a move, at each place it could be.
    const crashes = [];
    for (const point of ['before-write', 'mid-write', 'after-write']) {
        await restart('gently', { SECTOR_CRASH: point });
        await ready(a, b);
        const was = await mine('pilot-a'), name = { seq: was.nextMove, op: op('a') };
        const child = server;
        const answer = await move(a, 'pilot-a', true, 100_000, { ...name, options: { retries: 0, timeoutMs: 3000 } }).then(() => 'answered', () => 'no answer');
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
        const retry = await move(a, 'pilot-a', true, 100_000, name);
        assert.deepEqual([retry.ok, retry.repeat, retry.stored, retry.cargo], [true, landed, was.stored - 100_000, was.cargo + 100_000]);
        like(await move(a, 'pilot-a', true, 100_000, name), { ok: true, repeat: true });
        const end = await mine('pilot-a');
        assert.deepEqual([end.cargo, end.stored], [was.cargo + 100_000, was.stored - 100_000]);
        await note(`she asks again under the same number and name: ${landed ? 'answered, not done again' : 'done, once'}`);
        crashes.push({ stoppedAt: point, onDiskAfter: landed ? 'the whole move' : 'none of it', retry: landed ? 'answered as done, moved nothing' : 'done once' });
    }
    pass('stopped dead before, during and after writing a move, the server comes back with all of it or none, never a hold debited and a warehouse not credited; asked again, the order is done exactly once');

    // ---- Found in review, 1: a disk that will not take the write --------------------------------------------------------
    // The save before the last is kept beside the save; with a directory standing where it goes, no write can finish.
    const onDisk = async () => { const saved = JSON.parse(await readFile(data, 'utf8')).pilots['pilot-a']; return [saved.cargo, saved.stored, saved.moves]; };
    await rm(`${data}.bak`, { force: true, recursive: true });
    await mkdir(`${data}.bak`);
    const stuck = await mine('pilot-a'), refusedOrder = { seq: stuck.nextMove, op: op('a') };
    const refusals = [];
    for (let n = 0; n < 4; n++) refusals.push(await move(a, 'pilot-a', false, 300_000, refusedOrder));
    // Every one of them is refused, the first and the repeats alike: before the fix the repeats were told it had been done.
    assert.ok(refusals.every((r) => r.ok === false && r.why === NOT_SAVED && r.repeat === false && r.cargo === stuck.cargo && r.stored === stuck.stored), JSON.stringify(refusals.map((r) => [r.ok, r.why, r.repeat, r.cargo, r.stored])));
    const during = await mine('pilot-a');
    assert.deepEqual([during.cargo, during.stored, during.nextMove], [stuck.cargo, stuck.stored, stuck.nextMove], 'the server holds no balance the disk does not');
    assert.deepEqual(await onDisk(), [stuck.cargo, stuck.stored, stuck.nextMove - 1]);
    await until('her own state to agree', () => a.state.cargo === stuck.cargo && a.state.stored === stuck.stored);
    // Its own periodic writes fail too while this lasts; it says so, and it does not fall over.
    // B casts off meanwhile, which the disk does not take either.
    like(await b.api.dock({ dock: false }), { docked: false, why: NONE, mooring: M.UNDOCKING });
    await wait(2500);
    assert.equal((await health()).saving, 'failing');
    assert.equal(await sumNow(), TOTAL);
    await note('the disk refuses writes: A\'s order to store 0.30 t is refused four times, nothing moves, the server stays up');
    // Killed in that state: what comes back is what was on the disk, which is what the pilot was told.
    await restart('kill');
    const afterStuck = await mine('pilot-a');
    assert.deepEqual([afterStuck.cargo, afterStuck.stored, afterStuck.nextMove], [stuck.cargo, stuck.stored, stuck.nextMove]);
    // And B's casting off, which no write recorded, has not happened: she lies in her berth.
    const backIn = await mine('pilot-b');
    assert.deepEqual([backIn.mooring, backIn.berth, at(backIn.flight.pos)], ['docked', lies.b, [...berthFor(lies.b).at]]);
    await occupied('killed while B was casting off and the disk refused writes: B is in her berth, as the disk has it');
    await ready(a, b);
    like(await move(a, 'pilot-a', false, 300_000, refusedOrder), { ok: false, why: NOT_SAVED }, 'still refused after the restart, with the disk still stuck');
    // The disk takes writes again. The same order, under the same number and name, is now done: once.
    await rm(`${data}.bak`, { recursive: true });
    const mended = await move(a, 'pilot-a', false, 300_000, refusedOrder);
    like(mended, { ok: true, repeat: false, cargo: stuck.cargo - 300_000, stored: stuck.stored + 300_000, next: refusedOrder.seq + 1 });
    for (let n = 0; n < 3; n++) like(await move(a, 'pilot-a', false, 300_000, refusedOrder), { ok: true, repeat: true, stored: stuck.stored + 300_000 });
    assert.deepEqual(await onDisk(), [stuck.cargo - 300_000, stuck.stored + 300_000, refusedOrder.seq]);
    await until('saving to be well again', async () => (await health()).saving === 'ok', 5000);
    // Told it was done, and killed that instant.
    await restart('kill');
    const afterMend = await mine('pilot-a');
    assert.deepEqual([afterMend.cargo, afterMend.stored, afterMend.nextMove], [stuck.cargo - 300_000, stuck.stored + 300_000, refusedOrder.seq + 1]);
    await note('the disk mends: the same order is done once, and is there after the server is killed the instant it said so');
    await ready(a, b);
    pass('a move the disk refused is refused however often it is asked, is in no balance, survives a kill as not done, and once the disk mends is done exactly once and survives a kill as done');

    // ---- Found in review, 2: an oldOrder order, sent again after many others ------------------------------------------------
    const oldOrder = { seq: (await mine('pilot-a')).nextMove, op: op('a') };
    like(await move(a, 'pilot-a', true, 200_000, oldOrder), { ok: true, repeat: false });
    const settled = await mine('pilot-a');
    // Sixty-four different orders that are each refused, as in the review: far more than the server remembers answers for.
    for (let n = 0; n < 64; n++) like(await move(a, 'pilot-a', n % 2 === 0, [0, -1, 9 * GRAMS, 2 ** 40][n % 4]), { ok: false });
    const pushed = await mine('pilot-a');
    assert.equal(pushed.nextMove, oldOrder.seq + 65);
    assert.deepEqual([pushed.cargo, pushed.stored], [settled.cargo, settled.stored]);
    const replay = async (when) => {
        const got = await move(a, 'pilot-a', true, 200_000, oldOrder);
        like(got, { ok: false, why: EXPIRED, cargo: settled.cargo, stored: settled.stored }, when);
        const now = await mine('pilot-a');
        assert.deepEqual([now.cargo, now.stored, now.nextMove], [settled.cargo, settled.stored, pushed.nextMove], when);
    };
    await replay('at once');
    await restart('gently');
    await ready(a, b);
    await replay('after a stop and start');
    a.sockets[a.sockets.length - 1].close();
    await until('her to redial', async () => a.session.state === 'ready' && (await mine('pilot-a')).here, 15000);
    await ready(a);
    await replay('after her link dropped');
    await restart('kill');
    await ready(a, b);
    await replay('after a kill');
    // Each of the sixty-four, and any number at or below the last, is the same.
    for (const seq of [oldOrder.seq, oldOrder.seq + 1, oldOrder.seq + 30, oldOrder.seq + 64]) like(await move(a, 'pilot-a', true, 200_000, { seq }), { ok: false, why: EXPIRED });
    const afterReplay = await mine('pilot-a');
    assert.deepEqual([afterReplay.cargo, afterReplay.stored], [settled.cargo, settled.stored]);
    // And a new order still goes through.
    like(await move(a, 'pilot-a', false, 50_000), { ok: true, repeat: false, stored: settled.stored + 50_000 });
    await note('A\'s order to take 0.20 t, sent again after 64 others, a stop and start, a dropped link and a kill: refused as expired each time');
    pass('an order is not done a second time after sixty-four others, a restart, a dropped link and a kill: it is refused as expired, and the balances stand');

    // Signing in again: the same ship in the same berth, the same hold, the same warehouse.
    const leaving = await mine('pilot-a');
    a.session.close();
    await wait(400);
    assert.equal(await occupied('A signed out, docked'), `${lies.a === 1 ? '1:pilot-a:docked 2:pilot-b:docked' : '1:pilot-b:docked 2:pilot-a:docked'}`);
    a = await pilot(CREDS.a);
    assert.deepEqual([a.welcome.cargo, a.welcome.stored, a.welcome.docked, a.welcome.nextMove, a.welcome.berth, a.welcome.mooring], [leaving.cargo, leaving.stored, true, leaving.nextMove, lies.a, M.DOCKED]);
    assert.deepEqual(a.welcome.flight.p, leaving.flight.pos);
    assert.deepEqual(at(a.welcome.flight.p), [...berthFor(lies.a).at]);
    assert.equal(a.welcome.station.name, SECTOR.station.name);
    assert.deepEqual(a.welcome.station.berths.map((berth) => [berth.id, at(berth.at), at(berth.approach)]), BERTHS.map((berth) => [berth.id, [...berth.at], [...berth.approach]]));
    await until('her state', () => a.state?.stored === leaving.stored && a.state.docked && a.state.berth === lies.a);
    pass('signed in again she has the same ship in the same berth, the same hold and the same warehouse');

    // The account signed in a second time while the first is still there: one ship, one berth, and the old seat can do nothing.
    const former = a;
    a = await pilot(CREDS.a);
    assert.deepEqual([a.welcome.berth, a.welcome.mooring, at(a.welcome.flight.p)], [lies.a, M.DOCKED, [...berthFor(lies.a).at]]);
    for (let n = 0; n < 4; n++) like(await a.api.dock({ dock: true }), { docked: true, berth: lies.a, mooring: M.DOCKED });
    await former.api.dock({ dock: false }, { retries: 0, timeoutMs: 1500 }).catch(() => undefined);
    await former.api.dock({ dock: true }, { retries: 0, timeoutMs: 1500 }).catch(() => undefined);
    await former.api.transfer({ seq: (await mine('pilot-a')).nextMove, op: op('a'), withdraw: true, grams: 1 }, { retries: 0, timeoutMs: 1500 }).catch(() => undefined);
    await wait(300);
    const seated = await mine('pilot-a');
    assert.deepEqual([seated.mooring, seated.berth, seated.cargo, seated.stored], ['docked', lies.a, leaving.cargo, leaving.stored]);
    assert.equal(await occupied('A signed in a second time over the first; the old seat tried to cast off'), `${lies.a === 1 ? '1:pilot-a:docked 2:pilot-b:docked' : '1:pilot-b:docked 2:pilot-a:docked'}`);
    former.session.close();
    await wait(300);
    assert.equal((await mine('pilot-a')).here, true, 'closing the old seat does not sign the new one out');
    pass('signed in a second time over the first, the account has the one ship in the one berth; the seat it took over can neither cast her off nor move her ore');

    // Cast off: the warehouse shuts at once, the station takes her out the way she came, and lets her go at rest outside.
    a.track = new Map();
    like(await a.api.dock({ dock: false }), { docked: false, why: NONE, berth: lies.a, mooring: M.UNDOCKING });
    like(await move(a, 'pilot-a', true, 1), { ok: false, why: NOT_DOCKED }, 'the instant she casts off');
    like(await move(a, 'pilot-a', false, 1), { ok: false, why: NOT_DOCKED }, 'the instant she casts off');
    like(await a.api.dock({ dock: false }), { why: MANEUVERING, mooring: M.UNDOCKING });
    assert.equal(await occupied('A casting off'), `${lies.a === 1 ? '1:pilot-a:undocking 2:pilot-b:docked' : '1:pilot-b:docked 2:pilot-a:undocking'}`);
    const leavingAt = Date.now();
    while ((await mine('pilot-a')).mooring === 'undocking') {
        if (Date.now() - leavingAt > 90000) throw new Error('A was never let go');
        await a.sail(1, { order: 1, rudder: 1, elevation: -1 });
        like(await move(a, 'pilot-a', true, 1), { ok: false, why: NOT_DOCKED }, 'on her way out');
    }
    const out = await mine('pilot-a'), lieA = berthFor(lies.a);
    const wayOut = [...a.track.values()].filter((one) => one.mooring === M.UNDOCKING);
    a.track = null;
    assert.ok(wayOut.length > 200, `${wayOut.length} steps on her way out`);
    for (const one of wayOut) {
        const p = one.own, over = Math.hypot(p[0] - lieA.at[0], p[2] - lieA.at[2]);
        assert.ok(over <= 0.01 || Math.abs(p[1] - lieA.over[1]) <= 0.01, `on her way out she was at ${p}`);
        assert.ok(Math.abs(p[2] - lieA.at[2]) <= 0.01, `she left the line out: ${p}`);
    }
    // Let go: at rest, at her approach point, which is clear of every part of the station; her berth is free; and she is hers again.
    assert.ok(off(out.flight.pos, lieA.approach) <= 12, `let go ${off(out.flight.pos, lieA.approach).toFixed(1)} from her approach point, at ${JSON.stringify(out.flight.pos)}`);
    assert.deepEqual([out.mooring, out.berth, out.docked], ['none', 0, false]);
    assert.equal(await occupied('A let go at her approach point'), lies.a === 1 ? '1:-:none 2:pilot-b:docked' : '1:pilot-b:docked 2:-:none');
    like(await move(a, 'pilot-a', true, 1), { ok: false, why: NOT_DOCKED });
    await a.sail(3, { order: 1 });
    assert.ok((await mine('pilot-a')).flight.speed > 100);
    await a.sail(1, { order: 0 });
    await note('A casts off and sails; her warehouse is out of reach again');
    pass(`cast off, her warehouse shut that instant and stayed shut; the station took her straight up and out along its own line over ${wayOut.length} steps, whatever her helm sent, and let her go at her approach point with her berth free and her helm her own`);

    // A berth only kept: hers while she is there or soon back, given up thirty seconds after she has gone.
    like(await a.api.dock({ dock: true }), { mooring: M.ASSIGNED });
    const keptBerth = (await mine('pilot-a')).berth;
    a.sockets[a.sockets.length - 1].close();
    await until('her to redial', async () => a.session.state === 'ready' && (await mine('pilot-a')).here, 15000);
    await ready(a);
    like(await mine('pilot-a'), { berth: keptBerth, mooring: 'assigned' });
    await occupied('A, with a berth kept, lost her link and came back');
    // Killed and started again, the berth is still kept for her.
    await restart('kill');
    like(await mine('pilot-a'), { berth: keptBerth, mooring: 'assigned', here: false });
    await ready(a, b);
    like(await mine('pilot-a'), { berth: keptBerth, mooring: 'assigned', here: true });
    await occupied('the server was killed and started again: the berth is still kept for A');
    a.session.close();
    const goneAt = Date.now();
    await wait(20000);
    like(await mine('pilot-a'), { berth: keptBerth, mooring: 'assigned', here: false });
    await occupied('A has been gone 20 s: still kept');
    // Found in review: stopped and started twenty seconds after she went, the berth is due when it was due, not thirty seconds from the start.
    const dueBefore = (await books()).berths.find((berth) => berth.id === keptBerth).lapses;
    assert.ok(Math.abs(dueBefore - (goneAt + SECTOR.station.reserveMs)) < 1500, `due at ${dueBefore}, she went at ${goneAt}`);
    await restart('kill');
    assert.equal((await books()).berths.find((berth) => berth.id === keptBerth).lapses, dueBefore, 'the time it is due is in the save');
    like(await mine('pilot-a'), { berth: keptBerth, mooring: 'assigned', here: false });
    await occupied(`killed and started ${((Date.now() - goneAt) / 1000).toFixed(0)} s after A went: still kept, due at the same time`);
    await restart('gently');
    assert.equal((await books()).berths.find((berth) => berth.id === keptBerth).lapses, dueBefore);
    assert.ok(Date.now() - goneAt < 28000, 'the two restarts were over before the berth was due');
    await until('the berth to be given up', async () => (await mine('pilot-a')).mooring === 'none', 20000);
    const freedAfter = (Date.now() - goneAt) / 1000;
    assert.ok(freedAfter >= 29 && freedAfter <= 32.5, `given up ${freedAfter.toFixed(1)} s after she went`);
    await until('B to be back', async () => b.session.state === 'ready' && (await mine('pilot-b')).here, 20000);
    assert.equal(await occupied(`A has been gone ${freedAfter.toFixed(0)} s: given up`), keptBerth === 1 ? '1:-:none 2:pilot-b:docked' : '1:pilot-b:docked 2:-:none');
    // B, docked and signed out for longer than that, keeps hers.
    b.session.close();
    await wait(32000);
    like(await mine('pilot-b'), { berth: lies.b, mooring: 'docked', here: false });
    await occupied('B, docked, has been signed out 32 s: still in her berth');
    a = await pilot(CREDS.a);
    b = await pilot(CREDS.b);
    assert.deepEqual([a.welcome.berth, a.welcome.mooring, b.welcome.berth, b.welcome.mooring], [0, M.NONE, lies.b, M.DOCKED]);
    const closing = await note('A is back with no berth; B is back in hers');
    pass(`a berth only kept survives a dropped link and a killed server, and is given up ${freedAfter.toFixed(1)} s after its pilot has gone though the server was killed and started and then stopped and started twenty seconds in; a docked ship keeps her berth however long her pilot is away`);

    // ---- Found in review: a ship reaches her berth while the disk refuses every write ------------------------------------------
    const lieNext = (await books()).berths.find((berth) => berth.pilot === '').id;
    const everDocked = () => a.states > 0 && a.state.docked;
    const bringIn = async () => {
        like(await a.api.dock({ dock: true }), { berth: lieNext, mooring: M.ASSIGNED });
        await haul(a, 'pilot-a', false);
        await until('A to lie in her berth', async () => { const now = await mine('pilot-a'); return now.arrived || now.mooring === 'docked'; }, 90000);
    };
    await rm(`${data}.bak`, { force: true, recursive: true });
    await mkdir(`${data}.bak`);
    let saidDocked = false;
    const watching = setInterval(() => { saidDocked ||= everDocked() || a.state?.mooring === M.DOCKED; }, 20);
    await bringIn();
    await wait(3000);
    const waitingIn = await mine('pilot-a');
    // She lies exactly in her berth, and the server does not say she is docked: nothing on the disk has her there.
    assert.deepEqual([at(waitingIn.flight.pos), waitingIn.mooring, waitingIn.docked, waitingIn.arrived, waitingIn.hold], [[...berthFor(lieNext).at], 'docking', false, true, 'NOT SAVED']);
    assert.deepEqual([a.state.mooring, a.state.docked, a.state.hold], [M.DOCKING, false, DOCK_NOT_SAVED]);
    assert.equal((await health()).saving, 'failing');
    like(await move(a, 'pilot-a', false, 1), { ok: false, why: NOT_DOCKED }, 'in her berth, not yet written down');
    like(await a.api.dock({ dock: true }), { docked: false, mooring: M.DOCKING });
    assert.equal(JSON.parse(await readFile(data, 'utf8')).pilots['pilot-a'].berth, 0, 'the disk has her with no berth');
    await occupied('A lies in her berth while the disk refuses writes: not called docked');
    assert.equal(saidDocked, false, 'she was never told she had docked');
    // Killed like that: she comes back with no berth, which is what she had been told.
    await restart('kill');
    like(await mine('pilot-a'), { berth: 0, mooring: 'none', docked: false });
    await occupied('killed while the disk refused writes: A has no berth, and was never told she had one to lie in');
    await ready(a, b);
    // Again, and this time the disk mends while she waits: the write that succeeds is what docks her.
    await bringIn();
    await wait(1500);
    like(await mine('pilot-a'), { mooring: 'docking', docked: false, arrived: true });
    assert.equal(saidDocked, false);
    await rm(`${data}.bak`, { recursive: true });
    const mendedAt = Date.now();
    await until('A to be told she is docked', () => a.state.docked && a.state.mooring === M.DOCKED, 5000);
    clearInterval(watching);
    const toldAfter = Date.now() - mendedAt;
    // Told, and killed that instant: the save that docked her brings her back docked.
    assert.deepEqual([JSON.parse(await readFile(data, 'utf8')).pilots['pilot-a'].berth], [lieNext], 'the disk had her in the berth before she was told');
    await restart('kill');
    const kept2 = await mine('pilot-a');
    assert.deepEqual([kept2.mooring, kept2.berth, kept2.docked, at(kept2.flight.pos)], ['docked', lieNext, true, [...berthFor(lieNext).at]]);
    await occupied('the disk mended, A was told she had docked, and the server was killed that instant: she is in her berth');
    await ready(a, b);
    like(await move(a, 'pilot-a', false, 1), { ok: true }, 'and her warehouse is open');
    like(await move(a, 'pilot-a', true, 1), { ok: true });
    await until('saving to be well again', async () => (await health()).saving === 'ok', 5000);
    await note('A reaches a berth while the disk refuses writes, and again as it mends');
    pass(`a ship that reaches her berth while the disk refuses writes lies there and is not called docked, with her warehouse shut; killed then, she comes back with no berth, as she had been told; when the disk mends she is told ${toldAfter} ms later, and killed that instant she comes back docked`);

    await mkdir(path.join(engine, 'output/space-frigate/sector'), { recursive: true });
    await writeFile(path.join(engine, 'output/space-frigate/sector', `ledger-${WIRE}.json`), JSON.stringify({ wire: WIRE, totalT: TOTAL / GRAMS, lines: ledger, crashes }, null, 1));
    await writeFile(path.join(engine, 'output/space-frigate/sector', `berths-${WIRE}.json`), JSON.stringify({ wire: WIRE, berths: BERTHS, lines: occupancy }, null, 1));
    pass(`${ledger.length} lines in the books, from mined out to cast off: every one ten tonnes (output/space-frigate/sector/ledger-${WIRE}.json)`);
    a.session.close();
    b.session.close();

    // ---- A save that is refusedOrder ------------------------------------------------------------
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
    like(await health(), { ok: true, pilots: 0, remaining: 0, held: closing.held, stored: closing.stored, total: TOTAL, saving: 'ok' });
    pass('with its save gone the server will not start, with --new or without, and makes no new world; put back, the save is carried on');
} finally {
    if (server) await stopGently().catch(() => undefined);
}
console.log(JSON.stringify({ ok: true, wire: WIRE, checks: checks.length }));
process.exit(0);

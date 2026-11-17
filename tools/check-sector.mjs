import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The sector server as its own process, with real sockets: two pilots, one rock of ten tonnes.
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
        export { ClientSession, NetRequestError } from 'esengine/session';
        export { GameSocket } from '../../../sdk/src/net/GameSocket.ts';
    ` },
    outfile: checkOut, bundle: true, format: 'esm', platform: 'node', target: 'node20', alias, logLevel: 'warning',
});
const { contract, SECTOR, GRAMS, ClientSession, GameSocket } = await import(pathToFileURL(checkOut).href);

const TOTAL = SECTOR.rock.total;
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

let server = null;
async function start() {
    const child = fork(serverFile, ['--port', String(port), '--data', data, '--wire', 'pb'], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
    child.gone = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => { if (/\[sector\] .* on ws:/.test(String(chunk))) resolve(); });
        child.once('exit', (code) => reject(new Error(`the server left with ${code} before listening`)));
    });
    server = child;
}
const stopGently = async () => { server.send('shutdown'); await server.gone; server = null; };
const kill = async () => { server.kill('SIGKILL'); await server.gone; server = null; };

const CREDS = { a: { account: 'pilot-a', token: 'test-token-a' }, b: { account: 'pilot-b', token: 'test-token-b' } };
const sums = { seen: 0, worst: 0 };
async function pilot(creds, fingerprint = contract.fingerprint) {
    const session = new ClientSession({
        connect: () => new GameSocket({ url }),
        wire: WIRE,
        credentials: () => ({ ...creds, contract: fingerprint }),
        backoff: { initialMs: 100, maxMs: 500 },
    });
    const me = { session, api: contract.client(session), state: null, states: 0, closed: '' };
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
    return me;
}
const at = (v) => [v.x, v.y, v.z];
const sumNow = async () => { const h = await health(); return h.remaining + h.held; };

try {
    await start();
    assert.deepEqual(await health(), { ok: true, pilots: 0, remaining: TOTAL, held: 0, total: TOTAL });
    pass('a new sector holds one rock of ten tonnes and no cargo');

    // ---- Who may come in ------------------------------------------------------
    await assert.rejects(pilot({ account: 'pilot-a', token: 'test-token-b' }), /UNKNOWN PILOT OR TOKEN/);
    await assert.rejects(pilot({ account: 'pilot-z', token: 'test-token-a' }), /UNKNOWN PILOT OR TOKEN/);
    await assert.rejects(pilot(CREDS.a, 'deadbeef'), /CLIENT AND SERVER DIFFER/);
    assert.equal((await health()).pilots, 0);
    pass('a wrong token, an unknown account and a client built against another contract are all turned away');

    // ---- Two pilots, one sector -----------------------------------------------
    let a = await pilot(CREDS.a), b = await pilot(CREDS.b);
    assert.equal(a.welcome.name, 'PILOT A');
    assert.equal(a.welcome.rock.total, TOTAL);
    assert.equal(a.welcome.rock.remaining, TOTAL);
    assert.equal(a.welcome.cargo, 0);
    assert.deepEqual(at(a.welcome.p), [...SECTOR.berths[0]]);
    assert.deepEqual(at(b.welcome.p), [...SECTOR.berths[1]]);
    await until('each to see the other', () => a.state?.others.length === 1 && b.state?.others.length === 1);
    assert.equal(a.state.others[0].account, 'pilot-b');
    assert.deepEqual(at(a.state.others[0].p), [...SECTOR.berths[1]]);
    pass('two pilots enter the same sector at their own berths and each sees the other');

    const from = at(b.state.others[0].p);
    for (let n = 1; n <= 12; n++) { await a.api.pose({ p: { x: from[0], y: from[1] + n * 4, z: from[2] + n * 4 }, q: { x: 0, y: 0.7071067811865476, z: 0, w: 0.7071067811865476 }, throttle: 0.5 }); await wait(100); }
    await until('B to see A where she went', () => Math.abs(b.state.others[0].p.y - (from[1] + 48)) < 0.01 && Math.abs(b.state.others[0].p.z - (from[2] + 48)) < 0.01);
    assert.ok(Math.abs(b.state.others[0].q.y - 0.7071067811865476) < 1e-9 && b.state.others[0].throttle === 0.5);
    pass('one pilot moving is seen moving, and turned, by the other');

    await a.api.pose({ p: { x: 9e9, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, throttle: 1 });
    await wait(150);
    assert.ok(Math.hypot(a.state.p.x - from[0], a.state.p.y - from[1] - 48, a.state.p.z - from[2] - 48) < 100, 'a claimed leap is walked at a frigate\'s pace');
    await assert.rejects(a.api.pose({ p: { x: Number.NaN, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, throttle: 1 }));
    pass('a pose that claims a leap across the sector is taken at a frigate\'s speed, and one that is not a number is refused');

    // ---- Mining ---------------------------------------------------------------
    await wait(300);
    assert.equal(a.state.cargo + b.state.cargo, 0, 'nobody is paid before asking');
    const began = Date.now();
    await a.api.mine({ on: true });
    await until('A to be mining', () => a.state.mining && a.state.cargo > 0);
    await until('B to see A mining', () => b.state.others[0].mining && b.state.others[0].cargo > 0);
    assert.equal(b.state.cargo, 0);
    pass('the pilot who asks is mined for; the other sees her beam and her hold, and gets nothing');

    // A client shouting: the same request many times, under one key and under many, and requests the server never offered.
    for (let n = 0; n < 30; n++) await a.session.request('mine', { on: true }, { idempotencyKey: 'again', codec: undefined }).catch(() => undefined);
    await Promise.all(Array.from({ length: 20 }, () => a.api.mine({ on: true }).catch(() => undefined)));
    for (const [type, payload] of [['grant', { cargo: 99 * GRAMS }], ['cargo', { set: 99 * GRAMS }], ['mine', { on: true, grams: 99 * GRAMS, cargo: 99 * GRAMS }], ['state', { cargo: 99 * GRAMS, remaining: 0 }]]) {
        await a.session.request(type, payload, { retries: 0, timeoutMs: 1000 }).catch(() => undefined);
        a.session.send(type, payload);
    }
    await wait(400);
    const paid = a.state.cargo, seconds = (Date.now() - began) / 1000;
    assert.ok(paid <= SECTOR.rate * seconds + 1, `paid ${paid} g in ${seconds.toFixed(2)} s at ${SECTOR.rate} g/s`);
    assert.ok(paid >= SECTOR.rate * (seconds - 1.5), 'and she was paid for the time she mined');
    assert.equal(await sumNow(), TOTAL);
    pass('asking again and again, replaying a request, and asking for cargo outright pay nothing beyond the clock');

    await b.api.mine({ on: true });
    await until('both to be mining', () => a.state.mining && b.state.mining);
    await wait(1500);
    assert.ok(a.state.cargo > paid && b.state.cargo > 0);
    pass('two pilots mine the one rock at once');

    // ---- The same pilot twice -------------------------------------------------
    const second = await pilot(CREDS.a);
    await until('the first seat to be taken', () => a.closed !== '');
    assert.match(a.closed, /replaced/);
    assert.equal(second.welcome.cargo > 0, true);
    await wait(600);
    assert.equal(second.state.mining, false, 'a new seat is not mining until it asks');
    const steady = second.state.cargo;
    await wait(600);
    assert.equal(second.state.cargo, steady);
    assert.equal(b.state.others.length, 1, 'and the sector holds her once');
    assert.equal(await sumNow(), TOTAL);
    a = second;
    pass('signing in a second time takes the seat from the first: one pilot, one hold, no second beam');

    // ---- Leaving and coming back ----------------------------------------------
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

    // ---- A server that is stopped and started ----------------------------------
    await a.api.mine({ on: true });
    await wait(700);
    await a.api.mine({ on: false });
    await until('A to stop', () => !a.state.mining);
    const before = { a: a.state.cargo, b: b.state.cargo, left: a.state.remaining };
    assert.equal(before.a + before.b + before.left, TOTAL);
    await stopGently();
    const saved = JSON.parse(await readFile(data, 'utf8'));
    assert.equal(saved.rock.remaining, before.left);
    assert.equal(saved.pilots['pilot-a'].cargo, before.a);
    assert.equal(saved.pilots['pilot-b'].cargo, before.b);
    await start();
    assert.deepEqual(await health(), { ok: true, pilots: 0, remaining: before.left, held: before.a + before.b, total: TOTAL });
    await until('both to be back by themselves', () => a.session.state === 'ready' && b.session.state === 'ready', 15000);
    const back = { a: await a.api.enter({}), b: await b.api.enter({}) };
    assert.equal(back.a.cargo, before.a);
    assert.equal(back.b.cargo, before.b);
    assert.equal(back.a.rock.remaining, before.left);
    await wait(500);
    assert.equal(a.state.cargo, before.a, 'and nobody is mining because the server came back');
    pass('a server stopped and started has the rock and both holds as they were, and its pilots reconnect by themselves');

    // ---- A server that is killed -----------------------------------------------
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

    // ---- To the last gram -------------------------------------------------------
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
} finally {
    if (server) await stopGently().catch(() => undefined);
}
console.log(JSON.stringify({ ok: true, wire: WIRE, checks: checks.length }));
process.exit(0);

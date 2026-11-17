import { chromium } from 'playwright';
import { fork, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

// Two real game clients in one sector: the web export twice, against the sector server as its own process.
const root = path.resolve('output/space-frigate');
const game = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'online');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const TOTAL = 10_000_000;
await mkdir(out, { recursive: true });
const built = spawnSync(process.execPath, [path.join(game, 'server/run.mjs'), '--build-only'], { encoding: 'utf8' });
if (built.status !== 0) throw new Error(built.stderr || built.stdout);
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const port = await freePort();
const data = path.join(await mkdtemp(path.join(tmpdir(), 'sector-online-')), 'sector.json');
let sectorServer = null;
async function startSector() {
    const child = fork(path.join(game, '.esengine/cache/sector-server.mjs'), ['--port', String(port), '--data', data], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
    child.gone = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => { if (/\[sector\] .* on ws:/.test(String(chunk))) resolve(); });
        child.once('exit', (code) => reject(new Error(`the sector server left with ${code}`)));
    });
    sectorServer = child;
}
const stopSector = async () => { sectorServer.send('shutdown'); await sectorServer.gone; sectorServer = null; };
const health = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();

const web = await serveHost(path.join(root, 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const problems = [];
const findings = [];
const expect = (what, ok, detail) => { findings.push({ what, ok, detail }); if (!ok) problems.push(`${what}: ${JSON.stringify(detail)}`); console.log(`${ok ? 'ok  ' : 'BAD '} ${what}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function client(name, account, token) {
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`${name}: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) problems.push(`${name}: ${m.text().slice(0, 300)}`); });
    const address = `http://127.0.0.1:${web.address().port}/?headless&server=${encodeURIComponent(`ws://127.0.0.1:${port}/sector`)}&account=${account}&token=${token}`;
    const open = async () => {
        await page.goto(address, { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000 });
        await page.waitForFunction(() => window.__spaceHud?.ready || window.__spaceHud?.error, null, { timeout: 120000 });
        await page.evaluate(() => window.__estellaCooked.setPaused(true));
    };
    await open();
    const step = (n) => page.evaluate((frames) => window.__estellaCooked.step(frames), n);
    const tap = async (key) => { await page.keyboard.down(key); await step(1); await page.keyboard.up(key); await step(1); };
    const seen = () => page.evaluate(() => {
        const h = window.__spaceHud, o = h.online;
        return {
            link: o.link, why: o.why, name: o.name, pos: o.pos, cargo: o.cargo, remaining: o.rock.remaining, total: o.rock.total, mining: o.mining, refusal: o.refusal,
            others: o.others.map((p) => ({ account: p.account, p: p.p, mining: p.mining, cargo: p.cargo })), pilots: h.pilots.map((p) => ({ ...p })),
            hold: h.mining.hold, firing: h.mining.firing, armed: h.mining.armed, selected: h.selected, locked: h.locked, text: h.contract.text, cue: h.contract.cue, system: h.ship.system, jumps: h.ship.jumps,
        };
    });
    // The game is stepped by hand, so real time (the server's clock, the socket) and game frames are walked together.
    // The game is stepped by hand, so it is stepped by the wall clock: a frame for each sixtieth of a second that passed, as it would run by itself.
    let stepped = Date.now();
    const pace = async () => { const now = Date.now(), frames = Math.max(1, Math.round((now - stepped) * 0.06)); stepped = now; await step(Math.min(frames, 30)); };
    const until = async (what, test, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { await pace(); if (test(await seen())) return true; await wait(20); } problems.push(`${name}: timed out waiting for ${what}: ${JSON.stringify(await seen())}`); return false; };
    const shoot = async (shot) => { await step(2); await page.screenshot({ path: path.join(out, `${shot}.png`), timeout: 60000 }); };
    return { page, open, step, tap, seen, pace, until, shoot };
}
const both = async (a, b, ms) => { for (const end = Date.now() + ms; Date.now() < end;) { await a.pace(); await b.pace(); await wait(20); } };
const sum = (a, b) => a.cargo + b.cargo + a.remaining;

try {
    await startSector();
    const a = await client('A', 'pilot-a', 'test-token-a');
    const b = await client('B', 'pilot-b', 'test-token-b');
    await a.until('A to be in the sector', (s) => s.link === 'online' && s.others.length === 1);
    await b.until('B to be in the sector', (s) => s.link === 'online' && s.others.length === 1);
    let sa = await a.seen(), sb = await b.seen();
    expect('two clients are in the same sector, each under her own account', sa.name === 'PILOT A' && sb.name === 'PILOT B' && sa.total === TOTAL && sa.remaining === TOTAL && sb.remaining === TOTAL, { sa, sb });
    expect('each draws the other\'s ship where the server has her', sa.pilots.length === 1 && sb.pilots.length === 1 && Math.abs(Math.hypot(sa.pilots[0].x, sa.pilots[0].y, sa.pilots[0].z) - 320) < 40 && sa.pilots[0].x > 250 && sb.pilots[0].x < -250, { a: sa.pilots, b: sb.pilots });
    await a.shoot('1-two-in-the-sector');

    // B sails; A, who does nothing, must see her go.
    const before = (await a.seen()).pilots[0];
    for (let n = 0; n < 4; n++) await b.tap('KeyW');
    await both(a, b, 6000);
    sa = await a.seen(); sb = await b.seen();
    const went = Math.hypot(sa.pilots[0].x - before.x, sa.pilots[0].y - before.y, sa.pilots[0].z - before.z);
    const apartNow = [sb.pos[0] - sa.pos[0], sb.pos[1] - sa.pos[1], sb.pos[2] - sa.pos[2]], off = Math.hypot(sa.pilots[0].x - apartNow[0], sa.pilots[0].y - apartNow[1], sa.pilots[0].z - apartNow[2]);
    expect('when one sails faster than the other, each ship is drawn where the two really stand to one another', went > 20 && sb.pos[2] > 100 && off < 45, { went, off, apartNow, seenByA: sa.pilots[0] });
    for (let n = 0; n < 5; n++) await b.tap('KeyS');

    // Both lock the shared rock and mine it.
    for (const c of [a, b]) { await c.tap('KeyT'); }
    await both(a, b, 1800);
    for (const c of [a, b]) { await c.tap('KeyF'); }
    await a.until('A to be mining', (s) => s.mining && s.cargo > 0);
    await b.until('B to be mining', (s) => s.mining && s.cargo > 0);
    let worst = 0, samples = 0, sawB = false, sawA = false, beams = 0;
    for (const end = Date.now() + 9000; Date.now() < end;) {
        await a.pace(); await b.pace();
        const la = await a.seen(), lb = await b.seen();
        sawB ||= la.others[0]?.mining === true; sawA ||= lb.others[0]?.mining === true;
        if (la.mining && lb.mining && la.firing && lb.firing) beams++;
        const h = await health();
        worst = Math.max(worst, Math.abs(h.remaining + h.held - TOTAL));
        samples++;
        await wait(30);
    }
    sa = await a.seen(); sb = await b.seen();
    expect('both mine the shared rock at once, and each sees the other mining', sa.cargo > 500000 && sb.cargo > 500000 && sawA && sawB && beams > 10, { a: sa.cargo, b: sb.cargo, sawA, sawB, beams });
    expect(`through ${samples} looks at the server's books while they mined, holds plus rock were ten tonnes every time`, worst === 0 && samples > 50, { worst, samples });
    expect('the hold each client shows is the server\'s figure for her', Math.abs(sa.hold * 1e6 - sa.cargo) < 50001 && Math.abs(sb.hold * 1e6 - sb.cargo) < 50001, { a: [sa.hold, sa.cargo], b: [sb.hold, sb.cargo] });
    await a.shoot('2-both-mining');
    await b.shoot('2-both-mining-b');

    // A edits what her own client shows and believes.
    const honest = (await health()).held;
    await a.page.evaluate(() => { const h = window.__spaceHud; h.mining.hold = 9999; h.online.cargo = 99_000_000; h.online.rock.remaining = 99_000_000; h.contract.delivered = 9999; h.tuning.capacity = 9999; });
    await both(a, b, 1500);
    sa = await a.seen(); sb = await b.seen();
    const now = await health();
    expect('editing the client\'s own numbers changes nothing: the next state puts them back and the server\'s books never moved', sa.cargo < TOTAL && sa.hold < 10.01 && sb.others[0].cargo === sa.cargo || Math.abs(sb.others[0].cargo - sa.cargo) < 400000, { shown: sa.hold, cargo: sa.cargo, seenByB: sb.others[0].cargo });
    expect('and the books still hold ten tonnes', now.remaining + now.held === TOTAL && now.held >= honest && now.held < honest + 1_200_000, { honest, now });

    // A reloads the page: a new connection, the same pilot.
    for (const c of [a, b]) await c.tap('KeyF');
    await both(a, b, 800);
    const kept = (await a.seen()).cargo;
    await a.open();
    await a.until('A to be back', (s) => s.link === 'online' && s.others.length === 1);
    sa = await a.seen();
    expect('a pilot who reloads the game is the same pilot with the same cargo, and is not mining until she asks', sa.cargo === kept && !sa.mining && sa.name === 'PILOT A', { kept, sa });

    // The server is stopped and started under both of them.
    const books = await health();
    await stopSector();
    await both(a, b, 1200);
    const lost = await a.seen();
    await startSector();
    const again = await health();
    await a.until('A to reconnect by herself', (s) => s.link === 'online' && s.others.length === 1, 30000);
    await b.until('B to reconnect by herself', (s) => s.link === 'online' && s.others.length === 1, 30000);
    sa = await a.seen(); sb = await b.seen();
    expect('while the server is down a client says so', lost.link === 'lost' && /LINK LOST/.test(lost.text), lost);
    expect('a server stopped and started has the same rock and the same holds, and both clients come back to them', again.remaining === books.remaining && again.held === books.held && sa.cargo === kept && sa.remaining === books.remaining && sum(sa, { cargo: sb.cargo }) === TOTAL, { books, again, a: sa.cargo, b: sb.cargo });
    await a.shoot('3-after-restart');

    // Mine it out.
    for (const c of [a, b]) { await c.tap('KeyT'); }
    await both(a, b, 1800);
    for (const c of [a, b]) { if (!(await c.seen()).armed) await c.tap('KeyF'); }
    for (const end = Date.now() + 120000; Date.now() < end && (await health()).remaining > 0;) {
        for (const c of [a, b]) { await c.pace(); const s = await c.seen(); if (s.selected !== 0) await c.tap('KeyT'); else if (s.locked && !s.armed) await c.tap('KeyF'); }
        await wait(40);
    }
    await both(a, b, 1000);
    sa = await a.seen(); sb = await b.seen();
    const end = await health();
    expect('mined out, the two holds are the whole ten tonnes and the rock is empty', end.remaining === 0 && end.held === TOTAL && sa.cargo + sb.cargo === TOTAL && sa.remaining === 0, { end, a: sa.cargo, b: sb.cargo });
    expect('and the client says the rock is mined out and mines no more', /MINED OUT/.test(sa.text) && !sa.firing && !sb.firing, { a: sa.text, b: sb.text });
    expect('a fixed sector: nobody jumped out of it', sa.system === 0 && sb.system === 0 && sa.jumps === 0, { a: sa.system, b: sb.system });
    await a.shoot('4-mined-out');
} catch (err) {
    problems.push(String(err?.stack ?? err));
} finally {
    await browser.close();
    web.close();
    if (sectorServer) await stopSector().catch(() => undefined);
}
console.log(JSON.stringify({ findings: findings.map((f) => ({ what: f.what, ok: f.ok })), problems: [...new Set(problems)] }, null, 1));
process.exit(problems.length > 0 ? 1 : 0);

import { chromium } from 'playwright';
import { fork, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

// The harbour's camera, watched in the real game: two clients, one to each berth, from asking for a berth to sailing away from
// it, at two window sizes, each window filmed. What is checked is read from the game as a pilot would see it: which shot is up,
// where the ship's box falls on the screen, where the warehouse panel is, and what the server says of her.
const root = path.resolve('output/space-frigate');
const game = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'director');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const SIZES = (process.env.DIRECTOR_SIZES ?? '1280x720,1920x1080').split(',').map((size) => size.split('x').map(Number));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const built = spawnSync(process.execPath, [path.join(game, 'server/run.mjs'), '--build-only'], { encoding: 'utf8' });
if (built.status !== 0) throw new Error(built.stderr || built.stdout);
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const findings = [];
const measured = {};
const expect = (what, ok, detail) => { findings.push({ what, ok }); if (!ok) problems.push(`${what}: ${JSON.stringify(detail)}`); console.log(`${ok ? 'ok  ' : 'BAD '} ${what}`); };
const web = await serveHost(path.join(root, process.env.SPACE_WEB ?? 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });

const IN = ['takeover', 'settle', 'berthed'], OUT = ['lift', 'clear', 'handover'];
const WIDTHS = { takeover: [0.24, 0.37], settle: [0.44, 0.56], berthed: [0.35, 0.47], lift: [0.29, 0.43], clear: [0.23, 0.37], handover: [0.25, 0.39] };

for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const port = await freePort();
    const data = path.join(await mkdtemp(path.join(tmpdir(), 'sector-director-')), 'sector.json');
    let server = null;
    const start = async (extra = []) => {
        const child = fork(path.join(game, '.esengine/cache/sector-server.mjs'), ['--port', String(port), '--data', data, ...extra], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
        child.gone = new Promise((resolve) => child.once('exit', resolve));
        await new Promise((resolve, reject) => { child.stdout.on('data', (chunk) => { if (/\[sector\] .* on ws:/.test(String(chunk))) resolve(); }); child.once('exit', (code) => reject(new Error(`the sector server left with ${code}`))); });
        server = child;
    };
    const books = async () => (await fetch(`http://127.0.0.1:${port}/pilots`)).json();
    const health = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, recordVideo: { dir: path.join(out, 'video'), size: { width, height } } });
    const films = {};

    async function client(name, account, token) {
        const page = await context.newPage();
        page.on('pageerror', (e) => problems.push(`${tag} ${name}: ${e}`));
        page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|net::/.test(m.text())) problems.push(`${tag} ${name}: ${m.text().slice(0, 300)}`); });
        const address = `http://127.0.0.1:${web.address().port}/?headless&server=${encodeURIComponent(`ws://127.0.0.1:${port}/sector`)}&account=${account}&token=${token}`;
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
        const pace = async () => { const now = Date.now(), frames = Math.max(1, Math.round((now - stepped) * 0.06)); stepped = now; await step(Math.min(frames, 30)); };
        const tap = async (key) => { await page.keyboard.down(key); await step(1); await page.keyboard.up(key); await step(1); };
        const seen = () => page.evaluate(() => {
            const h = window.__spaceHud, o = h.online, d = h.director, f = window.__estellaCooked.facts();
            return {
                link: o.link, mooring: o.mooring, berth: o.berth, hold: o.hold, pos: o.pos, welcomes: o.welcomes, text: h.contract.text, cue: h.contract.cue, order: h.helm.order, speed: h.ship.speed, mode: h.helm.mode,
                director: { on: d.on, shot: d.shot, presence: d.presence, dismissed: d.dismissed, fellBack: d.fellBack, fallbacks: d.fallbacks, confirmed: d.confirmed, sinceDocked: d.sinceDocked, shown: [...d.shown], frame: { ...d.frame }, fov: d.fov },
                fov: f.fov, cues: f.soundCues, lastCue: f.soundLastCue, spots: { ...h.stationSpots }, dock: { ...o.dock }, numbered: o.numbered,
            };
        });
        const until = async (what, test, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end;) { await pace(); if (test(await seen())) return true; await wait(20); } problems.push(`${tag} ${name}: timed out waiting for ${what}: ${JSON.stringify(await seen()).slice(0, 700)}`); return false; };
        const shoot = async (shot) => { await step(2); await page.screenshot({ path: path.join(out, `${tag}-${shot}.png`), timeout: 60000 }); stepped = Date.now(); };
        const engine = async (to) => { for (let n = 0; n < 6 && Math.abs((await seen()).order - to) > 0.01; n++) await tap((await seen()).order < to ? 'KeyW' : 'KeyS'); };
        return { name, page, open, step, pace, tap, seen, until, shoot, engine };
    }
    const both = async (a, b, ms, each) => { for (const end = Date.now() + ms; Date.now() < end;) { await a.pace(); await b.pace(); if (each) await each(); await wait(8); } };

    try {
        await start(['--new']);
        const a = await client('A', 'pilot-a', 'test-token-a'), b = await client('B', 'pilot-b', 'test-token-b');
        films[`berth1-${tag}`] = a.page.video(); films[`berth2-${tag}`] = b.page.video();
        await a.until('A to be in', (s) => s.link === 'online');
        await b.until('B to be in', (s) => s.link === 'online');
        for (const one of [a, b]) await one.engine(0);
        await both(a, b, 1500);
        // Each asks for a berth with the key, A first so that she has berth 1, and follows the glass to her approach point.
        await a.tap('KeyH');
        await a.until('A to be kept a berth', (s) => s.mooring === 'assigned' && s.berth === 1);
        await b.tap('KeyH');
        await b.until('B to be kept a berth', (s) => s.mooring === 'assigned' && s.berth === 2);
        const beforeIn = [await a.seen(), await b.seen()];
        expect(`${tag}: with a berth only kept, the view is still the pilot's own`, beforeIn.every((s) => !s.director.on && s.director.shown.length === 0), beforeIn.map((s) => s.director));

        // What is seen of each ship while the station has her: every shot, how long it stood, and how she sat in it once it had settled.
        const track = () => ({ shots: [], since: 0, sat: {}, cut: 0, looks: 0, fellBack: 0, away: [], early: 0, fovs: {} });
        const seenOf = { A: track(), B: track() };
        const note = (who, s, ships, id) => {
            const t = seenOf[who], d = s.director;
            if (!d.on) return;
            t.looks++;
            if (t.shots[t.shots.length - 1] !== d.shot) { t.shots.push(d.shot); t.since = Date.now(); }
            if (d.fellBack) t.fellBack++;
            // Where the director has the camera from is where the server has her: the picture is of the real ship.
            t.away.push(Math.hypot(s.pos[0] - ships[id].flight.pos.x, s.pos[1] - ships[id].flight.pos.y, s.pos[2] - ships[id].flight.pos.z));
            if (s.mooring !== 'docked' && s.spots.store) t.early++;
            if (Date.now() - t.since < 1600) return;
            if (!d.frame.whole) t.cut++;
            const sat = (t.sat[d.shot] ??= { least: 1, most: 0, left: 1, right: 0, top: 1, bottom: 0, n: 0 });
            sat.least = Math.min(sat.least, d.frame.width); sat.most = Math.max(sat.most, d.frame.width); sat.left = Math.min(sat.left, d.frame.left); sat.right = Math.max(sat.right, d.frame.right);
            sat.top = Math.min(sat.top, d.frame.top); sat.bottom = Math.max(sat.bottom, d.frame.bottom); sat.n++;
            t.fovs[d.shot] = d.fov;
        };
        const acted = { A: 0, B: 0 }, shot = {};
        const follow = async (one, s) => {
            if (s.mooring !== 'assigned' || Date.now() - acted[one.name] < 900) return;
            acted[one.name] = Date.now();
            if (s.cue === 'Gate') await one.tap('KeyB');
            else if (s.cue === 'Engine75') await one.engine(0.75);
            else if (s.cue === 'Engine25') await one.engine(0.25);
            else if (s.cue === 'Engine0') await one.engine(0);
        };
        // The disk refuses writes from before either arrives until both lie in their berths: neither may be called docked meanwhile.
        const { mkdir: makeDir, rm: remove } = await import('node:fs/promises');
        let stuck = false, waitedAt = 0, waiting = null;
        for (const end = Date.now() + 360000; Date.now() < end;) {
            await a.pace(); await b.pace();
            const [la, lb, ships] = [await a.seen(), await b.seen(), await books()];
            note('A', la, ships, 'pilot-a'); note('B', lb, ships, 'pilot-b');
            await follow(a, la); await follow(b, lb);
            if (!stuck && (la.mooring === 'docking' || lb.mooring === 'docking')) { stuck = true; await remove(`${data}.bak`, { force: true, recursive: true }); await makeDir(`${data}.bak`); }
            for (const [one, s] of [[a, la], [b, lb]]) {
                const key = `${one.name}-${s.director.shot}`;
                if (s.director.on && !shot[key] && Date.now() - seenOf[one.name].since > 2200) { shot[key] = true; await one.shoot(`berth${s.berth}-in-${IN.indexOf(s.director.shot) + 1}-${s.director.shot}`); }
            }
            if (ships['pilot-a'].arrived && ships['pilot-b'].arrived) {
                if (!waitedAt) waitedAt = Date.now();
                // Both lie in their berths and the disk has neither: six seconds of that, looked at, before the disk is mended.
                if (Date.now() - waitedAt > 6000) { waiting = [la, lb, ships, await health()]; break; }
            }
            await wait(15);
        }
        if (!waiting) throw new Error(`${tag}: the two ships never lay in their berths: ${JSON.stringify((await books()).berths)}`);
        await a.shoot('berth1-in-4-waiting-to-be-recorded');
        await b.shoot('berth2-in-4-waiting-to-be-recorded');
        expect(`${tag}: in her berth while the disk refuses writes, each window holds the settled shot and says the station cannot record it: not docked, no chime, no panel`,
            waiting.slice(0, 2).every((s) => s.mooring === 'docking' && s.hold === 'NOT SAVED' && s.director.on && s.director.shot === 'berthed' && s.director.confirmed === 0 && s.director.sinceDocked === 0 && !s.spots.store && /CANNOT RECORD IT YET/.test(s.text) && s.director.shown.join() === IN.join()) && waiting[3].saving === 'failing' && !waiting[2]['pilot-a'].docked && !waiting[2]['pilot-b'].docked,
            waiting.slice(0, 2).map((s) => [s.mooring, s.hold, s.director.shot, s.director.confirmed, s.director.shown, s.text]));
        const cuesBefore = [waiting[0].cues, waiting[1].cues];
        await remove(`${data}.bak`, { recursive: true });
        await a.until('A to be confirmed docked', (s) => s.mooring === 'docked', 15000);
        await b.until('B to be confirmed docked', (s) => s.mooring === 'docked', 15000);
        const justDocked = [await a.seen(), await b.seen()];
        await both(a, b, 2500);
        const docked = [await a.seen(), await b.seen()];
        await a.shoot('berth1-in-5-docked');
        await b.shoot('berth2-in-5-docked');
        expect(`${tag}: the disk mended, each is confirmed docked once: one chime, the panel a moment later and not before, and the same shot still up`,
            docked.every((s, i) => s.director.confirmed === 1 && s.cues === cuesBefore[i] + 1 && s.lastCue === 'arrival' && !!s.spots.store && s.director.shot === 'berthed' && s.director.shown.join() === IN.join()) && justDocked.every((s) => !s.spots.store || s.director.sinceDocked > 0.5),
            docked.map((s, i) => [s.director.confirmed, s.cues - cuesBefore[i], s.lastCue, Object.keys(s.spots), s.director.shown]));
        for (const [who, id, s] of [['A', 1, docked[0]], ['B', 2, docked[1]]]) {
            const t = seenOf[who];
            measured[`${tag} berth ${id} in`] = { shots: t.shots, looks: t.looks, shipWidth: Object.fromEntries(Object.entries(t.sat).map(([k, v]) => [k, [+v.least.toFixed(3), +v.most.toFixed(3)]])), cutWhenSettled: t.cut, fellBack: t.fellBack, cameraOffServerShip: +Math.max(0, ...t.away).toFixed(2), fov: t.fovs };
            expect(`${tag} berth ${id}: brought in through the three shots in order, each the size it is meant to be, the whole ship in every one, the camera never in the station`,
                t.shots.join() === IN.join() && t.cut === 0 && t.fellBack === 0 && s.director.fallbacks === 0 && IN.every((name) => t.sat[name] && t.sat[name].least >= WIDTHS[name][0] && t.sat[name].most <= WIDTHS[name][1]) && Math.abs(t.fovs.takeover - 42) < 1.5 && Math.abs(t.fovs.settle - 36) < 1.5 && t.early === 0 && Math.max(...t.away) < 12,
                measured[`${tag} berth ${id} in`]);
            // Docked: she is in the left of the picture and the warehouse panel is to the right of her, not over her.
            const scale = (s.spots.leave.x - s.spots.store.x) / 392, panelLeft = (s.spots.store.x - 114 * scale) / width;
            measured[`${tag} berth ${id} docked`] = { ship: [+s.director.frame.left.toFixed(3), +s.director.frame.right.toFixed(3), +s.director.frame.top.toFixed(3), +s.director.frame.bottom.toFixed(3)], panelLeft: +panelLeft.toFixed(3) };
            expect(`${tag} berth ${id}: docked, the whole ship is left of the warehouse panel, clear of the screen's edges`, s.director.frame.whole && s.director.frame.right <= panelLeft + 0.005 && s.director.frame.left > 0.02 && s.director.frame.top > 0.18 && s.director.frame.bottom < 0.92, measured[`${tag} berth ${id} docked`]);
        }

        // B takes the view back by dragging it: it is hers, the station carries on, and the harbour does not take it again while she lies there.
        await b.page.mouse.move(width * 0.3, height * 0.6); await b.step(1); await b.page.mouse.down(); await b.step(1);
        await b.page.mouse.move(width * 0.3 + 90, height * 0.6 + 20, { steps: 3 }); await b.step(2); await b.page.mouse.up(); await b.step(2);
        await both(a, b, 2500);
        const taken = await b.seen();
        await b.shoot('berth2-in-6-her-own-view');
        expect(`${tag}: dragging the view takes it back at once and it stays hers while she lies there, still docked with her warehouse open`, !taken.director.on && taken.director.dismissed && taken.director.shot === null && taken.mooring === 'docked' && !!taken.spots.store && taken.director.confirmed === 1, taken.director);

        // A reloads her window where she lies: straight to the settled shot, with nothing replayed and no chime.
        await a.open();
        await a.until('A to be back in her berth', (s) => s.link === 'online' && s.mooring === 'docked' && s.director.on, 30000);
        await both(a, b, 1500);
        const back = await a.seen();
        await a.shoot('berth1-in-7-signed-in-again');
        expect(`${tag}: signing in again where she lies goes straight to the settled shot: nothing before it is replayed, no chime, the panel up`, back.director.shown.join() === 'berthed' && back.director.confirmed === 0 && back.director.shot === 'berthed' && back.director.frame.whole && !!back.spots.store && back.lastCue !== 'arrival', { shown: back.director.shown, confirmed: back.director.confirmed, lastCue: back.lastCue });

        // Both cast off. A new manoeuvre: the harbour has both cameras again, B's too.
        seenOf.A = track(); seenOf.B = track();
        const numbered = [back.numbered, taken.numbered];
        await a.page.keyboard.down('KeyH'); await b.page.keyboard.down('KeyH'); await a.step(1); await b.step(1); await a.page.keyboard.up('KeyH'); await b.page.keyboard.up('KeyH');
        let released = null;
        for (const end = Date.now() + 120000; Date.now() < end;) {
            await a.pace(); await b.pace();
            const [la, lb, ships] = [await a.seen(), await b.seen(), await books()];
            note('A', la, ships, 'pilot-a'); note('B', lb, ships, 'pilot-b');
            for (const [one, s] of [[a, la], [b, lb]]) {
                const key = `${one.name}-${s.director.shot}`;
                if (s.director.on && !shot[key] && Date.now() - seenOf[one.name].since > 2200) { shot[key] = true; await one.shoot(`berth${s.berth}-out-${OUT.indexOf(s.director.shot) + 1}-${s.director.shot}`); }
            }
            if (la.mooring === 'none' && lb.mooring === 'none') { released = [la, lb, ships]; break; }
            await wait(15);
        }
        if (!released) throw new Error(`${tag}: the two ships were never let go`);
        // The frame she is let go her helm is hers: half ahead at once, while the picture is still easing back to her own.
        await a.engine(0.5); await b.engine(0.5);
        const atOnce = [await a.seen(), await b.seen()];
        await both(a, b, 900);
        await a.shoot('berth1-out-4-helm-handed-back');
        await b.shoot('berth2-out-4-helm-handed-back');
        await both(a, b, 4500);
        const sailing = [await a.seen(), await b.seen()], ships = await books();
        await a.shoot('berth1-out-5-sailing');
        await b.shoot('berth2-out-5-sailing');
        for (const [who, id, s] of [['A', 1, sailing[0]], ['B', 2, sailing[1]]]) {
            const t = seenOf[who];
            measured[`${tag} berth ${id} out`] = { shots: t.shots, looks: t.looks, shipWidth: Object.fromEntries(Object.entries(t.sat).map(([k, v]) => [k, [+v.least.toFixed(3), +v.most.toFixed(3)]])), cutWhenSettled: t.cut, fellBack: t.fellBack, fov: t.fovs };
            expect(`${tag} berth ${id}: taken out through the three shots in order on the berth's own side, the whole ship in each, the camera never in the station`,
                t.shots.join() === OUT.join() && t.cut === 0 && t.fellBack === 0 && s.director.fallbacks === 0 && ['lift', 'clear'].every((name) => t.sat[name] && t.sat[name].least >= WIDTHS[name][0] && t.sat[name].most <= WIDTHS[name][1]) && Math.abs(t.fovs.lift - 40) < 1.5,
                measured[`${tag} berth ${id} out`]);
        }
        measured[`${tag} handed back`] = { orderTheFrameSheWasLetGo: atOnce.map((s) => s.order), serverSpeed: [ships['pilot-a'].flight.speed, ships['pilot-b'].flight.speed].map((v) => +v.toFixed(1)), ordersTaken: [ships['pilot-a'].taken - numbered[0], ships['pilot-b'].taken - numbered[1]], fov: sailing.map((s) => +s.fov.toFixed(1)), directorOn: sailing.map((s) => s.director.on) };
        expect(`${tag}: let go, both helms answered at once and the server flew them: half ahead for five seconds, both under way, and the view each pilot's own again`,
            atOnce.every((s) => s.order === 0.5 && s.mooring === 'none') && ships['pilot-a'].flight.speed > 120 && ships['pilot-b'].flight.speed > 120 && ships['pilot-a'].taken > numbered[0] + 100 && ships['pilot-b'].taken > numbered[1] + 100 && sailing.every((s) => !s.director.on && s.director.presence === 0 && s.director.shot === null && s.fov < 40) && sailing[1].director.shown.join() === [...IN, ...OUT].join(),
            measured[`${tag} handed back`]);
        await a.page.close(); await b.page.close();
    } catch (err) {
        problems.push(`${tag}: ${String(err?.stack ?? err)}`);
    } finally {
        await context.close().catch(() => undefined);
        for (const [name, film] of Object.entries(films)) await film.saveAs(path.join(out, 'video', `${name}.webm`)).then(() => film.delete(), () => undefined);
        if (server) { server.send('shutdown'); await server.gone; }
    }
}
await browser.close();
web.close();
const report = { sizes: SIZES.map((s) => s.join('x')), findings, measured, problems: [...new Set(problems)] };
await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ findings: findings.length, bad: findings.filter((f) => !f.ok).length, problems: report.problems.length }));
process.exit(report.problems.length > 0 ? 1 : 0);

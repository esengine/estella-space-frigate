import { createServer } from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { SessionHost, SessionRejected, acceptWebSocket, type SessionContext } from 'esengine/session';
import { contract, toDockRefusal, toFlight, toQuat, toRefusal, toTransferRefusal, toVec, type Credentials } from '../src/protocol';
import { SECTOR, tonnage } from '../src/shared/sector';
import { NoSave, loadSave, writeSave } from './store';
import { createSector } from './world';

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : fallback;
}

const port = Number(arg('port', '8090')), bind = arg('host', '127.0.0.1');
const wire = arg('wire', 'pb') as 'json' | 'pb' | 'pb-only';
const file = path.resolve(arg('data', 'server-data/sector.json'));
const found = process.argv.includes('--new');

let saved;
try {
    saved = loadSave(file, { found });
} catch (err) {
    // A missing or unreadable save stops the server here. It never starts on an empty sector because it could not find the one it had.
    console.error(`[sector] not started: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof NoSave ? 3 : 4);
}
const sector = createSector(saved);
// A check stops the server at a named point to see what a crash there leaves: SECTOR_CRASH=before-write | mid-write | after-write.
const CRASH = process.env.SECTOR_CRASH ?? '';
const crash = (point: string): void => { if (CRASH === point) { console.log(`[sector] stopped dead at ${point}`); process.exit(86); } };
const save = (commit = false): void => { writeSave(file, sector.save(), commit ? () => crash('mid-write') : undefined); };

/** A seat is one sign-in. An account has one at a time, and only the seat it has now may fly the ship or work her beam. */
interface Seat extends SessionContext { seat: number }
let seats = 0;
const seated = new Map<string, number>();
const sits = (ctx: Seat): boolean => seated.get(ctx.playerId) === ctx.seat;

const host = new SessionHost<Seat>({
    wire,
    limits: { messagesPerSecond: 60, burst: 120 },
    authenticate(raw, connection) {
        const creds = raw as Partial<Credentials> | null;
        if (!creds || creds.contract !== contract.fingerprint) throw new SessionRejected('CLIENT AND SERVER DIFFER');
        const account = sector.login(creds.account, creds.token);
        if (!account) throw new SessionRejected('UNKNOWN PILOT OR TOKEN');
        const seat = ++seats;
        seated.set(account.id, seat);
        sector.enter(account.id);
        console.log(`[sector] ${account.id} in (seat ${seat})`);
        connection.onClose(() => {
            if (seated.get(account.id) !== seat) return;
            seated.delete(account.id);
            sector.leave(account.id);
            save();
            console.log(`[sector] ${account.id} out`);
        });
        return { playerId: account.id, seat };
    },
});

contract.serve(host, {
    enter(_, ctx) {
        const you = sector.welcome(ctx.playerId), here = you.sector;
        return {
            account: you.account, name: you.name, flight: toFlight(you.flight), cargo: you.cargo,
            sector: here.id, sectorName: here.name, rock: { id: here.rock.id, at: toVec(here.rock.at), total: here.rock.total, remaining: here.rock.remaining },
            range: here.range, rate: here.rate, capacity: here.capacity, stored: you.stored, docked: you.docked,
            station: { id: here.station.id, name: here.station.name, at: toVec(here.station.at), dockRange: here.station.dockRange, dockSpeed: here.station.dockSpeed },
        };
    },
    steer(steer, ctx) {
        return { taken: sits(ctx) ? sector.steer(ctx.playerId, steer.orders) : 0 };
    },
    mine(ask, ctx) {
        return { asking: sits(ctx) && sector.mine(ctx.playerId, ask.on) && ask.on };
    },
    dock(ask, ctx) {
        if (!sits(ctx)) return { docked: false, why: toDockRefusal('TOO FAR') };
        const got = sector.dock(ctx.playerId, ask.dock);
        return { docked: got.docked, why: toDockRefusal(got.why) };
    },
    transfer(ask, ctx) {
        // The pilot is the one this seat signed in as: the request has no way to say whose warehouse.
        const got = sits(ctx) ? sector.transfer(ctx.playerId, ask.op, ask.withdraw, ask.grams) : null;
        if (!got) return { op: ask.op, ok: false, why: toTransferRefusal('BAD ORDER'), withdraw: ask.withdraw, grams: 0, cargo: 0, stored: 0, repeat: false };
        // Ore that moved is on the disk before anyone is told it moved. A crash before the write leaves it unmoved, a crash
        // after leaves it moved, and the order's name is in the same write, so asking again is answered and never done again.
        if (got.moved) { crash('before-write'); save(true); crash('after-write'); }
        return { op: got.op, ok: got.ok, why: toTransferRefusal(got.why), withdraw: got.withdraw, grams: got.grams, cargo: got.cargo, stored: got.stored, repeat: !got.fresh };
    },
});

const http = createServer((req, res) => {
    if (req.url === '/healthz') {
        const ore = sector.ore();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pilots: host.playerCount, remaining: ore.remaining, held: ore.held, stored: ore.stored, total: ore.total }));
        return;
    }
    // The server's own account of each ship, for a check to read beside what the clients believe.
    if (req.url === '/pilots') {
        const out: Record<string, unknown> = {};
        for (const id of ['pilot-a', 'pilot-b']) { const s = sector.stateFor(id); out[id] = { here: sector.here(id), flight: s.flight, ack: s.ack, waiting: s.waiting, starved: s.starved, dropped: s.dropped, cargo: s.you.cargo, stored: s.you.stored, docked: s.you.docked, station: s.you.station, mining: s.you.mining }; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
    }
    res.writeHead(404);
    res.end();
});
const wss = new WebSocketServer({ server: http, path: '/sector', maxPayload: 16 * 1024, perMessageDeflate: false });
wss.on('connection', (socket) => acceptWebSocket(host, socket));
await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, bind, () => resolve()); });

let last = Date.now(), unsaved = 0;
const loop = setInterval(() => {
    const now = Date.now();
    sector.step(now - last);
    unsaved += now - last;
    last = now;
    if (unsaved >= SECTOR.saveMs) { unsaved = 0; if (sector.takeDirty()) save(); }
    for (const id of seated.keys()) {
        const state = sector.stateFor(id);
        contract.push(host as unknown as SessionHost<never>, id, 'state', {
            tick: state.tick, remaining: state.rock, flight: toFlight(state.flight), ack: state.ack, waiting: state.waiting,
            cargo: state.you.cargo, stored: state.you.stored, docked: state.you.docked, mining: state.you.mining, why: toRefusal(state.you.why),
            others: state.others.map((o) => ({ account: o.account, name: o.name, p: toVec(o.p), q: toQuat(o.q), v: toVec(o.v), throttle: o.th, mining: o.mining, docked: o.docked, cargo: o.cargo })),
        });
    }
}, SECTOR.tickMs);

let stopping = false;
const stop = (why: string): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(loop);
    host.close();
    save();
    const ore = sector.ore();
    console.log(`[sector] stopped (${why}): ${tonnage(ore.remaining)} t left + ${tonnage(ore.held)} t held + ${tonnage(ore.stored)} t stored, saved to ${file}`);
    wss.close(() => http.close(() => process.exit(0)));
    http.closeAllConnections?.();
    setTimeout(() => process.exit(0), 1000).unref();
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, () => stop(signal));
process.on('message', (message) => { if (message === 'shutdown') stop('message'); });
process.stdin.on('data', (chunk) => { if (/^\s*(stop|quit|exit)\s*$/im.test(String(chunk))) stop('stop'); });
process.stdin.on('error', () => undefined);

const address = http.address(), at = typeof address === 'object' && address ? address.port : port;
const ore = sector.ore();
console.log(`[sector] ${SECTOR.name} on ws://${bind}:${at}/sector  wire ${wire}  ${found ? 'founded' : 'carried on'}: ${tonnage(ore.remaining)} t left + ${tonnage(ore.held)} t held + ${tonnage(ore.stored)} t stored  save ${file}`);

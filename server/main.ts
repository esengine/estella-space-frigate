import { createServer } from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { SessionHost, SessionRejected, acceptWebSocket, type SessionContext } from 'esengine/session';
import { contract, toDockRefusal, toFlight, toMooring, toQuat, toRefusal, toTransferRefusal, toVec, type Credentials } from '../src/protocol';
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
const sector = createSector(saved, undefined, { keeper: true });
// A check stops the server at a named point to see what a crash there leaves: SECTOR_CRASH=before-write | mid-write | after-write.
const CRASH = process.env.SECTOR_CRASH ?? '';
const crash = (point: string): void => { if (CRASH === point) { console.log(`[sector] stopped dead at ${point}`); process.exit(86); } };
/**
 * Whatever has changed is written, and stays owed until it is: a write that fails is logged, said on /healthz, and tried
 * again a second later. It never stops the server, and nothing is told to a pilot as done on the strength of it.
 */
const saving = { ok: true, failures: 0, last: '', savedAt: Date.now() };
const wrote = (): void => { if (!saving.ok) console.log(`[sector] saving again after ${saving.failures} failed write(s)`); saving.ok = true; saving.failures = 0; saving.savedAt = Date.now(); };
const failedToWrite = (err: unknown): void => {
    saving.ok = false; saving.failures++; saving.last = err instanceof Error ? err.message : String(err);
    if (saving.failures === 1 || saving.failures % 30 === 0) console.error(`[sector] could not write the save (${saving.failures}): ${saving.last}`);
};
const save = (): boolean => {
    // What was written is handed back to the sector: a ship that had reached her berth is docked from the write that has her there.
    try { const written = sector.save(); sector.takeDirty(); writeSave(file, written); sector.committed(written); wrote(); return true; } catch (err) { sector.markDirty(); failedToWrite(err); return false; }
};

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

/** Puts on the disk what the sector would be with an order in it. It throws if it cannot, and then the order has not happened. */
const written = (after: Parameters<typeof writeSave>[1]): void => {
    crash('before-write');
    try { writeSave(file, after, () => crash('mid-write')); } catch (err) { failedToWrite(err); throw err; }
    sector.committed(after);
    wrote();
    crash('after-write');
};
const answered = (got: ReturnType<typeof sector.transfer>) => ({
    op: got.op, seq: got.seq, ok: got.ok, why: toTransferRefusal(got.why), withdraw: got.withdraw, grams: got.grams, cargo: got.cargo, stored: got.stored, repeat: got.ok && !got.fresh, next: got.next,
    sell: got.sell, paid: got.paid, credits: got.credits,
});

contract.serve(host, {
    enter(_, ctx) {
        const you = sector.welcome(ctx.playerId), here = you.sector;
        return {
            account: you.account, name: you.name, flight: toFlight(you.flight), cargo: you.cargo,
            sector: here.id, sectorName: here.name, rock: { id: here.rock.id, at: toVec(here.rock.at), total: here.rock.total, remaining: here.rock.remaining },
            range: here.range, rate: here.rate, capacity: here.capacity, stored: you.stored, credits: you.credits, docked: you.docked, nextMove: you.next, berth: you.berth, mooring: toMooring(you.mooring),
            station: {
                id: here.station.id, name: here.station.name, at: toVec(here.station.at), dockSpeed: here.station.dockSpeed, approachRange: here.station.approachRange, buyLot: here.station.buys.lot, buyPrice: here.station.buys.price,
                berths: here.station.berths.map((berth) => ({ id: berth.id, at: toVec(berth.at), over: toVec(berth.over), approach: toVec(berth.approach) })),
            },
        };
    },
    steer(steer, ctx) {
        return { taken: sits(ctx) ? sector.steer(ctx.playerId, steer.orders) : 0 };
    },
    mine(ask, ctx) {
        return { asking: sits(ctx) && sector.mine(ctx.playerId, ask.on) && ask.on };
    },
    dock(ask, ctx) {
        // A berth is the account's, and only the seat the account has now may ask for one or give one up.
        if (!sits(ctx)) return { docked: false, why: toDockRefusal('TOO FAR'), berth: 0, mooring: toMooring('none') };
        const got = sector.dock(ctx.playerId, ask.dock);
        return { docked: got.docked, why: toDockRefusal(got.why), berth: got.berth, mooring: toMooring(got.mooring) };
    },
    transfer(ask, ctx) {
        // The pilot is the one this seat signed in as: the request has no way to say whose warehouse.
        if (!sits(ctx)) return { op: ask.op, seq: ask.seq, ok: false, why: toTransferRefusal('BAD ORDER'), withdraw: ask.withdraw, grams: 0, cargo: 0, stored: 0, repeat: false, next: 0, sell: false, paid: 0, credits: 0 };
        // A move is written before it is made. The sector hands over what the save would be with the move in it; only when
        // that is on the disk does the move become true here, and only then is the pilot told. If the write fails nothing
        // has moved, nothing is remembered as done, and the answer is NOT SAVED: asked again it is tried again, and done once.
        // A crash before the write leaves it unmoved and one after leaves it moved, and the order's number is in the same
        // write, so the same order afterwards is answered or refused and never done again.
        const got = sector.transfer(ctx.playerId, ask.seq, ask.op, ask.withdraw, ask.grams, written);
        return answered(got);
    },
    sell(ask, ctx) {
        if (!sits(ctx)) return { op: ask.op, seq: ask.seq, ok: false, why: toTransferRefusal('BAD ORDER'), withdraw: false, grams: 0, cargo: 0, stored: 0, repeat: false, next: 0, sell: true, paid: 0, credits: 0 };
        // A sale is written before it is made, as a move of ore is: the warehouse, the station's stock and the credits in one save.
        return answered(sector.sell(ctx.playerId, ask.seq, ask.op, ask.grams, ask.price, written));
    },
});

const http = createServer((req, res) => {
    if (req.url === '/healthz') {
        const ore = sector.ore();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pilots: host.playerCount, remaining: ore.remaining, held: ore.held, stored: ore.stored, station: ore.station, credits: ore.credits, total: ore.total, saving: saving.ok ? 'ok' : 'failing' }));
        return;
    }
    // The server's own account of each ship, for a check to read beside what the clients believe.
    if (req.url === '/pilots') {
        const out: Record<string, unknown> = {};
        for (const id of ['pilot-a', 'pilot-b']) { const s = sector.stateFor(id); out[id] = { here: sector.here(id), flight: s.flight, ack: s.ack, waiting: s.waiting, starved: s.starved, dropped: s.dropped, cargo: s.you.cargo, stored: s.you.stored, credits: s.you.credits, docked: s.you.docked, berth: s.you.berth, mooring: s.you.mooring, hold: s.you.hold, arrived: s.you.arrived, taken: sector.taken(id), nextMove: s.you.next, station: s.you.station, mining: s.you.mining }; }
        out.berths = sector.berths();
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

let last = Date.now(), unsaved = 0, pressed = 0;
const loop = setInterval(() => {
    const now = Date.now();
    sector.step(now - last);
    unsaved += now - last;
    last = now;
    if (unsaved >= SECTOR.saveMs) { unsaved = 0; if (sector.isDirty()) save(); }
    // A ship has reached her berth and no save has her there: it is written now, not at the next second, and while the disk
    // refuses it is tried again four times a second. She is told she is docked only by the write that succeeds.
    else if (sector.unwritten() && now - pressed >= 250) { pressed = now; save(); }
    for (const id of seated.keys()) {
        const state = sector.stateFor(id);
        contract.push(host as unknown as SessionHost<never>, id, 'state', {
            tick: state.tick, remaining: state.rock, flight: toFlight(state.flight), ack: state.ack, waiting: state.waiting,
            cargo: state.you.cargo, stored: state.you.stored, docked: state.you.docked, nextMove: state.you.next, mining: state.you.mining, why: toRefusal(state.you.why),
            berth: state.you.berth, mooring: toMooring(state.you.mooring), hold: toDockRefusal(state.you.hold), credits: state.you.credits, stationOre: state.bought,
            others: state.others.map((o) => ({ account: o.account, name: o.name, p: toVec(o.p), q: toQuat(o.q), v: toVec(o.v), throttle: o.th, mining: o.mining, docked: o.docked, berth: o.berth, mooring: toMooring(o.mooring), cargo: o.cargo })),
        });
    }
}, SECTOR.tickMs);

let stopping = false;
const stop = (why: string): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(loop);
    host.close();
    const kept = save();
    const ore = sector.ore();
    console.log(`[sector] stopped (${why}): ${tonnage(ore.remaining)} t left + ${tonnage(ore.held)} t held + ${tonnage(ore.stored)} t stored, ${kept ? 'saved to' : 'NOT SAVED to'} ${file}`);
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

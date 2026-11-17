import { createServer } from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { SessionHost, SessionRejected, acceptWebSocket, type AcceptedConnection, type SessionContext } from 'esengine/session';
import { contract, toQuat, toRefusal, toVec, type Credentials } from '../src/protocol';
import { SECTOR, tonnage, type ServerMessage } from '../src/shared/sector';
import { loadSave, writeSave } from './store';
import { createSector } from './world';

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const port = Number(arg('port', '8090')), bind = arg('host', '127.0.0.1');
const wire = arg('wire', 'pb') as 'json' | 'pb' | 'pb-only';
const file = path.resolve(arg('data', 'server-data/sector.json'));
const sector = createSector(loadSave(file));
const seats = new Map<string, AcceptedConnection>();
const save = (): void => { writeSave(file, sector.save()); };

const host = new SessionHost<SessionContext>({
    wire,
    limits: { messagesPerSecond: 60, burst: 120 },
    authenticate(raw, connection) {
        const creds = raw as Partial<Credentials> | null;
        if (!creds || creds.contract !== contract.fingerprint) throw new SessionRejected('CLIENT AND SERVER DIFFER');
        const account = sector.login(creds.account, creds.token);
        if (!account) throw new SessionRejected('UNKNOWN PILOT OR TOKEN');
        seats.set(account.id, connection);
        sector.enter(account.id, Date.now());
        console.log(`[sector] ${account.id} in`);
        connection.onClose(() => {
            if (seats.get(account.id) !== connection) return;
            seats.delete(account.id);
            sector.leave(account.id);
            save();
            console.log(`[sector] ${account.id} out`);
        });
        return { playerId: account.id };
    },
});

contract.serve(host, {
    enter(_, ctx) {
        const { you, sector: here } = sector.welcome(ctx.playerId) as Extract<ServerMessage, { t: 'welcome' }>;
        return {
            account: you.account, name: you.name, p: toVec(you.p), q: toQuat(you.q), cargo: you.cargo,
            sector: here.id, sectorName: here.name, rock: { id: here.rock.id, at: toVec(here.rock.at), total: here.rock.total, remaining: here.rock.remaining },
            range: here.range, rate: here.rate, capacity: here.capacity,
        };
    },
    pose(pose, ctx) {
        sector.pose(ctx.playerId, [pose.p!.x, pose.p!.y, pose.p!.z], [pose.q!.x, pose.q!.y, pose.q!.z, pose.q!.w], pose.throttle, Date.now());
        return {};
    },
    mine(ask, ctx) {
        sector.mine(ctx.playerId, ask.on);
        return { asking: ask.on };
    },
});

const http = createServer((req, res) => {
    if (req.url === '/healthz') {
        const ore = sector.ore();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pilots: host.playerCount, remaining: ore.remaining, held: ore.held, total: ore.total }));
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
    for (const id of seats.keys()) {
        const state = sector.stateFor(id) as Extract<ServerMessage, { t: 'state' }>;
        contract.push(host as SessionHost<never>, id, 'state', {
            tick: state.tick, remaining: state.rock, p: toVec(state.you.p), cargo: state.you.cargo, mining: state.you.mining, why: toRefusal(state.you.why),
            others: state.others.map((o) => ({ account: o.account, name: o.name, p: toVec(o.p), q: toQuat(o.q), throttle: o.th, mining: o.mining, cargo: o.cargo })),
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
    console.log(`[sector] stopped (${why}): ${tonnage(ore.remaining)} t left + ${tonnage(ore.held)} t held, saved to ${file}`);
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
console.log(`[sector] ${SECTOR.name} on ws://${bind}:${at}/sector  wire ${wire}  ${tonnage(ore.remaining)} t left + ${tonnage(ore.held)} t held  save ${file}`);

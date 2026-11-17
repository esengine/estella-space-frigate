import { createSocket } from 'esengine';
import { ClientSession } from 'esengine/session';
import { contract, fromQuat, fromRefusal, fromVec, toQuat, toVec, type Credentials } from './protocol';
import { DRIFTING_ROCKS } from './shipState';
import { SECTOR, type PilotView, type Refusal, type Vec3 } from './shared/sector';

export const SHARED_ROCK = 0;

export type Link = 'offline' | 'connecting' | 'online' | 'lost' | 'refused';

export const online = {
    enabled: false,
    url: '',
    account: '',
    token: '',
    wire: 'pb' as 'pb' | 'json',
    link: 'offline' as Link,
    why: '',
    name: '',
    sector: SECTOR.name as string,
    pos: [0, 0, 0] as Vec3,
    berth: null as Vec3 | null,
    cargo: 0,
    capacity: SECTOR.capacity as number,
    range: SECTOR.range as number,
    rock: { at: [...SECTOR.rock.at] as Vec3, total: SECTOR.rock.total as number, remaining: SECTOR.rock.total as number },
    mining: false,
    refusal: 'NOT MINING' as Refusal,
    others: [] as PilotView[],
    tick: 0,
    welcomes: 0,
    asked: false,
};

const POSE_MS = 100, SNAP = 300;
let session: ClientSession | null = null, api: ReturnType<typeof contract.client> | null = null, posedAt = 0, posing = false;

export function configureOnline(search: string): void {
    const query = new URLSearchParams(search);
    const url = query.get('server') ?? '';
    if (!/^wss?:\/\//.test(url)) return;
    online.enabled = true;
    online.url = url;
    online.account = query.get('account') ?? '';
    online.token = query.get('token') ?? '';
    online.wire = query.get('wire') === 'json' ? 'json' : 'pb';
}

async function enter(): Promise<void> {
    const reply = await api!.enter({});
    online.name = reply.name;
    online.sector = reply.sectorName;
    online.berth = fromVec(reply.p);
    online.cargo = reply.cargo;
    online.capacity = reply.capacity;
    online.range = reply.range;
    online.rock = { at: fromVec(reply.rock?.at), total: reply.rock?.total ?? 0, remaining: reply.rock?.remaining ?? 0 };
    online.mining = false;
    online.refusal = 'NOT MINING';
    online.asked = false;
    online.why = '';
    online.link = 'online';
    online.welcomes++;
}

export function connectOnline(): void {
    if (!online.enabled || session) return;
    online.link = 'connecting';
    const made = new ClientSession({
        connect: () => createSocket({ url: online.url }),
        wire: online.wire,
        credentials: (): Credentials => ({ account: online.account, token: online.token, contract: contract.fingerprint }),
        backoff: { initialMs: 400, maxMs: 3000 },
    });
    session = made;
    api = contract.client(made);
    contract.on(made, 'state', (state) => {
        if (online.link !== 'online') return;
        online.tick = state.tick;
        online.rock.remaining = state.remaining;
        online.cargo = state.cargo;
        online.mining = state.mining;
        online.refusal = fromRefusal(state.why);
        online.others = state.others.map((o) => ({ account: o.account, name: o.name, p: fromVec(o.p), q: fromQuat(o.q), th: o.throttle, mining: o.mining, cargo: o.cargo }));
        const p = fromVec(state.p);
        if (online.berth === null && Math.hypot(p[0] - online.pos[0], p[1] - online.pos[1], p[2] - online.pos[2]) > SNAP) online.berth = p;
    });
    made.onState((state, reason) => {
        if (state === 'ready') { void enter().catch(() => undefined); return; }
        online.mining = false;
        online.others = [];
        if (state === 'closed') { online.link = 'refused'; online.why = (reason ?? 'CLOSED').toUpperCase(); }
        else online.link = online.welcomes > 0 ? 'lost' : 'connecting';
    });
    made.start().catch(() => undefined);
}

export function sendPose(q: { x: number; y: number; z: number; w: number }, throttle: number): void {
    const now = Date.now();
    if (online.link !== 'online' || posing || now - posedAt < POSE_MS || !api) return;
    posedAt = now;
    posing = true;
    api.pose({ p: toVec(online.pos), q: toQuat([q.x, q.y, q.z, q.w]), throttle }, { retries: 0, timeoutMs: 2000 }).then(() => { posing = false; }, () => { posing = false; });
}

export function askToMine(on: boolean): void {
    if (online.link !== 'online' || online.asked === on || !api) return;
    online.asked = on;
    api.mine({ on }).then((reply) => { online.asked = reply.asking; }, () => { online.asked = !on; });
}

export const parkedRock = (index: number): boolean => online.enabled && index !== SHARED_ROCK && index < DRIFTING_ROCKS;
export const pinnedRock = (index: number): boolean => online.enabled && index === SHARED_ROCK;

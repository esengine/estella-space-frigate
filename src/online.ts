import { createSocket } from 'esengine';
import { ClientSession } from 'esengine/session';
import { contract, fromDockRefusal, fromFlight, fromQuat, fromRefusal, fromTransferRefusal, fromVec, type Credentials } from './protocol';
import { DRIFTING_ROCKS } from './shipState';
import { SECTOR, type DockRefusal, type PilotView, type Refusal, type TransferRefusal, type Vec3 } from './shared/sector';
import { createPredictor, type Predictor } from './shared/predict';
import { copyFlight, turnShip, type Flight, type Orders, type Vec } from './shared/steer';

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
    /** Where this ship is drawn from, in the sector's own coordinates. */
    pos: [0, 0, 0] as Vec3,
    /** A move the world has to be shifted by at once, not sailed: taking the helm of a ship that is somewhere else. */
    leap: null as Vec3 | null,
    cargo: 0,
    capacity: SECTOR.capacity as number,
    range: SECTOR.range as number,
    rock: { at: [...SECTOR.rock.at] as Vec3, total: SECTOR.rock.total as number, remaining: SECTOR.rock.total as number },
    station: { name: SECTOR.station.name as string, at: [...SECTOR.station.at] as Vec3, dockRange: SECTOR.station.dockRange as number, dockSpeed: SECTOR.station.dockSpeed as number },
    /** Ore in this pilot's own warehouse at the station, and whether the server has her docked there. Both are the server's word. */
    stored: 0,
    docked: false,
    /** The last answer to asking to dock, and when: '' is that she may. */
    dock: { asking: false, why: '' as DockRefusal, at: 0 },
    /** The order to move ore that is out, or the last one answered. 'pending' is not yet a success: only the server's reply makes it one. */
    move: { seq: 0, op: '', withdraw: false, grams: 0, state: '' as '' | 'pending' | 'done' | 'refused', why: '' as TransferRefusal, cargo: 0, stored: 0, at: 0, tries: 0, repeat: false },
    /** The number the server will take for this pilot's next order to move ore. */
    nextMove: 1,
    mining: false,
    refusal: 'NOT MINING' as Refusal,
    others: [] as PilotView[],
    othersAt: 0,
    tick: 0,
    welcomes: 0,
    asked: false,
    /** The orders sent and not yet flown by the server, and how many it has waiting. */
    ahead: 0,
    waiting: 0,
    /** What the server's word has changed in the ship's predicted flight: how often, and the most at once. */
    fix: null as unknown as Predictor['fix'],
};

const SEND_MS = 60;
let session: ClientSession | null = null, api: ReturnType<typeof contract.client> | null = null;
const predictor = createPredictor();
online.fix = predictor.fix;
let sentAt = 0, drawn: Vec = { x: 0, y: 0, z: 0 };
let moving = false, movedAt = 0, named = 0;

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

/** Taking the helm of a ship that is where the server has her: the world is shifted to her at once, not sailed there. */
function take(truth: Flight): void {
    const from = predictor.show().pos;
    predictor.take(truth);
    const leap: Vec3 = [truth.pos.x - from.x, truth.pos.y - from.y, truth.pos.z - from.z];
    online.leap = online.leap ? [online.leap[0] + leap[0], online.leap[1] + leap[1], online.leap[2] + leap[2]] : leap;
    drawn = { ...truth.pos };
    online.pos = [truth.pos.x, truth.pos.y, truth.pos.z];
}

/** A frame of this ship's flight: the helm's orders go to the predictor, and what it has numbered goes to the server. */
export function flyOnline(dt: number, orders: Orders): { shown: Flight; jets: { yaw: number; pitch: number; roll: number }; went: Vec } {
    const linked = online.link === 'online';
    predictor.advance(dt, orders, linked, online.docked);
    const now = Date.now();
    // An order to move ore that has had no answer is asked again, under the same name, until it has one: the server does it once.
    if (linked && online.move.state === 'pending' && !moving && now - movedAt > (online.move.why === 'NOT SAVED' ? 1500 : 700)) sendMove();
    if (linked && api && predictor.unsent() > 0 && now - sentAt >= SEND_MS) {
        sentAt = now;
        api.steer({ orders: predictor.drain().map((one) => ({ seq: one.seq, ...one.orders })) }, { retries: 0, timeoutMs: 3000 }).catch(() => undefined);
    }
    online.ahead = predictor.ahead();
    const shown = predictor.show();
    const went = { x: shown.pos.x - drawn.x, y: shown.pos.y - drawn.y, z: shown.pos.z - drawn.z };
    drawn = { ...shown.pos };
    online.pos = [shown.pos.x, shown.pos.y, shown.pos.z];
    return { shown, jets: turnShip(copyFlight(shown), predictor.orders(), 0), went };
}
async function enter(): Promise<void> {
    const reply = await api!.enter({});
    take(fromFlight(reply.flight));
    online.name = reply.name;
    online.sector = reply.sectorName;
    online.cargo = reply.cargo;
    online.stored = reply.stored;
    online.docked = reply.docked;
    online.nextMove = reply.nextMove;
    if (reply.station) online.station = { name: reply.station.name, at: fromVec(reply.station.at), dockRange: reply.station.dockRange, dockSpeed: reply.station.dockSpeed };
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
        online.stored = state.stored;
        online.docked = state.docked;
        online.nextMove = state.nextMove;
        online.mining = state.mining;
        online.refusal = fromRefusal(state.why);
        online.others = state.others.map((o) => ({ account: o.account, name: o.name, p: fromVec(o.p), q: fromQuat(o.q), v: fromVec(o.v), th: o.throttle, mining: o.mining, docked: o.docked, cargo: o.cargo }));
        online.othersAt = Date.now();
        online.waiting = state.waiting;
        predictor.settle(fromFlight(state.flight), state.ack, state.waiting);
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

export function askToMine(on: boolean): void {
    if (online.link !== 'online' || online.asked === on || !api) return;
    online.asked = on;
    api.mine({ on }).then((reply) => { online.asked = reply.asking; }, () => { online.asked = !on; });
}

export const parkedRock = (index: number): boolean => online.enabled && index !== SHARED_ROCK && index < DRIFTING_ROCKS;
export const pinnedRock = (index: number): boolean => online.enabled && index === SHARED_ROCK;

/** Ask to make fast to the station, or to cast off. The answer is the server's, from where it has flown her. */
export function askToDock(want: boolean): void {
    if (online.link !== 'online' || online.dock.asking || !api) return;
    online.dock.asking = true;
    api.dock({ dock: want }, { retries: 1, timeoutMs: 4000 }).then((reply) => {
        online.dock = { asking: false, why: reply.docked || !want ? '' : fromDockRefusal(reply.why), at: Date.now() };
        online.docked = reply.docked;
    }, () => { online.dock.asking = false; });
}

function sendMove(): void {
    if (!api || online.move.state !== 'pending') return;
    const { seq, op, withdraw, grams } = online.move;
    moving = true;
    movedAt = Date.now();
    online.move.tries++;
    api.transfer({ seq, op, withdraw, grams }, { retries: 0, timeoutMs: 4000 }).then((reply) => {
        moving = false;
        if (online.move.op !== reply.op || online.move.state !== 'pending') return;
        const why = fromTransferRefusal(reply.why);
        // The station could not write it down, so it did not happen: the same order is sent again until it can, or the pilot leaves.
        if (!reply.ok && why === 'NOT SAVED') { online.move = { ...online.move, why }; return; }
        // The server never took this number, so the order has not been seen under it: it goes again under the number it gives.
        if (!reply.ok && why === 'OUT OF ORDER' && reply.next > 0) { online.move = { ...online.move, seq: reply.next, why: '' }; return; }
        online.move = { ...online.move, state: reply.ok ? 'done' : 'refused', why, cargo: reply.cargo, stored: reply.stored, at: Date.now(), repeat: reply.repeat };
        if (reply.ok) { online.cargo = reply.cargo; online.stored = reply.stored; }
    }, () => { moving = false; });
}

/**
 * Order ore out of the hold into this pilot's warehouse, or back. One order at a time. It takes the pilot's next number and a
 * name of its own here, once, so that sending it again is the same order and the server does it once.
 */
export function moveOre(withdraw: boolean, grams: number): boolean {
    if (online.link !== 'online' || online.move.state === 'pending' || !api) return false;
    const op = `${online.account}-${Date.now().toString(36)}-${(++named).toString(36)}-${Math.random().toString(36).slice(2, 10)}`.slice(0, 64);
    online.move = { seq: online.nextMove, op, withdraw, grams, state: 'pending', why: '', cargo: online.cargo, stored: online.stored, at: Date.now(), tries: 0, repeat: false };
    sendMove();
    return true;
}
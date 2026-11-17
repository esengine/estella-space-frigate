import { SECTOR, allot, mayDock, quat4, vec3, type DockRefusal, type PilotView, type Quat4, type Refusal, type Transfer, type TransferRefusal, type Vec3 } from '../src/shared/sector';
import { FLIGHT_TICK, NO_ORDERS, atRest, attitudeOf, cleanOrders, copyFlight, forwardOf, stepFlight, type Flight, type Orders } from '../src/shared/steer';
import { FIELD_DRIFT } from '../src/shipState';

export interface Account { id: string; name: string; token: string }

export const TEST_ACCOUNTS: readonly Account[] = [
    { id: 'pilot-a', name: 'PILOT A', token: 'test-token-a' },
    { id: 'pilot-b', name: 'PILOT B', token: 'test-token-b' },
];

export interface SavedPilot {
    /** Ore in her hold, grams. */
    cargo: number;
    /** Ore in her own warehouse at the station, grams. Nobody else's order reaches it. */
    stored: number;
    docked: boolean;
    /** `p` is where she is and `q` the way she heads; a ship is saved at rest, since nobody is at her helm when a server starts. */
    p: Vec3;
    q: Quat4;
    /** The last orders to move ore and what came of each, so that one asked again after a crash is answered and not done twice. */
    ops: Transfer[];
}

export interface Saved {
    version: 2;
    sector: string;
    rock: { id: string; total: number; remaining: number };
    pilots: Record<string, SavedPilot>;
}

/**
 * The orders waiting to be flown, at most: four tenths of a second, which rides out an uneven link or a hitch in a client's frames.
 * Waiting orders buy nothing: they are flown one a step like any others, so a longer wait is only a later ship.
 */
export const ORDERS_WAITING = 12;
const ORDERS_A_CALL = 32;
/** The orders to move ore that are remembered for each pilot. A retry comes within moments; this is many times that. */
export const OPS_KEPT = 64;

interface Pilot {
    account: Account; cargo: number; stored: number; docked: boolean; ops: Transfer[]; flight: Flight; here: boolean;
    orders: Orders; waiting: { seq: number; orders: Orders }[]; taken: number; ack: number; starved: number; dropped: number;
    wantsMine: boolean; mining: boolean; why: Refusal;
}

export function freshSave(): Saved {
    return { version: 2, sector: SECTOR.id, rock: { id: SECTOR.rock.id, total: SECTOR.rock.total, remaining: SECTOR.rock.total }, pilots: {} };
}

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** What is wrong with a save, or '' if nothing: above all, that the rock, every hold and every warehouse together are the ore the sector was founded with. */
export function auditSave(saved: Saved): string {
    if (saved === null || typeof saved !== 'object' || saved.version !== 2 || saved.sector !== SECTOR.id || saved.rock?.id !== SECTOR.rock.id || typeof saved.pilots !== 'object' || saved.pilots === null) return 'the save is for another sector or version';
    if (!whole(saved.rock.total) || !whole(saved.rock.remaining) || saved.rock.total !== SECTOR.rock.total) return 'the rock is not the one this sector holds';
    let held = 0;
    for (const [id, pilot] of Object.entries(saved.pilots)) {
        if (!whole(pilot.cargo) || !whole(pilot.stored) || typeof pilot.docked !== 'boolean' || !vec3(pilot.p) || !quat4(pilot.q) || !Array.isArray(pilot.ops)) return `pilot ${id} is not a pilot this server wrote`;
        for (const op of pilot.ops) if (typeof op?.op !== 'string' || typeof op.ok !== 'boolean' || !whole(op.cargo) || !whole(op.stored)) return `pilot ${id} has an order to move ore this server did not write`;
        held += pilot.cargo + pilot.stored;
    }
    if (held + saved.rock.remaining !== saved.rock.total) return `ore does not add up: ${held} g held and stored + ${saved.rock.remaining} g left is not ${saved.rock.total} g`;
    return '';
}

const tuple = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
const stationRange = (f: Flight): number => { const s = SECTOR.station.at; return Math.hypot(f.pos.x - s[0], f.pos.y - s[1], f.pos.z - s[2]); };

export function createSector(saved: Saved = freshSave(), accounts: readonly Account[] = TEST_ACCOUNTS) {
    const fault = auditSave(saved);
    if (fault) throw new Error(fault);
    let remaining = saved.rock.remaining, tick = 0, turn = 0, dirty = false, owed = 0;
    const pilots = new Map<string, Pilot>();
    accounts.forEach((account, i) => {
        const kept = saved.pilots[account.id];
        const p = kept ? vec3(kept.p)! : [...SECTOR.berths[i % SECTOR.berths.length]!] as Vec3, q = kept ? quat4(kept.q)! : [0, 0, 0, 1] as Quat4;
        pilots.set(account.id, {
            account, cargo: kept?.cargo ?? 0, stored: kept?.stored ?? 0, docked: kept?.docked ?? false, ops: kept ? kept.ops.map((op) => ({ ...op })) : [],
            flight: atRest({ x: p[0], y: p[1], z: p[2] }, { x: q[0], y: q[1], z: q[2], w: q[3] }), here: false,
            orders: { ...NO_ORDERS }, waiting: [], taken: 0, ack: 0, starved: 0, dropped: 0, wantsMine: false, mining: false, why: 'NOT MINING',
        });
    });
    for (const id of Object.keys(saved.pilots)) if (!pilots.has(id)) throw new Error(`the save holds cargo for ${id}, who has no account here`);

    const login = (id: unknown, token: unknown): Account | null => {
        const pilot = typeof id === 'string' ? pilots.get(id) : undefined;
        return pilot && typeof token === 'string' && token === pilot.account.token ? pilot.account : null;
    };

    /** A pilot takes her helm: orders are numbered from 1 again, and whatever an earlier seat had queued is gone. */
    const enter = (id: string): void => {
        const pilot = pilots.get(id)!;
        pilot.here = true; pilot.wantsMine = false; pilot.mining = false; pilot.why = 'NOT MINING';
        pilot.waiting = []; pilot.taken = 0; pilot.ack = 0; pilot.orders = { ...NO_ORDERS };
    };

    /** Nobody at the helm: the engine is stopped and the helm put amidships, and she runs her way off where she is. A docked ship stays docked. */
    const leave = (id: string): void => {
        const pilot = pilots.get(id);
        if (!pilot) return;
        pilot.here = false; pilot.wantsMine = false; pilot.mining = false; pilot.why = 'NOT MINING';
        pilot.waiting = []; pilot.orders = { ...NO_ORDERS };
    };

    /**
     * Orders from a helm, to be flown one a step in the order they were given. A number at or below one already
     * taken is a repeat and is dropped; more than can wait pushes the oldest out. A docked ship takes the numbers
     * and flies none of them. Returns the highest number taken.
     */
    const steer = (id: string, sent: unknown): number => {
        const pilot = pilots.get(id);
        if (!pilot || !pilot.here || !Array.isArray(sent)) return pilot?.taken ?? 0;
        for (const one of sent.slice(0, ORDERS_A_CALL) as { seq?: unknown }[]) {
            const seq = one?.seq;
            if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= pilot.taken) continue;
            pilot.taken = seq;
            if (pilot.docked) { pilot.ack = seq; continue; }
            pilot.waiting.push({ seq, orders: cleanOrders(one as Partial<Orders>) });
            while (pilot.waiting.length > ORDERS_WAITING) { pilot.waiting.shift(); pilot.dropped++; }
        }
        return pilot.taken;
    };

    const mine = (id: string, on: unknown): boolean => {
        const pilot = pilots.get(id);
        if (!pilot || !pilot.here || typeof on !== 'boolean') return false;
        pilot.wantsMine = on;
        return true;
    };

    /**
     * Making fast to the station, or casting off. Whether she may is the server's to say, from where it has flown her
     * and how fast she is going: nothing a client sends about being docked, near or stopped is read. Docked, she is held:
     * her way is taken off and her helm does nothing until she casts off.
     */
    const dock = (id: string, want: unknown): { docked: boolean; why: DockRefusal } => {
        const pilot = pilots.get(id);
        if (!pilot || !pilot.here || typeof want !== 'boolean') return { docked: pilot?.docked ?? false, why: 'TOO FAR' };
        if (!want) {
            if (pilot.docked) { pilot.docked = false; dirty = true; }
            return { docked: false, why: '' };
        }
        if (pilot.docked) return { docked: true, why: '' };
        const why = mayDock(stationRange(pilot.flight), pilot.flight.speed);
        if (why) return { docked: false, why };
        pilot.docked = true;
        pilot.flight = { ...pilot.flight, yawRate: 0, pitchRate: 0, rollRate: 0, bank: 0, throttle: 0, speed: 0 };
        pilot.waiting = []; pilot.ack = pilot.taken; pilot.orders = { ...NO_ORDERS };
        pilot.wantsMine = false;
        dirty = true;
        return { docked: true, why: '' };
    };

    /**
     * Ore between this pilot's hold and this pilot's warehouse: there is no way to name another's. `op` is the order's own
     * name, made by whoever gives it; an order already answered is answered the same again and moves nothing, whatever it
     * now says. An order is refused as a value, and the refusal is remembered like a success, so a retry is told the same.
     * `fresh` says whether this call is the one that decided it: the caller must have that on disk before saying so.
     */
    const transfer = (id: string, op: unknown, withdraw: unknown, grams: unknown): Transfer & { fresh: boolean; moved: boolean } => {
        const pilot = pilots.get(id)!;
        const refuse = (why: TransferRefusal, keep: boolean): Transfer & { fresh: boolean; moved: boolean } => {
            const out: Transfer = { op: typeof op === 'string' ? op.slice(0, 64) : '', ok: false, why, withdraw: withdraw === true, grams: whole(grams) && grams <= SECTOR.rock.total ? grams : 0, cargo: pilot.cargo, stored: pilot.stored };
            if (keep) { pilot.ops.push(out); while (pilot.ops.length > OPS_KEPT) pilot.ops.shift(); dirty = true; }
            return { ...out, fresh: keep, moved: false };
        };
        if (!pilot.here || typeof op !== 'string' || op.length < 8 || op.length > 64 || typeof withdraw !== 'boolean') return refuse('BAD ORDER', false);
        const before = pilot.ops.find((one) => one.op === op);
        if (before) return { ...before, fresh: false, moved: false };
        if (!pilot.docked) return refuse('NOT DOCKED', true);
        if (typeof grams !== 'number' || !Number.isInteger(grams) || grams <= 0 || grams > SECTOR.rock.total) return refuse('BAD AMOUNT', true);
        if (withdraw) {
            if (grams > pilot.stored) return refuse('NOT ENOUGH IN THE WAREHOUSE', true);
            if (pilot.cargo + grams > SECTOR.capacity) return refuse('HOLD FULL', true);
            pilot.stored -= grams; pilot.cargo += grams;
        } else {
            if (grams > pilot.cargo) return refuse('NOT ENOUGH IN THE HOLD', true);
            pilot.cargo -= grams; pilot.stored += grams;
        }
        const done: Transfer = { op, ok: true, why: '', withdraw, grams, cargo: pilot.cargo, stored: pilot.stored };
        pilot.ops.push(done);
        while (pilot.ops.length > OPS_KEPT) pilot.ops.shift();
        dirty = true;
        return { ...done, fresh: true, moved: true };
    };

    /** One step of flight for every ship, by the server's own count of steps. A docked ship is not flown. */
    const fly = (): void => {
        for (const pilot of pilots.values()) {
            if (pilot.docked) continue;
            if (pilot.here) {
                const next = pilot.waiting.shift();
                if (next) { pilot.orders = next.orders; pilot.ack = next.seq; } else if (pilot.taken > 0) pilot.starved++;
            }
            const before = pilot.flight.pos;
            stepFlight(pilot.flight, pilot.orders, FLIGHT_TICK);
            if (before.x !== pilot.flight.pos.x || before.y !== pilot.flight.pos.y || before.z !== pilot.flight.pos.z) dirty = true;
        }
    };

    const dig = (seconds: number): void => {
        const miners: Pilot[] = [];
        const rock = SECTOR.rock.at;
        for (const pilot of pilots.values()) {
            pilot.mining = false;
            if (!pilot.here || !pilot.wantsMine) { pilot.why = 'NOT MINING'; continue; }
            if (remaining <= 0) { pilot.why = 'ROCK EXHAUSTED'; continue; }
            const at = pilot.flight.pos;
            if (Math.hypot(at.x - rock[0], at.y - rock[1], at.z - rock[2]) > SECTOR.range) { pilot.why = 'OUT OF RANGE'; continue; }
            if (pilot.cargo >= SECTOR.capacity) { pilot.why = 'HOLD FULL'; continue; }
            pilot.why = '';
            miners.push(pilot);
        }
        if (miners.length === 0 || seconds <= 0) return;
        const wants = miners.map((pilot) => Math.min(Math.floor(SECTOR.rate * seconds), SECTOR.capacity - pilot.cargo));
        const got = allot(remaining, wants, turn++ % miners.length);
        miners.forEach((pilot, i) => {
            const grams = got[i]!;
            if (grams <= 0) return;
            pilot.cargo += grams;
            remaining -= grams;
            pilot.mining = true;
            dirty = true;
        });
    };

    /** The server's clock moved on by `ms`: as many whole steps of flight as that is, and that much mining. */
    const step = (ms: number): void => {
        tick++;
        const seconds = Number.isFinite(ms) ? Math.min(250, Math.max(0, ms)) / 1000 : 0;
        owed += seconds;
        while (owed >= FLIGHT_TICK) { owed -= FLIGHT_TICK; fly(); }
        dig(seconds);
    };

    const view = (pilot: Pilot): PilotView => {
        const q = attitudeOf(pilot.flight), forward = forwardOf(pilot.flight), pace = pilot.flight.speed * FIELD_DRIFT;
        return { account: pilot.account.id, name: pilot.account.name, p: tuple(pilot.flight.pos), q: [q.x, q.y, q.z, q.w], v: [forward.x * pace, forward.y * pace, forward.z * pace], th: pilot.flight.throttle, mining: pilot.mining, docked: pilot.docked, cargo: pilot.cargo };
    };

    const welcome = (id: string) => {
        const pilot = pilots.get(id)!;
        return {
            account: id, name: pilot.account.name, flight: copyFlight(pilot.flight), cargo: pilot.cargo, stored: pilot.stored, docked: pilot.docked,
            sector: {
                id: SECTOR.id, name: SECTOR.name, rock: { id: SECTOR.rock.id, at: [...SECTOR.rock.at] as Vec3, total: SECTOR.rock.total, remaining }, range: SECTOR.range, rate: SECTOR.rate, capacity: SECTOR.capacity,
                station: { id: SECTOR.station.id, name: SECTOR.station.name, at: [...SECTOR.station.at] as Vec3, dockRange: SECTOR.station.dockRange, dockSpeed: SECTOR.station.dockSpeed },
            },
        };
    };

    const stateFor = (id: string) => {
        const pilot = pilots.get(id)!;
        return {
            tick, rock: remaining, flight: copyFlight(pilot.flight), ack: pilot.ack, waiting: pilot.waiting.length, starved: pilot.starved, dropped: pilot.dropped,
            you: { p: tuple(pilot.flight.pos), cargo: pilot.cargo, stored: pilot.stored, docked: pilot.docked, mining: pilot.mining, why: pilot.why, station: stationRange(pilot.flight) },
            others: [...pilots.values()].filter((other) => other !== pilot && other.here).map(view),
        };
    };

    const save = (): Saved => {
        const out = freshSave();
        out.rock.remaining = remaining;
        for (const pilot of pilots.values()) {
            const l = pilot.flight.level;
            out.pilots[pilot.account.id] = { cargo: pilot.cargo, stored: pilot.stored, docked: pilot.docked, p: tuple(pilot.flight.pos), q: [l.x, l.y, l.z, l.w], ops: pilot.ops.map((op) => ({ ...op })) };
        }
        return out;
    };

    /** The sector's ore, wherever it is: what the rock has left, what is in holds, what is in warehouses. They are always the whole. */
    const ore = (): { remaining: number; held: number; stored: number; total: number } => {
        let held = 0, stored = 0;
        for (const pilot of pilots.values()) { held += pilot.cargo; stored += pilot.stored; }
        return { remaining, held, stored, total: SECTOR.rock.total };
    };

    return {
        login, enter, leave, steer, mine, dock, transfer, step, welcome, stateFor, save, ore,
        here: (id: string): boolean => pilots.get(id)?.here === true,
        takeDirty: (): boolean => { const was = dirty; dirty = false; return was; },
    };
}

export type Sector = ReturnType<typeof createSector>;

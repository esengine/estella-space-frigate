import { SECTOR, allot, quat4, vec3, type PilotView, type Quat4, type Refusal, type Vec3 } from '../src/shared/sector';
import { FLIGHT_TICK, NO_ORDERS, atRest, attitudeOf, cleanOrders, copyFlight, forwardOf, stepFlight, type Flight, type Orders } from '../src/shared/steer';
import { FIELD_DRIFT } from '../src/shipState';

export interface Account { id: string; name: string; token: string }

export const TEST_ACCOUNTS: readonly Account[] = [
    { id: 'pilot-a', name: 'PILOT A', token: 'test-token-a' },
    { id: 'pilot-b', name: 'PILOT B', token: 'test-token-b' },
];

export interface Saved {
    version: 1;
    sector: string;
    rock: { id: string; total: number; remaining: number };
    /** `p` is where she is and `q` the way she heads; a ship is saved at rest, since nobody is at her helm when a server starts. */
    pilots: Record<string, { cargo: number; p: Vec3; q: Quat4 }>;
}

/**
 * The orders waiting to be flown, at most: four tenths of a second, which rides out an uneven link or a hitch in a client's frames.
 * Waiting orders buy nothing: they are flown one a step like any others, so a longer wait is only a later ship.
 */
export const ORDERS_WAITING = 12;
const ORDERS_A_CALL = 32;

interface Pilot {
    account: Account; cargo: number; flight: Flight; here: boolean;
    orders: Orders; waiting: { seq: number; orders: Orders }[]; taken: number; ack: number; starved: number; dropped: number;
    wantsMine: boolean; mining: boolean; why: Refusal;
}

export function freshSave(): Saved {
    return { version: 1, sector: SECTOR.id, rock: { id: SECTOR.rock.id, total: SECTOR.rock.total, remaining: SECTOR.rock.total }, pilots: {} };
}

export function auditSave(saved: Saved): string {
    if (saved === null || typeof saved !== 'object' || saved.version !== 1 || saved.sector !== SECTOR.id || saved.rock?.id !== SECTOR.rock.id || typeof saved.pilots !== 'object' || saved.pilots === null) return 'the save is for another sector or version';
    const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
    if (!whole(saved.rock.total) || !whole(saved.rock.remaining) || saved.rock.total !== SECTOR.rock.total) return 'the rock is not the one this sector holds';
    let held = 0;
    for (const [id, pilot] of Object.entries(saved.pilots)) {
        if (!whole(pilot.cargo) || !vec3(pilot.p) || !quat4(pilot.q)) return `pilot ${id} is not a pilot this server wrote`;
        held += pilot.cargo;
    }
    if (held + saved.rock.remaining !== saved.rock.total) return `ore does not add up: ${held} g held + ${saved.rock.remaining} g left is not ${saved.rock.total} g`;
    return '';
}

const tuple = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];

export function createSector(saved: Saved = freshSave(), accounts: readonly Account[] = TEST_ACCOUNTS) {
    const fault = auditSave(saved);
    if (fault) throw new Error(fault);
    let remaining = saved.rock.remaining, tick = 0, turn = 0, dirty = false, owed = 0;
    const pilots = new Map<string, Pilot>();
    accounts.forEach((account, i) => {
        const kept = saved.pilots[account.id];
        const p = kept ? vec3(kept.p)! : [...SECTOR.berths[i % SECTOR.berths.length]!] as Vec3, q = kept ? quat4(kept.q)! : [0, 0, 0, 1] as Quat4;
        pilots.set(account.id, {
            account, cargo: kept?.cargo ?? 0, flight: atRest({ x: p[0], y: p[1], z: p[2] }, { x: q[0], y: q[1], z: q[2], w: q[3] }), here: false,
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

    /** Nobody at the helm: the engine is stopped and the helm put amidships, and she runs her way off where she is. */
    const leave = (id: string): void => {
        const pilot = pilots.get(id);
        if (!pilot) return;
        pilot.here = false; pilot.wantsMine = false; pilot.mining = false; pilot.why = 'NOT MINING';
        pilot.waiting = []; pilot.orders = { ...NO_ORDERS };
    };

    /**
     * Orders from a helm, to be flown one a step in the order they were given. A number at or below one already
     * taken is a repeat and is dropped; more than can wait pushes the oldest out. Returns the highest number taken.
     */
    const steer = (id: string, sent: unknown): number => {
        const pilot = pilots.get(id);
        if (!pilot || !pilot.here || !Array.isArray(sent)) return pilot?.taken ?? 0;
        for (const one of sent.slice(0, ORDERS_A_CALL) as { seq?: unknown }[]) {
            const seq = one?.seq;
            if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= pilot.taken) continue;
            pilot.taken = seq;
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

    /** One step of flight for every ship, by the server's own count of steps. */
    const fly = (): void => {
        for (const pilot of pilots.values()) {
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
        return { account: pilot.account.id, name: pilot.account.name, p: tuple(pilot.flight.pos), q: [q.x, q.y, q.z, q.w], v: [forward.x * pace, forward.y * pace, forward.z * pace], th: pilot.flight.throttle, mining: pilot.mining, cargo: pilot.cargo };
    };

    const welcome = (id: string) => {
        const pilot = pilots.get(id)!;
        return {
            account: id, name: pilot.account.name, flight: copyFlight(pilot.flight), cargo: pilot.cargo,
            sector: { id: SECTOR.id, name: SECTOR.name, rock: { id: SECTOR.rock.id, at: [...SECTOR.rock.at] as Vec3, total: SECTOR.rock.total, remaining }, range: SECTOR.range, rate: SECTOR.rate, capacity: SECTOR.capacity },
        };
    };

    const stateFor = (id: string) => {
        const pilot = pilots.get(id)!;
        return {
            tick, rock: remaining, flight: copyFlight(pilot.flight), ack: pilot.ack, waiting: pilot.waiting.length, starved: pilot.starved, dropped: pilot.dropped,
            you: { p: tuple(pilot.flight.pos), cargo: pilot.cargo, mining: pilot.mining, why: pilot.why },
            others: [...pilots.values()].filter((other) => other !== pilot && other.here).map(view),
        };
    };

    const save = (): Saved => {
        const out = freshSave();
        out.rock.remaining = remaining;
        for (const pilot of pilots.values()) { const l = pilot.flight.level; out.pilots[pilot.account.id] = { cargo: pilot.cargo, p: tuple(pilot.flight.pos), q: [l.x, l.y, l.z, l.w] }; }
        return out;
    };

    const ore = (): { remaining: number; held: number; total: number } => {
        let held = 0;
        for (const pilot of pilots.values()) held += pilot.cargo;
        return { remaining, held, total: SECTOR.rock.total };
    };

    return {
        login, enter, leave, steer, mine, step, welcome, stateFor, save, ore,
        here: (id: string): boolean => pilots.get(id)?.here === true,
        takeDirty: (): boolean => { const was = dirty; dirty = false; return was; },
    };
}

export type Sector = ReturnType<typeof createSector>;

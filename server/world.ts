import { MOORINGS, SECTOR, allot, berthOf, inHand, mayDock, quat4, vec3, type DockRefusal, type Mooring, type PilotView, type Quat4, type Refusal, type Transfer, type TransferRefusal, type Vec3 } from '../src/shared/sector';
import { FLIGHT_TICK, NO_ORDERS, atRest, attitudeOf, cleanOrders, copyFlight, forwardOf, stepFlight, unitQuat, type Flight, type Orders, type Quat, type Vec } from '../src/shared/steer';
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
    /** The berth kept for her or that she lies in, by its number; 0 is none. No two pilots have the same one. */
    berth: number;
    /** Where she stands with the station. A save taken while the station had her in hand is read as the manoeuvre finished. */
    mooring: Mooring;
    /**
     * The number of the last order to move ore that was answered. Orders are numbered 1, 2, 3 for each pilot for as long as the
     * sector lives, and one whose number is at or below this is never done: that, and not a list of what was done, is what
     * stops an old order being done again, however many came after it and however often the server was restarted.
     */
    moves: number;
    /** `p` is where she is and `q` the way she heads; a ship is saved at rest, since nobody is at her helm when a server starts. */
    p: Vec3;
    q: Quat4;
    /** The last few answers, so that an order asked again straight away is told what it was told. Being forgotten here undoes nothing. */
    ops: Transfer[];
    /**
     * When a berth that is only kept for her is given up, in milliseconds of the clock on the wall: set the moment her pilot
     * goes, and 0 while her pilot is at her helm or nothing is only kept. It is a time and not a count, so that a server stopped
     * and started gives the berth up when it would have, and not thirty seconds after it came back.
     */
    lapses?: number;
}

export interface Saved {
    version: 4;
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
/**
 * The answers kept for each pilot, to give again to an order asked again. It is a convenience and can be any size: an order
 * that has dropped out of it is refused as expired, never done a second time, because its number is behind `moves`.
 */
export const ANSWERS_KEPT = 8;
/** A ship in her berth that no save has yet: her glass is told so once it has lasted this long, which a working disk never takes. */
const UNSAVED_SAID_MS = 400;

interface Pilot {
    account: Account; cargo: number; stored: number; moves: number; ops: Transfer[]; flight: Flight; here: boolean;
    berth: number; mooring: Mooring;
    /** While the station has her in hand: which leg of the way in or out she is on, and the way she is being moved, for others to draw her by. */
    leg: number; vel: Vec;
    /** When a berth only kept for her is given up, on the wall's clock (0: not while things stand as they do), and what stands between her and being taken in hand. */
    lapses: number; hold: DockRefusal;
    /** Lying in her berth at the end of the way in, and for how long, while no save yet says so: -1 when that is not how she is. */
    arrived: number;
    orders: Orders; waiting: { seq: number; orders: Orders }[]; taken: number; ack: number; starved: number; dropped: number;
    wantsMine: boolean; mining: boolean; why: Refusal;
}

export function freshSave(): Saved {
    return { version: 4, sector: SECTOR.id, rock: { id: SECTOR.rock.id, total: SECTOR.rock.total, remaining: SECTOR.rock.total }, pilots: {} };
}

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * What is wrong with a save, or '' if nothing: above all, that the rock, every hold and every warehouse together are the ore the
 * sector was founded with; and that a berth is a berth the station has, held by one pilot.
 */
export function auditSave(saved: Saved): string {
    if (saved === null || typeof saved !== 'object' || saved.version !== 4 || saved.sector !== SECTOR.id || saved.rock?.id !== SECTOR.rock.id || typeof saved.pilots !== 'object' || saved.pilots === null) return 'the save is for another sector or version';
    if (!whole(saved.rock.total) || !whole(saved.rock.remaining) || saved.rock.total !== SECTOR.rock.total) return 'the rock is not the one this sector holds';
    let held = 0;
    const taken = new Set<number>();
    for (const [id, pilot] of Object.entries(saved.pilots)) {
        if (!whole(pilot.cargo) || !whole(pilot.stored) || !whole(pilot.moves) || !vec3(pilot.p) || !quat4(pilot.q) || !Array.isArray(pilot.ops)) return `pilot ${id} is not a pilot this server wrote`;
        if (!MOORINGS.includes(pilot.mooring) || !whole(pilot.berth) || (pilot.mooring === 'none') !== (pilot.berth === 0) || (pilot.berth !== 0 && !berthOf(pilot.berth))) return `pilot ${id} has a berth the station does not have, or none where she should`;
        if (pilot.berth !== 0 && taken.has(pilot.berth)) return `berth ${pilot.berth} is held by two pilots`;
        if (pilot.berth !== 0) taken.add(pilot.berth);
        if (pilot.lapses !== undefined && (!whole(pilot.lapses) || (pilot.lapses !== 0 && pilot.mooring !== 'assigned'))) return `pilot ${id} has a berth due to be given up that is not one only kept`;
        for (const op of pilot.ops) if (typeof op?.op !== 'string' || typeof op.ok !== 'boolean' || !whole(op.cargo) || !whole(op.stored) || !whole(op.seq) || op.seq < 1 || op.seq > pilot.moves) return `pilot ${id} has an order to move ore this server did not write`;
        held += pilot.cargo + pilot.stored;
    }
    if (held + saved.rock.remaining !== saved.rock.total) return `ore does not add up: ${held} g held and stored + ${saved.rock.remaining} g left is not ${saved.rock.total} g`;
    return '';
}

const tuple = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
const point = (v: readonly number[]): Vec => ({ x: v[0]!, y: v[1]!, z: v[2]! });
const stationRange = (f: Flight): number => { const s = SECTOR.station.at; return Math.hypot(f.pos.x - s[0], f.pos.y - s[1], f.pos.z - s[2]); };
const between = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const HEADING: Quat = unitQuat({ x: SECTOR.station.heading[0], y: SECTOR.station.heading[1], z: SECTOR.station.heading[2], w: SECTOR.station.heading[3] });
const STILL: Vec = { x: 0, y: 0, z: 0 };

/**
 * One step of a ship the station has in hand: she is carried toward `to` no faster than the station moves a ship, and turned
 * toward `facing` no faster than it turns one. Returns whether she is there, exactly, and the way she moved this step.
 */
export function tug(f: Flight, to: Vec, facing: Quat, dt: number): { there: boolean; vel: Vec } {
    const { speed, turn } = SECTOR.station.tug;
    const far = between(f.pos, to), reach = speed * dt;
    const from = f.pos;
    f.pos = far <= reach ? { ...to } : { x: from.x + ((to.x - from.x) * reach) / far, y: from.y + ((to.y - from.y) * reach) / far, z: from.z + ((to.z - from.z) * reach) / far };
    const dot = f.level.x * facing.x + f.level.y * facing.y + f.level.z * facing.z + f.level.w * facing.w, same = dot < 0 ? -1 : 1;
    const angle = 2 * Math.acos(Math.min(1, Math.abs(dot))), share = angle <= turn * dt ? 1 : (turn * dt) / angle;
    f.level = share >= 1 ? { ...facing } : unitQuat({ x: f.level.x + (facing.x * same - f.level.x) * share, y: f.level.y + (facing.y * same - f.level.y) * share, z: f.level.z + (facing.z * same - f.level.z) * share, w: f.level.w + (facing.w * same - f.level.w) * share });
    f.yawRate = 0; f.pitchRate = 0; f.rollRate = 0; f.bank = 0; f.throttle = 0; f.speed = 0;
    return { there: far <= reach && share >= 1, vel: dt > 0 ? { x: (f.pos.x - from.x) / dt, y: (f.pos.y - from.y) / dt, z: (f.pos.z - from.z) / dt } : STILL };
}

/**
 * `clock` is the wall's clock when the sector is made, after which the sector keeps time by what `step` is told has passed.
 * `keeper` says there is a disk under this sector: then a ship that reaches her berth is not called docked until a save that
 * has her there is written and `committed`. Without one (a sector that lives in memory) she is docked as she arrives.
 */
export function createSector(saved: Saved = freshSave(), accounts: readonly Account[] = TEST_ACCOUNTS, opts: { clock?: () => number; keeper?: boolean } = {}) {
    const fault = auditSave(saved);
    if (fault) throw new Error(fault);
    let remaining = saved.rock.remaining, tick = 0, turn = 0, dirty = false, owed = 0, failed = '';
    let wall = (opts.clock ?? Date.now)();
    const keeper = opts.keeper === true;
    const pilots = new Map<string, Pilot>();
    accounts.forEach((account, i) => {
        const kept = saved.pilots[account.id];
        const p = kept ? vec3(kept.p)! : [...SECTOR.berths[i % SECTOR.berths.length]!] as Vec3, q = kept ? quat4(kept.q)! : [0, 0, 0, 1] as Quat4;
        let flight = atRest({ x: p[0], y: p[1], z: p[2] }, { x: q[0], y: q[1], z: q[2], w: q[3] });
        let berth = kept?.berth ?? 0, mooring: Mooring = kept?.mooring ?? 'none';
        // A server that stopped while the station had a ship in hand comes back with the manoeuvre finished: a ship being brought in
        // or lying in her berth is in her berth, and one being taken out is where she was to be let go, free. None is left part way.
        const lie = berthOf(berth);
        if (lie && (mooring === 'docking' || mooring === 'docked')) { mooring = 'docked'; flight = atRest(point(lie.at), HEADING); }
        else if (lie && mooring === 'undocking') { mooring = 'none'; berth = 0; flight = atRest(point(lie.approach), HEADING); }
        // Nobody is at a helm when a server starts. A berth only kept lapses when its save says; one saved while its pilot was
        // still there (the server was killed under her) has thirty seconds from now, which is the soonest she can have gone.
        const lapses = mooring === 'assigned' ? (kept?.lapses || wall + SECTOR.station.reserveMs) : 0;
        pilots.set(account.id, {
            account, cargo: kept?.cargo ?? 0, stored: kept?.stored ?? 0, moves: kept?.moves ?? 0, ops: kept ? kept.ops.map((op) => ({ ...op })) : [],
            flight, here: false, berth, mooring, leg: 0, vel: STILL, lapses, hold: '', arrived: -1,
            orders: { ...NO_ORDERS }, waiting: [], taken: 0, ack: 0, starved: 0, dropped: 0, wantsMine: false, mining: false, why: 'NOT MINING',
        });
    });
    for (const id of Object.keys(saved.pilots)) if (!pilots.has(id)) throw new Error(`the save holds cargo for ${id}, who has no account here`);

    const login = (id: unknown, token: unknown): Account | null => {
        const pilot = typeof id === 'string' ? pilots.get(id) : undefined;
        return pilot && typeof token === 'string' && token === pilot.account.token ? pilot.account : null;
    };

    /**
     * A pilot takes her helm: orders are numbered from 1 again, and whatever an earlier seat had queued is gone. Her berth is
     * the account's and not the seat's: a second sign-in finds the same one, and takes no other.
     */
    const enter = (id: string): void => {
        const pilot = pilots.get(id)!;
        pilot.here = true; pilot.wantsMine = false; pilot.mining = false; pilot.why = 'NOT MINING';
        if (pilot.lapses !== 0) { pilot.lapses = 0; dirty = true; }
        pilot.waiting = []; pilot.taken = 0; pilot.ack = 0; pilot.orders = { ...NO_ORDERS };
    };

    /**
     * Nobody at the helm: the engine is stopped and the helm put amidships, and she runs her way off where she is. A ship the
     * station has in hand is carried on with, and a docked ship stays docked; a berth only kept for her is kept a while longer.
     */
    const leave = (id: string): void => {
        const pilot = pilots.get(id);
        if (!pilot) return;
        pilot.here = false; pilot.wantsMine = false; pilot.mining = false; pilot.why = 'NOT MINING';
        if (pilot.mooring === 'assigned') { pilot.lapses = Math.round(wall) + SECTOR.station.reserveMs; dirty = true; }
        pilot.waiting = []; pilot.orders = { ...NO_ORDERS };
    };

    /**
     * Orders from a helm, to be flown one a step in the order they were given. A number at or below one already
     * taken is a repeat and is dropped; more than can wait pushes the oldest out. A ship the station has in hand takes the
     * numbers and flies none of them. Returns the highest number taken.
     */
    const steer = (id: string, sent: unknown): number => {
        const pilot = pilots.get(id);
        if (!pilot || !pilot.here || !Array.isArray(sent)) return pilot?.taken ?? 0;
        for (const one of sent.slice(0, ORDERS_A_CALL) as { seq?: unknown }[]) {
            const seq = one?.seq;
            if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= pilot.taken) continue;
            pilot.taken = seq;
            if (inHand(pilot.mooring)) { pilot.ack = seq; continue; }
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

    const freeBerth = (): number => {
        const held = new Set([...pilots.values()].map((pilot) => pilot.berth));
        return SECTOR.station.berths.find((berth) => !held.has(berth.id))?.id ?? 0;
    };
    const release = (pilot: Pilot): void => { pilot.berth = 0; pilot.mooring = 'none'; pilot.leg = 0; pilot.vel = STILL; pilot.lapses = 0; pilot.hold = ''; pilot.arrived = -1; dirty = true; };

    /**
     * Asking the station for a berth, or giving one up.
     *
     * `want` true asks for a berth: the station keeps the first that nobody has for this pilot, who then has that one and no
     * other until it is given up, whoever signs in as her and however often she asks. `want` false gives it up: a berth only
     * kept is let go at once, and a docked ship is cast off, which closes her warehouse on the spot and takes her out the way
     * she came in. A ship the station is moving is not interrupted. Nothing here is decided by where a client says it is.
     */
    const dock = (id: string, want: unknown): { docked: boolean; why: DockRefusal; berth: number; mooring: Mooring } => {
        const pilot = pilots.get(id)!;
        const answer = (why: DockRefusal) => ({ docked: pilot.mooring === 'docked', why, berth: pilot.berth, mooring: pilot.mooring });
        if (!pilot.here || typeof want !== 'boolean') return answer('TOO FAR');
        if (want) {
            if (pilot.mooring !== 'none') return answer('');
            const berth = freeBerth();
            if (!berth) return answer('NO BERTH FREE');
            pilot.berth = berth; pilot.mooring = 'assigned'; pilot.lapses = 0; pilot.hold = 'TOO FAR';
            dirty = true;
            return answer('');
        }
        if (pilot.mooring === 'assigned') { release(pilot); return answer(''); }
        if (pilot.mooring === 'docked') { pilot.mooring = 'undocking'; pilot.leg = 0; pilot.wantsMine = false; dirty = true; return answer(''); }
        if (pilot.mooring === 'docking' || pilot.mooring === 'undocking') return answer('MANEUVERING');
        return answer('');
    };

    /**
     * Ore between this pilot's hold and this pilot's warehouse: there is no way to name another's. The warehouse is open
     * only to a ship lying in her berth: not to one on her way in, and not from the moment she is cast off.
     *
     * An order has a number, `seq`, and a name of its own, `op`. The number must be the next one for this pilot. One whose
     * number has been answered already is given that answer again if it is still remembered under that name, and is
     * otherwise refused as EXPIRED; either way it moves nothing, so no order is ever done twice. One whose number is
     * ahead of the next is OUT OF ORDER. An order is refused as a value, and a refusal takes its number like a success.
     *
     * A move is not made here until it is written: `persist` is handed the whole sector as it would be with the move in
     * it, and only when that returns are the balances, the number and the answer changed. If it throws, nothing has
     * happened: the order is told NOT SAVED, keeps its number, and asked again is done then, once.
     */
    const transfer = (id: string, seq: unknown, op: unknown, withdraw: unknown, grams: unknown, persist?: (after: Saved) => void): Transfer & { fresh: boolean; moved: boolean; next: number } => {
        const pilot = pilots.get(id)!;
        const shown = (): Pick<Transfer, 'seq' | 'op' | 'withdraw' | 'grams'> => ({
            seq: whole(seq) && seq <= 0xffffffff ? seq : 0, op: typeof op === 'string' ? op.slice(0, 64) : '', withdraw: withdraw === true,
            grams: whole(grams) && grams <= SECTOR.rock.total ? grams : 0,
        });
        /** A refusal that takes no number: the order was not one, or was not this pilot's next. */
        const turnAway = (why: TransferRefusal) => ({ ...shown(), ok: false, why, cargo: pilot.cargo, stored: pilot.stored, fresh: false, moved: false, next: pilot.moves + 1 });
        const remember = (answer: Transfer): Transfer[] => [...pilot.ops, answer].slice(-ANSWERS_KEPT);
        if (!pilot.here || typeof op !== 'string' || op.length < 8 || op.length > 64 || typeof withdraw !== 'boolean' || !whole(seq) || seq < 1 || seq > 0xffffffff) return turnAway('BAD ORDER');
        if (seq <= pilot.moves) {
            const before = pilot.ops.find((one) => one.seq === seq && one.op === op);
            return before ? { ...before, fresh: false, moved: false, next: pilot.moves + 1 } : turnAway('EXPIRED');
        }
        if (seq !== pilot.moves + 1) return turnAway('OUT OF ORDER');
        let why: TransferRefusal = '';
        if (pilot.mooring !== 'docked') why = 'NOT DOCKED';
        else if (typeof grams !== 'number' || !Number.isInteger(grams) || grams <= 0 || grams > SECTOR.rock.total) why = 'BAD AMOUNT';
        else if (withdraw && grams > pilot.stored) why = 'NOT ENOUGH IN THE WAREHOUSE';
        else if (withdraw && pilot.cargo + grams > SECTOR.capacity) why = 'HOLD FULL';
        else if (!withdraw && grams > pilot.cargo) why = 'NOT ENOUGH IN THE HOLD';
        if (why) {
            const refused: Transfer = { ...shown(), ok: false, why, cargo: pilot.cargo, stored: pilot.stored };
            pilot.moves = seq;
            pilot.ops = remember(refused);
            dirty = true;
            return { ...refused, fresh: true, moved: false, next: pilot.moves + 1 };
        }
        const amount = grams as number;
        const cargo = withdraw ? pilot.cargo + amount : pilot.cargo - amount, stored = withdraw ? pilot.stored - amount : pilot.stored + amount;
        const done: Transfer = { seq, op, ok: true, why: '', withdraw, grams: amount, cargo, stored };
        const ops = remember(done);
        if (persist) {
            const after = save();
            after.pilots[id] = { ...after.pilots[id]!, cargo, stored, moves: seq, ops: ops.map((one) => ({ ...one })) };
            try { persist(after); } catch (err) {
                failed = err instanceof Error ? err.message : String(err);
                return turnAway('NOT SAVED');
            }
        }
        pilot.cargo = cargo; pilot.stored = stored; pilot.moves = seq; pilot.ops = ops;
        return { ...done, fresh: true, moved: true, next: pilot.moves + 1 };
    };

    /** Whether a ship with a berth kept for her is taken in hand now: she is at her approach point and slow enough, as the server has flown her. */
    const clearance = (pilot: Pilot): DockRefusal => mayDock(between(pilot.flight.pos, point(berthOf(pilot.berth)!.approach)), pilot.flight.speed);

    /**
     * One step of flight for every ship, by the server's own count of steps. A ship lying in her berth is not moved. One the
     * station has in hand is carried by it along a way that is the same for every ship at that berth: in, to her approach
     * point and round to the berth's heading, across to over the berth, and straight down into it; out, straight up and
     * back across to the approach point, where she is let go at rest, clear of the station, with her helm her pilot's again
     * and her berth free. Every other ship is flown by her orders, and one with a berth kept for her is taken in hand the
     * step she meets the conditions for it.
     */
    const fly = (): void => {
        for (const pilot of pilots.values()) {
            const lie = berthOf(pilot.berth);
            if (pilot.mooring === 'docked') { pilot.vel = STILL; continue; }
            // At the end of the way in and not yet written down: she lies there, and waits.
            if (pilot.arrived >= 0) { pilot.vel = STILL; continue; }
            if (lie && (pilot.mooring === 'docking' || pilot.mooring === 'undocking')) {
                const way = pilot.mooring === 'docking' ? [lie.approach, lie.over, lie.at] : [lie.over, lie.approach];
                const moved = tug(pilot.flight, point(way[pilot.leg]!), HEADING, FLIGHT_TICK);
                pilot.vel = moved.vel;
                if (moved.there) pilot.leg++;
                if (pilot.leg >= way.length) {
                    pilot.flight = atRest(point(way[way.length - 1]!), HEADING);
                    // With a disk under the sector she is not docked until the disk says she is in her berth: see `committed`.
                    if (pilot.mooring === 'docking' && keeper) { pilot.arrived = 0; pilot.vel = STILL; }
                    else if (pilot.mooring === 'docking') { pilot.mooring = 'docked'; pilot.leg = 0; pilot.vel = STILL; }
                    else { release(pilot); pilot.orders = { ...NO_ORDERS }; pilot.waiting = []; }
                }
                dirty = true;
                continue;
            }
            if (pilot.here) {
                const next = pilot.waiting.shift();
                if (next) { pilot.orders = next.orders; pilot.ack = next.seq; } else if (pilot.taken > 0) pilot.starved++;
            }
            const before = pilot.flight.pos;
            stepFlight(pilot.flight, pilot.orders, FLIGHT_TICK);
            pilot.vel = STILL;
            if (before.x !== pilot.flight.pos.x || before.y !== pilot.flight.pos.y || before.z !== pilot.flight.pos.z) dirty = true;
            if (pilot.mooring === 'assigned' && pilot.here) {
                pilot.hold = clearance(pilot);
                if (pilot.hold === '') {
                    pilot.mooring = 'docking'; pilot.leg = 0; pilot.wantsMine = false;
                    pilot.flight = { ...pilot.flight, yawRate: 0, pitchRate: 0, rollRate: 0, bank: 0, throttle: 0, speed: 0 };
                    pilot.waiting = []; pilot.ack = pilot.taken; pilot.orders = { ...NO_ORDERS };
                    dirty = true;
                }
            }
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

    /**
     * The server's clock moved on by `ms`: as many whole steps of flight as that is, that much mining, and that much nearer
     * to giving up a berth that is only kept for a pilot who is gone.
     */
    const step = (ms: number): void => {
        tick++;
        const passed = Number.isFinite(ms) ? Math.min(250, Math.max(0, ms)) : 0, seconds = passed / 1000;
        // The wall's clock is not held back as the flying is: a berth lapses when it was due, however the server's steps fell.
        wall += Number.isFinite(ms) ? Math.max(0, ms) : 0;
        owed += seconds;
        while (owed >= FLIGHT_TICK) { owed -= FLIGHT_TICK; fly(); }
        dig(seconds);
        for (const pilot of pilots.values()) {
            if (pilot.arrived >= 0) pilot.arrived += passed;
            if (pilot.mooring === 'assigned' && !pilot.here && pilot.lapses !== 0 && wall >= pilot.lapses) release(pilot);
        }
    };

    const view = (pilot: Pilot): PilotView => {
        const q = attitudeOf(pilot.flight), forward = forwardOf(pilot.flight), pace = pilot.flight.speed * FIELD_DRIFT;
        const v: Vec3 = inHand(pilot.mooring) ? tuple(pilot.vel) : [forward.x * pace, forward.y * pace, forward.z * pace];
        return { account: pilot.account.id, name: pilot.account.name, p: tuple(pilot.flight.pos), q: [q.x, q.y, q.z, q.w], v, th: pilot.flight.throttle, mining: pilot.mining, docked: pilot.mooring === 'docked', berth: pilot.berth, mooring: pilot.mooring, cargo: pilot.cargo };
    };

    const welcome = (id: string) => {
        const pilot = pilots.get(id)!, station = SECTOR.station;
        return {
            account: id, name: pilot.account.name, flight: copyFlight(pilot.flight), cargo: pilot.cargo, stored: pilot.stored, docked: pilot.mooring === 'docked', berth: pilot.berth, mooring: pilot.mooring, next: pilot.moves + 1,
            sector: {
                id: SECTOR.id, name: SECTOR.name, rock: { id: SECTOR.rock.id, at: [...SECTOR.rock.at] as Vec3, total: SECTOR.rock.total, remaining }, range: SECTOR.range, rate: SECTOR.rate, capacity: SECTOR.capacity,
                station: { id: station.id, name: station.name, at: [...station.at] as Vec3, approachRange: station.approachRange, dockSpeed: station.dockSpeed, berths: station.berths.map((berth) => ({ id: berth.id, at: [...berth.at] as Vec3, over: [...berth.over] as Vec3, approach: [...berth.approach] as Vec3 })) },
            },
        };
    };

    const stateFor = (id: string) => {
        const pilot = pilots.get(id)!;
        return {
            tick, rock: remaining, flight: copyFlight(pilot.flight), ack: pilot.ack, waiting: pilot.waiting.length, starved: pilot.starved, dropped: pilot.dropped,
            you: {
                p: tuple(pilot.flight.pos), cargo: pilot.cargo, stored: pilot.stored, docked: pilot.mooring === 'docked', berth: pilot.berth, mooring: pilot.mooring,
                // In her berth and not yet called docked: said at once to a check, and to her glass only once it has lasted.
                hold: pilot.mooring === 'assigned' ? pilot.hold : pilot.arrived >= UNSAVED_SAID_MS ? 'NOT SAVED' : '' as DockRefusal, arrived: pilot.arrived >= 0, next: pilot.moves + 1, mining: pilot.mining, why: pilot.why, station: stationRange(pilot.flight),
            },
            others: [...pilots.values()].filter((other) => other !== pilot && other.here).map(view),
        };
    };

    const save = (): Saved => {
        const out = freshSave();
        out.rock.remaining = remaining;
        for (const pilot of pilots.values()) {
            const l = pilot.flight.level;
            out.pilots[pilot.account.id] = { cargo: pilot.cargo, stored: pilot.stored, berth: pilot.berth, mooring: pilot.mooring, moves: pilot.moves, p: tuple(pilot.flight.pos), q: [l.x, l.y, l.z, l.w], ops: pilot.ops.map((op) => ({ ...op })), lapses: pilot.mooring === 'assigned' ? pilot.lapses : 0 };
        }
        return out;
    };

    /** The sector's ore, wherever it is: what the rock has left, what is in holds, what is in warehouses. They are always the whole. */
    const ore = (): { remaining: number; held: number; stored: number; total: number } => {
        let held = 0, stored = 0;
        for (const pilot of pilots.values()) { held += pilot.cargo; stored += pilot.stored; }
        return { remaining, held, stored, total: SECTOR.rock.total };
    };

    /**
     * `written` is on the disk. A ship lying at the end of her way in, whom it has in that berth, is docked from now: were the
     * server to stop this instant it would come back with her there. Until a save has her, she is not called docked, her
     * warehouse stays shut, and `unwritten` says a save is wanted at once.
     */
    const committed = (written: Saved): void => {
        for (const pilot of pilots.values()) {
            if (pilot.arrived < 0) continue;
            const kept = written.pilots[pilot.account.id];
            if (!kept || kept.berth !== pilot.berth || (kept.mooring !== 'docking' && kept.mooring !== 'docked')) continue;
            pilot.mooring = 'docked'; pilot.leg = 0; pilot.arrived = -1; pilot.vel = STILL;
            dirty = true;
        }
    };
    const unwritten = (): boolean => [...pilots.values()].some((pilot) => pilot.arrived >= 0);

    /** Who has each berth, by the station's own account: for a check to read. */
    const berths = () => SECTOR.station.berths.map((berth) => {
        const holder = [...pilots.values()].find((pilot) => pilot.berth === berth.id);
        return { id: berth.id, pilot: holder?.account.id ?? '', mooring: holder?.mooring ?? 'none' as Mooring, here: holder?.here ?? false, lapses: holder?.lapses ?? 0, arrived: (holder?.arrived ?? -1) >= 0 };
    });

    return {
        login, enter, leave, steer, mine, dock, transfer, step, welcome, stateFor, save, ore, berths, committed, unwritten,
        /** The highest helm order taken from this pilot's seat. */
        taken: (id: string): number => pilots.get(id)?.taken ?? 0,
        /** The wall's clock as the sector has it. */
        now: (): number => wall,
        here: (id: string): boolean => pilots.get(id)?.here === true,
        takeDirty: (): boolean => { const was = dirty; dirty = false; return was; },
        /** Something changed that is not on disk yet, or a write of it failed: it is written again until it is. */
        isDirty: (): boolean => dirty,
        markDirty: (): void => { dirty = true; },
        /** Why the last move that could not be written could not be, for the log. */
        lastFailure: (): string => failed,
    };
}

export type Sector = ReturnType<typeof createSector>;

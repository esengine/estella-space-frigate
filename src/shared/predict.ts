import { FLIGHT_TICK, NO_ORDERS, atRest, copyFlight, mulQuat, stepFlight, unitQuat, type Flight, type Orders, type Quat, type Vec } from './steer';

// A client's own ship while the server flies her: the helm answers at once because the orders are flown here too,
// and the server's word, when it comes, replaces the guess without the picture jumping.

export interface Numbered { seq: number; orders: Orders }

/** Past this many steps behind (a tab asleep, a stalled frame) the client does not try to catch up: it sails on from now. */
const STALL_TICKS = 6;
/** How long a correction takes to be let go of, seconds. */
const SETTLE = 0.12;
/** A correction this far off is not eased: the ship was somewhere else, and is shown there. */
const HARD = 200;
/** A correction a pilot would feel as being pulled back, in units. */
export const FELT = 5;
/** How closely the drawn ship follows the server's while the station moves her, seconds. */
const HELD = 0.09;
/** The orders the server should have waiting: enough to ride out an uneven link, few enough to add little to it. */
export const WAITING_AIM = 3;
/** The most this clock is hurried or held to keep them there. Nobody sees four parts in a hundred. */
const PACE_MOST = 0.04;

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
const conj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export const turnBetween = (a: Quat, b: Quat): number => 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)));

export function createPredictor() {
    let flight: Flight = atRest({ x: 0, y: 0, z: 0 });
    let pending: Numbered[] = [], outbox: Numbered[] = [];
    let seq = 0, owed = 0, pace = 1, last: Orders = { ...NO_ORDERS };
    let offPos: Vec = { x: 0, y: 0, z: 0 }, offTurn: Quat = { ...IDENTITY };
    /** The ship as drawn while the station has her in hand; null when she is her pilot's. */
    let hand: Flight | null = null;
    const fix = { count: 0, worst: 0, worstTurn: 0, hard: 0, recent: 0 };

    /** The ship to draw now: the predicted flight, carried into the part of a step not yet taken, with what is left of the last correction. */
    const show = (): Flight => {
        if (hand) return copyFlight(hand);
        const shown = copyFlight(flight);
        if (owed > 0) stepFlight(shown, last, owed);
        shown.pos = { x: shown.pos.x + offPos.x, y: shown.pos.y + offPos.y, z: shown.pos.z + offPos.z };
        shown.level = unitQuat(mulQuat(offTurn, shown.level));
        return shown;
    };

    /**
     * Taking the helm: the ship is where the server has her. A new sign-in counts its orders from 1, because the server
     * counts a new seat's from 1. Within one sign-in the count only ever goes up: given her helm back by the station, she
     * carries on from the number she had reached (`from`, the last the server took, if that is further on), since the server
     * drops any number at or below one it has taken.
     */
    const take = (truth: Flight, how: { signedIn: boolean; from?: number } = { signedIn: true }): void => {
        flight = copyFlight(truth);
        hand = null;
        pending = []; outbox = []; owed = 0; pace = 1;
        seq = how.signedIn ? 0 : Math.max(seq, Number.isInteger(how.from) ? how.from! : 0);
        offPos = { x: 0, y: 0, z: 0 }; offTurn = { ...IDENTITY };
    };

    /**
     * A frame. With `linked`, each whole step's orders are numbered, flown here and queued to send; without, the engine is
     * stopped and the helm put amidships, which is what the server does with a ship whose pilot is gone. held is a ship
     * made fast to the station.
     */
    const advance = (dt: number, orders: Orders, linked: boolean, held = false): void => {
        // In the station's hands nothing is flown here and no orders go out: she is where the server says. What is drawn is eased
        // toward that, since the server says it twenty times a second and a frame comes sixty.
        if (held) {
            hand ??= show();
            pending = []; outbox = []; owed = 0; last = NO_ORDERS;
            offPos = { x: 0, y: 0, z: 0 }; offTurn = { ...IDENTITY };
            const k = 1 - Math.exp(-Math.max(0, dt) / HELD), same = hand.level.x * flight.level.x + hand.level.y * flight.level.y + hand.level.z * flight.level.z + hand.level.w * flight.level.w < 0 ? -1 : 1;
            hand = {
                ...copyFlight(flight),
                pos: { x: hand.pos.x + (flight.pos.x - hand.pos.x) * k, y: hand.pos.y + (flight.pos.y - hand.pos.y) * k, z: hand.pos.z + (flight.pos.z - hand.pos.z) * k },
                level: unitQuat({ x: hand.level.x + (flight.level.x * same - hand.level.x) * k, y: hand.level.y + (flight.level.y * same - hand.level.y) * k, z: hand.level.z + (flight.level.z * same - hand.level.z) * k, w: hand.level.w + (flight.level.w * same - hand.level.w) * k }),
            };
            return;
        }
        hand = null;
        const flown = linked ? orders : NO_ORDERS;
        owed += Math.max(0, dt) * (linked ? pace : 1);
        if (owed > FLIGHT_TICK * STALL_TICKS) owed = FLIGHT_TICK * STALL_TICKS;
        while (owed >= FLIGHT_TICK) {
            owed -= FLIGHT_TICK;
            stepFlight(flight, flown, FLIGHT_TICK);
            if (!linked) continue;
            const one = { seq: ++seq, orders: { ...flown } };
            pending.push(one);
            outbox.push(one);
        }
        if (!linked) { pending = []; outbox = []; }
        last = flown;
        const ease = Math.exp(-Math.max(0, dt) / SETTLE), side = offTurn.w < 0 ? -ease : ease;
        offPos = { x: offPos.x * ease, y: offPos.y * ease, z: offPos.z * ease };
        offTurn = unitQuat({ x: offTurn.x * side, y: offTurn.y * side, z: offTurn.z * side, w: offTurn.w * side + (1 - ease) });
    };

    /** The server's word on this ship after the orders up to `ack`: it is the truth, and the orders it has not flown are flown again on top of it. */
    const settle = (truth: Flight, ack: number, waiting = WAITING_AIM): void => {
        // Two clocks never quite agree. If the server has too many orders waiting this one is running ahead and would have them
        // dropped; too few and the server runs dry. So this clock is held or hurried a little toward the number that should wait.
        const want = 1 + Math.max(-PACE_MOST, Math.min(PACE_MOST, (WAITING_AIM - waiting) * 0.012));
        pace += (want - pace) * 0.15;
        pending = pending.filter((one) => one.seq > ack);
        // The server never takes a number at or below one it has taken, so this count is never left behind its.
        if (Number.isInteger(ack) && ack > seq) seq = ack;
        const replayed = copyFlight(truth);
        for (const one of pending) stepFlight(replayed, one.orders, FLIGHT_TICK);
        const off = { x: flight.pos.x - replayed.pos.x, y: flight.pos.y - replayed.pos.y, z: flight.pos.z - replayed.pos.z };
        const far = Math.hypot(off.x, off.y, off.z), turned = turnBetween(flight.level, replayed.level);
        fix.recent = far;
        if (far > 1e-6 || turned > 1e-7) {
            fix.count++;
            fix.worst = Math.max(fix.worst, far);
            fix.worstTurn = Math.max(fix.worstTurn, turned);
            if (far > FELT) fix.hard++;
            if (far > HARD) { offPos = { x: 0, y: 0, z: 0 }; offTurn = { ...IDENTITY }; }
            else {
                offPos = { x: offPos.x + off.x, y: offPos.y + off.y, z: offPos.z + off.z };
                offTurn = unitQuat(mulQuat(mulQuat(offTurn, flight.level), conj(replayed.level)));
            }
        }
        flight = replayed;
    };

    return {
        show, take, advance, settle, fix,
        /** The number of the last order given: it only goes up while one sign-in lasts. */
        numbered: (): number => seq,
        /** The orders numbered since the last call, to send. */
        drain: (most = 32): Numbered[] => outbox.splice(0, most),
        unsent: (): number => outbox.length,
        ahead: (): number => pending.length,
        orders: (): Orders => last,
        /** How far what is drawn stands from the prediction: what is left of a correction, in units. */
        lag: (): number => Math.hypot(offPos.x, offPos.y, offPos.z),
        pace: (): number => pace,
    };
}

export type Predictor = ReturnType<typeof createPredictor>;

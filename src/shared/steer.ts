import { FIELD_DRIFT, TOP_SPEED } from '../shipState';

// How a frigate flies, with nothing of the engine or the screen in it: the game runs it for the ship in hand,
// and the sector server runs the same lines for every pilot, so what a helm can do is said once.

export type Vec = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

export const TURN_RATE = 0.3;
export const PITCH_RATE = 0.24;
export const YAW_THRUST = 0.14;
export const PITCH_THRUST = 0.11;
export const ROLL_RATE = 0.35;
export const ROLL_THRUST = 0.2;
export const THRUST_GAIN = 4;
export const BANK = 0.5;
export const THROTTLE_LAG = 2.2;
export const SPEED_LAG = 0.8;
/** The step the server flies every ship by, and the step a client predicts its own by. */
export const FLIGHT_TICK = 1 / 30;

export const mulQuat = (a: Quat, b: Quat): Quat => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

export function turnBy(q: Quat, v: Vec): Vec {
    const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
    return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
}

export const turnBack = (q: Quat, v: Vec): Vec => turnBy({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
export const about = (axis: 'x' | 'y' | 'z', angle: number): Quat => ({ x: 0, y: 0, z: 0, w: Math.cos(angle / 2), [axis]: Math.sin(angle / 2) });
export const within = (v: number, most: number): number => Math.max(-most, Math.min(most, v));
export const unitQuat = (q: Quat): Quat => { const l = Math.hypot(q.x, q.y, q.z, q.w) || 1; return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }; };

/** What a helm asks of the ship: the engine order, and the rudder, elevation and roll as shares of what she can turn. */
export interface Orders { order: number; rudder: number; elevation: number; roll: number }

/** Everything that is true of a ship in flight. `level` is her heading without the bank she leans into a turn with. */
export interface Flight { level: Quat; yawRate: number; pitchRate: number; rollRate: number; bank: number; throttle: number; speed: number; pos: Vec }

export const NO_ORDERS: Orders = { order: 0, rudder: 0, elevation: 0, roll: 0 };

export const atRest = (pos: Vec, level: Quat = { x: 0, y: 0, z: 0, w: 1 }): Flight => ({ level: unitQuat(level), yawRate: 0, pitchRate: 0, rollRate: 0, bank: 0, throttle: 0, speed: 0, pos: { ...pos } });
export const copyFlight = (f: Flight): Flight => ({ ...f, level: { ...f.level }, pos: { ...f.pos } });

const share = (v: unknown, low: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(low, Math.min(1, v)) : 0);
/** Orders as a ship can take them, whatever was sent: each within its range, and nothing where there was no number. */
export const cleanOrders = (o: { order?: unknown; rudder?: unknown; elevation?: unknown; roll?: unknown } | null | undefined): Orders =>
    ({ order: share(o?.order, 0), rudder: share(o?.rudder, -1), elevation: share(o?.elevation, -1), roll: share(o?.roll, -1) });

/** Her thrusters work toward the turn the helm asks for and she comes round as fast as they can push her. Returns how hard each fired. */
export function turnShip(f: Pick<Flight, 'level' | 'yawRate' | 'pitchRate' | 'rollRate' | 'bank'>, o: Orders, dt: number): { yaw: number; pitch: number; roll: number } {
    const want = { yaw: -o.rudder * TURN_RATE, pitch: o.elevation * PITCH_RATE, roll: o.roll * ROLL_RATE };
    const push = { yaw: within((want.yaw - f.yawRate) * THRUST_GAIN, YAW_THRUST), pitch: within((want.pitch - f.pitchRate) * THRUST_GAIN, PITCH_THRUST), roll: within((want.roll - f.rollRate) * THRUST_GAIN, ROLL_THRUST) };
    f.yawRate += push.yaw * dt;
    f.pitchRate += push.pitch * dt;
    f.rollRate += push.roll * dt;
    f.level = unitQuat(mulQuat(mulQuat(mulQuat(f.level, about('y', f.yawRate * dt)), about('x', -f.pitchRate * dt)), about('z', f.rollRate * dt)));
    f.bank += ((-f.yawRate / TURN_RATE) * BANK - f.bank) * Math.min(1, dt * 1.8);
    return { yaw: push.yaw / YAW_THRUST, pitch: push.pitch / PITCH_THRUST, roll: push.roll / ROLL_THRUST };
}

/** The drive follows the engine order, and her speed follows the drive: neither at once. */
export function driveShip(f: Pick<Flight, 'throttle' | 'speed'>, order: number, dt: number): void {
    f.throttle += (order - f.throttle) * Math.min(1, dt * THROTTLE_LAG);
    f.speed += (f.throttle * TOP_SPEED - f.speed) * Math.min(1, dt * SPEED_LAG);
}

export const forwardOf = (f: Pick<Flight, 'level'>): Vec => turnBy(f.level, { x: 0, y: 0, z: 1 });
export const attitudeOf = (f: Pick<Flight, 'level' | 'bank'>): Quat => mulQuat(f.level, about('z', f.bank));

/** One step of flight: she turns, sails on along her new heading at the speed she has, and her engine works toward its order. */
export function stepFlight(f: Flight, o: Orders, dt: number): void {
    turnShip(f, o, dt);
    const forward = forwardOf(f), run = f.speed * FIELD_DRIFT * dt;
    f.pos = { x: f.pos.x + forward.x * run, y: f.pos.y + forward.y * run, z: f.pos.z + forward.z * run };
    driveShip(f, o.order, dt);
}

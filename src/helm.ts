import { FIELD_DRIFT, ship } from './shipState';
import { PITCH_RATE, ROLL_RATE, TURN_RATE, about, attitudeOf, forwardOf, mulQuat, turnBack, turnBy, turnShip, within, type Flight, type Orders, type Quat, type Vec } from './shared/steer';

export { PITCH_RATE, PITCH_THRUST, ROLL_RATE, ROLL_THRUST, TURN_RATE, YAW_THRUST, mulQuat, turnBack, turnBy } from './shared/steer';
export type { Quat, Vec } from './shared/steer';

export const METRES = 1 / FIELD_DRIFT;
const LEVEL = 0.004;
const GATES = ['KESTREL GATE', 'TARN RELAY', 'OSSA ANCHORAGE'] as const;
const REPEAT = 0.32;

export const ENGINE_ORDERS = [0, 0.25, 0.5, 0.75, 1] as const;
export const RUDDER_ORDERS = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1] as const;
export const ELEVATION_ORDERS = [-1, -0.5, 0, 0.5, 1] as const;
const GATE_REACH = 260;
export const STANDOFF = 200;

const facing = (yaw: number, pitch: number, roll = 0): Quat => mulQuat(mulQuat(about('y', yaw), about('x', -pitch)), about('z', roll));

function toward(from: Quat, to: Quat, share: number): Quat {
    const same = from.x * to.x + from.y * to.y + from.z * to.z + from.w * to.w < 0 ? -1 : 1;
    const q = { x: from.x + (to.x * same - from.x) * share, y: from.y + (to.y * same - from.y) * share, z: from.z + (to.z * same - from.z) * share, w: from.w + (to.w * same - from.w) * share };
    const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

export type HelmMode = 'manual' | 'approach' | 'align' | 'level' | 'planet';

export const helm = {
    yaw: 0, pitch: 0, roll: 0, lean: 0, yawRate: 0, pitchRate: 0, rollRate: 0,
    jets: { yaw: 0, pitch: 0, roll: 0 },
    mode: 'manual' as HelmMode,
    order: 0.75,
    rudder: 0,
    elevation: 0,
    helmAngle: 0,
    attitude: facing(0, 0),
    level: facing(0, 0),
    frame: facing(0, 0),
    forward: { x: 0, y: 0, z: 1 } as Vec,
    gate: { x: 0, y: 14, z: 2600 } as Vec,
    gateName: GATES[0] as string,
    leg: 3,
    arrivals: 0,
    arrived: false,
    aim: null as Vec | null,
    target: null as Vec | null,
    surge: 1,
    fixed: false,
};

export interface HelmKeys { ahead: boolean; astern: boolean; port: boolean; starboard: boolean; climb: boolean; dive: boolean; steady: boolean; approach: boolean; align: boolean; level: boolean; planet?: boolean }

const held: Record<string, number> = {};

function tapped(name: string, down: boolean, dt: number, repeats = false): boolean {
    if (!down) { delete held[name]; return false; }
    const before = held[name];
    held[name] = (before ?? 0) + dt;
    if (before === undefined) return true;
    if (!repeats || held[name]! < REPEAT) return false;
    held[name] = 0.0001;
    return true;
}

const stepped = (ladder: readonly number[], now: number, by: number): number => {
    const next = by > 0 ? ladder.find((v) => v > now + 1e-6) : [...ladder].reverse().find((v) => v < now - 1e-6);
    return next ?? now;
};

export function setEngine(order: number): void { helm.order = Math.max(0, Math.min(1, order)); }
export function setRudder(order: number): void { helm.rudder = Math.max(-1, Math.min(1, order)); helm.mode = 'manual'; }
export function setElevation(order: number): void { helm.elevation = within(order, 1); helm.mode = 'manual'; }
export function steady(): void { helm.rudder = 0; helm.elevation = 0; helm.mode = 'manual'; }
export function engage(mode: HelmMode): void {
    if (mode === 'approach' && !helm.aim) return;
    if (mode === 'planet' && (!helm.target || helm.fixed)) return;
    helm.mode = helm.mode === mode ? 'manual' : mode;
    if (helm.mode === 'manual') steady();
}

/** The helm's part: keys and autopilots become the orders the ship is to fly by. Nothing moves here. */
export function helmOrders(keys: HelmKeys, dt: number): Orders {
    if (tapped('ahead', keys.ahead, dt, true)) setEngine(stepped(ENGINE_ORDERS, helm.order, 1));
    if (tapped('astern', keys.astern, dt, true)) setEngine(stepped(ENGINE_ORDERS, helm.order, -1));
    if (tapped('port', keys.port, dt, true)) setRudder(stepped(RUDDER_ORDERS, helm.rudder, -1));
    if (tapped('starboard', keys.starboard, dt, true)) setRudder(stepped(RUDDER_ORDERS, helm.rudder, 1));
    if (tapped('climb', keys.climb, dt, true)) setElevation(stepped(ELEVATION_ORDERS, helm.elevation, 1));
    if (tapped('dive', keys.dive, dt, true)) setElevation(stepped(ELEVATION_ORDERS, helm.elevation, -1));
    if (tapped('steady', keys.steady, dt)) steady();
    if (tapped('approach', keys.approach, dt)) engage('approach');
    if (tapped('align', keys.align, dt)) engage('align');
    if (tapped('level', keys.level, dt)) engage('level');
    if (tapped('planet', keys.planet ?? false, dt)) engage('planet');
    if (helm.mode === 'planet' && !helm.target) steady();
    if (helm.mode === 'approach' && !helm.aim) steady();
    if (helm.mode === 'approach' && helm.aim && Math.hypot(helm.aim.x, helm.aim.y, helm.aim.z) < STANDOFF) { steady(); setEngine(0); }

    let roll = 0;
    const to = helm.mode === 'approach' ? helm.aim : helm.mode === 'align' ? helm.gate : helm.mode === 'planet' ? helm.target : null;
    if (to) {
        const ahead = turnBack(helm.level, to);
        helm.rudder = -within(Math.atan2(ahead.x, ahead.z) * 1.4, TURN_RATE) / TURN_RATE;
        helm.elevation = within(Math.atan2(ahead.y, Math.hypot(ahead.x, ahead.z) || 1e-6) * 1.4, PITCH_RATE) / PITCH_RATE;
    }
    if (helm.mode === 'level') {
        const climb = Math.asin(Math.max(-1, Math.min(1, helm.forward.y)));
        if (Math.abs(helm.lean) < LEVEL && Math.abs(climb) < LEVEL && Math.abs(helm.rollRate) + Math.abs(helm.pitchRate) + Math.abs(helm.yawRate) < LEVEL) {
            steady();
        } else {
            helm.rudder = 0;
            helm.elevation = within(-climb * 1.4 * Math.max(0, Math.cos(helm.lean)), PITCH_RATE) / PITCH_RATE;
            roll = within(-helm.lean * 1.4, ROLL_RATE) / ROLL_RATE;
        }
    }
    return { order: helm.order, rudder: helm.rudder, elevation: helm.elevation, roll };
}

/** What the display and the rest of the game read off a ship in flight: her attitude, her heading, how she leans. */
function read(f: Pick<Flight, 'level' | 'yawRate' | 'pitchRate' | 'rollRate' | 'bank'>, dt: number): void {
    helm.level = f.level;
    helm.yawRate = f.yawRate; helm.pitchRate = f.pitchRate; helm.rollRate = f.rollRate; helm.roll = f.bank;
    helm.helmAngle = -helm.yawRate / TURN_RATE;
    helm.attitude = attitudeOf(f);
    helm.frame = toward(helm.frame, helm.level, Math.min(1, dt * 1.6));
    helm.forward = forwardOf(f);
    helm.yaw = Math.atan2(helm.forward.x, helm.forward.z);
    helm.pitch = Math.asin(Math.max(-1, Math.min(1, helm.forward.y)));
    helm.lean = Math.atan2(turnBy(helm.level, { x: 1, y: 0, z: 0 }).y, turnBy(helm.level, { x: 0, y: 1, z: 0 }).y);
}

/** The world goes by the ship by `moved`: the gate with it, and the gate is reached when she comes to it. */
function pass(moved: Vec): Vec {
    if (!ship.away) helm.gate = { x: helm.gate.x + moved.x, y: helm.gate.y + moved.y, z: helm.gate.z + moved.z };
    helm.arrived = false;
    if (!ship.away && !helm.fixed && Math.hypot(helm.gate.x, helm.gate.y, helm.gate.z) < GATE_REACH) {
        helm.arrived = true;
        helm.arrivals++;
        helm.leg = (helm.leg % 9) + 1;
        helm.gateName = GATES[helm.arrivals % GATES.length]!;
        const bearing = helm.yaw + 1.9 + helm.arrivals * 0.7, far = 5200;
        helm.gate = { x: Math.sin(bearing) * far, y: ((helm.arrivals * 37) % 9 - 4) * 90, z: Math.cos(bearing) * far };
        if (helm.mode === 'align') steady();
    }
    return moved;
}

/** A ship flown here, by this helm: the orders are taken, she turns by them, and the world goes by at the speed she has. */
export function stepHelm(keys: HelmKeys, dt: number): Vec {
    const orders = helmOrders(keys, dt);
    const flown = { level: helm.level, yawRate: helm.yawRate, pitchRate: helm.pitchRate, rollRate: helm.rollRate, bank: helm.roll };
    helm.jets = turnShip(flown, orders, dt);
    read(flown, dt);
    const run = ship.speed * FIELD_DRIFT * dt * helm.surge;
    return pass({ x: -helm.forward.x * run, y: -helm.forward.y * run, z: -helm.forward.z * run });
}

/** A ship flown elsewhere (the sector's): the helm shows the flight it is given, and the world goes by as far as she went since the last one. */
export function followFlight(shown: Flight, jets: { yaw: number; pitch: number; roll: number }, went: Vec, dt: number): Vec {
    helm.jets = jets;
    read(shown, dt);
    return pass({ x: -went.x, y: -went.y, z: -went.z });
}

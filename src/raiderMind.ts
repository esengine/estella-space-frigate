import { intercept, scatter } from './gunSolution';

export type V = { x: number; y: number; z: number };

export const RAIDER = {
    speed: 85, turn: 0.8, near: 330, far: 1050, range: 1450, cone: 0.07, burst: 3, every: 0.2, rest: 2.6,
    boltSpeed: 560, reach: 2400, hull: 9, radius: 19, scatter: 0.03, berth: 110, shieldCost: 0.035, hullCost: 0.03,
    first: 25, gap: 40, arrive: 2400, most: 3,
} as const;

export interface Mind { at: V; way: V; mode: 'run' | 'break'; aside: V; shots: number; wait: number; cool: number; passes: number }
export interface Hazard { at: V; radius: number }

const add = (a: V, b: V, k = 1): V => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V, b: V): V => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const size = (a: V): number => Math.hypot(a.x, a.y, a.z);
export const unit = (a: V): V => { const l = size(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };

export function steer(way: V, want: V, most: number): V {
    const along = Math.max(-1, Math.min(1, dot(way, want))), angle = Math.acos(along);
    if (angle <= most) return want;
    let side = add(want, way, -along);
    if (size(side) < 1e-6) side = cross(way, Math.abs(way.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 });
    side = unit(side);
    return unit(add({ x: way.x * Math.cos(most), y: way.y * Math.cos(most), z: way.z * Math.cos(most) }, side, Math.sin(most)));
}

export const aimAt = (mind: Mind, shipVelocity: V): V => unit(intercept({ x: -mind.at.x, y: -mind.at.y, z: -mind.at.z }, shipVelocity, RAIDER.boltSpeed).point);

export function wanted(mind: Mind, shipVelocity: V, hazards: readonly Hazard[]): V {
    const home = unit({ x: -mind.at.x, y: -mind.at.y, z: -mind.at.z });
    let want = mind.mode === 'run' ? aimAt(mind, shipVelocity) : unit(add({ x: -home.x * 0.5, y: -home.y * 0.5, z: -home.z * 0.5 }, mind.aside, 0.9));
    for (const hazard of hazards) {
        const off = add(mind.at, hazard.at, -1), gap = size(off) - hazard.radius;
        if (gap >= RAIDER.berth || dot(mind.way, off) > 0) continue;
        want = unit(add(want, unit(off), (1 - Math.max(0, gap) / RAIDER.berth) * 2.4));
    }
    return want;
}

export function advance(mind: Mind, shipVelocity: V, hazards: readonly Hazard[], dt: number, roll: () => number): V | null {
    const far = size(mind.at);
    if (mind.mode === 'run' && far < RAIDER.near) {
        const home = unit({ x: -mind.at.x, y: -mind.at.y, z: -mind.at.z });
        const flat = cross(home, Math.abs(home.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 });
        const turn = roll() * Math.PI * 2, lift = cross(home, flat);
        mind.aside = unit(add({ x: flat.x * Math.cos(turn), y: flat.y * Math.cos(turn), z: flat.z * Math.cos(turn) }, lift, Math.sin(turn)));
        mind.mode = 'break';
        mind.shots = 0;
        mind.passes++;
    } else if (mind.mode === 'break' && far > RAIDER.far) {
        mind.mode = 'run';
        mind.wait = 0;
    }
    mind.way = steer(mind.way, wanted(mind, shipVelocity, hazards), RAIDER.turn * dt);
    mind.at = add(add(mind.at, mind.way, RAIDER.speed * dt), shipVelocity, -dt);
    mind.cool = Math.max(0, mind.cool - dt);
    mind.wait = Math.max(0, mind.wait - dt);
    if (mind.mode !== 'run' || size(mind.at) > RAIDER.range) return null;
    const lay = aimAt(mind, shipVelocity);
    if (Math.acos(Math.max(-1, Math.min(1, dot(mind.way, lay)))) > RAIDER.cone) return null;
    if (mind.shots === 0 && mind.wait === 0) mind.shots = RAIDER.burst;
    if (mind.shots === 0 || mind.cool > 0) return null;
    mind.shots--;
    mind.cool = RAIDER.every;
    if (mind.shots === 0) mind.wait = RAIDER.rest;
    return scatter(lay, RAIDER.scatter, roll(), roll());
}

export function formUp(wave: number, slot: number, forward: V, roll: () => number): Mind {
    const flat = unit(cross({ x: 0, y: 1, z: 0 }, forward)), bearing = (roll() - 0.5) * 2, lift = (roll() - 0.5) * 0.3;
    const out = unit(add(add({ x: forward.x * Math.cos(bearing), y: forward.y * Math.cos(bearing), z: forward.z * Math.cos(bearing) }, flat, Math.sin(bearing)), { x: 0, y: 1, z: 0 }, lift));
    const at = add({ x: out.x * RAIDER.arrive, y: out.y * RAIDER.arrive, z: out.z * RAIDER.arrive }, flat, 150 * (slot - 1) + 40 * wave);
    return { at, way: unit({ x: -at.x, y: -at.y, z: -at.z }), mode: 'run', aside: flat, shots: 0, wait: slot * 0.7, cool: 0, passes: 0 };
}

export const waveSize = (wave: number): number => Math.min(RAIDER.most, 2 + Math.min(1, wave));

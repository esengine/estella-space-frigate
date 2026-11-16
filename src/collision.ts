export type Point = { x: number; y: number; z: number };

export const HULL_BOXES: readonly (readonly number[])[] = [
    [-10.5, -6, -46, 10.5, 5.6, 6], [-7, -4.8, 6, 7, 3.6, 34], [-4, -3.6, 34, 4, 1.6, 56],
    [-5, 5.6, -36, 5, 9.4, 5], [-3.2, 9.4, -28, 3.2, 14.2, -18],
    [-21, -4.6, -46, -13, 2.6, -8], [13, -4.6, -46, 21, 2.6, -8],
];

export const IMPACT = {
    shipMass: 20000, turning: 30, restitution: 0.25, rockBody: 0.95, felt: 3, spin: 0.22,
    toll: 2.5e7, hullShare: 0.6, regenAfter: 5, regen: 0.06, settle: 0.15, refit: 6, patched: 0.3,
} as const;

export interface Contact { point: Point; normal: Point; depth: number }

export function touch(centre: Point, radius: number): Contact | null {
    let deepest: Contact | null = null;
    const c = [centre.x, centre.y, centre.z];
    for (const box of HULL_BOXES) {
        const near = [0, 1, 2].map((axis) => Math.max(box[axis]!, Math.min(box[axis + 3]!, c[axis]!)));
        const off = [c[0]! - near[0]!, c[1]! - near[1]!, c[2]! - near[2]!];
        const gap = Math.hypot(off[0]!, off[1]!, off[2]!);
        if (gap >= radius) continue;
        let normal = off, depth = radius - gap;
        if (gap < 1e-6) {
            let least = Infinity, axis = 0, sign = 1;
            for (let k = 0; k < 3; k++) {
                const low = c[k]! - box[k]!, high = box[k + 3]! - c[k]!;
                if (low < least) { least = low; axis = k; sign = -1; }
                if (high < least) { least = high; axis = k; sign = 1; }
            }
            normal = [0, 0, 0];
            normal[axis] = sign;
            depth = radius + least;
        } else {
            normal = [off[0]! / gap, off[1]! / gap, off[2]! / gap];
        }
        if (deepest === null || depth > deepest.depth) deepest = { point: { x: near[0]!, y: near[1]!, z: near[2]! }, normal: { x: normal[0]!, y: normal[1]!, z: normal[2]! }, depth };
    }
    return deepest;
}

export function clearance(centre: Point, radius: number): number {
    let least = Infinity;
    const c = [centre.x, centre.y, centre.z];
    for (const box of HULL_BOXES) {
        const off = [0, 1, 2].map((axis) => c[axis]! - Math.max(box[axis]!, Math.min(box[axis + 3]!, c[axis]!)));
        const gap = Math.hypot(off[0]!, off[1]!, off[2]!);
        const inside = gap < 1e-6 ? -Math.min(...[0, 1, 2].map((k) => Math.min(c[k]! - box[k]!, box[k + 3]! - c[k]!))) : gap;
        least = Math.min(least, inside - radius);
    }
    return least;
}

export const rockMass = (size: number): number => size * size * size;

export interface Blow { rock: Point; ship: Point; closing: number; energy: number }

export function strike(relative: Point, normal: Point, shipMass: number, mass: number, restitution: number): Blow | null {
    const closing = -(relative.x * normal.x + relative.y * normal.y + relative.z * normal.z);
    if (closing <= 0) return null;
    const reduced = 1 / (1 / shipMass + 1 / mass);
    const impulse = (1 + restitution) * closing * reduced;
    const push = impulse / mass, shove = -impulse / shipMass;
    return {
        rock: { x: normal.x * push, y: normal.y * push, z: normal.z * push },
        ship: { x: normal.x * shove, y: normal.y * shove, z: normal.z * shove },
        closing,
        energy: 0.5 * reduced * closing * closing,
    };
}

export function absorb(shield: number, hull: number, energy: number): { shield: number; hull: number } {
    const toll = energy / IMPACT.toll;
    const taken = Math.min(shield, toll);
    return { shield: shield - taken, hull: Math.max(0, hull - (toll - taken) * IMPACT.hullShare) };
}

export function spinFrom(point: Point, shove: Point): Point {
    const k = 1 / (IMPACT.turning * IMPACT.turning);
    const turn = { x: (point.y * shove.z - point.z * shove.y) * k, y: (point.z * shove.x - point.x * shove.z) * k, z: (point.x * shove.y - point.y * shove.x) * k };
    const size = Math.hypot(turn.x, turn.y, turn.z);
    const kept = size > IMPACT.spin ? IMPACT.spin / size : 1;
    return { x: turn.x * kept, y: turn.y * kept, z: turn.z * kept };
}

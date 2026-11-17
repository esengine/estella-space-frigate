import { SECTOR, type Vec3 } from './sector';

// The station and a frigate as boxes in the sector's own coordinates: where a ship could foul the station, and where a camera
// looking at her would be inside it or have it in the way. It is the same model the berths' rules are checked against.

export interface Box { min: Vec3; max: Vec3 }

const S = SECTOR.station.at;
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Box => ({ min: [S[0] + x0, S[1] + y0, S[2] + z0], max: [S[0] + x1, S[1] + y1, S[2] + z1] });

/** The wing the two berths are on, what stands on its back, the two berth frames, and the hub with its tower and what hangs below. */
export const STRUCTURE: readonly Box[] = [
    box(-41, 41, -19, 19, 92, 420),
    box(-22, 22, 15, 48, 100, 420),
    ...[1, -1].flatMap((side) => [
        box(Math.min(side * 36, side * 117), Math.max(side * 36, side * 117), -5, 5, 165.5, 174.5),
        box(Math.min(side * 36, side * 117), Math.max(side * 36, side * 117), -5, 5, 313.5, 322.5),
        box(Math.min(side * 107.5, side * 118.5), Math.max(side * 107.5, side * 118.5), -5, 28, 165, 323),
    ]),
    box(-130, 130, -250, 240, -130, 130),
];

/** A frigate lying to the berths' heading, about the point she is flown by; and the ball that holds her whichever way she lies. */
export const HULL: Box = { min: [-24.5, -11.5, -52.5], max: [24.5, 23.5, 59.5] };
export const HULL_BALL = 64;

/** Whether the straight line from `a` to `b` passes through a box, or starts or ends in it. */
export function crosses(a: Vec3, b: Vec3, part: Box, pad = 0): boolean {
    let from = 0, to = 1;
    for (let axis = 0; axis < 3; axis++) {
        const lo = part.min[axis]! - pad, hi = part.max[axis]! + pad, way = b[axis]! - a[axis]!;
        if (Math.abs(way) < 1e-9) { if (a[axis]! < lo || a[axis]! > hi) return false; continue; }
        const t0 = (lo - a[axis]!) / way, t1 = (hi - a[axis]!) / way;
        from = Math.max(from, Math.min(t0, t1));
        to = Math.min(to, Math.max(t0, t1));
        if (from > to) return false;
    }
    return true;
}

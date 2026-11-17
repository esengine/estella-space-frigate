export type Vec3 = [number, number, number];
export type Quat4 = [number, number, number, number];

export const GRAMS = 1_000_000;

export const SECTOR = {
    id: 'kestrel-belt',
    name: 'KESTREL BELT',
    rock: { id: 'rock-01', at: [0, 30, 700] as Vec3, total: 10 * GRAMS },
    range: 1500,
    rate: 0.2 * GRAMS,
    capacity: 40 * GRAMS,
    topSpeed: 50.4,
    tickMs: 50,
    saveMs: 1000,
    berths: [[-160, 0, 0], [160, 0, 0]] as Vec3[],
} as const;

export const tonnes = (grams: number): number => grams / GRAMS;
export const tonnage = (grams: number): string => (grams / GRAMS).toFixed(2);

export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const vec3 = (v: unknown): Vec3 | null => (Array.isArray(v) && v.length === 3 && v.every(finite) ? [v[0], v[1], v[2]] : null);
export const quat4 = (v: unknown): Quat4 | null => {
    if (!Array.isArray(v) || v.length !== 4 || !v.every(finite)) return null;
    const l = Math.hypot(v[0], v[1], v[2], v[3]);
    return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l, v[3] / l] : null;
};
export const apart = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function stepToward(from: Vec3, to: Vec3, most: number): Vec3 {
    const far = apart(from, to);
    if (far <= most || far === 0) return [to[0], to[1], to[2]];
    const k = most / far;
    return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k];
}

export function allot(remaining: number, wants: readonly number[], first: number): number[] {
    const got = wants.map(() => 0);
    let left = Math.max(0, Math.floor(remaining));
    const total = wants.reduce((sum, want) => sum + want, 0);
    if (total <= left) return wants.map((want) => Math.max(0, Math.floor(want)));
    const share = Math.floor(left / Math.max(1, wants.length));
    wants.forEach((want, i) => { got[i] = Math.min(Math.max(0, Math.floor(want)), share); left -= got[i]!; });
    for (let n = 0; n < wants.length && left > 0; n++) {
        const i = (first + n) % wants.length, more = Math.min(left, Math.max(0, Math.floor(wants[i]!)) - got[i]!);
        got[i] = got[i]! + more;
        left -= more;
    }
    return got;
}

export type Refusal = '' | 'NOT MINING' | 'OUT OF RANGE' | 'ROCK EXHAUSTED' | 'HOLD FULL';

export interface PilotView { account: string; name: string; p: Vec3; q: Quat4; v: Vec3; th: number; mining: boolean; cargo: number }

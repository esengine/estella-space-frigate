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
    tickMs: 50,
    saveMs: 1000,
    berths: [[-160, 0, 0], [160, 0, 0]] as Vec3[],
    // The station stands further from the rock than a beam reaches: ore is carried to it, never mined from it.
    station: { id: 'kestrel-station', name: 'KESTREL STATION', at: [0, 0, -1700] as Vec3, dockRange: 300, dockSpeed: 80 },
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

/** Why a ship may not make fast to the station. '' is that she may, or has. */
export type DockRefusal = '' | 'TOO FAR' | 'TOO FAST';

/** Why ore did not move between a hold and a warehouse. '' is that it did. */
export type TransferRefusal = '' | 'NOT DOCKED' | 'BAD AMOUNT' | 'NOT ENOUGH IN THE HOLD' | 'NOT ENOUGH IN THE WAREHOUSE' | 'HOLD FULL' | 'BAD ORDER';

export interface PilotView { account: string; name: string; p: Vec3; q: Quat4; v: Vec3; th: number; mining: boolean; docked: boolean; cargo: number }

/** What came of an order to move ore, kept under the order's own name so that asking again is told the same and nothing moves twice. */
export interface Transfer { op: string; ok: boolean; why: TransferRefusal; withdraw: boolean; grams: number; cargo: number; stored: number }

/** A ship that is not within reach of the station, or is still making way, may not dock. */
export function mayDock(distance: number, speed: number): DockRefusal {
    if (!(distance <= SECTOR.station.dockRange)) return 'TOO FAR';
    if (!(Math.abs(speed) <= SECTOR.station.dockSpeed)) return 'TOO FAST';
    return '';
}

/** What a helm should do next to bring ore to the station, from where she is. The server decides whether she docks; this only says how to get there. */
export function approach(s: { distance: number; speed: number; order: number; aligned: boolean }): { text: string; cue: string } {
    const { dockRange, dockSpeed, name } = SECTOR.station;
    if (s.distance <= dockRange) {
        // A client's own ship is a little ahead of the one the server is flying, and so a little slower while she slows: the helm is told she may dock only with some to spare.
        if (s.speed <= dockSpeed * 0.85) return { text: `ALONGSIDE ${name}   PRESS H TO DOCK`, cue: 'Dock' };
        return s.order > 0 ? { text: 'TOO FAST TO DOCK   STOP THE ENGINE   PRESS S', cue: 'Engine0' } : { text: 'TOO FAST TO DOCK   SHE IS SLOWING', cue: '' };
    }
    if (!s.aligned) return { text: `ORE ABOARD   PRESS B TO STEER FOR ${name}`, cue: 'Gate' };
    if (s.distance <= dockRange + 500) {
        if (s.order > 0.25) return { text: 'STATION AHEAD   SLOW TO ONE QUARTER   PRESS S', cue: 'Engine25' };
        if (s.order < 0.25) return { text: 'SHORT OF THE STATION   ONE QUARTER AHEAD   PRESS W', cue: 'Engine25' };
        return { text: `CLOSING ON ${name}   STAND BY TO DOCK`, cue: '' };
    }
    if (s.order < 0.75) return { text: 'ENGINE AHEAD FOR THE STATION   PRESS W', cue: 'Engine75' };
    return { text: `ON COURSE FOR ${name}`, cue: '' };
}

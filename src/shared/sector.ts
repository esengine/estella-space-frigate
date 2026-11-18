export type Vec3 = [number, number, number];
export type Quat4 = [number, number, number, number];

export const GRAMS = 1_000_000;

/** The path the sector server answers on, and the one a deployed page dials on its own host (project.esproject's server.path). */
export const SECTOR_PATH = '/sector';

export const SECTOR = {
    id: 'kestrel-belt',
    name: 'KESTREL BELT',
    rock: { id: 'rock-01', at: [0, 30, 700] as Vec3, total: 10 * GRAMS },
    range: 1500,
    rate: 0.2 * GRAMS,
    capacity: 40 * GRAMS,
    tickMs: 50,
    saveMs: 1000,
    /** Where each pilot's ship lies when the sector is founded. */
    berths: [[-160, 0, 0], [160, 0, 0]] as Vec3[],
    // The station stands further from the rock than a beam reaches: ore is carried to it, never mined from it.
    // It spans 832 units, eight frigate lengths, with its wings along x and z. Two of its eight berths are in use: the pair on the
    // wing that points at the rock, one each side of it. A berth is a frame 68 wide and 140 long that a frigate, 48 by 111, is
    // lowered into from above: `at` is where she lies, bow away from the hub; `over` is 170 straight above it, clear of the wing's
    // deck and crane; and `approach` is 90 further out to her own side at that height, where she is taken in hand and where she is
    // let go. The two approach points are 328 apart, so two ships turning at them, each within reach of her own, cannot touch;
    // from there in they lie the same way, 148 apart, and a frigate is 48 across.
    station: {
        id: 'kestrel-station', name: 'KESTREL ANCHORAGE', at: [0, 0, -1900] as Vec3,
        berths: [
            { id: 1, at: [74, 0, -1656] as Vec3, over: [74, 170, -1656] as Vec3, approach: [164, 170, -1656] as Vec3 },
            { id: 2, at: [-74, 0, -1656] as Vec3, over: [-74, 170, -1656] as Vec3, approach: [-164, 170, -1656] as Vec3 },
        ],
        // Every berth on this wing lies the same way: bow to +z, out along the wing.
        heading: [0, 0, 0, 1] as Quat4,
        // She is taken in hand within this of her approach point, making no more than this.
        approachRange: 45, dockSpeed: 80,
        // How the station moves a ship it has in hand: units a second, and radians a second.
        tug: { speed: 16, turn: 0.3 },
        // A berth kept for a pilot who has gone is given up after this.
        reserveMs: 30_000,
        // What the station buys: ore, a lot at a time out of the seller's own warehouse, at one price. A test price, fixed.
        buys: { lot: 1 * GRAMS, price: 100 },
    },
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

/**
 * Where a ship stands with the station. `assigned`: a berth is kept for her and she is still her pilot's to fly. `docking` and
 * `undocking`: the station has her in hand and her helm does nothing. `docked`: she lies in her berth, and her warehouse is open.
 */
export type Mooring = 'none' | 'assigned' | 'docking' | 'docked' | 'undocking';
export const MOORINGS: readonly Mooring[] = ['none', 'assigned', 'docking', 'docked', 'undocking'];
/** The station has her: she is not flown by her helm. */
export const inHand = (mooring: Mooring): boolean => mooring === 'docking' || mooring === 'docked' || mooring === 'undocking';

/**
 * Why a ship has no berth, or is not yet taken in hand. '' is that nothing is in the way. MANEUVERING: the station has her in
 * hand and will not be interrupted. NOT SAVED: she lies in her berth and the station has not been able to write that down, so
 * it does not yet call her docked; it is trying again.
 */
export type DockRefusal = '' | 'TOO FAR' | 'TOO FAST' | 'NO BERTH FREE' | 'MANEUVERING' | 'NOT SAVED';

/**
 * Why ore did not move between a hold and a warehouse. '' is that it did.
 * EXPIRED: its number was answered long ago and the answer is no longer kept; it was not done again. OUT OF ORDER: its number is
 * ahead of the next. NOT SAVED: it was valid and could not be written, so it was not done; asked again it will be tried again.
 * WRONG PRICE: a sale that named a price the station is not paying.
 */
export type TransferRefusal = '' | 'NOT DOCKED' | 'BAD AMOUNT' | 'NOT ENOUGH IN THE HOLD' | 'NOT ENOUGH IN THE WAREHOUSE' | 'HOLD FULL' | 'BAD ORDER' | 'EXPIRED' | 'OUT OF ORDER' | 'NOT SAVED' | 'WRONG PRICE';

export interface PilotView { account: string; name: string; p: Vec3; q: Quat4; v: Vec3; th: number; mining: boolean; docked: boolean; berth: number; mooring: Mooring; cargo: number }

/** What came of an order to move ore, kept under the order's own name so that asking again is told the same and nothing moves twice. */
export interface Transfer {
    seq: number; op: string; ok: boolean; why: TransferRefusal; withdraw: boolean; grams: number; cargo: number; stored: number;
    /** A sale to the station and not a move between hold and warehouse; what it paid, if it was made; and the pilot's credits after it. */
    sell: boolean; paid: number; credits: number;
}

export const berthOf = (id: number) => SECTOR.station.berths.find((berth) => berth.id === id) ?? null;

/** A ship that is not at her approach point, or is still making way, is not taken in hand. */
export function mayDock(distance: number, speed: number): DockRefusal {
    if (!(distance <= SECTOR.station.approachRange)) return 'TOO FAR';
    if (!(Math.abs(speed) <= SECTOR.station.dockSpeed)) return 'TOO FAST';
    return '';
}

/**
 * What a helm should do next to bring her to her berth's approach point, from where she is. `distance` is to that point.
 * The server decides when she is taken in hand; this only says how to get there.
 */
export function approach(s: { distance: number; speed: number; order: number; aligned: boolean; berth: number }): { text: string; cue: string } {
    const { approachRange, dockSpeed } = SECTOR.station;
    if (s.distance <= approachRange) {
        // A client's own ship is a little ahead of the one the server is flying, and so a little slower while she slows.
        if (s.speed <= dockSpeed * 0.85) return { text: `AT THE APPROACH TO BERTH ${s.berth}   HOLD HER HERE`, cue: '' };
        return s.order > 0 ? { text: 'TOO FAST FOR THE BERTH   STOP THE ENGINE   PRESS S', cue: 'Engine0' } : { text: 'TOO FAST FOR THE BERTH   SHE IS SLOWING', cue: '' };
    }
    if (!s.aligned) return { text: `BERTH ${s.berth} IS YOURS   PRESS B TO STEER FOR ITS APPROACH`, cue: 'Gate' };
    if (s.distance <= approachRange + 500) {
        if (s.order > 0.25) return { text: `BERTH ${s.berth} AHEAD   SLOW TO ONE QUARTER   PRESS S`, cue: 'Engine25' };
        if (s.order < 0.25) return { text: `SHORT OF BERTH ${s.berth}   ONE QUARTER AHEAD   PRESS W`, cue: 'Engine25' };
        return { text: `CLOSING ON BERTH ${s.berth}   STOP THE ENGINE AT ITS APPROACH`, cue: '' };
    }
    if (s.order < 0.75) return { text: `ENGINE AHEAD FOR BERTH ${s.berth}   PRESS W`, cue: 'Engine75' };
    return { text: `ON COURSE FOR THE APPROACH TO BERTH ${s.berth}`, cue: '' };
}

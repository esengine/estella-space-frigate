import { createSector, freshSave, type Saved, type Sector } from '../server/world';
import { DIRECTOR, blocked, director, frameOf, rigFor, shotFor, stepDirector, type Rig, type Shot } from '../src/director';
import { SECTOR, type Mooring, type Vec3 } from '../src/shared/sector';
import { STRUCTURE } from '../src/shared/stationShape';
import { FLIGHT_TICK } from '../src/shared/steer';

const A = 'pilot-a', B = 'pilot-b';
const STATION = SECTOR.station, TICK = FLIGHT_TICK * 1000, WIDE = 16 / 9;
const placed = (at: { [id: string]: { p: readonly number[]; berth?: number; mooring?: Mooring } }): Saved => {
    const saved = freshSave();
    [A, B].forEach((id, i) => {
        const want = at[id];
        saved.pilots[id] = { cargo: 0, stored: 0, credits: 0, berth: want?.berth ?? 0, mooring: want?.mooring ?? 'none', moves: 0, p: [...(want?.p ?? SECTOR.berths[i]!)] as Vec3, q: [0, 0, 0, 1], ops: [] };
    });
    return saved;
};
const where = (s: Sector, id: string): Vec3 => { const p = s.stateFor(id).flight.pos; return [p.x, p.y, p.z]; };
const inside = (p: Vec3): boolean => STRUCTURE.some((part) => [0, 1, 2].every((axis) => p[axis]! > part.min[axis]! && p[axis]! < part.max[axis]!));
/** The pilot's own camera: astern and above her, wherever she is. */
const own = (ship: Vec3): Rig => ({ eye: [ship[0], ship[1] + 40, ship[2] - 150], target: ship, fov: 34 });
const reset = (): void => { Object.assign(director, { on: false, shot: null, presence: 0, dismissed: false, action: '', fellBack: false, fallbacks: 0, cuts: 0, confirmed: 0, sinceDocked: 0, shown: [], primed: false, lastMooring: 'none' }); };

/** A sector stepped a frame at a time with the director watching one pilot, as the game's own loop does it. */
function watch(s: Sector, id: string, o: { until: (m: Mooring) => boolean; most?: number; each?: (rig: Rig | null, ship: Vec3, m: Mooring) => void; took?: (frame: number) => boolean; arrived?: boolean }): { frames: number; shots: Shot[] } {
    const shots: Shot[] = [];
    let frames = 0;
    for (; frames < (o.most ?? 30 * 120); frames++) {
        s.step(TICK);
        const you = s.stateFor(id).you, ship = where(s, id);
        const rig = stepDirector({ dt: FLIGHT_TICK, mooring: you.mooring, berth: you.berth, ship, aspect: WIDE, own: own(ship), took: o.took?.(frames) ?? false, arrivedDocked: frames === 0 && o.arrived === true });
        if (director.shot && shots[shots.length - 1] !== director.shot) shots.push(director.shot);
        o.each?.(rig, ship, you.mooring);
        if (o.until(you.mooring)) break;
    }
    return { frames, shots };
}

describe('the harbour\'s camera', () => {
    beforeEach(reset);

    it('takes its shot from where the server has her, the same for both berths', () => {
        for (const berth of STATION.berths) {
            const at = (x: number, y: number): Vec3 => [x, y, berth.at[2]];
            expect(shotFor('none', [...berth.approach] as Vec3, berth.id)).toBeNull();
            expect(shotFor('assigned', [...berth.approach] as Vec3, berth.id)).toBeNull();
            expect(shotFor('docking', [...berth.approach] as Vec3, berth.id)).toBe('takeover');
            expect(shotFor('docking', [...berth.over] as Vec3, berth.id)).toBe('takeover');
            expect(shotFor('docking', at(berth.at[0], berth.over[1] - 2), berth.id)).toBe('settle');
            expect(shotFor('docking', at(berth.at[0], DIRECTOR.nearBerth + 1), berth.id)).toBe('settle');
            expect(shotFor('docking', at(berth.at[0], DIRECTOR.nearBerth - 1), berth.id)).toBe('berthed');
            // In her berth and not yet written down, and docked: the same settled shot, not the first one again.
            expect(shotFor('docking', [...berth.at] as Vec3, berth.id)).toBe('berthed');
            expect(shotFor('docked', [...berth.at] as Vec3, berth.id)).toBe('berthed');
            expect(shotFor('undocking', [...berth.at] as Vec3, berth.id)).toBe('lift');
            expect(shotFor('undocking', [...berth.over] as Vec3, berth.id)).toBe('clear');
            const side = Math.sign(berth.at[0]);
            expect(shotFor('undocking', at(berth.approach[0] - side * (DIRECTOR.nearRelease + 2), berth.over[1]), berth.id)).toBe('clear');
            expect(shotFor('undocking', at(berth.approach[0] - side * (DIRECTOR.nearRelease - 2), berth.over[1]), berth.id)).toBe('handover');
            expect(shotFor('docked', [...berth.at] as Vec3, 9)).toBeNull();
        }
    });

    it('shows the whole ship in every shot at both berths, at the size each is meant to be, with nothing of the station in the way', () => {
        for (const berth of STATION.berths) {
            const side = Math.sign(berth.at[0]);
            const along = (from: readonly number[], to: readonly number[], n: number): Vec3[] => Array.from({ length: n + 1 }, (_, i) => [0, 1, 2].map((axis) => from[axis]! + ((to[axis]! - from[axis]!) * i) / n) as Vec3);
            const way: [Mooring, Vec3][] = [
                ...along(berth.approach, berth.over, 6).map((p): [Mooring, Vec3] => ['docking', p]),
                ...along(berth.over, berth.at, 12).slice(1).map((p): [Mooring, Vec3] => ['docking', p]),
                ['docked', [...berth.at] as Vec3],
                ...along(berth.at, berth.over, 12).map((p): [Mooring, Vec3] => ['undocking', p]),
                ...along(berth.over, berth.approach, 6).slice(1).map((p): [Mooring, Vec3] => ['undocking', p]),
            ];
            for (const [mooring, ship] of way) {
                const shot = shotFor(mooring, ship, berth.id)!, rig = rigFor(shot, ship, berth.id), frame = frameOf(rig, ship, WIDE);
                const what = `berth ${berth.id} ${mooring} ${shot} at ${ship.map((v) => v.toFixed(0))}`;
                expect(frame.whole, what).toBe(true);
                expect(blocked(rig.eye, ship), what).toBe(false);
                expect(inside(rig.eye), what).toBe(false);
                // The camera stands outside the wing, on the berth's own side of it, in every shot.
                expect(Math.sign(rig.eye[0]), what).toBe(side);
                expect(Math.abs(rig.eye[0]), what).toBeGreaterThan(Math.abs(berth.at[0]) + 30);
                const range: Record<Shot, [number, number]> = { takeover: [0.25, 0.36], settle: [0.45, 0.55], berthed: [0.36, 0.46], lift: [0.3, 0.42], clear: [0.24, 0.36], handover: [0.26, 0.38] };
                expect(frame.width, what).toBeGreaterThanOrEqual(range[shot][0]);
                expect(frame.width, what).toBeLessThanOrEqual(range[shot][1]);
                // Lying in her berth she is in the left half and the right is clear for the warehouse: at 1280 across the panel starts at 0.50.
                if (shot === 'berthed') { expect(frame.right, what).toBeLessThan(0.5); expect(frame.left, what).toBeGreaterThan(0.02); expect(frame.bottom, what).toBeLessThan(0.9); expect(frame.top, what).toBeGreaterThan(0.2); }
            }
        }
    });

    it('follows a ship in at each berth through three shots in order, once, never inside the station, and chimes once when the server says docked', () => {
        for (const [id, berth] of [[A, STATION.berths[0]!], [B, STATION.berths[1]!]] as const) {
            reset();
            // The station gives out the first berth that is free, so for the second the first is taken already.
            const other = id === A ? B : A;
            const s = createSector(placed({ [id]: { p: [berth.approach[0] + 10, berth.approach[1] - 8, berth.approach[2] + 12] }, ...(berth.id === 2 ? { [other]: { p: [...STATION.berths[0]!.at], berth: 1, mooring: 'docked' as Mooring } } : {}) }));
            s.enter(id);
            // A berth only kept: the view is still hers.
            s.dock(id, true);
            expect(stepDirector({ dt: FLIGHT_TICK, mooring: 'assigned', berth: berth.id, ship: where(s, id), aspect: WIDE, own: own(where(s, id)), took: false, arrivedDocked: false })).toBeNull();
            let cut = 0, foul = 0, least = 1, frames = 0;
            const ran = watch(s, id, { until: (m) => m === 'docked', each: (rig, ship) => {
                frames++;
                if (!rig) return;
                if (inside(rig.eye)) foul++;
                // Once the camera has come round to a shot the whole ship is in it; in the eight tenths of a second between two it may not be.
                if (director.presence === 1 && !director.frame.whole) cut++;
                least = Math.min(least, director.frame.width);
                expect(Number.isFinite(rig.eye[0] + rig.target[0] + rig.fov)).toBe(true);
                void ship;
            } });
            expect(ran.shots).toEqual(['takeover', 'settle', 'berthed']);
            expect(foul).toBe(0);
            expect(cut).toBeLessThan(frames * 0.08);
            expect(director.fallbacks).toBe(0);
            expect(director.confirmed).toBe(1);
            // Docked, it holds the settled shot and the panel's clock runs; nothing is shown twice and no second chime comes.
            const held = watch(s, id, { until: () => false, most: 30 * 6 });
            expect(held.shots).toEqual(['berthed']);
            expect(director.confirmed).toBe(1);
            expect(director.sinceDocked).toBeGreaterThan(DIRECTOR.panelAfter + DIRECTOR.panelFade);
            expect(director.frame.whole).toBe(true);
            expect(director.frame.right).toBeLessThan(0.5);
            expect(Math.abs(director.fov - 36)).toBeLessThan(0.1);
            // Out again: three more, in order, and the view is hers the frame she is let go.
            s.dock(id, false);
            let handed: Rig | null = null;
            const out = watch(s, id, { until: (m) => m === 'none', each: (rig, _ship, m) => { if (m === 'none') handed = rig; else if (rig && inside(rig.eye)) foul++; } });
            expect(out.shots).toEqual(['lift', 'clear', 'handover']);
            expect(foul).toBe(0);
            expect(director.on).toBe(false);
            expect(director.shot).toBeNull();
            // What is left of the director's picture is eased into her own over a moment, and then it is gone.
            expect(handed).not.toBeNull();
            const after = watch(s, id, { until: () => false, most: 30 });
            expect(after.shots).toEqual([]);
            expect(stepDirector({ dt: FLIGHT_TICK, mooring: 'none', berth: 0, ship: where(s, id), aspect: WIDE, own: own(where(s, id)), took: false, arrivedDocked: false })).toBeNull();
            expect(director.shown).toEqual(['takeover', 'settle', 'berthed', 'lift', 'clear', 'handover']);
        }
    });

    it('waits in the settled shot while her berthing cannot be written, with no chime and no panel, and confirms once when it is', () => {
        const berth = STATION.berths[0]!;
        const s = createSector(placed({ [A]: { p: [...berth.approach] } }), undefined, { keeper: true });
        s.enter(A);
        s.dock(A, true);
        watch(s, A, { until: () => s.unwritten(), most: 30 * 90 });
        expect(s.stateFor(A).you).toMatchObject({ mooring: 'docking', arrived: true });
        // Ten seconds of a disk that refuses: the same shot, held; nothing chimes, the panel's clock does not start, nothing is shown again.
        const waited = watch(s, A, { until: () => false, most: 30 * 10 });
        expect(waited.shots).toEqual(['berthed']);
        expect(director.shown).toEqual(['takeover', 'settle', 'berthed']);
        expect(director.confirmed).toBe(0);
        expect(director.sinceDocked).toBe(0);
        expect(director.frame.whole).toBe(true);
        // Written: docked, one chime, and the panel's clock starts from then.
        s.committed(s.save());
        watch(s, A, { until: () => false, most: 6 });
        expect(s.stateFor(A).you.mooring).toBe('docked');
        expect(director.confirmed).toBe(1);
        expect(director.sinceDocked).toBeGreaterThan(0);
        expect(director.sinceDocked).toBeLessThan(DIRECTOR.panelAfter);
        watch(s, A, { until: () => false, most: 30 * 5 });
        expect(director.confirmed).toBe(1);
        expect(director.shown).toEqual(['takeover', 'settle', 'berthed']);
    });

    it('gives the view up when her pilot takes it, for the rest of that manoeuvre, and takes it again for the next', () => {
        const berth = STATION.berths[1]!;
        const s = createSector(placed({ [B]: { p: [...berth.approach] }, [A]: { p: [...STATION.berths[0]!.at], berth: 1, mooring: 'docked' } }));
        s.enter(B);
        s.dock(B, true);
        // She drags the view half way down.
        const ran = watch(s, B, { until: (m) => m === 'docked', took: (frame) => frame === 400 });
        expect(ran.shots.includes('berthed')).toBe(false);
        expect(director.dismissed).toBe(true);
        expect(director.on).toBe(false);
        // Docked, it stays hers: no shot, though the panel's clock still runs and she is still confirmed.
        const docked = watch(s, B, { until: () => false, most: 30 * 4 });
        expect(docked.shots).toEqual([]);
        expect(director.confirmed).toBe(1);
        expect(director.sinceDocked).toBeGreaterThan(DIRECTOR.panelAfter + DIRECTOR.panelFade);
        // Casting off is a new manoeuvre: the harbour has the camera again.
        s.dock(B, false);
        const out = watch(s, B, { until: (m) => m === 'none' });
        expect(out.shots).toEqual(['lift', 'clear', 'handover']);
        expect(director.dismissed).toBe(false);
    });

    it('signing in to a ship already in the station\'s hands goes straight to the shot for where she is, without the ones before it', () => {
        const berth = STATION.berths[0]!;
        // Docked: the settled shot at once, the panel up at once, and no chime.
        const docked = createSector(placed({ [A]: { p: [...berth.at], berth: 1, mooring: 'docked' } }));
        docked.enter(A);
        const first = watch(docked, A, { until: () => false, most: 1, arrived: true });
        expect(first.shots).toEqual(['berthed']);
        expect(director.confirmed).toBe(0);
        expect(director.sinceDocked).toBeGreaterThanOrEqual(DIRECTOR.panelAfter + DIRECTOR.panelFade);
        // The camera is at the shot, not sweeping in from somewhere else.
        const rig = rigFor('berthed', [...berth.at] as Vec3, 1);
        expect(Math.hypot(director.eye[0] - rig.eye[0], director.eye[1] - rig.eye[1], director.eye[2] - rig.eye[2])).toBeLessThan(1);
        expect(director.shown).toEqual(['berthed']);
        // Part way down when she signs in: the three-quarter shot, not the long one first.
        reset();
        const coming = createSector(placed({ [A]: { p: [...berth.approach] } }));
        coming.enter(A);
        coming.dock(A, true);
        for (let n = 0; n < 30 * 60 && coming.stateFor(A).flight.pos.y > 100; n++) coming.step(TICK);
        expect(coming.stateFor(A).you.mooring).toBe('docking');
        const joined = watch(coming, A, { until: (m) => m === 'docked', arrived: true });
        expect(joined.shots).toEqual(['settle', 'berthed']);
    });
});

import { createSector, freshSave, type Saved, type Sector } from '../server/world';
import { GRAMS, SECTOR, approach, mayDock } from '../src/shared/sector';
import { FLIGHT_TICK } from '../src/shared/steer';

const A = 'pilot-a', B = 'pilot-b';
const TOTAL = SECTOR.rock.total, STATION = SECTOR.station;
const all = (s: Sector): number => { const ore = s.ore(); return ore.remaining + ore.held + ore.stored; };
const run = (s: Sector, seconds: number): void => { for (let ms = 0; ms < seconds * 1000; ms += SECTOR.tickMs) s.step(SECTOR.tickMs); };

/** A save with each pilot where the test wants her: at the station or at her berth, with ore in her hold. */
const placed = (at: { [id: string]: { cargo?: number; stored?: number; docked?: boolean; atStation?: boolean; off?: number } }): Saved => {
    const saved = freshSave();
    let out = 0;
    [A, B].forEach((id, i) => {
        const want = at[id] ?? {}, p = want.atStation ? [STATION.at[0] + (want.off ?? 40), STATION.at[1], STATION.at[2]] : [...SECTOR.berths[i]!];
        saved.pilots[id] = { cargo: want.cargo ?? 0, stored: want.stored ?? 0, docked: want.docked ?? false, moves: 0, p: p as [number, number, number], q: [0, 0, 0, 1], ops: [] };
        out += (want.cargo ?? 0) + (want.stored ?? 0);
    });
    saved.rock.remaining = TOTAL - out;
    return saved;
};
const alongside = (cargo = 2 * GRAMS): Sector => { const s = createSector(placed({ [A]: { cargo, atStation: true }, [B]: { cargo: 3 * GRAMS, atStation: true, off: -60 } })); s.enter(A); s.enter(B); return s; };
const docked = (cargo = 2 * GRAMS): Sector => { const s = alongside(cargo); s.dock(A, true); s.dock(B, true); return s; };

describe('the station', () => {
    it('stands where no beam reaches: ore comes to it in a hold or not at all', () => {
        const rock = SECTOR.rock.at, far = Math.hypot(STATION.at[0] - rock[0], STATION.at[1] - rock[1], STATION.at[2] - rock[2]);
        expect(far - STATION.dockRange).toBeGreaterThan(SECTOR.range + 400);
        const s = docked();
        s.mine(A, true);
        run(s, 5);
        expect(s.stateFor(A).you).toMatchObject({ mining: false, cargo: 2 * GRAMS });
        // And from where a ship mines she is nowhere near it.
        for (const berth of SECTOR.berths) expect(Math.hypot(berth[0] - STATION.at[0], berth[1] - STATION.at[1], berth[2] - STATION.at[2])).toBeGreaterThan(STATION.dockRange + 1000);
    });

    it('is docked with by a ship the server has flown within reach of it and slowed, and by no other', () => {
        expect(mayDock(STATION.dockRange, STATION.dockSpeed)).toBe('');
        expect(mayDock(STATION.dockRange + 0.01, 0)).toBe('TOO FAR');
        expect(mayDock(10, STATION.dockSpeed + 0.01)).toBe('TOO FAST');
        expect(mayDock(Number.NaN, 0)).toBe('TOO FAR');
        expect(mayDock(10, Number.NaN)).toBe('TOO FAST');
        const s = createSector();
        expect(s.dock(A, true)).toEqual({ docked: false, why: 'TOO FAR' });
        s.enter(A);
        // At her berth, sixteen hundred units off: asking, however often and with whatever beside it, does not dock her.
        for (let n = 0; n < 50; n++) expect(s.dock(A, true)).toEqual({ docked: false, why: 'TOO FAR' });
        expect(s.dock(A, 'yes' as never).docked).toBe(false);
        expect(s.dock(A, { docked: true, distance: 0, speed: 0 } as never).docked).toBe(false);
        expect(s.stateFor(A).you.docked).toBe(false);
        // Nine hundred units short of its reach is still too far; and within reach at speed she may not dock either.
        const there = createSector(placed({ [A]: { atStation: true, off: STATION.dockRange + 900 } }));
        there.enter(A);
        expect(there.dock(A, true).why).toBe('TOO FAR');
        const fast = createSector(placed({ [A]: { atStation: true, off: 0 } }));
        fast.enter(A);
        let n = 0;
        for (let t = 0; t < 1.2; t += FLIGHT_TICK) { fast.steer(A, [{ seq: ++n, order: 1, rudder: 0, elevation: 0, roll: 0 }]); fast.step(FLIGHT_TICK * 1000); }
        expect(fast.stateFor(A).flight.speed).toBeGreaterThan(STATION.dockSpeed);
        expect(fast.stateFor(A).you.station).toBeLessThan(STATION.dockRange);
        expect(fast.dock(A, true)).toEqual({ docked: false, why: 'TOO FAST' });
        // Engine stopped, she runs her way off, and then she may.
        for (let t = 0; t < 6; t += FLIGHT_TICK) { fast.steer(A, [{ seq: ++n, order: 0, rudder: 0, elevation: 0, roll: 0 }]); fast.step(FLIGHT_TICK * 1000); }
        expect(fast.stateFor(A).you.station).toBeLessThan(STATION.dockRange);
        expect(fast.dock(A, true)).toEqual({ docked: true, why: '' });
        expect(fast.stateFor(A).flight).toMatchObject({ speed: 0, throttle: 0, yawRate: 0 });
    });

    it('holds a docked ship: her helm does nothing until she casts off', () => {
        const s = docked();
        const at = { ...s.stateFor(A).flight.pos };
        for (let n = 1; n <= 150; n++) { s.steer(A, [{ seq: n, order: 1, rudder: 1, elevation: 1, roll: 0 }]); s.step(FLIGHT_TICK * 1000); }
        expect(s.stateFor(A).flight.pos).toEqual(at);
        expect(s.stateFor(A).flight.speed).toBe(0);
        expect(s.stateFor(A)).toMatchObject({ ack: 150, waiting: 0 });
        expect(s.dock(A, false)).toEqual({ docked: false, why: '' });
        for (let n = 151; n <= 300; n++) { s.steer(A, [{ seq: n, order: 1, rudder: 0, elevation: 0, roll: 0 }]); s.step(FLIGHT_TICK * 1000); }
        expect(s.stateFor(A).flight.pos.z - at.z).toBeGreaterThan(100);
    });

    it('tells a helm how to come to it, a step at a time', () => {
        expect(approach({ distance: 2000, speed: 0, order: 0, aligned: false })).toMatchObject({ cue: 'Gate' });
        expect(approach({ distance: 2000, speed: 0, order: 0, aligned: true })).toMatchObject({ cue: 'Engine75' });
        expect(approach({ distance: 2000, speed: 300, order: 0.75, aligned: true })).toMatchObject({ cue: '' });
        expect(approach({ distance: 700, speed: 300, order: 0.75, aligned: true })).toMatchObject({ cue: 'Engine25' });
        expect(approach({ distance: 700, speed: 0, order: 0, aligned: true })).toMatchObject({ cue: 'Engine25' });
        expect(approach({ distance: 700, speed: 100, order: 0.25, aligned: true })).toMatchObject({ cue: '' });
        expect(approach({ distance: 250, speed: 100, order: 0.25, aligned: true })).toMatchObject({ cue: 'Engine0' });
        expect(approach({ distance: 250, speed: 100, order: 0, aligned: true })).toMatchObject({ cue: '' });
        expect(approach({ distance: 250, speed: 60, order: 0, aligned: false })).toMatchObject({ cue: 'Dock' });
        expect(approach({ distance: 250, speed: 75, order: 0, aligned: true })).toMatchObject({ cue: '' });
    });
});

import { createSector, freshSave, auditSave, tug, type Account, type Saved, type Sector } from '../server/world';
import { GRAMS, SECTOR, approach, berthOf, mayDock, type Vec3 } from '../src/shared/sector';
import { FLIGHT_TICK, atRest, turnBy, type Flight } from '../src/shared/steer';
import { TOP_SPEED } from '../src/shipState';
import { createPredictor } from '../src/shared/predict';

const A = 'pilot-a', B = 'pilot-b';
const TOTAL = SECTOR.rock.total, STATION = SECTOR.station, TICK = FLIGHT_TICK * 1000;
const [ONE, TWO] = STATION.berths;
const run = (s: Sector, seconds: number, each?: () => void): void => { for (let t = 0; t < seconds - 1e-9; t += FLIGHT_TICK) { s.step(TICK); each?.(); } };
const at = (s: Sector, id: string): Vec3 => { const p = s.stateFor(id).flight.pos; return [p.x, p.y, p.z]; };
const far = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const you = (s: Sector, id: string) => s.stateFor(id).you;

/** A save with each pilot where the test wants her. */
const placed = (where: { [id: string]: { p?: readonly number[]; q?: readonly number[]; cargo?: number; berth?: number; mooring?: Saved['pilots'][string]['mooring'] } }, ids = [A, B]): Saved => {
    const saved = freshSave();
    let out = 0;
    ids.forEach((id, i) => {
        const want = where[id] ?? {};
        saved.pilots[id] = { cargo: want.cargo ?? 0, stored: 0, credits: 0, berth: want.berth ?? 0, mooring: want.mooring ?? 'none', moves: 0, p: [...(want.p ?? SECTOR.berths[i % 2]!)] as Vec3, q: [...(want.q ?? [0, 0, 0, 1])] as [number, number, number, number], ops: [] };
        out += want.cargo ?? 0;
    });
    saved.rock.remaining = TOTAL - out;
    return saved;
};
const near = (berth: typeof ONE, off: readonly number[] = [0, 0, 0]): Vec3 => [berth.approach[0] + off[0]!, berth.approach[1] + off[1]!, berth.approach[2] + off[2]!];

// The station where a ship could foul it, as boxes in the sector's own coordinates: the wing the two berths are on, what stands on
// its back, the two berth frames, and the tower. A frigate lying to the berths' heading is a box; turned any other way she is taken
// as the ball that holds her whichever way she lies.
const S = STATION.at;
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => ({ min: [S[0] + x0, S[1] + y0, S[2] + z0], max: [S[0] + x1, S[1] + y1, S[2] + z1] });
const STRUCTURE = [
    box(-41, 41, -19, 19, 92, 420),          // the spar
    box(-22, 22, 15, 48, 100, 420),          // the housing, cargo, crane and tip mast along its back
    ...[1, -1].flatMap((side) => [
        box(Math.min(side * 36, side * 117), Math.max(side * 36, side * 117), -5, 5, 165.5, 174.5),   // fore arm
        box(Math.min(side * 36, side * 117), Math.max(side * 36, side * 117), -5, 5, 313.5, 322.5),   // aft arm
        box(Math.min(side * 107.5, side * 118.5), Math.max(side * 107.5, side * 118.5), -5, 28, 165, 323), // outer beam, its lamps and mast
    ]),
    box(-130, 130, -250, 240, -130, 130),    // the hub, the tower and everything hung below
];
const HULL = { min: [-24.5, -11.5, -52.5], max: [24.5, 23.5, 59.5] }, BALL = 64;
const fouls = (f: Flight): boolean => {
    const aligned = Math.abs(f.level.w) > 0.999999, c = [f.pos.x, f.pos.y, f.pos.z];
    return STRUCTURE.some((part) => {
        if (aligned) return [0, 1, 2].every((axis) => c[axis]! + HULL.min[axis]! < part.max[axis]! && c[axis]! + HULL.max[axis]! > part.min[axis]!);
        const nearest = c.map((v, axis) => Math.max(part.min[axis]!, Math.min(part.max[axis]!, v)));
        return far(nearest, c) < BALL;
    });
};

describe('the station\'s berths', () => {
    it('stand where no beam reaches, a frigate fits each with room to spare, and the way in is clear of the station', () => {
        const rock = SECTOR.rock.at;
        for (const berth of STATION.berths) {
            expect(far(berth.at, rock)).toBeGreaterThan(SECTOR.range + 400);
            expect(far(berth.approach, rock)).toBeGreaterThan(SECTOR.range + 400);
            // Over is straight above the berth, and the approach is level with it and further out to the same side.
            expect([berth.over[0], berth.over[2]]).toEqual([berth.at[0], berth.at[2]]);
            expect(berth.approach[1]).toBe(berth.over[1]);
            expect(Math.abs(berth.approach[0] - S[0])).toBeGreaterThan(Math.abs(berth.over[0] - S[0]) + 60);
            // Lying in it, and over it, she touches nothing; and anywhere she may be taken in hand, turned any way, she touches nothing.
            expect(fouls(atRest({ x: berth.at[0], y: berth.at[1], z: berth.at[2] }))).toBe(false);
            expect(fouls(atRest({ x: berth.over[0], y: berth.over[1], z: berth.over[2] }))).toBe(false);
            for (const off of [[STATION.approachRange, 0, 0], [-STATION.approachRange, 0, 0], [0, -STATION.approachRange, 0], [0, 0, STATION.approachRange], [0, 0, -STATION.approachRange]]) {
                const p = near(berth, off);
                expect(fouls(atRest({ x: p[0], y: p[1], z: p[2] }, { x: 0, y: 0.7071, z: 0, w: 0.7071 }))).toBe(false);
            }
        }
        // Two ships each within reach of her own approach point cannot touch, whichever way each is turned.
        expect(far(ONE.approach, TWO.approach) - 2 * STATION.approachRange).toBeGreaterThan(2 * BALL);
        // And lying in their berths they are a hull's breadth and more apart.
        expect(Math.abs(ONE.at[0] - TWO.at[0]) - (HULL.max[0]! - HULL.min[0]!)).toBeGreaterThan(40);
        // The check itself can tell: nine units off her berth she is still inside the frame, twelve and she is on its beam.
        expect(fouls(atRest({ x: ONE.at[0] + 9, y: 0, z: ONE.at[2] }))).toBe(false);
        expect(fouls(atRest({ x: ONE.at[0] + 12, y: 0, z: ONE.at[2] }))).toBe(true);
    });

    it('are given out by the station, one to a pilot and never one to two', () => {
        const three: Account[] = [{ id: A, name: 'A', token: 'a' }, { id: B, name: 'B', token: 'b' }, { id: 'pilot-c', name: 'C', token: 'c' }];
        const s = createSector(placed({}, [A, B, 'pilot-c']), three);
        expect(s.dock(A, true)).toMatchObject({ berth: 0, mooring: 'none' });
        for (const id of [A, B, 'pilot-c']) s.enter(id);
        // Asking, and asking again, and saying whatever beside it, gets one berth and keeps it.
        expect(s.dock(A, true)).toEqual({ docked: false, why: '', berth: 1, mooring: 'assigned' });
        for (let n = 0; n < 20; n++) expect(s.dock(A, true)).toMatchObject({ berth: 1, mooring: 'assigned' });
        expect(s.dock(A, { dock: true, berth: 2, docked: true } as never)).toMatchObject({ berth: 1, mooring: 'assigned' });
        // The two ask in the same instant: the second gets the other berth; a third gets none.
        expect(s.dock(B, true)).toEqual({ docked: false, why: '', berth: 2, mooring: 'assigned' });
        expect(s.dock('pilot-c', true)).toEqual({ docked: false, why: 'NO BERTH FREE', berth: 0, mooring: 'none' });
        expect(s.berths()).toMatchObject([{ id: 1, pilot: A, mooring: 'assigned', here: true }, { id: 2, pilot: B, mooring: 'assigned', here: true }]);
        // A second sign-in as the same pilot is the same pilot: the same berth, and no other.
        s.enter(A); s.enter(A);
        expect(s.dock(A, true)).toMatchObject({ berth: 1 });
        expect(s.dock('pilot-c', true).why).toBe('NO BERTH FREE');
        // Given up, it goes to whoever asks next.
        expect(s.dock(A, false)).toEqual({ docked: false, why: '', berth: 0, mooring: 'none' });
        expect(s.dock('pilot-c', true)).toMatchObject({ berth: 1, mooring: 'assigned' });
        expect(s.dock(A, true).why).toBe('NO BERTH FREE');
        expect(auditSave(s.save())).toBe('');
    });

    it('take a ship in hand only where the server has flown her to her approach point, and slowed', () => {
        expect(mayDock(STATION.approachRange, STATION.dockSpeed)).toBe('');
        expect(mayDock(STATION.approachRange + 0.01, 0)).toBe('TOO FAR');
        expect(mayDock(10, STATION.dockSpeed + 0.01)).toBe('TOO FAST');
        expect(mayDock(Number.NaN, 0)).toBe('TOO FAR');
        // Where the sector was founded: she has a berth kept, and nothing she sends brings her in.
        const s = createSector();
        s.enter(A);
        s.dock(A, true);
        run(s, 3);
        expect(you(s, A)).toMatchObject({ mooring: 'assigned', berth: 1, hold: 'TOO FAR', docked: false });
        // Without a berth kept for her, lying on the approach point itself does nothing.
        const unasked = createSector(placed({ [A]: { p: ONE.approach } }));
        unasked.enter(A);
        run(unasked, 2);
        expect(you(unasked, A)).toMatchObject({ mooring: 'none', berth: 0 });
        // Sailing through her approach point at speed she is not taken; out the far side she is out of reach again.
        const fast = createSector(placed({ [A]: { p: near(ONE, [0, 0, -30]) } }));
        fast.enter(A);
        let n = 0;
        for (let t = 0; t < 1.3; t += FLIGHT_TICK) { fast.steer(A, [{ seq: ++n, order: 1, rudder: 0, elevation: 0, roll: 0 }]); fast.step(TICK); }
        fast.dock(A, true);
        fast.steer(A, [{ seq: ++n, order: 1, rudder: 0, elevation: 0, roll: 0 }]);
        fast.step(TICK);
        expect(fast.stateFor(A).flight.speed).toBeGreaterThan(STATION.dockSpeed);
        expect(far(at(fast, A), ONE.approach)).toBeLessThan(STATION.approachRange);
        expect(you(fast, A)).toMatchObject({ mooring: 'assigned', hold: 'TOO FAST' });
        for (let t = 0; t < 4; t += FLIGHT_TICK) { fast.steer(A, [{ seq: ++n, order: 1, rudder: 0, elevation: 0, roll: 0 }]); fast.step(TICK); }
        expect(you(fast, A)).toMatchObject({ mooring: 'assigned', hold: 'TOO FAR' });
        // At rest within reach of it, she is taken that step.
        const slow = createSector(placed({ [A]: { p: near(ONE, [20, -10, 15]) } }));
        slow.enter(A);
        slow.dock(A, true);
        slow.step(TICK);
        expect(you(slow, A)).toMatchObject({ mooring: 'docking', berth: 1 });
    });

    it('bring her in along one way, at the station\'s pace, into her berth exactly, touching nothing, and only then open her warehouse', () => {
        const s = createSector(placed({ [A]: { p: near(ONE, [30, -20, 25]), q: [0, 0.6, 0, 0.8], cargo: 2 * GRAMS } }));
        s.enter(A);
        s.dock(A, true);
        const legs = new Set<string>();
        let before = s.stateFor(A).flight, seq = 0, ticks = 0, fouled = 0, refusedEarly = 0;
        while (you(s, A).mooring !== 'docked' && ticks < 30 * 60) {
            // Her pilot heaves on everything all the way in, and asks for her warehouse.
            s.steer(A, [{ seq: ++seq, order: 1, rudder: 1, elevation: -1, roll: 1 }]);
            s.step(TICK);
            ticks++;
            const now = s.stateFor(A).flight;
            expect(far([now.pos.x, now.pos.y, now.pos.z], [before.pos.x, before.pos.y, before.pos.z])).toBeLessThanOrEqual(STATION.tug.speed * FLIGHT_TICK + 1e-9);
            expect(now.speed).toBe(0);
            if (fouls(now)) fouled++;
            const aligned = Math.abs(now.level.w) > 0.999999;
            legs.add(!aligned ? 'turning' : now.pos.x === ONE.over[0] && now.pos.z === ONE.over[2] ? 'down' : now.pos.y === ONE.over[1] ? 'across' : 'to the point');
            if (ticks % 30 === 0 && you(s, A).mooring === 'docking' && s.transfer(A, you(s, A).next, `early-${ticks}-order`, false, 1).why === 'NOT DOCKED') refusedEarly++;
            before = now;
        }
        expect(you(s, A)).toMatchObject({ mooring: 'docked', docked: true, berth: 1 });
        expect(at(s, A)).toEqual([...ONE.at]);
        expect(s.stateFor(A).flight.level).toEqual({ x: 0, y: 0, z: 0, w: 1 });
        expect(fouled).toBe(0);
        expect(legs.has('turning') && legs.has('across') && legs.has('down')).toBe(true);
        expect(refusedEarly).toBeGreaterThan(5);
        // Under 45 units to her point, 90 across, 170 down, at 16 a second: twenty seconds or so.
        expect(ticks * FLIGHT_TICK).toBeGreaterThan(15);
        expect(ticks * FLIGHT_TICK).toBeLessThan(26);
        expect(s.stateFor(A)).toMatchObject({ ack: seq, waiting: 0 });
        // Now she is in, it opens; and her helm still does nothing.
        expect(s.transfer(A, you(s, A).next, 'order-once-docked', false, 1 * GRAMS)).toMatchObject({ ok: true, stored: 1 * GRAMS });
        for (let n = 0; n < 90; n++) { s.steer(A, [{ seq: ++seq, order: 1, rudder: 1, elevation: 0, roll: 0 }]); s.step(TICK); }
        expect(at(s, A)).toEqual([...ONE.at]);
    });

    it('take her out the way she came, shut her warehouse the moment she casts off, and let her go at rest clear of the station', () => {
        const s = createSector(placed({ [A]: { p: ONE.at, berth: 1, mooring: 'docked', cargo: 2 * GRAMS } }));
        s.enter(A);
        expect(s.dock(A, false)).toEqual({ docked: false, why: '', berth: 1, mooring: 'undocking' });
        // At once: no warehouse, and no changing her mind half way.
        expect(s.transfer(A, 1, 'order-after-cast-off', false, 1)).toMatchObject({ ok: false, why: 'NOT DOCKED' });
        expect(s.dock(A, true)).toMatchObject({ mooring: 'undocking', berth: 1 });
        expect(s.dock(A, false)).toMatchObject({ why: 'MANEUVERING', mooring: 'undocking' });
        let ticks = 0, fouled = 0, seq = 0, highest = 0;
        const path: Vec3[] = [];
        while (you(s, A).mooring === 'undocking' && ticks < 30 * 60) {
            s.steer(A, [{ seq: ++seq, order: 1, rudder: -1, elevation: 1, roll: 0 }]);
            s.step(TICK);
            ticks++;
            if (fouls(s.stateFor(A).flight)) fouled++;
            path.push(at(s, A));
            highest = Math.max(highest, at(s, A)[1]);
        }
        // Released: at the approach point, at rest, heading out, with no berth, and nowhere inside the station.
        expect(you(s, A)).toMatchObject({ mooring: 'none', berth: 0, docked: false });
        expect(at(s, A)).toEqual([...ONE.approach]);
        expect(s.stateFor(A).flight).toMatchObject({ speed: 0, throttle: 0, yawRate: 0 });
        expect(fouled).toBe(0);
        expect(fouls(s.stateFor(A).flight)).toBe(false);
        expect(highest).toBe(ONE.over[1]);
        // Straight up first: for the whole of the rise she is over her berth.
        expect(path.filter((p) => p[1] < ONE.over[1]).every((p) => p[0] === ONE.at[0] && p[2] === ONE.at[2])).toBe(true);
        expect(s.berths()[0]).toMatchObject({ id: 1, pilot: '' });
        // And the helm is hers again: the next orders are flown.
        const from = at(s, A);
        for (let n = 0; n < 150; n++) { s.steer(A, [{ seq: ++seq, order: 1, rudder: 0, elevation: 0, roll: 0 }]); s.step(TICK); }
        expect(at(s, A)[2] - from[2]).toBeGreaterThan(60);
        expect(s.stateFor(A).flight.speed).toBeLessThanOrEqual(TOP_SPEED);
    });

    it('bring two ships in at once to their own berths, never nearer one another than a hull, and both see the same', () => {
        const s = createSector(placed({ [A]: { p: near(ONE, [-40, 10, 0]), q: [0, 0.7071, 0, 0.7071] }, [B]: { p: near(TWO, [40, -10, 5]), q: [0, -0.7071, 0, 0.7071] } }));
        s.enter(A); s.enter(B);
        expect([s.dock(A, true).berth, s.dock(B, true).berth]).toEqual([1, 2]);
        let closest = Infinity, fouled = 0, bothInHand = 0;
        run(s, 30, () => {
            closest = Math.min(closest, far(at(s, A), at(s, B)));
            if (fouls(s.stateFor(A).flight) || fouls(s.stateFor(B).flight)) fouled++;
            if (you(s, A).mooring === 'docking' && you(s, B).mooring === 'docking') bothInHand++;
        });
        expect(you(s, A)).toMatchObject({ mooring: 'docked', berth: 1 });
        expect(you(s, B)).toMatchObject({ mooring: 'docked', berth: 2 });
        expect([at(s, A), at(s, B)]).toEqual([[...ONE.at], [...TWO.at]]);
        expect(bothInHand).toBeGreaterThan(300);
        expect(fouled).toBe(0);
        expect(closest).toBeGreaterThan(2 * BALL);
        // What each is told of the other is where the server has her: one account of both ships.
        expect(s.stateFor(B).others.find((o) => o.account === A)).toMatchObject({ p: [...ONE.at], berth: 1, mooring: 'docked', docked: true });
        expect(s.stateFor(A).others.find((o) => o.account === B)).toMatchObject({ p: [...TWO.at], berth: 2, mooring: 'docked' });
    });

    it('keep a berth for a pilot who has gone for thirty seconds and no longer, unless the station has her', () => {
        // B lies off berth 1's approach point: A will have given berth 1 up by the time she asks, and it is the first free.
        const s = createSector(placed({ [A]: { p: [0, 0, 0] }, [B]: { p: near(ONE, [10, 0, 0]) } }));
        s.enter(A); s.enter(B);
        s.dock(A, true);
        // Gone for twenty-nine seconds and back: the same berth, and the count starts again.
        s.leave(A);
        run(s, 29);
        expect(s.berths()[0]).toMatchObject({ pilot: A, mooring: 'assigned', here: false });
        s.enter(A);
        expect(you(s, A)).toMatchObject({ berth: 1, mooring: 'assigned' });
        s.leave(A);
        run(s, 29);
        expect(s.berths()[0]!.pilot).toBe(A);
        // Past thirty, it is given up, and is the next pilot's to have.
        run(s, 1.2);
        expect(s.berths()[0]).toMatchObject({ pilot: '', mooring: 'none' });
        s.enter(A);
        expect(you(s, A)).toMatchObject({ berth: 0, mooring: 'none' });
        // B is being brought in when her link goes: the station carries on, and she is docked however long she is away.
        s.dock(B, true);
        run(s, 2);
        expect(you(s, B).mooring).toBe('docking');
        s.leave(B);
        run(s, 120);
        expect(s.berths()[0]).toMatchObject({ id: 1, pilot: B, mooring: 'docked', here: false });
        s.enter(B);
        expect(you(s, B)).toMatchObject({ berth: 1, mooring: 'docked', docked: true });
        expect(at(s, B)).toEqual([...ONE.at]);
    });

    it('are as they were after a restart: a docked ship in her berth, a kept berth kept, and no ship left part way', () => {
        const s = createSector(placed({ [A]: { p: ONE.at, berth: 1, mooring: 'docked', cargo: 1 * GRAMS }, [B]: { p: near(TWO, [5, 5, 5]) } }));
        s.enter(A); s.enter(B);
        s.dock(B, true);
        run(s, 6);
        expect(you(s, B).mooring).toBe('docking');
        // Stopped with B half way in.
        const half = JSON.parse(JSON.stringify(s.save())) as Saved;
        expect(half.pilots[B]).toMatchObject({ berth: 2, mooring: 'docking' });
        expect(auditSave(half)).toBe('');
        const back = createSector(half);
        expect(back.berths()).toMatchObject([{ id: 1, pilot: A, mooring: 'docked', here: false }, { id: 2, pilot: B, mooring: 'docked', here: false }]);
        back.enter(A); back.enter(B);
        expect(at(back, A)).toEqual([...ONE.at]);
        expect(at(back, B)).toEqual([...TWO.at]);
        expect(you(back, A)).toMatchObject({ cargo: 1 * GRAMS, docked: true, berth: 1 });
        // Stopped with A half way out: she comes back let go, clear, with no berth.
        back.dock(A, false);
        run(back, 4);
        expect(you(back, A).mooring).toBe('undocking');
        const out = createSector(JSON.parse(JSON.stringify(back.save())));
        out.enter(A);
        expect(you(out, A)).toMatchObject({ mooring: 'none', berth: 0 });
        expect(at(out, A)).toEqual([...ONE.approach]);
        expect(fouls(out.stateFor(A).flight)).toBe(false);
        // A berth that was only kept, in a save with no time for giving it up (the server was killed with her pilot still there),
        // is kept across the restart for thirty seconds from it: she cannot have gone sooner than that.
        const kept = createSector(placed({ [A]: { berth: 2, mooring: 'assigned' } }));
        expect(kept.berths()[1]).toMatchObject({ pilot: A, mooring: 'assigned' });
        run(kept, 29);
        expect(kept.berths()[1]!.pilot).toBe(A);
        run(kept, 2);
        expect(kept.berths()[1]!.pilot).toBe('');
    });

    it('refuse a save in which a berth is held twice, is not one the station has, or does not go with her mooring', () => {
        const good = placed({ [A]: { p: ONE.at, berth: 1, mooring: 'docked' }, [B]: { berth: 2, mooring: 'assigned' } });
        expect(auditSave(good)).toBe('');
        for (const edit of [
            (v: Saved) => { v.pilots[B]!.berth = 1; },
            (v: Saved) => { v.pilots[A]!.berth = 3; },
            (v: Saved) => { v.pilots[A]!.berth = 0; },
            (v: Saved) => { v.pilots[A]!.mooring = 'none'; },
            (v: Saved) => { v.pilots[B]!.mooring = 'moored' as never; },
            (v: Saved) => { delete (v.pilots[B] as { berth?: number }).berth; },
        ]) {
            const forged = JSON.parse(JSON.stringify(good)) as Saved;
            edit(forged);
            expect(auditSave(forged)).not.toBe('');
            expect(() => createSector(forged)).toThrow();
        }
    });

    it('move a ship in hand no faster than the station moves ships, and turn her no faster than it turns them', () => {
        const f = atRest({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0, w: 0 });
        let steps = 0, turned = 0;
        for (; steps < 2000; steps++) {
            const was = { ...f.level }, from = { ...f.pos };
            const moved = tug(f, { x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, FLIGHT_TICK);
            const dot = Math.abs(was.x * f.level.x + was.y * f.level.y + was.z * f.level.z + was.w * f.level.w);
            turned = Math.max(turned, 2 * Math.acos(Math.min(1, dot)));
            expect(far([f.pos.x, f.pos.y, f.pos.z], [from.x, from.y, from.z])).toBeLessThanOrEqual(STATION.tug.speed * FLIGHT_TICK + 1e-9);
            if (moved.there) break;
        }
        expect(turned).toBeLessThanOrEqual(STATION.tug.turn * FLIGHT_TICK * 1.02);
        // A half turn at 0.3 a second is ten seconds and more; a hundred units at 16 is six: she is there when both are done.
        expect(steps * FLIGHT_TICK).toBeGreaterThan(Math.PI / STATION.tug.turn - 0.5);
        expect(f.pos).toEqual({ x: 100, y: 0, z: 0 });
        expect(f.level).toEqual({ x: 0, y: 0, z: 0, w: 1 });
        expect(turnBy(f.level, { x: 0, y: 0, z: 1 }).z).toBe(1);
    });

    it('tell a helm how to come to her approach point, a step at a time', () => {
        const say = (s: Partial<Parameters<typeof approach>[0]>) => approach({ distance: 2000, speed: 0, order: 0, aligned: true, berth: 2, ...s });
        expect(say({ aligned: false })).toMatchObject({ cue: 'Gate' });
        expect(say({ aligned: false }).text).toMatch(/BERTH 2/);
        expect(say({})).toMatchObject({ cue: 'Engine75' });
        expect(say({ speed: 300, order: 0.75 })).toMatchObject({ cue: '' });
        expect(say({ distance: 400, speed: 300, order: 0.75 })).toMatchObject({ cue: 'Engine25' });
        expect(say({ distance: 400 })).toMatchObject({ cue: 'Engine25' });
        expect(say({ distance: 400, speed: 100, order: 0.25 })).toMatchObject({ cue: '' });
        expect(say({ distance: 30, speed: 100, order: 0.25 })).toMatchObject({ cue: 'Engine0' });
        expect(say({ distance: 30, speed: 100 })).toMatchObject({ cue: '' });
        expect(say({ distance: 30, speed: 75 }).text).toMatch(/SLOWING/);
        expect(say({ distance: 30, speed: 60 }).text).toMatch(/HOLD HER HERE/);
        expect(berthOf(1)).toBe(ONE);
        expect(berthOf(9)).toBeNull();
    });
});

describe('what the review of the berths found', () => {
    it('the helm is hers again after a cast-off in the same sign-in: her orders go on from the number they had reached, and the server flies them', () => {
        // The game's own link, as src/online.ts keeps it: a predictor numbering the helm's orders, and a sector flying them.
        const s = createSector(placed({ [A]: { p: near(ONE, [0, 0, 400]), q: [0, 1, 0, 0], cargo: 2 * GRAMS } }));
        s.enter(A);
        const p = createPredictor();
        p.take(s.welcome(A).flight);
        let mooring = you(s, A).mooring, helm = { order: 0.25, rudder: 0, elevation: 0, roll: 0 }, sent: number[] = [];
        const frame = (): void => {
            p.advance(FLIGHT_TICK, helm, true, mooring === 'docking' || mooring === 'docked' || mooring === 'undocking');
            const out = p.drain();
            sent.push(...out.map((one) => one.seq));
            s.steer(A, out.map((one) => ({ seq: one.seq, ...one.orders })));
            s.step(TICK);
            const state = s.stateFor(A), was = mooring;
            mooring = state.you.mooring;
            const held = (m: string): boolean => m === 'docking' || m === 'docked' || m === 'undocking';
            if (held(was) && !held(mooring)) p.take(state.flight, { signedIn: false, from: state.ack }); else p.settle(state.flight, state.ack, state.waiting);
        };
        // Under her own helm to the approach point, where she is taken in hand and brought in.
        s.dock(A, true);
        for (let n = 0; n < 30 * 120 && mooring !== 'docked'; n++) { helm = { ...helm, order: mooring === 'assigned' && far(at(s, A), ONE.approach) > 60 ? 0.25 : 0 }; frame(); }
        expect(mooring).toBe('docked');
        const before = p.numbered();
        expect(before).toBeGreaterThan(100);
        expect(s.taken(A)).toBe(before);
        // Cast off, and at her helm the moment she is let go: no sign-in, no restart.
        s.dock(A, false);
        helm = { ...helm, order: 0 };
        for (let n = 0; n < 30 * 60 && mooring !== 'none'; n++) frame();
        expect(mooring).toBe('none');
        expect(at(s, A)).toEqual([...ONE.approach]);
        sent = [];
        helm = { order: 0.5, rudder: 0, elevation: 0, roll: 0 };
        for (let n = 0; n < 150; n++) frame();
        // Five seconds at half ahead: every order was numbered past the last the server had, and it flew them.
        expect(Math.min(...sent)).toBe(before + 1);
        // A client's clock is paced a few parts in a hundred to the server's, so 150 frames is 150 orders give or take.
        expect(s.taken(A)).toBeGreaterThanOrEqual(before + 145);
        expect(s.taken(A)).toBeLessThanOrEqual(before + 158);
        expect(s.taken(A)).toBe(p.numbered());
        expect(s.stateFor(A).ack).toBeGreaterThan(before + 140);
        expect(s.stateFor(A).flight.speed).toBeGreaterThan(TOP_SPEED * 0.4);
        expect(far(at(s, A), ONE.approach)).toBeGreaterThan(60);
        expect(far([p.show().pos.x, p.show().pos.y, p.show().pos.z], at(s, A))).toBeLessThan(5);
        // A new sign-in is the one time the count starts again, because the server's does.
        s.leave(A); s.enter(A);
        p.take(s.welcome(A).flight);
        expect(p.numbered()).toBe(0);
        expect(s.taken(A)).toBe(0);
    });

    it('a berth only kept is given up thirty seconds after its pilot went, by the clock on the wall, however the server was stopped and started meanwhile', () => {
        const s = createSector(placed({ [A]: { p: [0, 0, 0] } }));
        s.enter(A);
        s.dock(A, true);
        expect(s.save().pilots[A]!.lapses).toBe(0);
        const wentAt = s.now();
        s.leave(A);
        expect(s.save().pilots[A]!.lapses).toBe(Math.round(wentAt) + STATION.reserveMs);
        run(s, 20);
        // Stopped twenty seconds after she went, and started at once: twelve seconds more is past the thirty.
        const saved = JSON.parse(JSON.stringify(s.save())) as Saved;
        expect(auditSave(saved)).toBe('');
        const stoppedAt = s.now();
        const back = createSector(saved, undefined, { clock: () => stoppedAt });
        run(back, 9.5);
        expect(back.berths()[0]).toMatchObject({ pilot: A, mooring: 'assigned' });
        run(back, 0.6);
        expect(back.berths()[0]).toMatchObject({ pilot: '', mooring: 'none' });
        expect(back.now() - wentAt).toBeLessThan(STATION.reserveMs + 200);
        // Down for longer than was left: given up on the first step back.
        const late = createSector(saved, undefined, { clock: () => stoppedAt + 15_000 });
        late.step(TICK);
        expect(late.berths()[0]!.pilot).toBe('');
        // Started again and again, each time with five seconds run: it is still thirty seconds in all, not thirty from the last start.
        let hopping = createSector(saved, undefined, { clock: () => stoppedAt });
        for (let hop = 0; hop < 2; hop++) {
            run(hopping, 4.5);
            expect(hopping.berths()[0]!.pilot).toBe(A);
            const at = hopping.now();
            hopping = createSector(JSON.parse(JSON.stringify(hopping.save())), undefined, { clock: () => at });
        }
        run(hopping, 1.2);
        expect(hopping.berths()[0]!.pilot).toBe('');
        // Back before it lapses, she keeps it, nothing is due any more, and going again starts thirty seconds afresh.
        const home = createSector(saved, undefined, { clock: () => stoppedAt });
        home.enter(A);
        expect(home.save().pilots[A]!.lapses).toBe(0);
        run(home, 40);
        expect(home.berths()[0]!.pilot).toBe(A);
        // A save that says a berth is due to be given up when it is not one only kept is not one this server wrote.
        const bad = JSON.parse(JSON.stringify(saved)) as Saved;
        bad.pilots[A]!.mooring = 'docked';
        expect(auditSave(bad)).toMatch(/due to be given up/);
    });

    it('with a disk under the sector a ship in her berth is not docked until a save has her there, and is docked by the write that does', () => {
        const s = createSector(placed({ [A]: { p: near(ONE, [5, 0, 0]), cargo: 2 * GRAMS } }), undefined, { keeper: true });
        s.enter(A);
        const beforeBerth = JSON.parse(JSON.stringify(s.save())) as Saved;
        s.dock(A, true);
        run(s, 60);
        // She lies in her berth, and no save says so: not docked, warehouse shut, and a save is wanted now.
        expect(at(s, A)).toEqual([...ONE.at]);
        expect(you(s, A)).toMatchObject({ mooring: 'docking', docked: false, arrived: true, hold: 'NOT SAVED' });
        expect(s.unwritten()).toBe(true);
        expect(s.transfer(A, 1, 'too-early-1', false, 1 * GRAMS)).toMatchObject({ ok: false, why: 'NOT DOCKED' });
        expect(s.dock(A, false)).toMatchObject({ why: 'MANEUVERING', mooring: 'docking' });
        // The disk refuses for a long while: she waits where she is, and is told why.
        run(s, 30);
        expect(you(s, A)).toMatchObject({ mooring: 'docking', docked: false, hold: 'NOT SAVED' });
        expect(at(s, A)).toEqual([...ONE.at]);
        // A write of something older, which does not have her in the berth, confirms nothing.
        s.committed(beforeBerth);
        expect(you(s, A).mooring).toBe('docking');
        // Killed now, what is on the disk is the older save: she has no berth, and was never told she had docked.
        const lost = createSector(beforeBerth, undefined, { keeper: true });
        expect(lost.berths()[0]!.pilot).toBe('');
        // The write that succeeds has her there, and would bring her back docked; from that write she is docked.
        const written = JSON.parse(JSON.stringify(s.save())) as Saved;
        expect(written.pilots[A]).toMatchObject({ berth: 1, mooring: 'docking', p: [...ONE.at] });
        const recovered = createSector(written, undefined, { keeper: true });
        recovered.enter(A);
        expect(you(recovered, A)).toMatchObject({ mooring: 'docked', docked: true, berth: 1 });
        expect(at(recovered, A)).toEqual([...ONE.at]);
        s.committed(written);
        expect(you(s, A)).toMatchObject({ mooring: 'docked', docked: true, arrived: false, hold: '' });
        expect(s.unwritten()).toBe(false);
        expect(s.transfer(A, 2, 'now-docked-1', false, 1 * GRAMS)).toMatchObject({ ok: true, stored: 1 * GRAMS });
        // A working disk is quicker than her glass is told anything: for the first moments nothing is said to be wrong.
        const quick = createSector(placed({ [A]: { p: near(ONE, [5, 0, 0]) } }), undefined, { keeper: true });
        quick.enter(A);
        quick.dock(A, true);
        for (let n = 0; n < 30 * 60 && !quick.unwritten(); n++) quick.step(TICK);
        expect(you(quick, A)).toMatchObject({ mooring: 'docking', arrived: true, hold: '' });
    });
});
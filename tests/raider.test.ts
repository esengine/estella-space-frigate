import { RAIDER, advance, aimAt, formUp, steer, unit, waveSize, wanted, type Hazard, type Mind, type V } from '../src/raiderMind';

const STEP = 1 / 60;
const dice = (seed: number): (() => number) => { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
const far = (v: V): number => Math.hypot(v.x, v.y, v.z);
const angle = (a: V, b: V): number => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
const cruise = { x: 0, y: 0, z: 50 };
const fresh = (at: V): Mind => ({ at, way: unit({ x: -at.x, y: -at.y, z: -at.z }), mode: 'run', aside: { x: 1, y: 0, z: 0 }, shots: 0, wait: 0, cool: 0, passes: 0 });

describe('how a raider flies', () => {
    it('turns no faster than its helm allows, and stops turning once it points where it wants', () => {
        const ahead = { x: 0, y: 0, z: 1 }, abeam = { x: 1, y: 0, z: 0 };
        const turned = steer(ahead, abeam, 0.2);
        expect(angle(ahead, turned)).toBeCloseTo(0.2, 6);
        expect(angle(turned, abeam)).toBeCloseTo(Math.PI / 2 - 0.2, 6);
        expect(steer(ahead, unit({ x: 0.05, y: 0, z: 1 }), 0.2)).toEqual(unit({ x: 0.05, y: 0, z: 1 }));
        expect(far(steer(ahead, { x: 0, y: 0, z: -1 }, 0.3))).toBeCloseTo(1, 6);
    });

    it('makes passes: in to gun range, away before it rams, and back again', () => {
        const mind = fresh({ x: 600, y: 80, z: 2200 }), roll = dice(7);
        let nearest = Infinity, furthest = 0;
        for (let frame = 0; frame < 60 * 90; frame++) {
            advance(mind, cruise, [], STEP, roll);
            if (frame > 60 * 30) furthest = Math.max(furthest, far(mind.at));
            nearest = Math.min(nearest, far(mind.at));
        }
        expect(mind.passes).toBeGreaterThanOrEqual(3);
        expect(nearest).toBeGreaterThan(120);
        expect(nearest).toBeLessThan(RAIDER.near);
        expect(furthest).toBeLessThan(RAIDER.far + 700);
    });

    it('fires only on a run, inside its range, with its nose on the lead, in bursts with a rest between', () => {
        const mind = fresh({ x: 300, y: 0, z: 2300 }), roll = dice(11), times: number[] = [];
        for (let frame = 0; frame < 60 * 60; frame++) {
            const before = { ...mind, at: { ...mind.at } };
            const shot = advance(mind, cruise, [], STEP, roll);
            if (!shot) continue;
            times.push(frame * STEP);
            expect(before.mode).toBe('run');
            expect(far(mind.at)).toBeLessThanOrEqual(RAIDER.range);
            expect(angle(shot, aimAt(mind, cruise))).toBeLessThan(RAIDER.cone);
        }
        expect(times.length).toBeGreaterThanOrEqual(RAIDER.burst * 2);
        const gaps = times.slice(1).map((t, i) => t - times[i]!);
        expect(Math.min(...gaps)).toBeGreaterThan(RAIDER.every - 1e-6);
        expect(gaps.filter((gap) => gap > RAIDER.rest - 1e-6).length).toBeGreaterThanOrEqual(1);
    });

    it('lays ahead of a ship that is under way', () => {
        const mind = fresh({ x: 900, y: 0, z: 0 });
        expect(aimAt(mind, cruise).z).toBeGreaterThan(0.05);
        expect(aimAt(mind, { x: 0, y: 0, z: 0 }).z).toBeCloseTo(0, 6);
    });

    it('goes round a rock in its way instead of through it', () => {
        const rock: Hazard = { at: { x: 0, y: 0, z: 1100 }, radius: 40 };
        const blind = fresh({ x: 0, y: 4, z: 2000 }), wary = fresh({ x: 0, y: 4, z: 2000 }), roll = dice(3);
        let through = Infinity, round = Infinity;
        for (let frame = 0; frame < 60 * 14; frame++) {
            advance(blind, { x: 0, y: 0, z: 0 }, [], STEP, roll);
            advance(wary, { x: 0, y: 0, z: 0 }, [rock], STEP, roll);
            through = Math.min(through, far({ x: blind.at.x - rock.at.x, y: blind.at.y - rock.at.y, z: blind.at.z - rock.at.z }));
            round = Math.min(round, far({ x: wary.at.x - rock.at.x, y: wary.at.y - rock.at.y, z: wary.at.z - rock.at.z }));
        }
        expect(through).toBeLessThan(rock.radius);
        expect(round).toBeGreaterThan(rock.radius + RAIDER.radius);
        expect(far(wanted(wary, { x: 0, y: 0, z: 0 }, [rock]))).toBeCloseTo(1, 6);
    });
});

describe('a wave of raiders', () => {
    it('arrives well clear of the ship, apart from one another, already heading in', () => {
        const roll = dice(5), forward = { x: 0, y: 0, z: 1 };
        const wave = [0, 1, 2].map((slot) => formUp(1, slot, forward, roll));
        for (const mind of wave) {
            expect(far(mind.at)).toBeGreaterThan(RAIDER.arrive * 0.9);
            expect(angle(mind.way, unit({ x: -mind.at.x, y: -mind.at.y, z: -mind.at.z }))).toBeLessThan(1e-6);
        }
    });

    it('is two the first time and three after, never more than there are hulls', () => {
        expect([0, 1, 2, 9].map(waveSize)).toEqual([2, 3, 3, 3]);
    });
});

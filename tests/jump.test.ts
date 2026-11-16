import { JUMP, jumpAt, nextSystem } from '../src/jump';
import { SYSTEMS } from '../src/systems';

describe('the jump through a gate', () => {
    it('is nothing before it starts and nothing once it is over', () => {
        expect(jumpAt(-1)).toEqual({ tunnel: 0, stretch: 0, flash: 0, blend: 0, rush: 0, swapped: false, over: true });
        expect(jumpAt(JUMP.seconds)).toEqual({ tunnel: 0, stretch: 0, flash: 0, blend: 1, rush: 0, swapped: true, over: true });
    });

    it('opens from the picture it left and closes on the one it reached without a step', () => {
        const first = jumpAt(0), last = jumpAt(JUMP.seconds - 1e-4);
        expect(first.tunnel).toBe(0);
        expect(first.stretch).toBe(0);
        expect(first.blend).toBe(0);
        expect(first.flash).toBeLessThan(1e-9);
        expect(last.tunnel).toBe(0);
        expect(last.stretch).toBeLessThan(1e-6);
        expect(last.blend).toBe(1);
        expect(last.flash).toBeLessThan(1e-9);
    });

    it('changes systems only while the screen is white', () => {
        expect(jumpAt(JUMP.swap - 1e-3).swapped).toBe(false);
        expect(jumpAt(JUMP.swap).swapped).toBe(true);
        expect(jumpAt(JUMP.swap).flash).toBe(1);
        expect(jumpAt(JUMP.swap - 1e-3).flash).toBeGreaterThan(0.99);
        expect(jumpAt(JUMP.swap).tunnel).toBe(1);
    });

    it('never jerks: no value moves more than a little in one frame', () => {
        const keys = ['tunnel', 'stretch', 'flash', 'blend', 'rush'] as const;
        for (let frame = 1; frame <= Math.ceil(JUMP.seconds * 60); frame++) {
            const before = jumpAt((frame - 1) / 60), now = jumpAt(Math.min(frame / 60, JUMP.seconds - 1e-6));
            for (const key of keys) expect(Math.abs(now[key] - before[key])).toBeLessThan(0.1);
        }
    });

    it('goes round every system in turn', () => {
        const seen = [0];
        while (seen.length < SYSTEMS.length) seen.push(nextSystem(seen[seen.length - 1]!, SYSTEMS.length));
        expect([...seen].sort()).toEqual(SYSTEMS.map((_, i) => i));
        expect(nextSystem(seen[seen.length - 1]!, SYSTEMS.length)).toBe(0);
    });

    it('lights every system from a sun that is a direction, and keeps each planet clear of the ship', () => {
        for (const system of SYSTEMS) {
            expect(Math.hypot(system.sun.x, system.sun.y, system.sun.z)).toBeCloseTo(1, 3);
            expect(Math.hypot(system.at.x, system.at.y, system.at.z) - system.radius).toBeGreaterThan(1600);
        }
    });
});

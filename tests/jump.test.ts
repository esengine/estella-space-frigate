import { JUMP, jumpAt, nextSystem } from '../src/jump';
import { makeSystem } from '../src/worlds';

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

    it('goes on to a new system at every gate, without end', () => {
        expect(nextSystem(0)).toBe(1);
        expect(nextSystem(41)).toBe(42);
    });

    it('lights every system from a sun that is a direction, and keeps each planet clear of the ship', () => {
        for (let index = 0; index < 50; index++) {
            const system = makeSystem(7, index);
            expect(Math.hypot(system.sun.x, system.sun.y, system.sun.z)).toBeCloseTo(1, 3);
            expect(Math.hypot(system.at.x, system.at.y, system.at.z) - system.radius).toBeGreaterThan(1600);
        }
    });
});

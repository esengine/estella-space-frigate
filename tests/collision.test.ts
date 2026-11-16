import { HULL_BOXES, IMPACT, absorb, clearance, rockMass, spinFrom, strike, touch } from '../src/collision';

describe('a rock against the hull', () => {
    it('is clear while it is further off than its own radius', () => {
        expect(touch({ x: 40, y: 0, z: -20 }, 10)).toBeNull();
        expect(clearance({ x: 40, y: 0, z: -20 }, 10)).toBeCloseTo(40 - 21 - 10, 6);
    });

    it('touches where it is nearest, and is pushed straight back out from there', () => {
        const hit = touch({ x: 0, y: 30, z: -23 }, 20)!;
        expect(hit.normal).toEqual({ x: 0, y: 1, z: 0 });
        expect(hit.point).toEqual({ x: 0, y: 14.2, z: -23 });
        expect(hit.depth).toBeCloseTo(20 - (30 - 14.2), 6);
        expect(clearance({ x: 0, y: 30, z: -23 }, 20)).toBeCloseTo(-hit.depth, 6);
    });

    it('caught with its centre inside the hull, leaves by the nearest face', () => {
        const hit = touch({ x: 9.5, y: 0, z: -20 }, 2)!;
        expect(hit.normal).toEqual({ x: 1, y: 0, z: 0 });
        expect(hit.depth).toBeCloseTo(3, 6);
    });

    it('meets the bow before it meets the stern when it comes from ahead', () => {
        const bow = Math.max(...HULL_BOXES.map((box) => box[5]!));
        const hit = touch({ x: 0, y: 0, z: bow + 4 }, 5)!;
        expect(hit.normal.z).toBeCloseTo(1, 6);
        expect(hit.point.z).toBe(bow);
    });
});

describe('the blow', () => {
    const ahead = { x: 0, y: 0, z: 1 };

    it('is none when the two are already parting', () => {
        expect(strike({ x: 0, y: 0, z: 5 }, ahead, IMPACT.shipMass, 500, 0.25)).toBeNull();
    });

    it('keeps the momentum of the two together', () => {
        const mass = rockMass(18), blow = strike({ x: 3, y: -2, z: -40 }, ahead, IMPACT.shipMass, mass, 0.25)!;
        expect(blow.closing).toBe(40);
        expect(blow.rock.z * mass + blow.ship.z * IMPACT.shipMass).toBeCloseTo(0, 6);
        expect(blow.rock.x).toBe(0);
    });

    it('throws a pebble ahead of the ship and barely slows her', () => {
        const blow = strike({ x: 0, y: 0, z: -50 }, ahead, IMPACT.shipMass, rockMass(5), 0.25)!;
        expect(blow.rock.z).toBeGreaterThan(55);
        expect(Math.abs(blow.ship.z)).toBeLessThan(0.5);
    });

    it('stops the ship and more against something far heavier than she is', () => {
        const blow = strike({ x: 0, y: 0, z: -50 }, ahead, IMPACT.shipMass, rockMass(200), 0.25)!;
        expect(blow.ship.z).toBeLessThan(-55);
        expect(blow.rock.z).toBeLessThan(1);
    });

    it('costs four times as much at twice the speed', () => {
        const slow = strike({ x: 0, y: 0, z: -20 }, ahead, IMPACT.shipMass, rockMass(20), 0.25)!;
        const fast = strike({ x: 0, y: 0, z: -40 }, ahead, IMPACT.shipMass, rockMass(20), 0.25)!;
        expect(fast.energy / slow.energy).toBeCloseTo(4, 6);
    });
});

describe('what a blow costs', () => {
    it('comes off the shield first', () => {
        expect(absorb(1, 1, IMPACT.toll * 0.3)).toEqual({ shield: 0.7, hull: 1 });
    });

    it('reaches the hull only with what the shield could not take, and less of it', () => {
        const left = absorb(0.1, 1, IMPACT.toll * 0.3);
        expect(left.shield).toBe(0);
        expect(left.hull).toBeCloseTo(1 - 0.2 * IMPACT.hullShare, 6);
    });

    it('never leaves less than no hull', () => {
        expect(absorb(0, 0.05, IMPACT.toll * 3).hull).toBe(0);
    });
});

describe('the turn a blow gives her', () => {
    it('is none through the middle of the ship', () => {
        const spin = spinFrom({ x: 0, y: 0, z: 0 }, { x: -3, y: 0, z: 0 });
        expect(Math.hypot(spin.x, spin.y, spin.z)).toBe(0);
    });

    it('swings the bow away from a blow on the bow', () => {
        const spin = spinFrom({ x: 4, y: 0, z: 50 }, { x: -1, y: 0, z: 0 });
        expect(spin.y).toBeLessThan(0);
        expect(Math.abs(spin.x) + Math.abs(spin.z)).toBeLessThan(1e-9);
    });

    it('is never more than the thrusters can take back in a few seconds', () => {
        const spin = spinFrom({ x: 4, y: 0, z: 50 }, { x: -400, y: 0, z: 0 });
        expect(Math.hypot(spin.x, spin.y, spin.z)).toBeCloseTo(IMPACT.spin, 6);
    });
});

import { ORDERS_WAITING, createSector, type Sector } from '../server/world';
import { helm, stepHelm } from '../src/helm';
import { FELT, createPredictor } from '../src/shared/predict';
import { FIELD_DRIFT, TOP_SPEED, ship } from '../src/shipState';
import { FLIGHT_TICK, PITCH_RATE, TURN_RATE, YAW_THRUST, atRest, cleanOrders, copyFlight, driveShip, forwardOf, stepFlight, type Flight, type Orders } from '../src/shared/steer';

const A = 'pilot-a', B = 'pilot-b';
const TICK_MS = FLIGHT_TICK * 1000;
const NONE = { order: 0, rudder: 0, elevation: 0, roll: 0 };
const fly = (f: Flight, seconds: number, orders: Partial<Orders>): Flight => { for (let t = 0; t < seconds - 1e-9; t += FLIGHT_TICK) stepFlight(f, { ...NONE, ...orders }, FLIGHT_TICK); return f; };
const heading = (f: Flight): number => { const fwd = forwardOf(f); return Math.atan2(fwd.x, fwd.z); };
const far = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const TOP = TOP_SPEED * FIELD_DRIFT;

describe('how a frigate flies', () => {
    it('works up to her speed and runs it off: neither the drive nor the hull answers at once', () => {
        const f = atRest({ x: 0, y: 0, z: 0 });
        fly(f, 1, { order: 1 });
        expect(f.throttle).toBeGreaterThan(0.8);
        expect(f.speed).toBeLessThan(TOP_SPEED * 0.5);
        fly(f, 4, { order: 1 });
        expect(f.speed).toBeGreaterThan(TOP_SPEED * 0.9);
        fly(f, 60, { order: 1 });
        expect(f.speed).toBeLessThanOrEqual(TOP_SPEED);
        expect(f.speed).toBeGreaterThan(TOP_SPEED * 0.999);
        fly(f, 1, { order: 0 });
        expect(f.speed).toBeGreaterThan(TOP_SPEED * 0.5);
        fly(f, 15, { order: 0 });
        expect(f.speed).toBeLessThan(1);
    });

    it('comes round on her thrusters, and no faster than they can push her', () => {
        const f = atRest({ x: 0, y: 0, z: 0 });
        fly(f, 0.5, { rudder: 1 });
        expect(Math.abs(f.yawRate)).toBeLessThanOrEqual(YAW_THRUST * 0.5 + 1e-9);
        fly(f, 20, { rudder: 1 });
        expect(Math.abs(f.yawRate)).toBeLessThanOrEqual(TURN_RATE + 1e-9);
        expect(Math.abs(f.yawRate)).toBeGreaterThan(TURN_RATE * 0.99);
        expect(Math.abs(f.bank)).toBeGreaterThan(0.4);
        const g = atRest({ x: 0, y: 0, z: 0 });
        let seconds = 0;
        while (Math.abs(heading(g)) < Math.PI - 0.05 && seconds < 60) { fly(g, 0.1, { rudder: 1 }); seconds += 0.1; }
        expect(seconds).toBeGreaterThan(Math.PI / TURN_RATE);
        expect(seconds).toBeLessThan(Math.PI / TURN_RATE + 3);
        const h = atRest({ x: 0, y: 0, z: 0 });
        fly(h, 20, { elevation: 1 });
        expect(Math.abs(h.pitchRate)).toBeLessThanOrEqual(PITCH_RATE + 1e-9);
    });

    it('is one set of rules: the ship in hand offline and a ship the server flies turn alike', () => {
        Object.assign(helm, { level: { x: 0, y: 0, z: 0, w: 1 }, yawRate: 0, pitchRate: 0, rollRate: 0, roll: 0, mode: 'manual', order: 0.75, rudder: 2 / 3, elevation: -0.5, fixed: true });
        Object.assign(ship, { speed: 0, throttle: 0, away: false });
        const idle = { ahead: false, astern: false, port: false, starboard: false, climb: false, dive: false, steady: false, approach: false, align: false, level: false };
        const f = atRest({ x: 0, y: 0, z: 0 }), engine = { throttle: 0, speed: 0 }, at = { x: 0, y: 0, z: 0 };
        for (let n = 0; n < 300; n++) {
            const moved = stepHelm(idle, FLIGHT_TICK);
            at.x -= moved.x; at.y -= moved.y; at.z -= moved.z;
            driveShip(engine, helm.order, FLIGHT_TICK);
            ship.speed = engine.speed;
            stepFlight(f, { order: 0.75, rudder: 2 / 3, elevation: -0.5, roll: 0 }, FLIGHT_TICK);
        }
        expect(helm.level).toEqual(f.level);
        expect(helm.yawRate).toBeCloseTo(f.yawRate, 12);
        expect(helm.roll).toBeCloseTo(f.bank, 12);
        expect(ship.speed).toBeCloseTo(f.speed, 9);
        expect(far(at, f.pos)).toBeLessThan(1e-6);
        expect(far(at, { x: 0, y: 0, z: 0 })).toBeGreaterThan(200);
        helm.fixed = false;
    });

    it('takes orders only as a helm can give them', () => {
        expect(cleanOrders({ order: 99, rudder: -50, elevation: 7, roll: 3 })).toEqual({ order: 1, rudder: -1, elevation: 1, roll: 1 });
        expect(cleanOrders({ order: -4, rudder: Number.NaN, elevation: Infinity, roll: 'hard' })).toEqual({ order: 0, rudder: 0, elevation: 0, roll: 0 });
        expect(cleanOrders(null)).toEqual(NONE);
        expect(cleanOrders({})).toEqual(NONE);
    });
});

describe('a ship the server flies', () => {
    const flying = (): Sector => { const s = createSector(); s.enter(A); s.enter(B); return s; };
    /** A pilot at her helm: one order a step, each numbered, as an honest client sends them. */
    const honest = (s: Sector, id: string, seconds: number, orders: Partial<Orders>, from = { seq: 0 }): void => {
        for (let t = 0; t < seconds - 1e-9; t += FLIGHT_TICK) { s.steer(id, [{ seq: ++from.seq, ...NONE, ...orders }]); s.step(TICK_MS); }
    };

    it('flies the orders it is sent, one a step and in order, exactly as the rules say', () => {
        const s = flying(), alone = atRest({ x: -160, y: 0, z: 0 });
        honest(s, A, 12, { order: 1, rudder: -1 / 3, elevation: 0.5 });
        fly(alone, 12, { order: 1, rudder: -1 / 3, elevation: 0.5 });
        const got = s.stateFor(A);
        expect(got.flight.pos).toEqual(alone.pos);
        expect(got.flight.level).toEqual(alone.level);
        expect(got.flight.speed).toBe(alone.speed);
        expect(got).toMatchObject({ ack: 360, waiting: 0, starved: 0, dropped: 0 });
    });

    it('has no way to be told where a ship is: a forged place, speed or heading in a request is not read', () => {
        const s = flying();
        const start = copyFlight(s.stateFor(A).flight);
        for (let n = 1; n <= 30; n++) {
            s.steer(A, [{ seq: n, ...NONE, p: { x: 9e6, y: 0, z: 0 }, pos: { x: 9e6, y: 0, z: 0 }, level: { x: 0, y: 1, z: 0, w: 0 }, q: [0, 1, 0, 0], speed: 99999, throttle: 50, yawRate: 40, flight: { pos: { x: 9e6, y: 0, z: 0 }, speed: 99999 } } as never]);
            s.step(TICK_MS);
        }
        const after = s.stateFor(A).flight;
        expect(after.pos).toEqual(start.pos);
        expect(after.level).toEqual(start.level);
        expect(after).toMatchObject({ speed: 0, throttle: 0, yawRate: 0 });
    });

    it('flies by its own clock: a client that runs fast, or sends a minute of orders at once, goes no further', () => {
        const fair = flying(), fast = flying(), flood = flying();
        const seq = { seq: 0 };
        honest(fair, A, 20, { order: 1 });
        // Ten steps of orders for every step the server takes: a client clock running ten times fast.
        for (let t = 0; t < 20 - 1e-9; t += FLIGHT_TICK) { fast.steer(A, Array.from({ length: 10 }, () => ({ seq: ++seq.seq, ...NONE, order: 1 }))); fast.step(TICK_MS); }
        // A minute of full-ahead orders in the first instant, then silence.
        for (let n = 0; n < 60; n++) flood.steer(A, Array.from({ length: 30 }, (_, i) => ({ seq: n * 30 + i + 1, ...NONE, order: 1 })));
        for (let t = 0; t < 20 - 1e-9; t += FLIGHT_TICK) flood.step(TICK_MS);
        const went = (s: Sector): number => s.stateFor(A).flight.pos.z;
        expect(went(fair)).toBeGreaterThan(700);
        expect(Math.abs(went(fast) - went(fair))).toBeLessThan(TOP * FLIGHT_TICK * 2);
        expect(went(flood)).toBeLessThanOrEqual(went(fair));
        for (const s of [fair, fast, flood]) expect(s.stateFor(A).flight.speed).toBeLessThanOrEqual(TOP_SPEED);
        expect(fast.stateFor(A).dropped).toBeGreaterThan(5000);
        expect(fast.stateFor(A).waiting).toBeLessThanOrEqual(ORDERS_WAITING);
        // And the server's own clock cannot be hurried from outside: a step of a minute flies a quarter of a second.
        const jump = flying();
        honest(jump, A, 5, { order: 1 });
        const before = jump.stateFor(A).flight.pos.z;
        jump.step(60_000);
        expect(jump.stateFor(A).flight.pos.z - before).toBeLessThan(TOP * 0.3);
    });

    it('cannot be turned on the spot: flicking the helm from side to side, or asking for more than hard over, turns her no faster', () => {
        const hard = flying(), greedy = flying(), flick = flying();
        honest(hard, A, 6, { order: 1, rudder: 1 });
        honest(greedy, A, 6, { order: 1, rudder: 500, roll: 500, elevation: 0 });
        const seq = { seq: 0 };
        for (let n = 0; n < 180; n++) { flick.steer(A, [{ seq: ++seq.seq, ...NONE, order: 1, rudder: n % 2 === 0 ? 1 : -1 }]); flick.step(TICK_MS); }
        const turned = (s: Sector): number => Math.abs(heading(s.stateFor(A).flight));
        expect(turned(hard)).toBeGreaterThan(1);
        expect(turned(hard)).toBeLessThan(TURN_RATE * 6);
        expect(Math.abs(greedy.stateFor(A).flight.yawRate)).toBeLessThanOrEqual(TURN_RATE + 1e-9);
        expect(turned(greedy)).toBeLessThanOrEqual(turned(hard) + 1e-9);
        expect(turned(flick)).toBeLessThan(0.02);
        // An about-turn takes the ten seconds and more it takes any frigate, whatever is sent.
        const about = flying(), n = { seq: 0 };
        let seconds = 0;
        while (Math.abs(heading(about.stateFor(A).flight)) < Math.PI - 0.05 && seconds < 60) { honest(about, A, 0.5, { order: 1, rudder: 9 }, n); seconds += 0.5; }
        expect(seconds).toBeGreaterThan(Math.PI / TURN_RATE);
    });

    it('takes an order once: a repeat, an old number and a number out of order change nothing', () => {
        const once = flying(), again = flying();
        const seq = { seq: 0 };
        for (let n = 0; n < 150; n++) {
            const order = { seq: ++seq.seq, ...NONE, order: 1, rudder: 0.5 };
            once.steer(A, [order]);
            for (let k = 0; k < 20; k++) again.steer(A, [order, { ...order, seq: order.seq - 1, rudder: -1, order: 0 }, { ...order, seq: 1 }, { ...order, seq: 0 }, { ...order, seq: -5 }, { ...order, seq: 2.5 }, { ...order, seq: 'next' as never }]);
            once.step(TICK_MS);
            again.step(TICK_MS);
        }
        expect(again.stateFor(A).flight).toEqual(once.stateFor(A).flight);
        expect(again.stateFor(A).ack).toBe(150);
        expect(again.steer(A, 'full ahead' as never)).toBe(150);
        expect(again.steer(A, [null, 7, 'x'] as never)).toBe(150);
    });

    it('a pilot who is gone has her engine stopped and her helm amidships; a new seat starts its count again and the old orders are gone', () => {
        const s = flying();
        honest(s, A, 10, { order: 1, rudder: 1 });
        expect(s.stateFor(A).flight.speed).toBeGreaterThan(300);
        s.steer(A, Array.from({ length: 8 }, (_, i) => ({ seq: 301 + i, ...NONE, order: 1, rudder: -1 })));
        s.leave(A);
        expect(s.steer(A, [{ seq: 400, ...NONE, order: 1 }])).toBe(308);
        for (let t = 0; t < 30; t += FLIGHT_TICK) s.step(TICK_MS);
        const adrift = s.stateFor(A);
        expect(adrift.flight.speed).toBeLessThan(1);
        expect(Math.abs(adrift.flight.yawRate)).toBeLessThan(1e-6);
        expect(adrift.waiting).toBe(0);
        const where = { ...adrift.flight.pos };
        s.enter(A);
        expect(s.stateFor(A).ack).toBe(0);
        expect(s.steer(A, [{ seq: 1, ...NONE, order: 1 }])).toBe(1);
        honest(s, A, 5, { order: 1 }, { seq: 1 });
        expect(far(s.stateFor(A).flight.pos, where)).toBeGreaterThan(50);
        // The other pilot's helm does not reach her.
        const mine = copyFlight(s.stateFor(A).flight);
        s.steer(B, [{ seq: 1, ...NONE, order: 1, rudder: 1 }]);
        expect(s.stateFor(A).flight).toEqual(mine);
    });
});

describe('a client predicting its own ship', () => {
    /** A link with a fixed delay each way and a little unevenness, between a predictor and a sector, stepped by one clock. */
    function voyage(oneWayMs: number, jitterMs: number, seconds: number, helmAt: (t: number) => Partial<Orders>, clientClock = 1) {
        const s = createSector();
        s.enter(A);
        const p = createPredictor();
        p.take(s.welcome(A).flight);
        let seed = 7;
        const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        const up: { at: number; orders: unknown[] }[] = [], down: { at: number; flight: Flight; ack: number; waiting: number }[] = [];
        let shownBefore = p.show(), worstFrame = 0, worstLag = 0, sentAt = -1, serverAt = 0;
        const FRAME = 1000 / 60;
        for (let now = 0; now < seconds * 1000; now += FRAME) {
            // The server: its own steps, by its own clock, and a state out twenty times a second.
            while (up.length > 0 && up[0]!.at <= now) s.steer(A, up.shift()!.orders);
            if (now - serverAt >= 50) { s.step(now - serverAt); serverAt = now; const state = s.stateFor(A); down.push({ at: now + oneWayMs + rand() * jitterMs, flight: state.flight, ack: state.ack, waiting: state.waiting }); }
            // The client: a frame of the helm, what the server said, and its orders out.
            while (down.length > 0 && down[0]!.at <= now) { const got = down.shift()!; p.settle(got.flight, got.ack, got.waiting); }
            p.advance((FRAME / 1000) * clientClock, { ...NONE, ...helmAt(now / 1000) }, true);
            if (p.unsent() > 0 && now - sentAt >= 60) { sentAt = now; up.push({ at: now + oneWayMs + rand() * jitterMs, orders: p.drain().map((one) => ({ seq: one.seq, ...one.orders })) }); }
            const shown = p.show();
            // What a pilot would see as a jerk: the drawn ship moving in a frame by other than her own way.
            const expected = shownBefore.speed * FIELD_DRIFT * (FRAME / 1000) * clientClock;
            worstFrame = Math.max(worstFrame, Math.abs(far(shown.pos, shownBefore.pos) - expected));
            worstLag = Math.max(worstLag, p.lag());
            shownBefore = shown;
        }
        const truth = s.stateFor(A);
        return { p, s, truth, worstFrame, worstLag, apart: far(p.show().pos, truth.flight.pos) };
    }
    const weave = (t: number): Partial<Orders> => ({ order: t < 2 ? 0.75 : t % 20 < 12 ? 1 : 0.5, rudder: Math.round(Math.sin(t / 4) * 3) / 3, elevation: Math.round(Math.sin(t / 7) * 2) / 2 });

    it('answers the helm at once, whatever the link: the ship drawn is under way in the frame the order is given', () => {
        const p = createPredictor();
        p.take(atRest({ x: 0, y: 0, z: 0 }));
        for (let n = 0; n < 6; n++) p.advance(1 / 60, { ...NONE, order: 1, rudder: 1 }, true);
        expect(p.show().throttle).toBeGreaterThan(0.15);
        expect(Math.abs(p.show().yawRate)).toBeGreaterThan(0.01);
        expect(p.ahead()).toBe(3);
    });

    it('on a link of 200 ms there and back, a minute of hard flying is never pulled back', () => {
        const v = voyage(100, 0, 60, weave);
        expect(v.truth.flight.speed).toBeGreaterThan(150);
        expect(v.p.fix.hard).toBe(0);
        expect(v.p.fix.worst).toBeLessThan(FELT);
        expect(v.worstFrame).toBeLessThan(0.2);
        expect(v.worstLag).toBeLessThan(FELT);
        // She is ahead of the server's ship by what she has ordered and it has not yet flown: the link, and no more.
        expect(v.p.ahead()).toBeGreaterThanOrEqual(5);
        expect(v.p.ahead()).toBeLessThanOrEqual(15);
        // The two clocks are kept together: over the minute the server never ran dry and threw nothing away.
        expect(v.truth.dropped).toBe(0);
        expect(v.truth.starved).toBeLessThan(12);
        expect(Math.abs(v.p.pace() - 1)).toBeLessThan(0.04);
        expect(v.apart).toBeLessThan(TOP * 0.6);
    });

    it('nor on an uneven one: 200 ms with up to 60 ms of jitter each way', () => {
        const v = voyage(100, 60, 60, weave);
        expect(v.p.fix.hard).toBe(0);
        expect(v.p.fix.worst).toBeLessThan(FELT);
        expect(v.worstFrame).toBeLessThan(0.5);
        expect(v.worstLag).toBeLessThan(FELT);
        expect(v.truth.dropped).toBe(0);
    });

    it('keeps its clock to the server\'s: a client a hundredth fast or slow all minute is neither dropped nor left dry', () => {
        for (const clock of [1.01, 0.99]) {
            const v = voyage(100, 20, 60, weave, clock);
            expect(v.truth.dropped).toBe(0);
            expect(v.truth.starved).toBeLessThan(15);
            expect(v.p.fix.hard).toBe(0);
            expect(v.p.fix.worst).toBeLessThan(FELT);
        }
    });

    it('a client whose clock runs fast is held to the server\'s ship, not ahead of it', () => {
        const v = voyage(100, 0, 60, () => ({ order: 1 }), 1.5);
        const honest = voyage(100, 0, 60, () => ({ order: 1 }), 1);
        // The server's ship went exactly as far as an honest one: the fast clock bought nothing.
        expect(Math.abs(v.truth.flight.pos.z - honest.truth.flight.pos.z)).toBeLessThan(TOP * 0.2);
        expect(v.truth.dropped).toBeGreaterThan(500);
        // And the cheat's own picture is dragged back to it again and again, never left ahead.
        expect(v.p.fix.count).toBeGreaterThan(100);
        expect(v.apart).toBeLessThan(TOP * 1.5);
    });
});

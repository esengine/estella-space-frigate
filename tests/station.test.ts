import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupOf, loadSave, writeSave } from '../server/store';
import { OPS_KEPT, auditSave, createSector, freshSave, type Saved, type Sector } from '../server/world';
import { GRAMS, SECTOR, approach, mayDock } from '../src/shared/sector';
import { FLIGHT_TICK } from '../src/shared/steer';

const A = 'pilot-a', B = 'pilot-b';
const TOTAL = SECTOR.rock.total, STATION = SECTOR.station;
const all = (s: Sector): number => { const ore = s.ore(); return ore.remaining + ore.held + ore.stored; };
const run = (s: Sector, seconds: number): void => { for (let ms = 0; ms < seconds * 1000; ms += SECTOR.tickMs) s.step(SECTOR.tickMs); };
let named = 0;
const op = (): string => `order-${String(++named).padStart(6, '0')}`;

/** A save with each pilot where the test wants her: at the station or at her berth, with ore in her hold. */
const placed = (at: { [id: string]: { cargo?: number; stored?: number; docked?: boolean; atStation?: boolean; off?: number } }): Saved => {
    const saved = freshSave();
    let out = 0;
    [A, B].forEach((id, i) => {
        const want = at[id] ?? {}, p = want.atStation ? [STATION.at[0] + (want.off ?? 40), STATION.at[1], STATION.at[2]] : [...SECTOR.berths[i]!];
        saved.pilots[id] = { cargo: want.cargo ?? 0, stored: want.stored ?? 0, docked: want.docked ?? false, p: p as [number, number, number], q: [0, 0, 0, 1], ops: [] };
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

describe('a pilot\'s warehouse', () => {
    it('takes ore from her hold and gives it back, and the two are always what she had', () => {
        const s = docked();
        const put = s.transfer(A, op(), false, 1_500_000);
        expect(put).toMatchObject({ ok: true, why: '', withdraw: false, grams: 1_500_000, cargo: 500_000, stored: 1_500_000, fresh: true, moved: true });
        expect(s.stateFor(A).you).toMatchObject({ cargo: 500_000, stored: 1_500_000 });
        const back = s.transfer(A, op(), true, 400_000);
        expect(back).toMatchObject({ ok: true, withdraw: true, cargo: 900_000, stored: 1_100_000 });
        expect(s.ore()).toEqual({ remaining: 5 * GRAMS, held: 900_000 + 3 * GRAMS, stored: 1_100_000, total: TOTAL });
        expect(all(s)).toBe(TOTAL);
    });

    it('is hers alone: nothing the other pilot sends reaches it, and nothing she sends reaches theirs', () => {
        const s = docked();
        s.transfer(A, op(), false, 2 * GRAMS);
        const mine = { ...s.stateFor(A).you };
        // B empties and fills as B likes; whatever B adds to the order naming A is not read.
        expect(s.transfer(B, op(), true, 1 * GRAMS)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE WAREHOUSE', stored: 0 });
        expect((s.transfer as (...all: unknown[]) => { ok: boolean })(B, op(), true, 1 * GRAMS, A, { account: A, from: A, target: A }).ok).toBe(false);
        expect(s.transfer(B, op(), false, 3 * GRAMS)).toMatchObject({ ok: true, cargo: 0, stored: 3 * GRAMS });
        expect(s.stateFor(A).you).toMatchObject({ cargo: mine.cargo, stored: mine.stored });
        expect(s.stateFor(B).you).toMatchObject({ cargo: 0, stored: 3 * GRAMS });
        expect(all(s)).toBe(TOTAL);
    });

    it('is reached only by a ship that is docked, as the server has it', () => {
        const away = createSector(placed({ [A]: { cargo: 2 * GRAMS, stored: 1 * GRAMS } }));
        away.enter(A);
        expect(away.transfer(A, op(), false, 1 * GRAMS)).toMatchObject({ ok: false, why: 'NOT DOCKED', cargo: 2 * GRAMS, stored: 1 * GRAMS });
        expect(away.transfer(A, op(), true, 1 * GRAMS)).toMatchObject({ ok: false, why: 'NOT DOCKED' });
        const near = alongside();
        expect(near.transfer(A, op(), false, 1 * GRAMS)).toMatchObject({ ok: false, why: 'NOT DOCKED' });
        near.dock(A, true);
        expect(near.transfer(A, op(), false, 1 * GRAMS).ok).toBe(true);
        near.dock(A, false);
        expect(near.transfer(A, op(), true, 1 * GRAMS)).toMatchObject({ ok: false, why: 'NOT DOCKED', stored: 1 * GRAMS });
        // A pilot who is not signed in gives no orders at all.
        near.leave(A);
        expect(near.transfer(A, op(), true, 1 * GRAMS)).toMatchObject({ ok: false, why: 'BAD ORDER' });
        expect(all(near)).toBe(TOTAL);
    });

    it('refuses an amount that is not ore she has: nothing, less than nothing, a part of a gram, more than is there, more than a hold takes', () => {
        const s = docked();
        const before = { ...s.ore() };
        for (const grams of [0, -1, -5 * GRAMS, 0.5, 1.5 * GRAMS + 0.25, Number.NaN, Infinity, 2 ** 40, '1000000', null, undefined, [1], { grams: 1 }]) {
            expect(s.transfer(A, op(), false, grams as never)).toMatchObject({ ok: false, why: 'BAD AMOUNT', moved: false });
            expect(s.transfer(A, op(), true, grams as never)).toMatchObject({ ok: false, why: 'BAD AMOUNT', moved: false });
        }
        // What a refusal says back is itself something the wire can carry: an amount that was never one is given as none.
        expect(s.transfer(A, op(), false, 2 ** 40)).toMatchObject({ ok: false, grams: 0 });
        expect(s.transfer(A, op(), true, -3)).toMatchObject({ ok: false, grams: 0 });
        expect(s.transfer(A, op(), false, 2 * GRAMS + 1)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE HOLD', grams: 2 * GRAMS + 1 });
        expect(s.transfer(A, op(), true, 1)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE WAREHOUSE' });
        expect(s.ore()).toEqual(before);
        expect(s.transfer(A, op(), false, 2 * GRAMS)).toMatchObject({ ok: true, cargo: 0, stored: 2 * GRAMS });
        expect(s.transfer(A, op(), false, 1)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE HOLD' });
        // An order with no name of its own, or a name too short or too long to be one, or no direction, is not an order.
        for (const name of ['', 'short', 'x'.repeat(65), 7, null, undefined]) expect(s.transfer(A, name as never, true, 1)).toMatchObject({ ok: false, why: 'BAD ORDER' });
        expect(s.transfer(A, op(), 'out' as never, 1)).toMatchObject({ ok: false, why: 'BAD ORDER' });
        expect(all(s)).toBe(TOTAL);
        // A hold takes forty tonnes and no more.
        const full = createSector(placed({ [A]: { cargo: 2 * GRAMS, stored: 3 * GRAMS, docked: true, atStation: true } }));
        full.enter(A);
        expect(full.transfer(A, op(), true, 3 * GRAMS).ok).toBe(true);
        expect(SECTOR.capacity).toBeGreaterThan(TOTAL);
    });

    it('does an order once: asked again under the same name it gives the same answer and moves nothing', () => {
        const s = docked();
        const name = op();
        const first = s.transfer(A, name, false, 1 * GRAMS);
        expect(first).toMatchObject({ ok: true, cargo: 1 * GRAMS, stored: 1 * GRAMS, fresh: true, moved: true });
        for (let n = 0; n < 200; n++) expect(s.transfer(A, name, false, 1 * GRAMS)).toMatchObject({ ok: true, cargo: 1 * GRAMS, stored: 1 * GRAMS, fresh: false, moved: false });
        expect(s.stateFor(A).you).toMatchObject({ cargo: 1 * GRAMS, stored: 1 * GRAMS });
        // The same name with other words is still the order that was answered, not a new one.
        expect(s.transfer(A, name, true, 1 * GRAMS)).toMatchObject({ ok: true, withdraw: false, stored: 1 * GRAMS, moved: false });
        expect(s.transfer(A, name, false, 999)).toMatchObject({ grams: 1 * GRAMS, moved: false });
        expect(s.stateFor(A).you).toMatchObject({ cargo: 1 * GRAMS, stored: 1 * GRAMS });
        // A refusal is remembered like a success.
        const no = op();
        expect(s.transfer(A, no, true, 9 * GRAMS)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE WAREHOUSE', fresh: true });
        s.transfer(A, op(), false, 1 * GRAMS);
        expect(s.transfer(A, no, true, 1)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE WAREHOUSE', fresh: false, stored: 1 * GRAMS });
        // A name is a pilot's own: B using A's name gives B's own order.
        expect(s.transfer(B, name, false, 1 * GRAMS)).toMatchObject({ ok: true, cargo: 2 * GRAMS, stored: 1 * GRAMS, fresh: true });
        expect(all(s)).toBe(TOTAL);
    });

    it('is on the disk with the order that filled it: a server that comes back answers the same order the same way and does it no second time', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'station-')), file = path.join(dir, 'sector.json');
        writeSave(file, placed({ [A]: { cargo: 2 * GRAMS, atStation: true, docked: true }, [B]: { cargo: 3 * GRAMS, atStation: true, docked: true, off: -60 } }));
        const s = createSector(loadSave(file));
        s.enter(A);
        const name = op();
        expect(s.transfer(A, name, false, 1_250_000).ok).toBe(true);
        // What the server would write before saying so.
        writeSave(file, s.save());
        // It is killed. What comes back has the ore where the order put it, the ship still docked, and the order's answer.
        const back = createSector(loadSave(file));
        expect(back.ore()).toEqual({ remaining: 5 * GRAMS, held: 750_000 + 3 * GRAMS, stored: 1_250_000, total: TOTAL });
        back.enter(A);
        expect(back.welcome(A)).toMatchObject({ cargo: 750_000, stored: 1_250_000, docked: true });
        expect(back.transfer(A, name, false, 1_250_000)).toMatchObject({ ok: true, cargo: 750_000, stored: 1_250_000, fresh: false, moved: false });
        expect(back.stateFor(A).you).toMatchObject({ cargo: 750_000, stored: 1_250_000, docked: true });
        // Killed BEFORE it wrote: the save is the one before, the ore is unmoved, and the same order, asked again, is done then: once.
        const lost = createSector(JSON.parse(readFileSync(backupOf(file), 'utf8')));
        lost.enter(A);
        expect(lost.stateFor(A).you).toMatchObject({ cargo: 2 * GRAMS, stored: 0 });
        expect(lost.transfer(A, name, false, 1_250_000)).toMatchObject({ ok: true, cargo: 750_000, stored: 1_250_000, fresh: true, moved: true });
        expect(lost.transfer(A, name, false, 1_250_000).moved).toBe(false);
        expect(all(lost)).toBe(TOTAL);
    });

    it('a write cut short leaves the save whole, as it was', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'station-')), file = path.join(dir, 'sector.json');
        writeSave(file, placed({ [A]: { cargo: 2 * GRAMS, atStation: true, docked: true } }));
        const s = createSector(loadSave(file));
        s.enter(A);
        s.transfer(A, op(), false, 1 * GRAMS);
        expect(() => writeSave(file, s.save(), () => { throw new Error('the power went'); })).toThrow('the power went');
        const back = createSector(loadSave(file));
        expect(back.ore()).toEqual({ remaining: 8 * GRAMS, held: 2 * GRAMS, stored: 0, total: TOTAL });
        // And half a file where the draft was, or beside the save, changes nothing.
        writeFileSync(`${file}.writing`, '{"version":2,"sector":"kestrel-belt","rock":{"id":"rock-01","total":10000000,"remaining":0},"pilots":{"pilot-a":{"cargo":99');
        expect(createSector(loadSave(file)).ore().held).toBe(2 * GRAMS);
    });

    it('remembers the last orders and no more, and a save from before the station opens with every warehouse empty', () => {
        const s = docked();
        const first = op();
        s.transfer(A, first, false, 1);
        for (let n = 0; n < OPS_KEPT; n++) s.transfer(A, op(), n % 2 === 0, 1);
        expect(s.save().pilots[A]!.ops).toHaveLength(OPS_KEPT);
        expect(auditSave(s.save())).toBe('');
        const dir = mkdtempSync(path.join(tmpdir(), 'station-')), file = path.join(dir, 'sector.json');
        writeFileSync(file, JSON.stringify({ version: 1, sector: SECTOR.id, rock: { id: SECTOR.rock.id, total: TOTAL, remaining: 6 * GRAMS }, pilots: { [A]: { cargo: 1 * GRAMS, p: [1, 2, 3], q: [0, 0, 0, 1] }, [B]: { cargo: 3 * GRAMS, p: [4, 5, 6], q: [0, 1, 0, 0] } } }));
        const old = createSector(loadSave(file));
        expect(old.ore()).toEqual({ remaining: 6 * GRAMS, held: 4 * GRAMS, stored: 0, total: TOTAL });
        old.enter(A);
        expect(old.welcome(A)).toMatchObject({ cargo: 1 * GRAMS, stored: 0, docked: false });
        expect(old.welcome(A).flight.pos).toEqual({ x: 1, y: 2, z: 3 });
    });

    it('refuses a save in which a warehouse has gained or lost ore', () => {
        const s = docked();
        s.transfer(A, op(), false, 1 * GRAMS);
        const saved = s.save();
        expect(auditSave(saved)).toBe('');
        for (const edit of [
            (v: Saved) => { v.pilots[A]!.stored += 1; },
            (v: Saved) => { v.pilots[A]!.stored -= 1 * GRAMS; },
            (v: Saved) => { v.pilots[B]!.stored = 5 * GRAMS; },
            (v: Saved) => { v.pilots[A]!.stored = -1 * GRAMS; v.pilots[A]!.cargo += 2 * GRAMS; },
            (v: Saved) => { v.pilots[A]!.stored += 0.5; v.pilots[A]!.cargo -= 0.5; },
            (v: Saved) => { delete (v.pilots[A] as { stored?: number }).stored; },
            (v: Saved) => { (v.pilots[A] as { docked: unknown }).docked = 'yes'; },
            (v: Saved) => { (v.pilots[A] as { ops: unknown }).ops = [{ op: 7 }]; },
        ]) {
            const forged = JSON.parse(JSON.stringify(saved)) as Saved;
            edit(forged);
            expect(auditSave(forged)).not.toBe('');
            expect(() => createSector(forged)).toThrow();
        }
    });

    it('holds the sum of the rock, every hold and every warehouse through any order of mining, sailing, docking, moving ore and restarts', () => {
        let seed = 2024;
        const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        let s = createSector(placed({ [A]: { cargo: 1 * GRAMS, atStation: true }, [B]: { atStation: false } }));
        const names: string[] = [];
        let moved = 0, refused = 0;
        for (let n = 0; n < 8000; n++) {
            const id = rand() < 0.5 ? A : B, roll = rand();
            if (roll < 0.06) s.enter(id);
            else if (roll < 0.09) s.leave(id);
            else if (roll < 0.2) s.mine(id, rand() < 0.7);
            else if (roll < 0.3) s.dock(id, rand() < 0.8);
            else if (roll < 0.62) {
                const again = names.length > 0 && rand() < 0.3, name = again ? names[Math.floor(rand() * names.length)]! : op();
                if (!again) names.push(name);
                const grams = rand() < 0.15 ? [0, -7, 2.5, Number.NaN, 9e15][Math.floor(rand() * 5)]! : Math.floor(rand() * 3 * GRAMS);
                const got = s.transfer(id, name, rand() < 0.5, grams);
                if (got.moved) moved++; else if (!got.ok) refused++;
            }
            else if (roll < 0.64) s = createSector(JSON.parse(JSON.stringify(s.save())));
            else s.step(Math.floor(rand() * 300));
            expect(all(s)).toBe(TOTAL);
            const ore = s.ore();
            expect(ore.remaining >= 0 && ore.held >= 0 && ore.stored >= 0).toBe(true);
        }
        expect(auditSave(s.save())).toBe('');
        expect(moved).toBeGreaterThan(50);
        expect(refused).toBeGreaterThan(50);
        expect(s.ore().stored).toBeGreaterThan(0);
    });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NoSave, backupOf, loadSave, writeSave } from '../server/store';
import { auditSave, createSector, freshSave, type Sector } from '../server/world';
import { GRAMS, SECTOR, allot } from '../src/shared/sector';
import { FLIGHT_TICK } from '../src/shared/steer';

const A = 'pilot-a', B = 'pilot-b';
const TOTAL = SECTOR.rock.total;
const whole = (s: Sector): number => { const ore = s.ore(); return ore.remaining + ore.held; };
const both = (saved = freshSave()): Sector => { const s = createSector(saved); s.enter(A); s.enter(B); return s; };
const run = (s: Sector, seconds: number): void => { for (let ms = 0; ms < seconds * 1000; ms += SECTOR.tickMs) s.step(SECTOR.tickMs); };
/** A pilot at her helm for `seconds`: one order a step, as an honest client sends them. */
const sail = (s: Sector, id: string, seconds: number, orders: { order?: number; rudder?: number; elevation?: number }, from = { seq: 0 }): void => {
    for (let t = 0; t < seconds; t += FLIGHT_TICK) { s.steer(id, [{ seq: ++from.seq, order: 0, rudder: 0, elevation: 0, roll: 0, ...orders }]); s.step(FLIGHT_TICK * 1000); }
};

describe('the shared rock', () => {
    it('is ten tonnes, and what two pilots mine and what is left are always ten tonnes', () => {
        const s = both();
        expect(TOTAL).toBe(10 * GRAMS);
        s.mine(A, true);
        run(s, 5);
        s.mine(B, true);
        for (let ms = 0; ms < 120000; ms += SECTOR.tickMs) { s.step(SECTOR.tickMs); expect(whole(s)).toBe(TOTAL); }
        const a = s.stateFor(A), b = s.stateFor(B);
        expect(a.rock).toBe(0);
        expect(a.you.cargo + b.you.cargo).toBe(TOTAL);
        expect(a.you.cargo).toBeGreaterThan(b.you.cargo);
        expect(a.you.cargo - b.you.cargo).toBeLessThan(1.1 * GRAMS);
        expect(a.you).toMatchObject({ mining: false, why: 'ROCK EXHAUSTED' });
    });

    it('pays by the server clock, not by how often or how loudly a client asks', () => {
        const quiet = both(), loud = both();
        quiet.mine(A, true);
        loud.mine(A, true);
        for (let ms = 0; ms < 10000; ms += SECTOR.tickMs) {
            for (let n = 0; n < 50; n++) { loud.mine(A, true); loud.mine(A, 'yes' as never); loud.mine(A, 99999 as never); }
            quiet.step(SECTOR.tickMs);
            loud.step(SECTOR.tickMs);
        }
        expect(loud.stateFor(A).you.cargo).toBe(quiet.stateFor(A).you.cargo);
        expect(quiet.stateFor(A).you.cargo).toBe(SECTOR.rate * 10);
        expect(whole(loud)).toBe(TOTAL);
    });

    it('a stalled or lying clock cannot pay for time that did not pass', () => {
        const s = both();
        s.mine(A, true);
        s.step(60_000);
        expect(s.stateFor(A).you.cargo).toBe(SECTOR.rate * 0.25);
        s.step(-5000);
        s.step(Number.NaN);
        expect(s.stateFor(A).you.cargo).toBe(SECTOR.rate * 0.25);
        expect(whole(s)).toBe(TOTAL);
    });

    it('two beams on the last grams share them and take no more than there is', () => {
        expect(allot(5, [10, 10], 0)).toEqual([3, 2]);
        expect(allot(5, [10, 10], 1)).toEqual([2, 3]);
        expect(allot(100, [10, 10], 0)).toEqual([10, 10]);
        expect(allot(7, [1, 10], 0)).toEqual([1, 6]);
        expect(allot(0, [10, 10], 0)).toEqual([0, 0]);
        for (let left = 0; left < 40; left++) expect(allot(left, [9, 13, 4], left).reduce((a, b) => a + b, 0)).toBe(Math.min(left, 26));
    });

    it('is mined only by a pilot who is signed in, asking, and where the server has flown her within reach of it', () => {
        const s = createSector();
        expect(s.mine(A, true)).toBe(false);
        run(s, 2);
        expect(whole(s)).toBe(TOTAL);
        expect(s.ore().held).toBe(0);
        s.enter(A);
        run(s, 2);
        expect(s.stateFor(A).you).toMatchObject({ cargo: 0, why: 'NOT MINING' });
        s.mine(A, true);
        run(s, 1);
        expect(s.stateFor(A).you.mining).toBe(true);
        // She sails on past the rock and out of reach of it; the beam is cut where the server has her, whatever she asks.
        const seq = { seq: 0 };
        let cut = -1;
        for (let second = 0; second < 90 && cut < 0; second++) { sail(s, A, 1, { order: 1 }, seq); if (s.stateFor(A).you.why === 'OUT OF RANGE') cut = second; }
        const at = s.stateFor(A).flight.pos, rock = SECTOR.rock.at;
        expect(cut).toBeGreaterThan(30);
        expect(Math.hypot(at.x - rock[0], at.y - rock[1], at.z - rock[2])).toBeGreaterThan(SECTOR.range);
        expect(Math.hypot(at.x - rock[0], at.y - rock[1], at.z - rock[2])).toBeLessThan(SECTOR.range + 60);
        const held = s.stateFor(A).you.cargo;
        sail(s, A, 3, { order: 1 }, seq);
        expect(s.stateFor(A).you).toMatchObject({ cargo: held, mining: false, why: 'OUT OF RANGE' });
        s.leave(A);
        run(s, 3);
        expect(s.ore().held).toBe(held);
        expect(whole(s)).toBe(TOTAL);
    });

    it('knows a pilot by her account and token, and by nothing else', () => {
        const s = createSector();
        expect(s.login(A, 'test-token-a')?.name).toBe('PILOT A');
        expect(s.login(A, 'test-token-b')).toBeNull();
        expect(s.login('pilot-c', 'test-token-a')).toBeNull();
        expect(s.login(A, undefined)).toBeNull();
        expect(s.login({ id: A }, 'test-token-a')).toBeNull();
    });

    it('a pilot who signs in again has the cargo she left with, and is not mining until she asks', () => {
        const s = both();
        s.mine(A, true);
        run(s, 4);
        const held = s.stateFor(A).you.cargo;
        expect(held).toBe(SECTOR.rate * 4);
        s.leave(A);
        run(s, 4);
        s.enter(A);
        expect(s.welcome(A).cargo).toBe(held);
        run(s, 4);
        expect(s.stateFor(A).you).toMatchObject({ cargo: held, mining: false, why: 'NOT MINING' });
        s.enter(A);
        s.enter(A);
        expect(s.stateFor(A).you.cargo).toBe(held);
        expect(whole(s)).toBe(TOTAL);
    });

    it('a restarted server has the rock and the holds it stopped with, and each ship where she was', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'sector-')), file = path.join(dir, 'deep', 'sector.json');
        const s = createSector(loadSave(file, { found: true }));
        s.enter(A); s.enter(B);
        s.mine(A, true);
        sail(s, A, 6, { order: 1, rudder: 1 });
        s.mine(B, true);
        run(s, 3);
        const before = { ore: s.ore(), a: s.stateFor(A), b: s.stateFor(B) };
        expect(before.a.flight.speed).toBeGreaterThan(50);
        writeSave(file, s.save());
        const again = createSector(loadSave(file));
        expect(again.ore()).toEqual(before.ore);
        again.enter(A);
        again.enter(B);
        const back = again.stateFor(A);
        expect(back.you).toMatchObject({ cargo: before.a.you.cargo, mining: false });
        expect(back.flight.pos).toEqual(before.a.flight.pos);
        expect(back.flight.level).toEqual(before.a.flight.level);
        expect(back.flight).toMatchObject({ speed: 0, throttle: 0, yawRate: 0 });
        expect(again.stateFor(B).you.cargo).toBe(before.b.you.cargo);
        again.mine(B, true);
        run(again, 200);
        expect(again.ore().remaining).toBe(0);
        expect(whole(again)).toBe(TOTAL);
    });

    it('founds a sector only when told to, and never because its save was not found', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'sector-')), file = path.join(dir, 'sector.json');
        // No save and no word to found one: nothing is created.
        expect(() => loadSave(file)).toThrow(NoSave);
        expect(() => loadSave(file)).toThrow(/--new/);
        expect(existsSync(file)).toBe(false);
        // Founded once, on purpose, and written at once so that its absence afterwards is a loss.
        expect(loadSave(file, { found: true })).toEqual(freshSave());
        expect(existsSync(file)).toBe(true);
        expect(() => loadSave(file, { found: true })).toThrow(/already saved/);
        const s = both(loadSave(file));
        s.mine(A, true);
        run(s, 5);
        writeSave(file, s.save());
        run(s, 5);
        writeSave(file, s.save());
        const mined = s.ore().held;
        expect(JSON.parse(readFileSync(backupOf(file), 'utf8')).pilots[A].cargo).toBe(SECTOR.rate * 5);
        // The save is lost. With or without --new the server does not start a new world over the old one's remains.
        rmSync(file);
        expect(() => loadSave(file)).toThrow(/sector\.json\.bak is there: a sector lived here/);
        expect(() => loadSave(file, { found: true })).toThrow(NoSave);
        expect(existsSync(file)).toBe(false);
        // Restoring is a person's act: the save before the last one, put back, is carried on from.
        writeFileSync(file, readFileSync(backupOf(file)));
        expect(createSector(loadSave(file)).ore().held).toBe(SECTOR.rate * 5);
        expect(mined).toBe(SECTOR.rate * 10);
        // A save that cannot be read stops the server too, and says where the one before it is.
        writeFileSync(file, '{"version":1,"sector":');
        expect(() => loadSave(file)).toThrow(/cannot be read as a save.*\.bak/);
    });

    it('refuses a save in which ore has appeared or gone, to read it or to write it', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'sector-')), file = path.join(dir, 'sector.json');
        const s = both();
        s.mine(A, true);
        run(s, 5);
        writeSave(file, s.save());
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        expect(auditSave(saved)).toBe('');
        for (const edit of [
            (v: typeof saved) => { v.pilots[A].cargo += 1; },
            (v: typeof saved) => { v.rock.remaining += GRAMS; },
            (v: typeof saved) => { v.rock.total = 99 * GRAMS; v.rock.remaining = 98 * GRAMS; },
            (v: typeof saved) => { v.pilots[B].cargo = -1 * GRAMS; v.rock.remaining += GRAMS; },
            (v: typeof saved) => { v.pilots[A].cargo += 0.5; v.rock.remaining -= 0.5; },
            (v: typeof saved) => { v.sector = 'elsewhere'; },
            (v: typeof saved) => { v.pilots[A].p = [Number.NaN, 0, 0]; },
        ]) {
            const forged = JSON.parse(JSON.stringify(saved));
            edit(forged);
            expect(auditSave(forged)).not.toBe('');
            writeFileSync(file, JSON.stringify(forged));
            expect(() => loadSave(file)).toThrow();
            expect(() => writeSave(file, forged)).toThrow();
        }
        const stray = JSON.parse(JSON.stringify(saved));
        stray.pilots['pilot-z'] = { cargo: 0, p: [0, 0, 0], q: [0, 0, 0, 1] };
        expect(() => createSector(stray)).toThrow(/pilot-z/);
    });

    it('holds its sum through any order of sign-ins, orders, beams and restarts', () => {
        let seed = 12345;
        const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        let s = createSector();
        const seqs: Record<string, number> = { [A]: 0, [B]: 0 };
        for (let n = 0; n < 6000; n++) {
            const id = rand() < 0.5 ? A : B, roll = rand();
            if (roll < 0.08) { s.enter(id); seqs[id] = 0; }
            else if (roll < 0.12) s.leave(id);
            else if (roll < 0.3) s.mine(id, rand() < 0.7);
            else if (roll < 0.5) s.steer(id, [{ seq: ++seqs[id]!, order: rand() * 3 - 1, rudder: rand() * 4 - 2, elevation: rand() * 4 - 2, roll: rand() < 0.1 ? Number.NaN : 0 }]);
            else if (roll < 0.52) { s = createSector(JSON.parse(JSON.stringify(s.save()))); seqs[A] = 0; seqs[B] = 0; }
            else s.step(Math.floor(rand() * 400) - 20);
            expect(whole(s)).toBe(TOTAL);
            expect(auditSave(s.save())).toBe('');
        }
        expect(s.ore().held).toBeGreaterThan(0);
    });
});

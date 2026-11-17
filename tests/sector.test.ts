import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSave, writeSave } from '../server/store';
import { auditSave, createSector, freshSave, type Sector } from '../server/world';
import { GRAMS, SECTOR, allot, apart, type ServerMessage, type Vec3 } from '../src/shared/sector';

const A = 'pilot-a', B = 'pilot-b';
const TOTAL = SECTOR.rock.total;
const whole = (s: Sector): number => { const ore = s.ore(); return ore.remaining + ore.held; };
const state = (s: Sector, id: string) => s.stateFor(id) as Extract<ServerMessage, { t: 'state' }>;
const both = (saved = freshSave()): Sector => { const s = createSector(saved); s.enter(A, 0); s.enter(B, 0); return s; };
const run = (s: Sector, seconds: number): void => { for (let ms = 0; ms < seconds * 1000; ms += SECTOR.tickMs) s.step(SECTOR.tickMs); };

describe('the shared rock', () => {
    it('is ten tonnes, and what two pilots mine and what is left are always ten tonnes', () => {
        const s = both();
        expect(TOTAL).toBe(10 * GRAMS);
        s.mine(A, true);
        run(s, 5);
        s.mine(B, true);
        for (let ms = 0; ms < 120000; ms += SECTOR.tickMs) { s.step(SECTOR.tickMs); expect(whole(s)).toBe(TOTAL); }
        const a = state(s, A), b = state(s, B);
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
        expect(state(loud, A).you.cargo).toBe(state(quiet, A).you.cargo);
        expect(state(quiet, A).you.cargo).toBe(SECTOR.rate * 10);
        expect(whole(loud)).toBe(TOTAL);
    });

    it('a stalled or lying clock cannot pay for time that did not pass', () => {
        const s = both();
        s.mine(A, true);
        s.step(60_000);
        expect(state(s, A).you.cargo).toBe(SECTOR.rate * 0.25);
        s.step(-5000);
        s.step(Number.NaN);
        expect(state(s, A).you.cargo).toBe(SECTOR.rate * 0.25);
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

    it('is mined only by a pilot who is signed in, asking, and within reach of it', () => {
        const s = createSector();
        expect(s.mine(A, true)).toBe(false);
        run(s, 2);
        expect(whole(s)).toBe(TOTAL);
        expect(s.ore().held).toBe(0);
        s.enter(A, 0);
        run(s, 2);
        expect(state(s, A).you).toMatchObject({ cargo: 0, why: 'NOT MINING' });
        s.mine(A, true);
        let now = 0;
        const away: Vec3 = [0, 0, -5000];
        while (apart(state(s, A).you.p, away) > 1) { now += 100; s.pose(A, away, [0, 0, 0, 1], 1, now); }
        const held = state(s, A).you.cargo;
        run(s, 3);
        expect(state(s, A).you).toMatchObject({ cargo: held, mining: false, why: 'OUT OF RANGE' });
        s.leave(A);
        run(s, 3);
        expect(s.ore().held).toBe(held);
    });

    it('a pilot moves no faster than a frigate can, however far the client says she went', () => {
        const s = both();
        const start = state(s, A).you.p;
        s.pose(A, [0, 30, 700], [0, 0, 0, 1], 1, 100);
        for (let n = 0; n < 500; n++) s.pose(A, [9e9, 0, 0], [0, 0, 0, 1], 1, 100);
        expect(apart(state(s, A).you.p, start)).toBeLessThan(SECTOR.topSpeed * 1.25 * 0.1 + 12.001);
        let now = 100;
        for (let n = 0; n < 100; n++) { now += 100; s.pose(A, [9e9, 0, 0], [0, 0, 0, 1], 1, now); }
        expect(apart(state(s, A).you.p, start)).toBeLessThan(SECTOR.topSpeed * 1.25 * 10.1 + 12.001);
        expect(s.pose(A, [Number.NaN, 0, 0], [0, 0, 0, 1], 1, now)).toBe(false);
        expect(s.pose(A, 'there' as never, [0, 0, 0, 1], 1, now)).toBe(false);
        expect(s.pose(A, [0, 0, 0], [0, 0, 0, 0], 1, now)).toBe(false);
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
        const held = state(s, A).you.cargo;
        expect(held).toBe(SECTOR.rate * 4);
        s.leave(A);
        run(s, 4);
        s.enter(A, 0);
        expect((s.welcome(A) as Extract<ServerMessage, { t: 'welcome' }>).you.cargo).toBe(held);
        run(s, 4);
        expect(state(s, A).you).toMatchObject({ cargo: held, mining: false, why: 'NOT MINING' });
        s.enter(A, 0);
        s.enter(A, 0);
        expect(state(s, A).you.cargo).toBe(held);
        expect(whole(s)).toBe(TOTAL);
    });

    it('a restarted server has the rock and the holds it stopped with', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'sector-')), file = path.join(dir, 'deep', 'sector.json');
        expect(loadSave(file)).toEqual(freshSave());
        const s = both();
        s.mine(A, true);
        run(s, 6);
        s.mine(B, true);
        run(s, 3);
        s.pose(A, [-150, 5, 9], [0, 1, 0, 0], 1, 50);
        const before = { ore: s.ore(), a: state(s, A).you, b: state(s, B).you };
        writeSave(file, s.save());
        const again = createSector(loadSave(file));
        expect(again.ore()).toEqual(before.ore);
        again.enter(A, 0);
        again.enter(B, 0);
        expect(state(again, A).you).toMatchObject({ cargo: before.a.cargo, p: before.a.p, mining: false });
        expect(state(again, B).you.cargo).toBe(before.b.cargo);
        again.mine(B, true);
        run(again, 200);
        expect(again.ore().remaining).toBe(0);
        expect(whole(again)).toBe(TOTAL);
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

    it('holds its sum through any order of sign-ins, moves, beams and restarts', () => {
        let seed = 12345;
        const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        let s = createSector(), now = 0;
        for (let n = 0; n < 6000; n++) {
            const id = rand() < 0.5 ? A : B, roll = rand();
            now += Math.floor(rand() * 120);
            if (roll < 0.08) s.enter(id, now);
            else if (roll < 0.12) s.leave(id);
            else if (roll < 0.3) s.mine(id, rand() < 0.7);
            else if (roll < 0.5) s.pose(id, [rand() * 4000 - 2000, rand() * 400 - 200, rand() * 4000 - 2000], [0, 0, 0, 1], rand(), now);
            else if (roll < 0.52) s = createSector(JSON.parse(JSON.stringify(s.save())));
            else s.step(Math.floor(rand() * 400) - 20);
            expect(whole(s)).toBe(TOTAL);
            expect(auditSave(s.save())).toBe('');
        }
        expect(s.ore().held).toBeGreaterThan(0);
    });
});

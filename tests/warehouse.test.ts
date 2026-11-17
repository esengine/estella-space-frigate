import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupOf, loadSave, writeSave } from '../server/store';
import { ANSWERS_KEPT, auditSave, createSector, freshSave, type Saved, type Sector } from '../server/world';
import { GRAMS, SECTOR } from '../src/shared/sector';

const A = 'pilot-a', B = 'pilot-b';
const TOTAL = SECTOR.rock.total, STATION = SECTOR.station;
const all = (s: Sector): number => { const ore = s.ore(); return ore.remaining + ore.held + ore.stored; };
let named = 0;
const op = (): string => `order-${String(++named).padStart(6, '0')}`;
const next = (s: Sector, id: string): number => s.stateFor(id).you.next;
/** An order as a client gives it: under the pilot's next number and a name of its own, unless the test says otherwise. */
const order = (s: Sector, id: string, withdraw: boolean, grams: unknown, o: { seq?: unknown; name?: unknown; persist?: (after: Saved) => void } = {}) =>
    s.transfer(id, 'seq' in o ? o.seq : next(s, id), 'name' in o ? o.name : op(), withdraw, grams, o.persist);
const balances = (s: Sector, id: string) => { const you = s.stateFor(id).you; return { cargo: you.cargo, stored: you.stored, next: you.next }; };

const placed = (at: { [id: string]: { cargo?: number; stored?: number; docked?: boolean; atStation?: boolean; off?: number } }): Saved => {
    const saved = freshSave();
    let out = 0;
    [A, B].forEach((id, i) => {
        // Docked is in her own berth; at the station and not docked is on its approach point, where the station will take her in hand when she has a berth.
        const want = at[id] ?? {}, berth = STATION.berths[i]!;
        const p = want.docked ? [...berth.at] : want.atStation ? [...berth.approach] : [...SECTOR.berths[i]!];
        saved.pilots[id] = { cargo: want.cargo ?? 0, stored: want.stored ?? 0, credits: 0, berth: want.docked ? berth.id : 0, mooring: want.docked ? 'docked' : 'none', moves: 0, p: p as [number, number, number], q: [0, 0, 0, 1], ops: [] };
        out += (want.cargo ?? 0) + (want.stored ?? 0);
    });
    saved.rock.remaining = TOTAL - out;
    return saved;
};
const docked = (cargo = 2 * GRAMS): Sector => {
    const s = createSector(placed({ [A]: { cargo, atStation: true, docked: true }, [B]: { cargo: 3 * GRAMS, atStation: true, docked: true, off: -60 } }));
    s.enter(A); s.enter(B);
    return s;
};

describe('a pilot\'s warehouse', () => {
    it('takes ore from her hold and gives it back, and the two are always what she had', () => {
        const s = docked();
        expect(order(s, A, false, 1_500_000)).toMatchObject({ seq: 1, ok: true, why: '', withdraw: false, grams: 1_500_000, cargo: 500_000, stored: 1_500_000, fresh: true, moved: true, next: 2 });
        expect(balances(s, A)).toEqual({ cargo: 500_000, stored: 1_500_000, next: 2 });
        expect(order(s, A, true, 400_000)).toMatchObject({ seq: 2, ok: true, withdraw: true, cargo: 900_000, stored: 1_100_000, next: 3 });
        expect(s.ore()).toEqual({ remaining: 5 * GRAMS, held: 900_000 + 3 * GRAMS, stored: 1_100_000, station: 0, credits: 0, total: TOTAL });
    });

    it('is hers alone: nothing the other pilot sends reaches it, and nothing she sends reaches theirs', () => {
        const s = docked();
        order(s, A, false, 2 * GRAMS);
        const mine = balances(s, A);
        expect(order(s, B, true, 1 * GRAMS)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE WAREHOUSE', stored: 0 });
        expect((s.transfer as (...words: unknown[]) => { ok: boolean })(B, next(s, B), op(), true, 1 * GRAMS, undefined, A, { account: A, from: A }).ok).toBe(false);
        expect(order(s, B, false, 3 * GRAMS)).toMatchObject({ ok: true, cargo: 0, stored: 3 * GRAMS });
        // Each pilot has her own count of orders: B's numbers are not A's, and B using A's number and name is B's own order.
        expect(balances(s, A)).toEqual(mine);
        expect(balances(s, B)).toMatchObject({ cargo: 0, stored: 3 * GRAMS });
        expect(all(s)).toBe(TOTAL);
    });

    it('is reached only by a ship that is docked, as the server has it', () => {
        const away = createSector(placed({ [A]: { cargo: 2 * GRAMS, stored: 1 * GRAMS } }));
        away.enter(A);
        expect(order(away, A, false, 1 * GRAMS)).toMatchObject({ ok: false, why: 'NOT DOCKED', cargo: 2 * GRAMS, stored: 1 * GRAMS });
        expect(order(away, A, true, 1 * GRAMS)).toMatchObject({ ok: false, why: 'NOT DOCKED' });
        // Cast off, it is shut at once, though she has not moved yet; and all the way out, and once she is let go.
        const s = docked();
        expect(order(s, A, false, 500_000).ok).toBe(true);
        s.dock(A, false);
        expect(order(s, A, false, 1 * GRAMS)).toMatchObject({ ok: false, why: 'NOT DOCKED' });
        for (let n = 0; n < 40 * 30; n++) { s.step(1000 / 30); if (n % 60 === 0) expect(order(s, A, true, 1).why).toBe('NOT DOCKED'); }
        expect(s.stateFor(A).you).toMatchObject({ mooring: 'none', berth: 0 });
        // She asks for a berth again from where she was let go, is brought in, and it opens when she is in and not before.
        s.dock(A, true);
        for (let n = 0; n < 40 * 30 && s.stateFor(A).you.mooring !== 'docked'; n++) { s.step(1000 / 30); if (n % 60 === 0 && s.stateFor(A).you.mooring !== 'docked') expect(order(s, A, true, 1).why).toBe('NOT DOCKED'); }
        expect(order(s, A, false, 1 * GRAMS).ok).toBe(true);
        s.leave(A);
        expect(order(s, A, true, 1 * GRAMS)).toMatchObject({ ok: false, why: 'BAD ORDER' });
        expect(all(s)).toBe(TOTAL);
    });

    it('refuses an amount that is not ore she has, and what it says back the wire can carry', () => {
        const s = docked();
        const before = { ...s.ore() };
        for (const grams of [0, -1, -5 * GRAMS, 0.5, 1.5 * GRAMS + 0.25, Number.NaN, Infinity, 2 ** 40, '1000000', null, undefined, [1], { grams: 1 }]) {
            for (const withdraw of [false, true]) {
                const got = order(s, A, withdraw, grams);
                expect(got).toMatchObject({ ok: false, why: 'BAD AMOUNT', moved: false });
                expect(Number.isInteger(got.grams) && got.grams >= 0 && got.grams <= TOTAL).toBe(true);
            }
        }
        expect(order(s, A, false, 2 * GRAMS + 1)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE HOLD', grams: 2 * GRAMS + 1 });
        expect(order(s, A, true, 1)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE WAREHOUSE' });
        expect(s.ore()).toEqual(before);
        // An order with no name of its own, no direction or no number is not an order, and takes no number.
        const at = next(s, A);
        for (const name of ['', 'short', 'x'.repeat(65), 7, null, undefined]) expect(order(s, A, true, 1, { name })).toMatchObject({ ok: false, why: 'BAD ORDER' });
        for (const seq of [0, -1, 1.5, Number.NaN, '3', null, undefined, 2 ** 33]) expect(order(s, A, true, 1, { seq })).toMatchObject({ ok: false, why: 'BAD ORDER' });
        expect(s.transfer(A, at, op(), 'out' as never, 1)).toMatchObject({ ok: false, why: 'BAD ORDER' });
        expect(next(s, A)).toBe(at);
        expect(order(s, A, false, 2 * GRAMS)).toMatchObject({ ok: true, cargo: 0, stored: 2 * GRAMS });
        expect(all(s)).toBe(TOTAL);
    });

    it('does an order once: asked again straight away it gives the same answer and moves nothing', () => {
        const s = docked();
        const name = op();
        expect(order(s, A, false, 1 * GRAMS, { name })).toMatchObject({ seq: 1, ok: true, cargo: 1 * GRAMS, stored: 1 * GRAMS, fresh: true, moved: true });
        for (let n = 0; n < 200; n++) expect(order(s, A, false, 1 * GRAMS, { seq: 1, name })).toMatchObject({ ok: true, cargo: 1 * GRAMS, stored: 1 * GRAMS, fresh: false, moved: false, next: 2 });
        // The same number and name with other words is still the order that was answered, not a new one.
        expect(order(s, A, true, 999, { seq: 1, name })).toMatchObject({ ok: true, withdraw: false, grams: 1 * GRAMS, moved: false });
        // The same number under another name was never this pilot's order: it is refused, and nothing is done.
        expect(order(s, A, false, 1 * GRAMS, { seq: 1 })).toMatchObject({ ok: false, why: 'EXPIRED', moved: false, next: 2 });
        // A number ahead of the next is told which is next, and takes no number.
        expect(order(s, A, false, 1, { seq: 5 })).toMatchObject({ ok: false, why: 'OUT OF ORDER', next: 2 });
        expect(balances(s, A)).toEqual({ cargo: 1 * GRAMS, stored: 1 * GRAMS, next: 2 });
        // A refusal takes its number and is remembered like a success.
        const no = op();
        expect(order(s, A, true, 9 * GRAMS, { name: no })).toMatchObject({ seq: 2, ok: false, why: 'NOT ENOUGH IN THE WAREHOUSE', fresh: true, next: 3 });
        order(s, A, false, 1 * GRAMS);
        expect(order(s, A, true, 1, { seq: 2, name: no })).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE WAREHOUSE', fresh: false, stored: 1 * GRAMS });
        expect(all(s)).toBe(TOTAL);
    });

    // ---- The two faults found in review ---------------------------------------------------------------------------------

    it('a move that cannot be written is not made, is not called a success, and asked again is made then, once', () => {
        const s = docked();
        const name = op();
        let seenInside: unknown = null, handed: Saved | null = null;
        const failing = (after: Saved): void => { handed = after; seenInside = balances(s, A); throw new Error('EPERM: the backup could not be written'); };
        // The write fails. She is told so, as a refusal; nothing has moved, nothing is remembered, and her number is not spent.
        for (let n = 0; n < 3; n++) {
            expect(order(s, A, false, 1 * GRAMS, { seq: 1, name, persist: failing })).toMatchObject({ ok: false, why: 'NOT SAVED', moved: false, fresh: false, cargo: 2 * GRAMS, stored: 0, next: 1 });
            expect(balances(s, A)).toEqual({ cargo: 2 * GRAMS, stored: 0, next: 1 });
            expect(s.save().pilots[A]).toMatchObject({ cargo: 2 * GRAMS, stored: 0, moves: 0, ops: [] });
        }
        // What was offered to the disk was the sector with the move in it; and while it was being written the sector still had it unmoved.
        expect(handed!.pilots[A]).toMatchObject({ cargo: 1 * GRAMS, stored: 1 * GRAMS, moves: 1 });
        expect(auditSave(handed!)).toBe('');
        expect(seenInside).toEqual({ cargo: 2 * GRAMS, stored: 0, next: 1 });
        expect(s.lastFailure()).toMatch(/backup could not be written/);
        // Asking again under the same number and name while the disk still refuses is still not a success: this is the fault that was found.
        expect(order(s, A, false, 1 * GRAMS, { seq: 1, name, persist: failing }).ok).toBe(false);
        // The disk takes writes again. The same order is made, once.
        const written: Saved[] = [];
        const working = (after: Saved): void => { written.push(JSON.parse(JSON.stringify(after))); };
        expect(order(s, A, false, 1 * GRAMS, { seq: 1, name, persist: working })).toMatchObject({ ok: true, fresh: true, moved: true, cargo: 1 * GRAMS, stored: 1 * GRAMS, next: 2 });
        expect(order(s, A, false, 1 * GRAMS, { seq: 1, name, persist: working })).toMatchObject({ ok: true, fresh: false, moved: false, stored: 1 * GRAMS });
        expect(written).toHaveLength(1);
        expect(balances(s, A)).toEqual({ cargo: 1 * GRAMS, stored: 1 * GRAMS, next: 2 });
        // Killed the instant it said so: what comes back from the disk has the move, and answers the order as done.
        const back = createSector(written[0]!);
        back.enter(A);
        expect(balances(back, A)).toEqual({ cargo: 1 * GRAMS, stored: 1 * GRAMS, next: 2 });
        expect(order(back, A, false, 1 * GRAMS, { seq: 1, name })).toMatchObject({ ok: true, moved: false, fresh: false });
        expect(all(back)).toBe(TOTAL);
    });

    it('a move the disk refused leaves the disk and the server saying the same thing', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'warehouse-')), file = path.join(dir, 'sector.json');
        writeSave(file, placed({ [A]: { cargo: 2 * GRAMS, atStation: true, docked: true } }));
        const s = createSector(loadSave(file));
        s.enter(A);
        const name = op();
        // The real writer, stopped between the draft and the save as a disk that will not take the backup stops it.
        const refuse = (after: Saved): void => writeSave(file, after, () => { throw new Error('EPERM'); });
        expect(order(s, A, false, 1 * GRAMS, { seq: 1, name, persist: refuse })).toMatchObject({ ok: false, why: 'NOT SAVED' });
        const onDisk = createSector(loadSave(file));
        expect(onDisk.ore()).toEqual(s.ore());
        expect(onDisk.save().pilots[A]).toMatchObject({ cargo: 2 * GRAMS, stored: 0, moves: 0 });
        expect(order(s, A, false, 1 * GRAMS, { seq: 1, name, persist: (after) => writeSave(file, after) })).toMatchObject({ ok: true, moved: true });
        const then = createSector(loadSave(file));
        expect(then.save().pilots[A]).toMatchObject({ cargo: 1 * GRAMS, stored: 1 * GRAMS, moves: 1 });
        expect(JSON.parse(readFileSync(backupOf(file), 'utf8')).pilots[A]).toMatchObject({ cargo: 2 * GRAMS, stored: 0 });
    });

    it('an old order is never done again, however many came after it and however the server was restarted', () => {
        let s = docked();
        const first = op();
        expect(order(s, A, false, 1 * GRAMS, { name: first })).toMatchObject({ seq: 1, ok: true, stored: 1 * GRAMS });
        // Sixty-four different orders that are each refused, then some that are done: far more than are remembered.
        for (let n = 0; n < 64; n++) expect(order(s, A, n % 2 === 0, [0, -1, 9 * GRAMS, 2 ** 40][n % 4]).ok).toBe(false);
        for (let n = 0; n < 12; n++) expect(order(s, A, n % 2 === 0, 1000).ok).toBe(true);
        expect(s.save().pilots[A]!.ops).toHaveLength(ANSWERS_KEPT);
        expect(s.save().pilots[A]!.ops.some((one) => one.op === first)).toBe(false);
        const settled = balances(s, A);
        expect(settled.next).toBe(78);
        // The first order comes again, exactly as it was sent. It is refused as expired and nothing moves.
        const again = (): void => {
            expect(order(s, A, false, 1 * GRAMS, { seq: 1, name: first })).toMatchObject({ ok: false, why: 'EXPIRED', moved: false, cargo: settled.cargo, stored: settled.stored, next: 78 });
            expect(balances(s, A)).toEqual(settled);
        };
        again();
        // After she has signed out and in, and after the server has stopped and started from its save, twice.
        s.leave(A); s.enter(A);
        again();
        for (let n = 0; n < 2; n++) {
            s = createSector(JSON.parse(JSON.stringify(s.save())));
            s.enter(A);
            again();
        }
        // Every other old number, under its own name or any other, is the same.
        for (const seq of [1, 2, 40, 65, 69]) expect(order(s, A, false, 1 * GRAMS, { seq })).toMatchObject({ ok: false, why: 'EXPIRED' });
        expect(balances(s, A)).toEqual(settled);
        // And remembering fewer answers, or none, would change only what a retry is told: the number alone forbids the move.
        const bare = JSON.parse(JSON.stringify(s.save())) as Saved;
        bare.pilots[A]!.ops = [];
        const forgetful = createSector(bare);
        forgetful.enter(A);
        expect(order(forgetful, A, true, 1000, { seq: 77 })).toMatchObject({ ok: false, why: 'EXPIRED' });
        expect(balances(forgetful, A)).toEqual(settled);
        expect(all(s)).toBe(TOTAL);
    });

    it('is on the disk with the order that filled it, and a write cut short leaves the save whole', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'warehouse-')), file = path.join(dir, 'sector.json');
        writeSave(file, placed({ [A]: { cargo: 2 * GRAMS, atStation: true, docked: true }, [B]: { cargo: 3 * GRAMS, atStation: true, docked: true, off: -60 } }));
        const s = createSector(loadSave(file));
        s.enter(A);
        const name = op();
        expect(order(s, A, false, 1_250_000, { name, persist: (after) => writeSave(file, after) }).ok).toBe(true);
        const back = createSector(loadSave(file));
        expect(back.ore()).toEqual({ remaining: 5 * GRAMS, held: 750_000 + 3 * GRAMS, stored: 1_250_000, station: 0, credits: 0, total: TOTAL });
        back.enter(A);
        expect(back.welcome(A)).toMatchObject({ cargo: 750_000, stored: 1_250_000, docked: true, next: 2 });
        expect(order(back, A, false, 1_250_000, { seq: 1, name })).toMatchObject({ ok: true, fresh: false, moved: false });
        // Killed BEFORE it wrote: the save is the one before, the ore is unmoved, and the same order, asked again, is done then: once.
        const lost = createSector(JSON.parse(readFileSync(backupOf(file), 'utf8')));
        lost.enter(A);
        expect(balances(lost, A)).toEqual({ cargo: 2 * GRAMS, stored: 0, next: 1 });
        expect(order(lost, A, false, 1_250_000, { seq: 1, name })).toMatchObject({ ok: true, fresh: true, moved: true });
        expect(order(lost, A, false, 1_250_000, { seq: 1, name }).moved).toBe(false);
        // Half a file where the draft was changes nothing.
        writeFileSync(`${file}.writing`, '{"version":3,"sector":"kestrel-belt","rock":{"id":"rock-01","total":10000000,"remaining":0},"pilots":{"pilot-a":{"cargo":99');
        expect(createSector(loadSave(file)).ore().stored).toBe(1_250_000);
    });

    it('a save from before orders were numbered opens with its orders numbered, and they are still not done again', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'warehouse-')), file = path.join(dir, 'sector.json');
        const was = (name: string, stored: number) => ({ op: name, ok: true, why: '', withdraw: false, grams: 500_000, cargo: 2 * GRAMS - stored, stored });
        writeFileSync(file, JSON.stringify({ version: 2, sector: SECTOR.id, rock: { id: SECTOR.rock.id, total: TOTAL, remaining: 8 * GRAMS }, pilots: {
            [A]: { cargo: 1 * GRAMS, stored: 1 * GRAMS, docked: true, p: [...STATION.at], q: [0, 0, 0, 1], ops: [was('before-0001', 500_000), was('before-0002', 1 * GRAMS)] },
            [B]: { cargo: 0, stored: 0, docked: false, p: [4, 5, 6], q: [0, 1, 0, 0], ops: [] } } }));
        const s = createSector(loadSave(file));
        s.enter(A);
        expect(balances(s, A)).toEqual({ cargo: 1 * GRAMS, stored: 1 * GRAMS, next: 3 });
        expect(order(s, A, false, 500_000, { seq: 2, name: 'before-0002' })).toMatchObject({ ok: true, moved: false, fresh: false });
        expect(order(s, A, false, 500_000, { seq: 1, name: 'something-else' })).toMatchObject({ ok: false, why: 'EXPIRED' });
        expect(balances(s, A)).toEqual({ cargo: 1 * GRAMS, stored: 1 * GRAMS, next: 3 });
        // And one from before there was a station at all.
        writeFileSync(file, JSON.stringify({ version: 1, sector: SECTOR.id, rock: { id: SECTOR.rock.id, total: TOTAL, remaining: 6 * GRAMS }, pilots: { [A]: { cargo: 1 * GRAMS, p: [1, 2, 3], q: [0, 0, 0, 1] }, [B]: { cargo: 3 * GRAMS, p: [4, 5, 6], q: [0, 1, 0, 0] } } }));
        const old = createSector(loadSave(file));
        old.enter(A);
        expect(old.welcome(A)).toMatchObject({ cargo: 1 * GRAMS, stored: 0, docked: false, next: 1 });
    });

    it('refuses a save in which a warehouse has gained or lost ore, or an order is numbered past the count', () => {
        const s = docked();
        order(s, A, false, 1 * GRAMS);
        const saved = s.save();
        expect(auditSave(saved)).toBe('');
        for (const edit of [
            (v: Saved) => { v.pilots[A]!.stored += 1; },
            (v: Saved) => { v.pilots[A]!.stored -= 1 * GRAMS; },
            (v: Saved) => { v.pilots[B]!.stored = 5 * GRAMS; },
            (v: Saved) => { v.pilots[A]!.stored = -1 * GRAMS; v.pilots[A]!.cargo += 2 * GRAMS; },
            (v: Saved) => { v.pilots[A]!.stored += 0.5; v.pilots[A]!.cargo -= 0.5; },
            (v: Saved) => { delete (v.pilots[A] as { stored?: number }).stored; },
            (v: Saved) => { delete (v.pilots[A] as { moves?: number }).moves; },
            (v: Saved) => { v.pilots[A]!.moves = 0; },
            (v: Saved) => { v.pilots[A]!.berth = 7; },
            (v: Saved) => { (v.pilots[A] as { ops: unknown }).ops = [{ op: 7 }]; },
            (v: Saved) => { (v as { version: number }).version = 2; },
        ]) {
            const forged = JSON.parse(JSON.stringify(saved)) as Saved;
            edit(forged);
            expect(auditSave(forged)).not.toBe('');
            expect(() => createSector(forged)).toThrow();
        }
    });

    it('holds its sum, and does no order twice, through any order of mining, docking, moving ore, failed writes, replays and restarts', () => {
        let seed = 2024;
        const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        let s = createSector(placed({ [A]: { cargo: 1 * GRAMS, atStation: true, docked: true }, [B]: { atStation: true } }));
        let disk = JSON.stringify(s.save());
        const sent: { id: string; seq: number; name: string; withdraw: boolean; grams: number }[] = [];
        const made = new Map<string, number>();
        let moved = 0, refused = 0, unsaved = 0, replays = 0;
        for (let n = 0; n < 10000; n++) {
            const id = rand() < 0.5 ? A : B, roll = rand();
            if (roll < 0.06) s.enter(id);
            else if (roll < 0.09) s.leave(id);
            else if (roll < 0.18) s.mine(id, rand() < 0.7);
            else if (roll < 0.28) s.dock(id, rand() < 0.8);
            else if (roll < 0.62) {
                const replay = sent.length > 0 && rand() < 0.35;
                if (replay) replays++;
                const one = replay ? sent[Math.floor(rand() * sent.length)]! : { id, seq: next(s, id), name: op(), withdraw: rand() < 0.5, grams: rand() < 0.15 ? [0, -7, 2.5, Number.NaN, 9e15][Math.floor(rand() * 5)]! : Math.floor(rand() * 3 * GRAMS) };
                if (!replay) sent.push(one);
                const fails = rand() < 0.2;
                const got = s.transfer(one.id, one.seq, one.name, one.withdraw, one.grams, (after) => { if (fails) throw new Error('disk'); disk = JSON.stringify(after); });
                if (got.moved) { moved++; made.set(`${one.id}/${one.seq}/${one.name}`, (made.get(`${one.id}/${one.seq}/${one.name}`) ?? 0) + 1); }
                else if (got.why === 'NOT SAVED') unsaved++;
                else if (!got.ok) refused++;
                // A success is on the disk as it is said: the disk and the server agree about that pilot at that moment.
                if (got.moved) expect(JSON.parse(disk).pilots[one.id]).toMatchObject({ cargo: got.cargo, stored: got.stored, moves: got.seq });
            }
            else if (roll < 0.64) { s = createSector(JSON.parse(disk)); }
            else if (roll < 0.7) { disk = JSON.stringify(s.save()); }
            else s.step(Math.floor(rand() * 300));
            expect(all(s)).toBe(TOTAL);
        }
        expect(auditSave(s.save())).toBe('');
        expect(auditSave(JSON.parse(disk))).toBe('');
        expect([...made.values()].every((times) => times === 1)).toBe(true);
        // That the run did exercise each of them, not how often.
        expect(moved).toBeGreaterThan(10);
        expect(refused).toBeGreaterThan(50);
        expect(unsaved).toBeGreaterThan(5);
        expect(replays).toBeGreaterThan(500);
    });
});

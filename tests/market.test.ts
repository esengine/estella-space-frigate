import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSave, writeSave } from '../server/store';
import { ANSWERS_KEPT, auditSave, createSector, freshSave, type Saved, type Sector } from '../server/world';
import { GRAMS, SECTOR } from '../src/shared/sector';

const A = 'pilot-a', B = 'pilot-b';
const TOTAL = SECTOR.rock.total, STATION = SECTOR.station, LOT = STATION.buys.lot, PRICE = STATION.buys.price;
let named = 0;
const op = (): string => `trade-${String(++named).padStart(6, '0')}`;
const next = (s: Sector, id: string): number => s.stateFor(id).you.next;
const sell = (s: Sector, id: string, o: { seq?: unknown; name?: unknown; grams?: unknown; price?: unknown; persist?: (after: Saved) => void } = {}) =>
    s.sell(id, 'seq' in o ? o.seq : next(s, id), 'name' in o ? o.name : op(), 'grams' in o ? o.grams : LOT, 'price' in o ? o.price : PRICE, o.persist);
const move = (s: Sector, id: string, withdraw: boolean, grams: number) => s.transfer(id, next(s, id), op(), withdraw, grams);
const books = (s: Sector) => { const ore = s.ore(); return { ...ore, sum: ore.remaining + ore.held + ore.stored + ore.station }; };
const mine = (s: Sector, id: string) => { const you = s.stateFor(id).you; return { cargo: you.cargo, stored: you.stored, credits: you.credits, next: you.next }; };

/** A save with each pilot's ore where the test wants it: docked in her own berth unless it says she is at sea. */
const placed = (at: { [id: string]: { cargo?: number; stored?: number; atSea?: boolean } }): Saved => {
    const saved = freshSave();
    let out = 0;
    [A, B].forEach((id, i) => {
        const want = at[id] ?? {}, berth = STATION.berths[i]!;
        saved.pilots[id] = {
            cargo: want.cargo ?? 0, stored: want.stored ?? 0, credits: 0, berth: want.atSea ? 0 : berth.id, mooring: want.atSea ? 'none' : 'docked', moves: 0,
            p: (want.atSea ? [...SECTOR.berths[i]!] : [...berth.at]) as [number, number, number], q: [0, 0, 0, 1], ops: [],
        };
        out += (want.cargo ?? 0) + (want.stored ?? 0);
    });
    saved.rock.remaining = TOTAL - out;
    return saved;
};
const market = (a = 3 * GRAMS, b = 2 * GRAMS): Sector => {
    const s = createSector(placed({ [A]: { stored: a }, [B]: { stored: b } }));
    s.enter(A); s.enter(B);
    return s;
};

describe('the station buying ore', () => {
    it('takes a tonne from her warehouse, puts it in its own stock and pays her a hundred credits, all at once', () => {
        const s = market();
        expect(mine(s, A)).toMatchObject({ stored: 3 * GRAMS, credits: 0 });
        const got = sell(s, A);
        expect(got).toMatchObject({ ok: true, why: '', sell: true, grams: LOT, paid: PRICE, credits: PRICE, stored: 2 * GRAMS, cargo: 0, fresh: true, moved: true });
        expect(mine(s, A)).toMatchObject({ stored: 2 * GRAMS, credits: 100, cargo: 0 });
        expect(books(s)).toMatchObject({ stored: 4 * GRAMS, station: 1 * GRAMS, credits: 100, sum: TOTAL });
        // The delivery the task asks to be shown: A and B a tonne each, a hundred credits each, two tonnes in the station.
        expect(sell(s, B)).toMatchObject({ ok: true, paid: 100, credits: 100, stored: 1 * GRAMS });
        expect(mine(s, A).credits).toBe(100);
        expect(mine(s, B).credits).toBe(100);
        expect(books(s)).toMatchObject({ station: 2 * GRAMS, credits: 200, stored: 3 * GRAMS, sum: TOTAL });
        expect(s.stateFor(A).bought).toBe(2 * GRAMS);
        expect(auditSave(s.save())).toBe('');
        expect(s.save()).toMatchObject({ version: 5, station: { ore: 2 * GRAMS } });
    });

    it('sells only her own warehouse: her hold is not sold, the other pilot is not touched, and nothing names another seller', () => {
        const s = createSector(placed({ [A]: { cargo: 2 * GRAMS, stored: 0 }, [B]: { stored: 2 * GRAMS } }));
        s.enter(A); s.enter(B);
        // Two tonnes in her hold and none in her warehouse: there is nothing of hers to sell, though B's warehouse has two.
        expect(sell(s, A)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE WAREHOUSE', paid: 0, credits: 0 });
        expect(mine(s, A)).toMatchObject({ cargo: 2 * GRAMS, stored: 0, credits: 0 });
        expect(mine(s, B)).toMatchObject({ stored: 2 * GRAMS, credits: 0 });
        expect(books(s)).toMatchObject({ station: 0, credits: 0, sum: TOTAL });
        // Stored first, it is hers to sell; and the last of it sold, there is no more.
        move(s, A, false, 1 * GRAMS);
        expect(sell(s, A)).toMatchObject({ ok: true, stored: 0, credits: 100 });
        expect(sell(s, A)).toMatchObject({ ok: false, why: 'NOT ENOUGH IN THE WAREHOUSE', credits: 100 });
        expect(mine(s, B)).toMatchObject({ stored: 2 * GRAMS, credits: 0 });
        expect(books(s)).toMatchObject({ station: 1 * GRAMS, credits: 100, sum: TOTAL });
    });

    it('refuses a ship that is not lying in her berth, whatever she says', () => {
        const s = createSector(placed({ [A]: { stored: 2 * GRAMS, atSea: true } }));
        s.enter(A);
        expect(sell(s, A)).toMatchObject({ ok: false, why: 'NOT DOCKED', paid: 0 });
        // A berth only kept, and on her way in, and from the instant she casts off: not docked.
        s.dock(A, true);
        expect(sell(s, A)).toMatchObject({ ok: false, why: 'NOT DOCKED' });
        const in1 = market();
        in1.dock(A, false);
        expect(sell(in1, A)).toMatchObject({ ok: false, why: 'NOT DOCKED' });
        expect(books(in1)).toMatchObject({ station: 0, credits: 0, sum: TOTAL });
        // Signed out, an order in her name is not an order.
        const gone = market();
        gone.leave(A);
        expect(sell(gone, A)).toMatchObject({ ok: false, why: 'BAD ORDER' });
        expect(books(gone)).toMatchObject({ station: 0, credits: 0 });
    });

    it('pays its own price for its own lot: a forged price, a forged amount or a forged payment sells nothing', () => {
        const s = market();
        for (const price of [101, 99, 1_000_000, 0, -100, 100.5, '100', null, undefined, NaN, Infinity]) expect(sell(s, A, { price }), `price ${String(price)}`).toMatchObject({ ok: false, why: 'WRONG PRICE', paid: 0, credits: 0 });
        for (const grams of [2 * GRAMS, LOT - 1, LOT + 1, 1, 10 * GRAMS, 0, -LOT, 0.5, '1000000', null, 2 ** 40]) expect(sell(s, A, { grams }), `grams ${String(grams)}`).toMatchObject({ ok: false, why: 'BAD AMOUNT', paid: 0, credits: 0 });
        expect(mine(s, A)).toMatchObject({ stored: 3 * GRAMS, credits: 0 });
        expect(books(s)).toMatchObject({ station: 0, credits: 0, sum: TOTAL });
        // There is nothing in an order that says what she is paid: fields a client adds are not read.
        const forged = (s.sell as unknown as (...args: unknown[]) => { ok: boolean; paid: number; credits: number })(A, next(s, A), op(), LOT, PRICE, undefined, { paid: 99999, credits: 99999, account: B });
        expect(forged).toMatchObject({ ok: true, paid: 100, credits: 100 });
        expect(mine(s, B)).toMatchObject({ stored: 2 * GRAMS, credits: 0 });
        // Each refusal took a number, as any order does, and none of them is a sale that can be asked for again.
        expect(next(s, A)).toBe(24);
    });

    it('makes one sale of one order, however often it is asked', () => {
        const s = market();
        const order = { seq: next(s, A), name: op() };
        expect(sell(s, A, order)).toMatchObject({ ok: true, fresh: true, moved: true, credits: 100, stored: 2 * GRAMS });
        for (let n = 0; n < 40; n++) expect(sell(s, A, order)).toMatchObject({ ok: true, fresh: false, moved: false, paid: 100, credits: 100, stored: 2 * GRAMS });
        expect(mine(s, A)).toMatchObject({ stored: 2 * GRAMS, credits: 100 });
        expect(books(s)).toMatchObject({ station: 1 * GRAMS, credits: 100, sum: TOTAL });
        // The same number and name sent as a move of ore is the sale that was answered, and moves nothing.
        expect(s.transfer(A, order.seq, order.name, true, 1 * GRAMS)).toMatchObject({ ok: true, sell: true, fresh: false, moved: false, stored: 2 * GRAMS });
        // Its number under another name is a number already spent.
        expect(sell(s, A, { seq: order.seq, name: op() })).toMatchObject({ ok: false, why: 'EXPIRED', credits: 100 });
        // A number ahead of the next is not taken.
        expect(sell(s, A, { seq: next(s, A) + 3 })).toMatchObject({ ok: false, why: 'OUT OF ORDER' });
        expect(mine(s, A)).toMatchObject({ stored: 2 * GRAMS, credits: 100 });
    });

    it('does not make an old sale again after sixty-four moves and sales, a restart, or both', () => {
        let s = market(8 * GRAMS, 0);
        const old = { seq: next(s, A), name: op() };
        expect(sell(s, A, old)).toMatchObject({ ok: true, credits: 100, stored: 7 * GRAMS });
        // Far more orders than answers are kept for: moves, sales and refusals, mixed.
        let sold = 1;
        for (let n = 0; n < 64; n++) {
            if (n % 16 === 5) { expect(sell(s, A).ok).toBe(true); sold++; }
            else if (n % 4 === 0) move(s, A, true, 100_000);
            else if (n % 4 === 1) move(s, A, false, 100_000);
            else sell(s, A, { price: 7 });
        }
        expect(ANSWERS_KEPT).toBeLessThan(64);
        const settled = mine(s, A);
        expect(settled.credits).toBe(sold * 100);
        expect(settled.cargo + settled.stored).toBe((8 - sold) * GRAMS);
        const replay = (when: string): void => {
            expect(sell(s, A, old), when).toMatchObject({ ok: false, why: 'EXPIRED', paid: 0, credits: settled.credits, stored: settled.stored });
            expect(s.transfer(A, old.seq, old.name, false, 1), when).toMatchObject({ ok: false, why: 'EXPIRED' });
            expect(mine(s, A), when).toEqual(settled);
            expect(books(s), when).toMatchObject({ station: sold * GRAMS, credits: sold * 100, sum: TOTAL });
        };
        replay('at once');
        s = createSector(JSON.parse(JSON.stringify(s.save())) as Saved);
        s.enter(A); s.enter(B);
        replay('after a restart');
        // And a new sale still goes through.
        expect(sell(s, A)).toMatchObject({ ok: true, credits: settled.credits + 100, stored: settled.stored - LOT });
    });

    it('is written before it is made: a write that fails sells nothing, and the same order afterwards is made once', () => {
        const s = market();
        const order = { seq: next(s, A), name: op() };
        let handed: Saved | null = null;
        const refuse = (after: Saved): void => { handed = JSON.parse(JSON.stringify(after)) as Saved; throw new Error('disk full'); };
        for (let n = 0; n < 4; n++) expect(sell(s, A, { ...order, persist: refuse })).toMatchObject({ ok: false, why: 'NOT SAVED', paid: 0, credits: 0, stored: 3 * GRAMS, fresh: false, moved: false });
        // What was handed to the disk was the whole sale, in one save that adds up; and none of it is true here.
        expect(handed!.pilots[A]).toMatchObject({ stored: 2 * GRAMS, credits: 100, moves: order.seq });
        expect(handed!.station.ore).toBe(1 * GRAMS);
        expect(auditSave(handed!)).toBe('');
        expect(mine(s, A)).toMatchObject({ stored: 3 * GRAMS, credits: 0, next: order.seq });
        expect(books(s)).toMatchObject({ station: 0, credits: 0, sum: TOTAL });
        expect(s.save().station.ore).toBe(0);
        // The disk takes it: made now, once.
        let writes = 0;
        const accept = (): void => { writes++; };
        expect(sell(s, A, { ...order, persist: accept })).toMatchObject({ ok: true, fresh: true, moved: true, paid: 100, credits: 100, stored: 2 * GRAMS });
        for (let n = 0; n < 3; n++) expect(sell(s, A, { ...order, persist: accept })).toMatchObject({ ok: true, fresh: false, moved: false, credits: 100 });
        expect(writes).toBe(1);
        expect(books(s)).toMatchObject({ station: 1 * GRAMS, credits: 100, sum: TOTAL });
    });

    it('is on the disk whole or not at all: stopped before the write nothing was sold, after it everything was', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'market-'));
        const file = path.join(dir, 'sector.json');
        writeSave(file, placed({ [A]: { stored: 3 * GRAMS }, [B]: { stored: 2 * GRAMS } }));
        const s = createSector(loadSave(file));
        s.enter(A);
        const order = { seq: next(s, A), name: op() };
        // Stopped before the write: the disk has no sale. Started from it, the same order is made, once.
        const before = createSector(loadSave(file));
        before.enter(A);
        expect(mine(before, A)).toMatchObject({ stored: 3 * GRAMS, credits: 0 });
        // Written and then stopped, before a word was said: started from the disk, the sale is all there.
        expect(sell(s, A, { ...order, persist: (after) => writeSave(file, after) }).ok).toBe(true);
        const after = createSector(loadSave(file));
        after.enter(A);
        expect(mine(after, A)).toMatchObject({ stored: 2 * GRAMS, credits: 100, next: order.seq + 1 });
        expect(books(after)).toMatchObject({ station: 1 * GRAMS, credits: 100, sum: TOTAL });
        // Asked again by a client that never heard: answered as made, and not made again.
        expect(sell(after, A, order)).toMatchObject({ ok: true, fresh: false, moved: false, credits: 100, stored: 2 * GRAMS });
        expect(books(after)).toMatchObject({ station: 1 * GRAMS, credits: 100 });
    });

    it('refuses a save in which ore or credits have appeared, gone, or been paid for nothing', () => {
        const s = market();
        sell(s, A); sell(s, B);
        const good = JSON.parse(JSON.stringify(s.save())) as Saved;
        expect(auditSave(good)).toBe('');
        for (const [edit, fault] of [
            [(v: Saved) => { v.pilots[A]!.credits += 100; }, /credits do not add up/],
            [(v: Saved) => { v.pilots[A]!.credits = 0; }, /credits do not add up/],
            [(v: Saved) => { v.station.ore += LOT; }, /credits do not add up/],
            [(v: Saved) => { v.station.ore = 0; v.pilots[A]!.credits = 0; v.pilots[B]!.credits = 0; }, /ore does not add up/],
            [(v: Saved) => { v.pilots[A]!.stored += LOT; }, /ore does not add up/],
            [(v: Saved) => { v.station.ore = 1.5 * GRAMS; }, /credits do not add up/],
            [(v: Saved) => { v.pilots[A]!.credits = -100; }, /credits this server did not write/],
            [(v: Saved) => { (v as { station?: unknown }).station = undefined; }, /station has no stock/],
        ] as [(v: Saved) => void, RegExp][]) {
            const bad = JSON.parse(JSON.stringify(good)) as Saved;
            edit(bad);
            expect(auditSave(bad)).toMatch(fault);
            expect(() => createSector(bad)).toThrow();
        }
    });

    it('carries a save from before the station bought ore: nothing bought, nobody paid, every balance as it was', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'market-old-'));
        const file = path.join(dir, 'sector.json');
        writeFileSync(file, JSON.stringify({ version: 4, sector: SECTOR.id, rock: { id: SECTOR.rock.id, total: TOTAL, remaining: 5 * GRAMS }, pilots: {
            [A]: { cargo: 1 * GRAMS, stored: 2 * GRAMS, berth: 1, mooring: 'docked', moves: 3, p: [...STATION.berths[0]!.at], q: [0, 0, 0, 1], lapses: 0, ops: [{ seq: 3, op: 'old-order-0003', ok: true, why: '', withdraw: false, grams: 2 * GRAMS, cargo: 1 * GRAMS, stored: 2 * GRAMS }] },
            [B]: { cargo: 2 * GRAMS, stored: 0, berth: 0, mooring: 'none', moves: 0, p: [4, 5, 6], q: [0, 0, 0, 1], ops: [] } } }));
        const saved = loadSave(file);
        expect(saved).toMatchObject({ version: 5, station: { ore: 0 } });
        expect(saved.pilots[A]).toMatchObject({ cargo: 1 * GRAMS, stored: 2 * GRAMS, credits: 0, moves: 3, berth: 1, mooring: 'docked' });
        const s = createSector(saved);
        s.enter(A);
        // The order it remembered is still answered as it was, and her next sale takes the next number.
        expect(s.transfer(A, 3, 'old-order-0003', false, 2 * GRAMS)).toMatchObject({ ok: true, fresh: false, sell: false, stored: 2 * GRAMS });
        expect(sell(s, A)).toMatchObject({ ok: true, seq: 4, credits: 100, stored: 1 * GRAMS });
        expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(4);
    });
});

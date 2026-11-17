import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import { auditSave, freshSave, type Saved } from './world';

export const backupOf = (file: string): string => `${file}.bak`;
const draftOf = (file: string): string => `${file}.writing`;

/** Thrown when there is no save where one was asked for. A world is founded on purpose, never because a file was not found. */
export class NoSave extends Error {
    constructor(readonly file: string, readonly traces: readonly string[]) {
        super(traces.length > 0
            ? `no save at ${file}, but ${traces.join(' and ')} ${traces.length > 1 ? 'are' : 'is'} there: a sector lived here. Restore the save (the .bak is the save before the last one) and start again; nothing was created.`
            : `no save at ${file}. To found a new sector there, start once with --new; if a sector should be there, restore its save first. Nothing was created.`);
        this.name = 'NoSave';
    }
}

/**
 * A save from an earlier server, brought up to this one. Before there was a station (1): every warehouse is empty, nobody is
 * docked and no order to move ore was ever given. Before orders were numbered (2): the orders it remembers are numbered in the
 * order they were answered, and the pilot's count starts from them. Before there were berths (3): nobody has one. Before the
 * station bought ore (4): it has bought none, nobody has been paid, and no order remembered was a sale.
 */
function upgrade(saved: { version?: unknown; station?: unknown; pilots?: Record<string, Record<string, unknown>> }): void {
    if (typeof saved?.pilots !== 'object' || saved.pilots === null) return;
    if (saved.version === 1) {
        for (const pilot of Object.values(saved.pilots)) { pilot.stored ??= 0; pilot.docked ??= false; pilot.ops ??= []; }
        saved.version = 2;
    }
    if (saved.version === 2) {
        for (const pilot of Object.values(saved.pilots)) {
            const ops = Array.isArray(pilot.ops) ? pilot.ops as Record<string, unknown>[] : [];
            ops.forEach((op, i) => { op.seq = i + 1; });
            pilot.moves = ops.length;
            pilot.ops = ops.slice(-8);
        }
        saved.version = 3;
    }
    if (saved.version === 3) {
        // Before there were berths a docked ship lay wherever she had stopped off the station. She is free there now, with no berth.
        for (const pilot of Object.values(saved.pilots)) { delete pilot.docked; pilot.berth = 0; pilot.mooring = 'none'; }
        saved.version = 4;
    }
    if (saved.version === 4) {
        saved.station = { ore: 0 };
        for (const pilot of Object.values(saved.pilots)) {
            pilot.credits = 0;
            for (const op of Array.isArray(pilot.ops) ? pilot.ops as Record<string, unknown>[] : []) { op.sell = false; op.paid = 0; op.credits = 0; }
        }
        saved.version = 5;
    }
}
/**
 * The sector as it was saved. With `found`, a missing save is the first start and a new sector is written at once,
 * so that from then on its absence is a loss and not a beginning; and `found` over a sector that is there, or over
 * what is left of one, is refused, so a slip of the hand cannot found a new world on top of an old one.
 */
export function loadSave(file: string, options: { found?: boolean } = {}): Saved {
    // A draft beside a save that is there is a write that was cut short: the save is the whole one, and the draft is nothing.
    const traces = [backupOf(file), draftOf(file)].filter((trace) => existsSync(trace));
    if (existsSync(file)) {
        if (options.found) throw new Error(`a sector is already saved at ${file}: start without --new to carry it on, or move the save away to found another`);
        let saved: Saved;
        try { saved = JSON.parse(readFileSync(file, 'utf8')) as Saved; } catch (err) { throw new Error(`${file} cannot be read as a save (${err instanceof Error ? err.message : String(err)}); the save before it is ${backupOf(file)}`); }
        upgrade(saved as never);
        const fault = auditSave(saved);
        if (fault) throw new Error(`${file}: ${fault}`);
        return saved;
    }
    if (!options.found || traces.length > 0) throw new NoSave(file, traces.map((trace) => path.basename(trace)));
    const founded = freshSave();
    writeSave(file, founded);
    return founded;
}

/**
 * Written whole or not at all, and on the disk when this returns: to a draft that is flushed, the save there kept as the
 * .bak, then the draft put in its place in one move. Whatever stops the server part way leaves the save as it was or as
 * it is now, never half of each. `between` runs after the draft is written and before it takes the save's place: a check
 * stops the server there to see that.
 */
export function writeSave(file: string, saved: Saved, between?: () => void): void {
    const fault = auditSave(saved);
    if (fault) throw new Error(`refusing to write a save whose ${fault}`);
    mkdirSync(path.dirname(file), { recursive: true });
    const draft = openSync(draftOf(file), 'w');
    try { writeSync(draft, JSON.stringify(saved, null, 1)); fsyncSync(draft); } finally { closeSync(draft); }
    between?.();
    if (existsSync(file)) copyFileSync(file, backupOf(file));
    renameSync(draftOf(file), file);
}

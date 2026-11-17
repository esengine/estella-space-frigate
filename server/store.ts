import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
 * The sector as it was saved. With `found`, a missing save is the first start and a new sector is written at once,
 * so that from then on its absence is a loss and not a beginning; and `found` over a sector that is there, or over
 * what is left of one, is refused, so a slip of the hand cannot found a new world on top of an old one.
 */
export function loadSave(file: string, options: { found?: boolean } = {}): Saved {
    const traces = [backupOf(file), draftOf(file)].filter((trace) => existsSync(trace));
    if (existsSync(file)) {
        if (options.found) throw new Error(`a sector is already saved at ${file}: start without --new to carry it on, or move the save away to found another`);
        let saved: Saved;
        try { saved = JSON.parse(readFileSync(file, 'utf8')) as Saved; } catch (err) { throw new Error(`${file} cannot be read as a save (${err instanceof Error ? err.message : String(err)}); the save before it is ${backupOf(file)}`); }
        const fault = auditSave(saved);
        if (fault) throw new Error(`${file}: ${fault}`);
        return saved;
    }
    if (!options.found || traces.length > 0) throw new NoSave(file, traces.map((trace) => path.basename(trace)));
    const founded = freshSave();
    writeSave(file, founded);
    return founded;
}

/** Written whole or not at all: to a draft, the save there kept as the .bak, then the draft put in its place. */
export function writeSave(file: string, saved: Saved): void {
    const fault = auditSave(saved);
    if (fault) throw new Error(`refusing to write a save whose ${fault}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(draftOf(file), JSON.stringify(saved, null, 1));
    if (existsSync(file)) copyFileSync(file, backupOf(file));
    renameSync(draftOf(file), file);
}

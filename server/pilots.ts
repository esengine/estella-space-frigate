import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { TokenBook, newToken } from 'esengine/session';

/**
 * Who may fly in a deployed sector: a list of pilots and a token each, kept in a file beside the save and never in the game's
 * code, so the two test pilots the checks fly are not accounts on a sector anyone can reach.
 */
export function readPilots(file: string): TokenBook {
    if (!existsSync(file)) throw new Error(`no pilots at ${file}: add the first with --accounts ${file} --add-pilot <id>`);
    return TokenBook.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** A pilot added to the list, with a token of her own; the list is written whole or not at all. Returns her token. */
export function addPilot(file: string, id: string, name: string): string {
    const list = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { accounts?: unknown[] }).accounts ?? [] : [];
    if (list.some((a) => (a as { id?: unknown }).id === id)) throw new Error(`${id} is already a pilot here`);
    const token = newToken();
    const next = { accounts: [...list, { id, name: name || id.toUpperCase(), token }] };
    TokenBook.parse(next);
    writeFileSync(`${file}.writing`, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(`${file}.writing`, file);
    return token;
}

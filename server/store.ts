import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { auditSave, freshSave, type Saved } from './world';

export function loadSave(file: string): Saved {
    if (!existsSync(file)) return freshSave();
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Saved;
    const fault = auditSave(saved);
    if (fault) throw new Error(`${file}: ${fault}`);
    return saved;
}

export function writeSave(file: string, saved: Saved): void {
    const fault = auditSave(saved);
    if (fault) throw new Error(`refusing to write a save whose ${fault}`);
    mkdirSync(path.dirname(file), { recursive: true });
    const draft = `${file}.writing`;
    writeFileSync(draft, JSON.stringify(saved, null, 1));
    renameSync(draft, file);
}

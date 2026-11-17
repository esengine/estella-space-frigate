import { SECTOR, allot, apart, quat4, stepToward, vec3, type PilotView, type Quat4, type Refusal, type ServerMessage, type Vec3 } from '../src/shared/sector';

export interface Account { id: string; name: string; token: string }

export const TEST_ACCOUNTS: readonly Account[] = [
    { id: 'pilot-a', name: 'PILOT A', token: 'test-token-a' },
    { id: 'pilot-b', name: 'PILOT B', token: 'test-token-b' },
];

export interface Saved {
    version: 1;
    sector: string;
    rock: { id: string; total: number; remaining: number };
    pilots: Record<string, { cargo: number; p: Vec3; q: Quat4 }>;
}

interface Pilot { account: Account; cargo: number; p: Vec3; q: Quat4; th: number; here: boolean; wantsMine: boolean; mining: boolean; why: Refusal; posedAt: number; reach: number }

const SLACK = 12;
const HASTE = 1.25;

export function freshSave(): Saved {
    return { version: 1, sector: SECTOR.id, rock: { id: SECTOR.rock.id, total: SECTOR.rock.total, remaining: SECTOR.rock.total }, pilots: {} };
}

export function auditSave(saved: Saved): string {
    if (saved.version !== 1 || saved.sector !== SECTOR.id || saved.rock.id !== SECTOR.rock.id) return 'the save is for another sector or version';
    const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
    if (!whole(saved.rock.total) || !whole(saved.rock.remaining) || saved.rock.total !== SECTOR.rock.total) return 'the rock is not the one this sector holds';
    let held = 0;
    for (const [id, pilot] of Object.entries(saved.pilots)) {
        if (!whole(pilot.cargo) || !vec3(pilot.p) || !quat4(pilot.q)) return `pilot ${id} is not a pilot this server wrote`;
        held += pilot.cargo;
    }
    if (held + saved.rock.remaining !== saved.rock.total) return `ore does not add up: ${held} g held + ${saved.rock.remaining} g left is not ${saved.rock.total} g`;
    return '';
}

export function createSector(saved: Saved = freshSave(), accounts: readonly Account[] = TEST_ACCOUNTS) {
    const fault = auditSave(saved);
    if (fault) throw new Error(fault);
    let remaining = saved.rock.remaining, tick = 0, turn = 0, dirty = false;
    const pilots = new Map<string, Pilot>();
    accounts.forEach((account, i) => {
        const kept = saved.pilots[account.id];
        pilots.set(account.id, {
            account, cargo: kept?.cargo ?? 0, p: kept ? vec3(kept.p)! : [...SECTOR.berths[i % SECTOR.berths.length]!] as Vec3, q: kept ? quat4(kept.q)! : [0, 0, 0, 1],
            th: 0, here: false, wantsMine: false, mining: false, why: 'NOT MINING', posedAt: 0, reach: SLACK,
        });
    });
    for (const id of Object.keys(saved.pilots)) if (!pilots.has(id)) throw new Error(`the save holds cargo for ${id}, who has no account here`);

    const login = (id: unknown, token: unknown): Account | null => {
        const pilot = typeof id === 'string' ? pilots.get(id) : undefined;
        return pilot && typeof token === 'string' && token === pilot.account.token ? pilot.account : null;
    };

    const enter = (id: string, now: number): void => {
        const pilot = pilots.get(id)!;
        pilot.here = true; pilot.wantsMine = false; pilot.mining = false; pilot.why = 'NOT MINING'; pilot.posedAt = now; pilot.th = 0;
    };

    const leave = (id: string): void => {
        const pilot = pilots.get(id);
        if (!pilot) return;
        pilot.here = false; pilot.wantsMine = false; pilot.mining = false; pilot.why = 'NOT MINING';
    };

    const pose = (id: string, p: unknown, q: unknown, th: unknown, now: number): boolean => {
        const pilot = pilots.get(id), to = vec3(p), facing = quat4(q);
        if (!pilot || !pilot.here || !to || !facing) return false;
        if (!Number.isFinite(now)) return false;
        const seconds = Math.min(1, Math.max(0, (now - pilot.posedAt) / 1000));
        pilot.reach = Math.min(SECTOR.topSpeed * HASTE + SLACK, pilot.reach + SECTOR.topSpeed * HASTE * seconds);
        const next = stepToward(pilot.p, to, pilot.reach);
        pilot.reach -= apart(pilot.p, next);
        if (next[0] !== pilot.p[0] || next[1] !== pilot.p[1] || next[2] !== pilot.p[2]) dirty = true;
        pilot.p = next; pilot.q = facing; pilot.posedAt = now;
        pilot.th = typeof th === 'number' && Number.isFinite(th) ? Math.min(1, Math.max(0, th)) : 0;
        return true;
    };

    const mine = (id: string, on: unknown): boolean => {
        const pilot = pilots.get(id);
        if (!pilot || !pilot.here || typeof on !== 'boolean') return false;
        pilot.wantsMine = on;
        return true;
    };

    const step = (ms: number): void => {
        tick++;
        const seconds = Number.isFinite(ms) ? Math.min(250, Math.max(0, ms)) / 1000 : 0;
        const miners: Pilot[] = [];
        for (const pilot of pilots.values()) {
            pilot.mining = false;
            if (!pilot.here || !pilot.wantsMine) { pilot.why = 'NOT MINING'; continue; }
            if (remaining <= 0) { pilot.why = 'ROCK EXHAUSTED'; continue; }
            if (apart(pilot.p, SECTOR.rock.at as unknown as Vec3) > SECTOR.range) { pilot.why = 'OUT OF RANGE'; continue; }
            if (pilot.cargo >= SECTOR.capacity) { pilot.why = 'HOLD FULL'; continue; }
            pilot.why = '';
            miners.push(pilot);
        }
        if (miners.length === 0 || seconds <= 0) return;
        const wants = miners.map((pilot) => Math.min(Math.floor(SECTOR.rate * seconds), SECTOR.capacity - pilot.cargo));
        const got = allot(remaining, wants, turn++ % miners.length);
        miners.forEach((pilot, i) => {
            const grams = got[i]!;
            if (grams <= 0) return;
            pilot.cargo += grams;
            remaining -= grams;
            pilot.mining = true;
            dirty = true;
        });
    };

    const view = (pilot: Pilot): PilotView => ({ account: pilot.account.id, name: pilot.account.name, p: pilot.p, q: pilot.q, th: pilot.th, mining: pilot.mining, cargo: pilot.cargo });

    const welcome = (id: string): ServerMessage => {
        const pilot = pilots.get(id)!;
        return {
            t: 'welcome', v: 1, you: { account: id, name: pilot.account.name, p: pilot.p, q: pilot.q, cargo: pilot.cargo },
            sector: { id: SECTOR.id, name: SECTOR.name, rock: { id: SECTOR.rock.id, at: [...SECTOR.rock.at] as Vec3, total: SECTOR.rock.total, remaining }, range: SECTOR.range, rate: SECTOR.rate, capacity: SECTOR.capacity },
        };
    };

    const stateFor = (id: string): ServerMessage => {
        const pilot = pilots.get(id)!;
        return {
            t: 'state', tick, rock: remaining, you: { p: pilot.p, cargo: pilot.cargo, mining: pilot.mining, why: pilot.why },
            others: [...pilots.values()].filter((other) => other !== pilot && other.here).map(view),
        };
    };

    const save = (): Saved => {
        const out = freshSave();
        out.rock.remaining = remaining;
        for (const pilot of pilots.values()) out.pilots[pilot.account.id] = { cargo: pilot.cargo, p: [...pilot.p] as Vec3, q: [...pilot.q] as Quat4 };
        return out;
    };

    const ore = (): { remaining: number; held: number; total: number } => {
        let held = 0;
        for (const pilot of pilots.values()) held += pilot.cargo;
        return { remaining, held, total: SECTOR.rock.total };
    };

    return {
        login, enter, leave, pose, mine, step, welcome, stateFor, save, ore,
        here: (id: string): boolean => pilots.get(id)?.here === true,
        takeDirty: (): boolean => { const was = dirty; dirty = false; return was; },
    };
}

export type Sector = ReturnType<typeof createSector>;

export const CONTRACT = { goal: 10, banner: 7 } as const;

export type Stage = 'mine' | 'return' | 'done';

export interface Situation {
    hold: number;
    target: 'none' | 'rock' | 'major' | 'raider';
    locked: boolean;
    inRange: boolean;
    armed: boolean;
    firing: boolean;
    reason: string;
    combat: boolean;
    mode: string;
    stopped: boolean;
    away: boolean;
    gate: string;
}

export interface Advice { stage: Stage; text: string; cue: string; urgent: boolean }

export const contract = {
    delivered: 0,
    done: false,
    doneAt: -1,
    completions: 0,
    stage: 'mine' as Stage,
    cue: '',
    text: '',
};

export const stageOf = (hold: number): Stage => (contract.done ? 'done' : hold + contract.delivered >= CONTRACT.goal - 1e-6 ? 'return' : 'mine');

export function deliver(tonnes: number, time: number): boolean {
    if (contract.done || tonnes <= 0) return false;
    contract.delivered = Math.min(CONTRACT.goal, Math.round((contract.delivered + tonnes) * 10) / 10);
    if (contract.delivered < CONTRACT.goal) return false;
    contract.done = true;
    contract.doneAt = time;
    contract.completions++;
    return true;
}

export function advise(s: Situation): Advice {
    const stage = stageOf(s.hold);
    const say = (text: string, cue = '', urgent = cue !== ''): Advice => ({ stage, text, cue, urgent });
    if (stage === 'done') return say('CONTRACT COMPLETE   THE SHIP IS YOURS');
    if (stage === 'return') {
        if (s.away) return say('LEAVE THE PLANET   PRESS P FOR ORBIT', 'Orbit');
        if (s.mode !== 'align') return say(`ORE ABOARD   PRESS B TO STEER FOR ${s.gate}`, 'Gate');
        if (s.stopped) return say('ENGINE STOPPED   PRESS W TO GET UNDER WAY', 'Engine75');
        return say(`ON COURSE   FLY INTO THE ${s.gate} MARKER TO DELIVER`, '', true);
    }
    if (s.combat) return say('PRESS G TO LEAVE COMBAT MODE AND MINE', 'Guns');
    if (s.target === 'none') return say('PRESS T OR CLICK A ROCK TO LOCK IT', 'Lock');
    if (s.target === 'raider') return say('RAIDER LOCKED   THE GUNS ENGAGE IT   MINE WHEN IT IS DOWN');
    if (s.target === 'major') return say('TOO LARGE TO MINE   PRESS T FOR ANOTHER ROCK', 'Lock');
    if (!s.locked) return say('ACQUIRING LOCK   STAND BY');
    if (!s.inRange) {
        if (s.mode !== 'approach') return say('OUT OF BEAM RANGE   PRESS V TO CLOSE IN', 'Close');
        if (s.stopped) return say('ENGINE STOPPED   PRESS W TO GET UNDER WAY', 'Engine75');
        return say('CLOSING ON THE ROCK   STAND BY');
    }
    if (!s.armed) return say('ROCK IN RANGE   PRESS F TO START THE MINING BEAM', 'Mine');
    if (s.firing) return say('MINING   KEEP THE LOCK UNTIL THE ROCK BREAKS');
    if (s.reason) return say(`BEAM HELD   ${s.reason}   IT RESUMES BY ITSELF`);
    return say('MINING BEAM ARMED   STAND BY');
}

import { CONTRACT, advise, contract, deliver, stageOf, type Situation } from '../src/contract';

const at: Situation = { hold: 0, target: 'none', locked: false, inRange: false, armed: false, firing: false, reason: '', combat: false, mode: 'manual', stopped: false, away: false, gate: 'KESTREL GATE' };
const told = (now: Partial<Situation>) => advise({ ...at, ...now });

describe('the first contract', () => {
    beforeEach(() => { Object.assign(contract, { delivered: 0, done: false, doneAt: -1, completions: 0 }); });

    it('walks a hand that has read nothing from a rock to the beam, one order at a time', () => {
        expect(told({})).toMatchObject({ stage: 'mine', cue: 'Lock' });
        expect(told({ target: 'major' })).toMatchObject({ cue: 'Lock' });
        expect(told({ target: 'major' }).text).toMatch(/TOO LARGE/);
        expect(told({ target: 'raider' }).cue).toBe('');
        expect(told({ target: 'rock' }).text).toMatch(/ACQUIRING/);
        expect(told({ target: 'rock', locked: true })).toMatchObject({ cue: 'Close' });
        expect(told({ target: 'rock', locked: true, mode: 'approach', stopped: true })).toMatchObject({ cue: 'Engine75' });
        expect(told({ target: 'rock', locked: true, inRange: true })).toMatchObject({ cue: 'Mine' });
        expect(told({ target: 'rock', locked: true, inRange: true }).text).toMatch(/PRESS F/);
        expect(told({ target: 'rock', locked: true, inRange: true, armed: true, firing: true })).toMatchObject({ cue: '', urgent: false });
        expect(told({ target: 'rock', locked: true, inRange: true, armed: true, reason: 'EMITTER COOLING' }).text).toMatch(/EMITTER COOLING/);
        expect(told({ combat: true })).toMatchObject({ cue: 'Guns' });
    });

    it('sends her to the gate as soon as what is aboard and what is delivered make the tonnage', () => {
        expect(stageOf(CONTRACT.goal - 0.1)).toBe('mine');
        expect(stageOf(CONTRACT.goal)).toBe('return');
        expect(deliver(4, 10)).toBe(false);
        expect(stageOf(5.9)).toBe('mine');
        expect(stageOf(6)).toBe('return');
        expect(told({ hold: 6 })).toMatchObject({ stage: 'return', cue: 'Gate' });
        expect(told({ hold: 6 }).text).toMatch(/PRESS B.*KESTREL GATE/);
        expect(told({ hold: 6, mode: 'align', stopped: true })).toMatchObject({ cue: 'Engine75' });
        expect(told({ hold: 6, mode: 'align' })).toMatchObject({ cue: '', urgent: true });
        expect(told({ hold: 6, away: true })).toMatchObject({ cue: 'Orbit' });
        expect(told({ hold: 6, combat: true, target: 'raider' })).toMatchObject({ stage: 'return', cue: 'Gate' });
    });

    it('is complete once, at the delivery that makes the tonnage, and stays complete', () => {
        expect(deliver(0, 1)).toBe(false);
        expect(deliver(3.2, 2)).toBe(false);
        expect(contract).toMatchObject({ delivered: 3.2, done: false, completions: 0 });
        expect(deliver(9, 3)).toBe(true);
        expect(contract).toMatchObject({ delivered: CONTRACT.goal, done: true, doneAt: 3, completions: 1 });
        expect(deliver(25, 4)).toBe(false);
        expect(contract).toMatchObject({ delivered: CONTRACT.goal, done: true, doneAt: 3, completions: 1 });
        expect(stageOf(0)).toBe('done');
        expect(told({ hold: 30 })).toMatchObject({ stage: 'done', cue: '', urgent: false });
    });
});

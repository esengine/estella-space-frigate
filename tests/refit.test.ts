import { advise, contract, type Situation } from '../src/contract';
import { REFITS, install, refit, refitDue } from '../src/refit';

const fresh = () => ({ capacity: 40, recharge: 0.055 });
const done: Situation = { hold: 0, target: 'none', locked: false, inRange: false, armed: false, firing: false, reason: '', combat: false, mode: 'manual', stopped: false, away: false, gate: 'KESTREL GATE' };

describe('the free refit', () => {
    beforeEach(() => {
        Object.assign(refit, { choice: '', installs: 0, installedAt: -1, result: '', open: false, picked: '' });
        Object.assign(contract, { delivered: 10, done: true, doneAt: 5, completions: 1 });
    });

    it('is owed from the contract being complete until it is fitted, and not before', () => {
        expect(refitDue(false)).toBe(false);
        expect(refitDue(true)).toBe(true);
        expect(advise({ ...done, refit: '' })).toMatchObject({ stage: 'done', cue: 'Refit', urgent: true });
        expect(advise({ ...done, refit: '' }).text).toMatch(/PRESS U/);
        install('hold', fresh(), 9);
        expect(refitDue(true)).toBe(false);
        expect(advise({ ...done, refit: refit.result })).toMatchObject({ cue: '', urgent: false });
        expect(advise({ ...done, refit: refit.result }).text).toMatch(/REFIT FITTED.*40 T.*60 T/);
    });

    it('the hold refit carries 60 tonnes where she carried 40, and leaves the capacitor alone', () => {
        const tuning = fresh();
        expect(REFITS.hold.change(tuning)).toBe('40 T  >  60 T');
        expect(install('hold', tuning, 12)).toBe(true);
        expect(tuning).toEqual({ capacity: 60, recharge: 0.055 });
        expect(refit).toMatchObject({ choice: 'hold', installs: 1, installedAt: 12, result: 'ORE HOLD  40 T  >  60 T', open: false });
    });

    it('the capacitor refit recharges half again as fast, and leaves the hold alone', () => {
        const tuning = fresh();
        expect(install('capacitor', tuning, 3)).toBe(true);
        expect(tuning.capacity).toBe(40);
        expect(tuning.recharge).toBeCloseTo(0.0825, 9);
        expect(refit).toMatchObject({ choice: 'capacitor', installs: 1, result: 'CAPACITOR RECHARGE  +50 %' });
    });

    it('is fitted once: neither the same refit again nor the other one does anything more', () => {
        const tuning = fresh();
        install('hold', tuning, 1);
        expect(install('hold', tuning, 2)).toBe(false);
        expect(install('capacitor', tuning, 3)).toBe(false);
        expect(tuning).toEqual({ capacity: 60, recharge: 0.055 });
        expect(refit).toMatchObject({ choice: 'hold', installs: 1, installedAt: 1 });
    });
});

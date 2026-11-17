export type RefitChoice = 'hold' | 'capacitor';

export const REFITS = {
    hold: { key: 'J', code: 'KeyJ', title: 'ORE HOLD', change: (t: Tuning) => `${t.capacity} T  >  ${Math.round(t.capacity * 1.5)} T`, gain: 'CARRY HALF AGAIN AS MUCH ORE' },
    capacitor: { key: 'K', code: 'KeyK', title: 'CAPACITOR RECHARGE', change: () => '+50 %', gain: 'THE MINING BEAM IS READY SOONER' },
} as const;

export interface Tuning { capacity: number; recharge: number }

export const refit = {
    choice: '' as RefitChoice | '',
    installs: 0,
    installedAt: -1,
    result: '',
    open: false,
    picked: '' as RefitChoice | '',
};

export const refitDue = (contractDone: boolean): boolean => contractDone && refit.choice === '';

export function install(choice: RefitChoice, tuning: Tuning, time: number): boolean {
    if (refit.choice !== '') return false;
    if (choice === 'hold') {
        const before = tuning.capacity;
        tuning.capacity = Math.round(before * 1.5);
        refit.result = `ORE HOLD  ${before} T  >  ${tuning.capacity} T`;
    } else {
        tuning.recharge *= 1.5;
        refit.result = 'CAPACITOR RECHARGE  +50 %';
    }
    refit.choice = choice;
    refit.installs++;
    refit.installedAt = time;
    refit.open = false;
    refit.picked = '';
    return true;
}

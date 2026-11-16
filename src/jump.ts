import { smooth } from './flight';

export const JUMP = { seconds: 4.6, swap: 2.3, widen: 30, rush: 14, travel: 2600, glare: 0.5 } as const;

export interface JumpState { tunnel: number; stretch: number; flash: number; blend: number; rush: number; swapped: boolean; over: boolean }

const ramp = (t: number, from: number, to: number): number => smooth((t - from) / (to - from));

export function jumpAt(t: number): JumpState {
    if (t < 0) return { tunnel: 0, stretch: 0, flash: 0, blend: 0, rush: 0, swapped: false, over: true };
    if (t >= JUMP.seconds) return { tunnel: 0, stretch: 0, flash: 0, blend: 1, rush: 0, swapped: true, over: true };
    const off = (t - JUMP.swap) / 0.32;
    return {
        tunnel: ramp(t, 0.1, 0.7) * (1 - ramp(t, 3.3, 4.3)),
        stretch: ramp(t, 0, 1.1) * (1 - ramp(t, 3.1, JUMP.seconds)),
        flash: Math.exp(-off * off),
        blend: ramp(t, JUMP.swap - 0.5, JUMP.swap + 0.5),
        rush: ramp(t, 0, 0.9) * (1 - ramp(t, 3, 4.4)),
        swapped: t >= JUMP.swap,
        over: false,
    };
}

export const nextSystem = (now: number, count: number): number => (now + 1) % count;

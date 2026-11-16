export const ship = {
    time: 0,
    throttle: 0,
    wanted: 0,
    speed: 0,
    tour: true,
    shot: 0,
    system: 0,
    bound: 0,
    jump: -1,
    jumps: 0,
    shield: 1,
    hull: 1,
    impacts: 0,
    breaches: 0,
    struck: -100,
    blow: null as { rock: number; closing: number; shielded: boolean } | null,
    gap: Infinity,
    closest: Infinity,
};

export const TOP_SPEED = 420;

export const DRIFTING_ROCKS = 40;
export const FIELD_HALF_LENGTH = 1600;
export const FIELD_DRIFT = 0.12;

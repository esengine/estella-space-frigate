export interface Vec { x: number; y: number; z: number }
export interface Tone { r: number; g: number; b: number; a: 1 }

export const KINDS = ['gas giant', 'ice giant', 'desert world', 'lava world', 'ocean world', 'frozen world', 'terran world'] as const;
export type Kind = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const KIND_SWITCHES = ['PLANET_GIANT', 'PLANET_ICE', 'PLANET_DESERT', 'PLANET_LAVA', 'PLANET_OCEAN', 'PLANET_FROZEN', 'PLANET_TERRAN'] as const;

export const kindSwitches = (kind: Kind): Record<string, boolean> => Object.fromEntries(KIND_SWITCHES.map((name, i) => [name, i === kind]));

export interface Ring { normal: Vec; inner: number; outer: number; bright: Tone; dim: Tone; split: number; gap: number; second: Tone }

export interface Surface {
    kind: Kind;
    palette: readonly [Tone, Tone, Tone, Tone, Tone, Tone];
    accent: Tone;
    pole: Tone;
    glow: Tone;
    seed: Vec;
    shape: { x: number; y: number; z: number; w: number };
    spot: { x: number; y: number; z: number; w: number };
    tilt: { x: number; y: number; z: number; w: number };
}

export interface StarSystem {
    index: number;
    name: string;
    body: string;
    at: Vec;
    radius: number;
    air: number;
    ring: Ring | null;
    sun: Vec;
    sunColor: Tone;
    sunPower: number;
    shine: Vec;
    shineColor: Tone;
    shinePower: number;
    rim: Tone;
    rimPower: number;
    rimStrength: number;
    skyTurn: number;
    skyTint: Tone;
    skyVeil: Tone;
    bandTurn: number;
    surface: Surface;
}

export const FIELD = { clear: 1800, far: 26000, near: 7400, deep: 9800 } as const;

type Random = () => number;

export function randomFrom(seed: number): Random {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const mixSeed = (voyage: number, index: number): number => {
    let h = Math.imul((voyage >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
};

const between = (rand: Random, lo: number, hi: number): number => lo + (hi - lo) * rand();
const choose = <T>(rand: Random, list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(rand() * list.length))]!;
const unit = (v: Vec): Vec => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const cross = (a: Vec, b: Vec): Vec => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (v: Vec, k: number): Vec => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const round = (v: number, places = 5): number => Math.round(v * 10 ** places) / 10 ** places;
const roundVec = (v: Vec): Vec => ({ x: round(v.x), y: round(v.y), z: round(v.z) });

export function hsl(h: number, s: number, l: number): Tone {
    const hue = ((h % 1) + 1) % 1;
    const k = (n: number): number => (n + hue * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return { r: round(f(0), 4), g: round(f(8), 4), b: round(f(4), 4), a: 1 };
}

const toneScale = (t: Tone, k: number): Tone => ({ r: round(t.r * k, 4), g: round(t.g * k, 4), b: round(t.b * k, 4), a: 1 });

const SYLLABLES = ['ka', 've', 'mor', 'tal', 'ri', 'sa', 'nox', 'el', 'dra', 'ith', 'qu', 'or', 'zen', 'lu', 'thar', 'ce', 'vy', 'an', 'gal', 'us', 'pho', 'ren', 'ix', 'ma', 'kor', 'ae', 'syl', 'ven', 'oth', 'bri'] as const;
const SUFFIXES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'PRIME', 'MAJOR', 'B', 'C'] as const;

export function systemName(rand: Random): string {
    const count = rand() < 0.55 ? 2 : 3;
    let name = '';
    let last = '';
    for (let i = 0; i < count; i++) {
        let next = choose(rand, SYLLABLES);
        if (next === last) next = SYLLABLES[(SYLLABLES.indexOf(next) + 7) % SYLLABLES.length]!;
        name += next;
        last = next;
    }
    return name.toUpperCase().slice(0, 9);
}

const SUNS = [
    { color: { r: 1.0, g: 0.94, b: 0.86, a: 1 } as Tone, power: [1.45, 1.6] },
    { color: { r: 0.84, g: 0.92, b: 1.0, a: 1 } as Tone, power: [1.6, 1.8] },
    { color: { r: 1.0, g: 0.86, b: 0.7, a: 1 } as Tone, power: [1.5, 1.7] },
    { color: { r: 1.0, g: 0.78, b: 0.6, a: 1 } as Tone, power: [1.55, 1.75] },
    { color: { r: 0.96, g: 0.97, b: 1.0, a: 1 } as Tone, power: [1.4, 1.6] },
] as const;

function bandPalette(rand: Random, hue: number, sat: number, lights: readonly number[], drift: number): Surface['palette'] {
    return lights.map((l) => hsl(hue + between(rand, -drift, drift), Math.max(0, Math.min(1, sat + between(rand, -0.12, 0.12))), l)) as unknown as Surface['palette'];
}

function makeSurface(rand: Random, kind: Kind): { surface: Surface; rim: Tone; ringTint: number; shine: Tone } {
    const seed = { x: round(between(rand, -40, 40), 3), y: round(between(rand, -40, 40), 3), z: round(between(rand, -40, 40), 3) };
    const tiltAxis = unit({ x: between(rand, -1, 1), y: 0, z: between(rand, -1, 1) });
    const lean = between(rand, -0.45, 0.45), spin = between(rand, 0, Math.PI * 2);
    const ls = Math.sin(lean / 2), lc = Math.cos(lean / 2), ss = Math.sin(spin / 2), sc = Math.cos(spin / 2);
    const tilt = { x: round(tiltAxis.x * ls * sc - tiltAxis.z * ls * ss), y: round(lc * ss), z: round(tiltAxis.z * ls * sc + tiltAxis.x * ls * ss), w: round(lc * sc) };
    const stormLon = round(between(rand, 0, Math.PI * 2), 3), stormLat = round(between(rand, -0.5, 0.5), 3);
    const none: Tone = { r: 0, g: 0, b: 0, a: 1 };
    if (kind === 0) {
        const hue = choose(rand, [between(rand, 0.05, 0.11), between(rand, 0.0, 0.05), between(rand, 0.11, 0.16), between(rand, 0.54, 0.62), between(rand, 0.74, 0.86), between(rand, 0.36, 0.46)]);
        const sat = between(rand, 0.28, 0.6);
        const palette = bandPalette(rand, hue, sat, [0.6, 0.32, 0.74, 0.24, 0.5, 0.8], 0.045);
        return {
            surface: {
                kind, palette, seed, tilt,
                accent: hsl(hue + between(rand, -0.06, 0.03), Math.min(1, sat + 0.25), between(rand, 0.32, 0.48)),
                pole: hsl(hue + between(rand, 0.35, 0.6), between(rand, 0.08, 0.2), between(rand, 0.32, 0.42)),
                glow: none,
                shape: { x: round(between(rand, 6, 13), 3), y: round(between(rand, 1.0, 2.2), 3), z: stormLat, w: stormLon },
                spot: { x: round(between(rand, 0.08, 0.2), 3), y: round(rand() < 0.75 ? between(rand, 0.7, 1) : 0, 3), z: round(between(rand, 0.7, 0.85), 3), w: 0 },
            },
            rim: hsl(choose(rand, [0.58, hue]), 0.55, 0.68), ringTint: hue, shine: hsl(hue, sat, 0.6),
        };
    }
    if (kind === 1) {
        const hue = choose(rand, [between(rand, 0.52, 0.6), between(rand, 0.6, 0.7), between(rand, 0.44, 0.52)]);
        const sat = between(rand, 0.45, 0.75);
        const palette = bandPalette(rand, hue, sat, [0.33, 0.42, 0.53, 0.37, 0.6, 0.28], 0.03);
        return {
            surface: {
                kind, palette, seed, tilt,
                accent: hsl(hue + 0.02, 0.35, 0.9),
                pole: hsl(hue + 0.03, sat, 0.22),
                glow: none,
                shape: { x: round(between(rand, 3.2, 5.5), 3), y: round(between(rand, 0.3, 0.8), 3), z: stormLat, w: stormLon },
                spot: { x: round(between(rand, 0.06, 0.12), 3), y: round(between(rand, 0.5, 0.9), 3), z: round(between(rand, 0.68, 0.8), 3), w: round(between(rand, 0.3, 0.7), 3) },
            },
            rim: hsl(hue, 0.7, 0.62), ringTint: hue, shine: hsl(hue, sat, 0.55),
        };
    }
    if (kind === 2) {
        const family = choose(rand, ['rust', 'sand', 'grey', 'rose'] as const);
        const hue = family === 'rust' ? between(rand, 0.02, 0.07) : family === 'sand' ? between(rand, 0.08, 0.13) : family === 'rose' ? between(rand, 0.95, 1.0) : between(rand, 0, 1);
        const sat = family === 'grey' ? between(rand, 0.03, 0.1) : between(rand, 0.4, 0.65);
        const palette: Surface['palette'] = [
            hsl(hue, sat * 0.4, 0.13), hsl(hue, sat, 0.36), hsl(hue + 0.03, sat * 0.9, 0.52),
            hsl(hue + 0.02, sat * 0.5, 0.7), hsl(hue + 0.02, sat * 0.85, 0.58), hsl(hue, sat * 0.3, 0.04),
        ];
        return {
            surface: {
                kind, palette, seed, tilt,
                accent: hsl(hue, sat * 0.4, 0.62),
                pole: hsl(choose(rand, [0.58, hue]), 0.06, 0.9),
                glow: none,
                shape: { x: round(between(rand, 0.9, 1.4), 3), y: round(between(rand, 7, 11), 3), z: round(between(rand, 0.42, 0.55), 3), w: round(between(rand, 0.3, 0.75), 3) },
                spot: { x: round(between(rand, 0.9, 0.96), 3), y: round(rand() < 0.3 ? 0 : between(rand, 0.3, 0.6), 3), z: 0, w: 0 },
            },
            rim: hsl(hue + 0.02, 0.6, 0.6), ringTint: hue, shine: hsl(hue, sat, 0.45),
        };
    }
    if (kind === 3) {
        const hue = choose(rand, [between(rand, 0.0, 0.03), between(rand, 0.02, 0.05), between(rand, 0.04, 0.07)]);
        const palette: Surface['palette'] = [
            hsl(hue, 0.08, 0.05), hsl(hue, 0.1, 0.11), hsl(hue + 0.04, 0.12, 0.2),
            hsl(hue, 0.25, 0.3), hsl(hue, 0.15, 0.16), hsl(hue, 0.05, 0.02),
        ];
        const heat = between(rand, 0.9, 1.4);
        return {
            surface: {
                kind, palette, seed, tilt,
                accent: hsl(hue + 0.04, 1, 0.55),
                pole: hsl(hue, 0.05, 0.08),
                glow: toneScale(hsl(hue + 0.02, 1, 0.5), heat),
                shape: { x: round(between(rand, 1.0, 1.6), 3), y: round(between(rand, 0.03, 0.06), 3), z: round(between(rand, 0.34, 0.42), 3), w: round(between(rand, 0.45, 0.8), 3) },
                spot: { x: 0, y: 0, z: 0, w: 0 },
            },
            rim: hsl(hue + 0.02, 0.9, 0.55), ringTint: hue, shine: hsl(hue + 0.02, 0.9, 0.45),
        };
    }
    if (kind === 5) {
        const hue = choose(rand, [between(rand, 0.52, 0.6), between(rand, 0.6, 0.68), between(rand, 0.45, 0.52)]);
        const lines = choose(rand, [between(rand, 0.02, 0.07), between(rand, 0.55, 0.62), between(rand, 0.9, 0.97)]);
        const aurora = choose(rand, [between(rand, 0.3, 0.4), between(rand, 0.42, 0.5), between(rand, 0.76, 0.86)]);
        const palette: Surface['palette'] = [
            hsl(hue + 0.03, between(rand, 0.1, 0.25), 0.42), hsl(hue, between(rand, 0.2, 0.4), 0.7), hsl(hue - 0.02, between(rand, 0.15, 0.3), 0.86),
            hsl(lines, between(rand, 0.35, 0.6), between(rand, 0.32, 0.45)), hsl(hue, 0.3, 0.6), hsl(hue, 0.1, 0.95),
        ];
        return {
            surface: {
                kind, palette, seed, tilt,
                accent: toneScale(hsl(aurora + between(rand, 0.18, 0.3), 0.9, 0.55), between(rand, 0.75, 1.0)),
                pole: hsl(hue, 0.15, 0.92),
                glow: toneScale(hsl(aurora, 0.95, 0.5), between(rand, 0.8, 1.15)),
                shape: { x: round(between(rand, 1.0, 1.5), 3), y: round(between(rand, 2.4, 3.6), 3), z: round(between(rand, 0.55, 0.85), 3), w: round(between(rand, 0.6, 0.9), 3) },
                spot: { x: round(between(rand, 0.78, 0.88), 3), y: round(between(rand, 0.03, 0.05), 3), z: round(between(rand, 0.66, 0.76), 3), w: 0 },
            },
            rim: hsl(aurora, 0.6, 0.65), ringTint: hue, shine: hsl(hue, 0.3, 0.7),
        };
    }
    if (kind === 6) {
        const water = between(rand, 0.57, 0.62), green = between(rand, 0.24, 0.32);
        const palette: Surface['palette'] = [
            hsl(water, 0.75, 0.1), hsl(water - 0.04, 0.6, 0.28), hsl(green, between(rand, 0.35, 0.5), 0.22),
            hsl(between(rand, 0.06, 0.1), between(rand, 0.15, 0.3), 0.38), hsl(between(rand, 0.09, 0.12), between(rand, 0.35, 0.5), 0.52), hsl(0.6, 0.06, 0.94),
        ];
        return {
            surface: {
                kind, palette, seed, tilt,
                accent: hsl(water, 0.3, 0.75),
                pole: hsl(0.58, 0.06, 0.94),
                glow: toneScale(hsl(between(rand, 0.08, 0.12), 0.85, 0.6), between(rand, 1.4, 2.0)),
                shape: { x: round(between(rand, 1.1, 1.6), 3), y: 0, z: round(between(rand, 0.3, 0.7), 3), w: round(between(rand, 0.51, 0.54), 3) },
                spot: { x: round(between(rand, 0.55, 0.85), 3), y: round(between(rand, 0.7, 1.0), 3), z: 0, w: 0 },
            },
            rim: hsl(0.6, 0.8, 0.62), ringTint: water, shine: hsl(water, 0.5, 0.5),
        };
    }
    const water = choose(rand, [between(rand, 0.56, 0.63), between(rand, 0.47, 0.53), between(rand, 0.7, 0.78)]);
    const land = choose(rand, [between(rand, 0.25, 0.36), between(rand, 0.07, 0.12), between(rand, 0.93, 1.0), between(rand, 0.16, 0.22)]);
    const palette: Surface['palette'] = [
        hsl(water, 0.75, 0.12), hsl(water, 0.6, 0.3), hsl(land, between(rand, 0.35, 0.6), 0.27),
        hsl(land + 0.04, between(rand, 0.2, 0.45), 0.42), hsl(land - 0.03, 0.15, 0.6), hsl(0.6, 0.1, 0.92),
    ];
    return {
        surface: {
            kind, palette, seed, tilt,
            accent: hsl(water, 0.3, 0.75),
            pole: hsl(0.58, 0.08, 0.93),
            glow: none,
            shape: { x: round(between(rand, 1.1, 1.7), 3), y: 0, z: round(between(rand, 0.35, 0.8), 3), w: round(between(rand, 0.55, 0.59), 3) },
            spot: { x: round(between(rand, 0.4, 0.75), 3), y: 0, z: 0, w: 0 },
        },
        rim: hsl(0.58, 0.75, 0.62), ringTint: water, shine: hsl(water, 0.5, 0.5),
    };
}

const RADII: Record<Kind, readonly [number, number]> = { 0: [3700, 4700], 1: [2900, 3700], 2: [2400, 3400], 3: [2200, 3000], 4: [2600, 3500], 5: [2300, 3200], 6: [2600, 3400] };
const AIR: Record<Kind, readonly [number, number]> = { 0: [1.02, 1.03], 1: [1.025, 1.035], 2: [1.01, 1.016], 3: [1.012, 1.02], 4: [1.018, 1.026], 5: [1.012, 1.018], 6: [1.018, 1.026] };
const RIM: Record<Kind, readonly [number, number, number, number]> = { 0: [4.5, 5.5, 1.4, 1.8], 1: [3.6, 4.4, 1.8, 2.2], 2: [5.5, 6.5, 0.9, 1.2], 3: [4.5, 5.5, 1.4, 1.9], 4: [3.6, 4.4, 1.9, 2.3], 5: [4.5, 5.5, 1.0, 1.4], 6: [3.6, 4.4, 2.0, 2.4] };

export function makeSystem(voyage: number, index: number): StarSystem {
    const rand = randomFrom(mixSeed(voyage, index));
    const kind = choose(rand, [0, 0, 1, 2, 2, 3, 4, 5, 5, 6, 6] as const) as Kind;
    const look = makeSurface(rand, kind);
    const name = systemName(rand);
    const body = `${name} ${choose(rand, SUFFIXES)}`;

    const turn = between(rand, 0, Math.PI * 2), lift = between(rand, -0.62, 0.32);
    const way = { x: Math.cos(turn) * Math.cos(lift), y: Math.sin(lift), z: Math.sin(turn) * Math.cos(lift) };
    const distance = between(rand, FIELD.near, FIELD.deep);
    let radius = between(rand, RADII[kind][0], RADII[kind][1]);
    let ring: Ring | null = null;
    if ((kind === 0 && rand() < 0.55) || (kind === 1 && rand() < 0.45)) {
        const outer = between(rand, 1.8, 2.3), inner = between(rand, 1.22, 1.38);
        radius = Math.min(radius, (distance - FIELD.clear - 400) / outer);
        const tip = between(rand, 0.16, 0.6), about = between(rand, 0, Math.PI * 2);
        const normal = unit({ x: Math.sin(tip) * Math.cos(about), y: Math.cos(tip), z: Math.sin(tip) * Math.sin(about) });
        const tint = look.ringTint;
        ring = {
            normal: roundVec(normal), inner: round(inner, 3), outer: round(outer, 3),
            bright: hsl(tint + between(rand, -0.03, 0.03), between(rand, 0.1, 0.3), between(rand, 0.78, 0.88)),
            dim: hsl(tint + between(rand, -0.05, 0.05), between(rand, 0.15, 0.3), between(rand, 0.4, 0.52)),
            split: 0, gap: 0, second: hsl(tint + between(rand, 0.06, 0.16), between(rand, 0.2, 0.4), between(rand, 0.62, 0.78)),
        };
        if (rand() < 0.45) { ring.split = round(between(rand, 0.48, 0.62), 3); ring.gap = round(between(rand, 0.07, 0.11), 3); }
    }
    const air = between(rand, AIR[kind][0], AIR[kind][1]);
    const at = scale(way, distance);

    const toViewer = scale(way, -1);
    const across = unit(cross(toViewer, Math.abs(toViewer.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }));
    const side = unit(add(scale(across, Math.cos(between(rand, 0, Math.PI * 2))), scale(cross(toViewer, across), Math.sin(between(rand, 0, Math.PI * 2)))));
    const phase = between(rand, 0.6, 1.75);
    const toSun = unit(add(scale(toViewer, Math.cos(phase)), scale(unit(add(side, scale(toViewer, -dot(side, toViewer)))), Math.sin(phase))));
    const star = choose(rand, SUNS);
    const veilHue = between(rand, 0, 1), veilSat = between(rand, 0.15, 0.6);
    const veil = hsl(veilHue, veilSat, 0.5);
    const lift3 = (veil.r + veil.g + veil.b) / 3 || 1;
    const floor = (c: number): number => round(Math.max(0.45, c / lift3), 3);
    const skyVeil: Tone = { r: floor(veil.r), g: floor(veil.g), b: floor(veil.b), a: 1 };
    const skyTint: Tone = { r: round(Math.sqrt(skyVeil.r), 3), g: round(Math.sqrt(skyVeil.g), 3), b: round(Math.sqrt(skyVeil.b), 3), a: 1 };
    const rim = RIM[kind];

    return {
        index, name, body,
        at: roundVec(at),
        radius: Math.round(radius),
        air: round(air, 4),
        ring,
        sun: roundVec(scale(toSun, -1)),
        sunColor: star.color,
        sunPower: round(between(rand, star.power[0], star.power[1]), 3),
        shine: roundVec(toViewer),
        shineColor: look.shine,
        shinePower: round(between(rand, 0.25, 0.42), 3),
        rim: look.rim,
        rimPower: round(between(rand, rim[0], rim[1]), 3),
        rimStrength: round(between(rand, rim[2], rim[3]), 3),
        skyTurn: Math.round(between(rand, 0, 360)),
        skyTint,
        skyVeil,
        bandTurn: Math.round(between(rand, 0, 360)),
        surface: look.surface,
    };
}

export function ringSun(ring: Ring, sun: Vec): Vec {
    const f = unit(ring.normal);
    const up = Math.abs(f.y) > 0.99 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    const r = unit(cross(f, up));
    const u = cross(r, f);
    const to = unit(scale(sun, -1));
    return roundVec({ x: dot(to, r), y: dot(to, u), z: -dot(to, f) });
}

export const galaxy = { seed: 1 };

const atlas = new Map<string, StarSystem>();

export function systemAt(index: number): StarSystem {
    const key = `${galaxy.seed}:${index}`;
    let found = atlas.get(key);
    if (!found) {
        found = makeSystem(galaxy.seed, index);
        if (atlas.size > 64) atlas.clear();
        atlas.set(key, found);
    }
    return found;
}

export function voyageSeed(search: string, pick: () => number): number {
    const asked = /[?&]seed=(\d+)/.exec(search);
    if (asked) return Number(asked[1]) >>> 0;
    return Math.floor(pick() * 4294967296) >>> 0;
}

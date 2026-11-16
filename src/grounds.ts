import type { Color } from 'esengine';
import { groundRange, groundSample } from './planetGround';
import type { Kind, StarSystem, Surface, Tone } from './worlds';

export interface Ground {
    world: string;
    site: string;
    radius: number;
    seed: number;
    colors: [Color, Color, Color, Color];
    sea: Color | null;
    fog: Color;
    haze: number;
    fogDensity: number;
    clouds: number;
    ambient: Color;
    skyFog: number;
}

interface Kindred {
    world: string;
    site: string;
    radius: number;
    band: readonly [number, number];
    haze: number;
    fogDensity: number;
    clouds: number;
    skyFog: number;
    look: (s: Surface) => { colors: [Color, Color, Color, Color]; sea: Color | null; fog: Color; ambient: Color };
}

const rgb = (r: number, g: number, b: number): Color => ({ r, g, b, a: 1 });
const times = (t: Tone | Color, k: number): Color => rgb(Math.min(1, t.r * k), Math.min(1, t.g * k), Math.min(1, t.b * k));
const blend = (a: Tone | Color, b: Tone | Color, k: number): Color => rgb(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
const brightest = (t: Tone | Color): Color => times(t, 1 / Math.max(t.r, t.g, t.b, 1e-3));
const WHITE = rgb(1, 1, 1);

const KINDRED: Partial<Record<Kind, Kindred>> = {
    2: {
        world: 'desert', site: 'HIGHLAND DESERT', radius: 52000, band: [200, 1100], haze: 3.2, fogDensity: 0.00016, clouds: 0.12, skyFog: 0.95,
        look: (s) => ({
            colors: [times(s.palette[2], 0.85), s.palette[1], s.palette[3], blend(s.palette[0], s.palette[1], 0.4)],
            sea: null,
            fog: times(s.palette[4], 1.05),
            ambient: blend(WHITE, brightest(s.palette[4]), 0.9),
        }),
    },
    3: {
        world: 'lava', site: 'LAVA PLAIN', radius: 46000, band: [-150, 250], haze: 4.5, fogDensity: 0.0002, clouds: 0.12, skyFog: 0.95,
        look: (s) => ({
            colors: [times(s.palette[1], 1.1), times(s.palette[4], 1.25), times(s.palette[2], 2), times(s.palette[0], 1.5)],
            sea: times(s.glow, 1),
            fog: blend(times(s.palette[3], 1.4), times(s.glow, 1), 0.2),
            ambient: blend(WHITE, brightest(s.glow), 0.5),
        }),
    },
    4: {
        world: 'ocean', site: 'ISLAND CHAIN', radius: 56000, band: [60, 500], haze: 1.3, fogDensity: 0.00009, clouds: 0.42, skyFog: 0.6,
        look: (s) => ({
            colors: [s.palette[4], times(s.palette[2], 1.2), s.pole, times(s.palette[3], 0.75)],
            sea: blend(s.palette[0], s.palette[1], 0.6),
            fog: rgb(0.62, 0.74, 0.86),
            ambient: rgb(0.9, 0.95, 1.0),
        }),
    },
    5: {
        world: 'frozen', site: 'ICE SHELF', radius: 50000, band: [-100, 600], haze: 1.0, fogDensity: 0.00012, clouds: 0.2, skyFog: 0.75,
        look: (s) => ({
            colors: [s.palette[1], s.palette[2], s.palette[5], blend(s.palette[3], s.palette[0], 0.4)],
            sea: null,
            fog: rgb(0.8, 0.87, 0.95),
            ambient: rgb(0.86, 0.93, 1.0),
        }),
    },
    6: {
        world: 'terran', site: 'COASTLANDS', radius: 58000, band: [80, 700], haze: 1.2, fogDensity: 0.0001, clouds: 0.45, skyFog: 0.6,
        look: (s) => ({
            colors: [s.palette[4], times(s.palette[2], 1.25), s.pole, times(s.palette[3], 0.8)],
            sea: blend(s.palette[0], s.palette[1], 0.6),
            fog: rgb(0.66, 0.76, 0.88),
            ambient: rgb(0.92, 0.96, 1.0),
        }),
    },
};

export const SITE_TRIES = 48;
const UP = new Float32Array([0, 1, 0]);

export function heightAt(world: string, seed: number, radius: number, up: { x: number; y: number; z: number }): number {
    const [lo, hi] = groundRange(world);
    const got = groundSample({ world, seed, radius, directions: new Float32Array([up.x, up.y, up.z]), count: 1 }).heights[0]!;
    return Math.min(Math.max(got, lo), hi);
}

const made = new WeakMap<StarSystem, Ground | null>();

export function groundFor(system: StarSystem): Ground | null {
    const known = made.get(system);
    if (known !== undefined) return known;
    const kin = KINDRED[system.surface.kind];
    let ground: Ground | null = null;
    if (kin) {
        let base = 0x2545f491;
        for (const ch of `${system.body}:${system.index}:${system.surface.seed.x}:${system.surface.seed.z}`) base = (Math.imul(base, 31) + ch.charCodeAt(0)) | 0;
        let seed = base;
        for (let k = 0; k < SITE_TRIES; k++) {
            const tried = (base + Math.imul(k, 0x9e3779b1)) | 0;
            const h = groundSample({ world: kin.world, seed: tried, radius: kin.radius, directions: UP, count: 1 }).heights[0]!;
            if (h >= kin.band[0] && h <= kin.band[1]) { seed = tried; break; }
        }
        ground = { world: kin.world, site: kin.site, radius: kin.radius, seed, haze: kin.haze, fogDensity: kin.fogDensity, clouds: kin.clouds, skyFog: kin.skyFog, ...kin.look(system.surface) };
    }
    made.set(system, ground);
    return ground;
}

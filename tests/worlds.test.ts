import { readFileSync } from 'node:fs';
import { FIELD, KINDS, galaxy, hsl, makeSystem, ringSun, systemAt, voyageSeed, type StarSystem } from '../src/worlds';

const length = (v: { x: number; y: number; z: number }): number => Math.hypot(v.x, v.y, v.z);
const many = (voyage: number, count: number): StarSystem[] => Array.from({ length: count }, (_, index) => makeSystem(voyage, index));
const channels = (t: { r: number; g: number; b: number }): number[] => [t.r, t.g, t.b];

describe('the worlds a voyage passes', () => {
    it('are the same for the same voyage, and other for another', () => {
        expect(makeSystem(1234, 5)).toEqual(makeSystem(1234, 5));
        expect(makeSystem(1234, 5)).not.toEqual(makeSystem(1235, 5));
        expect(makeSystem(1234, 5)).not.toEqual(makeSystem(1234, 6));
        galaxy.seed = 99;
        const first = systemAt(3);
        galaxy.seed = 100;
        expect(systemAt(3)).not.toEqual(first);
        galaxy.seed = 99;
        expect(systemAt(3)).toEqual(first);
    });

    it('take every kind of world, and some ringed and some with two rings, over a voyage of eighty', () => {
        const worlds = many(2026, 80);
        expect(new Set(worlds.map((w) => w.surface.kind)).size).toBe(KINDS.length);
        expect(worlds.filter((w) => w.ring).length).toBeGreaterThan(3);
        expect(worlds.filter((w) => w.ring && w.ring.split > 0).length).toBeGreaterThan(0);
        expect(new Set(worlds.map((w) => w.name)).size).toBeGreaterThan(72);
        for (const w of worlds) expect(w.name).toMatch(/^[A-Z]{3,9}$/);
    });

    it('keep the planet, its air and its ring clear of the ship and inside the far plane', () => {
        for (const voyage of [1, 77, 4242, 31337]) {
            for (const w of many(voyage, 60)) {
                const distance = length(w.at), reach = w.radius * Math.max(w.air, w.ring ? w.ring.outer : 0);
                expect(distance - reach).toBeGreaterThanOrEqual(FIELD.clear);
                expect(distance + reach).toBeLessThan(FIELD.far);
            }
        }
    });

    it('light each planet from the side, so it is seen in phase and never only as its dark face or a full disc', () => {
        for (const w of many(5, 200)) {
            const d = length(w.at), toViewer = { x: -w.at.x / d, y: -w.at.y / d, z: -w.at.z / d };
            const toSun = { x: -w.sun.x, y: -w.sun.y, z: -w.sun.z };
            const phase = (Math.acos(toSun.x * toViewer.x + toSun.y * toViewer.y + toSun.z * toViewer.z) * 180) / Math.PI;
            expect(phase).toBeGreaterThan(30);
            expect(phase).toBeLessThan(101);
            expect(length(w.sun)).toBeCloseTo(1, 3);
            expect(length(w.shine)).toBeCloseTo(1, 3);
        }
    });

    it('give every colour a value the material can take, and a tilt that is a rotation', () => {
        for (const w of many(9, 100)) {
            const s = w.surface;
            for (const tone of [...s.palette, s.accent, s.pole, w.rim, w.sunColor, w.shineColor, ...(w.ring ? [w.ring.bright, w.ring.dim] : [])]) {
                for (const c of channels(tone)) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(1); }
            }
            for (const c of channels(s.glow)) expect(c).toBeGreaterThanOrEqual(0);
            expect(Math.hypot(s.tilt.x, s.tilt.y, s.tilt.z, s.tilt.w)).toBeCloseTo(1, 3);
            if (s.kind === 3) { expect(Math.max(...channels(s.glow))).toBeGreaterThan(0.8); expect(Math.max(...channels(s.glow))).toBeLessThan(1.5); }
            if (s.kind === 5 || s.kind === 6) { expect(Math.max(...channels(s.glow))).toBeGreaterThan(0.6); expect(Math.max(...channels(s.glow))).toBeLessThan(2.2); }
            if (s.kind < 3 || s.kind === 4) expect(channels(s.glow)).toEqual([0, 0, 0]);
            if (w.ring && w.ring.split > 0) {
                expect(w.ring.split - w.ring.gap).toBeGreaterThan(0.3);
                expect(w.ring.split + w.ring.gap).toBeLessThan(0.8);
            }
            for (const c of channels(w.skyVeil)) expect(c).toBeGreaterThanOrEqual(0.45);
            for (const k of ['r', 'g', 'b'] as const) expect(w.skyTint[k] / w.skyVeil[k]).toBeLessThan(1.5);
        }
    });

    it('turn a ring so the sun reaches it as the planet sees it', () => {
        const w = many(11, 80).find((x) => x.ring)!;
        const local = ringSun(w.ring!, w.sun);
        expect(length(local)).toBeCloseTo(1, 3);
        const flat = ringSun({ ...w.ring!, normal: { x: 0, y: 0.98, z: 0.2 } }, { x: 0, y: -0.98, z: -0.2 });
        expect(flat.z).toBeLessThan(-0.99);
    });

    it('draw colour from hue, saturation and lightness as a picture program does', () => {
        expect(hsl(0, 1, 0.5)).toEqual({ r: 1, g: 0, b: 0, a: 1 });
        expect(hsl(1 / 3, 1, 0.5)).toEqual({ r: 0, g: 1, b: 0, a: 1 });
        expect(hsl(0.5, 0, 0.25)).toEqual({ r: 0.25, g: 0.25, b: 0.25, a: 1 });
    });

    it('come from the seed in the address when it asks for one, and from chance otherwise', () => {
        expect(voyageSeed('?headless&seed=42', () => 0.5)).toBe(42);
        expect(voyageSeed('?seed=7', () => 0.5)).toBe(7);
        expect(voyageSeed('', () => 0.25)).toBe(1073741824);
        expect(voyageSeed('?headless', () => 0)).toBe(0);
    });

    it('are drawn by a shader that knows every kind the voyage can hold', () => {
        const shader = readFileSync(new URL('../assets/materials/planet.esshader', import.meta.url), 'utf8');
        for (const name of ['giant', 'ice', 'desert', 'lava', 'ocean', 'frozen', 'terran']) expect(shader).toMatch(new RegExp(`vec3 ${name}\\(`));
        expect(shader).toMatch(/range\(0,6\)/);
        expect(shader).toMatch(/glow \*= u_kind < 5\.5 \? mix\(0\.25, 1\.0, night\) : night;/);
        const ring = readFileSync(new URL('../assets/materials/ring.esshader', import.meta.url), 'utf8');
        for (const uniform of ['u_split', 'u_second']) expect(ring).toContain(`#pragma param ${uniform} `);
        for (const uniform of ['u_c0', 'u_c5', 'u_accent', 'u_pole', 'u_glow', 'u_seed', 'u_shape', 'u_spot']) expect(shader).toContain(`#pragma param ${uniform} `);
        expect(shader).not.toMatch(/smoothstep\(\s*([^,]+)\+\s*[\d.]+\s*,\s*\1-/);
    });
});

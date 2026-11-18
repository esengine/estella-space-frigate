import { describe, expect, it } from 'vitest';
import { floraRules } from '../src/flora';
import { groundFor } from '../src/grounds';
import { groundRange, groundSample } from '../src/planetGround';
import { WORLD_MAP, mapSeaLevel, siteTurn, specFor, worldMapMaker } from '../src/planetSpec';
import { makeSystem, type StarSystem } from '../src/worlds';

/** The first few systems of a voyage that have ground to stand on, one of each kind there is. */
function landable(): StarSystem[] {
    const seen = new Map<number, StarSystem>();
    for (let i = 1; i < 400 && seen.size < 5; i++) {
        const system = makeSystem(1, i);
        if (groundFor(system) && !seen.has(system.surface.kind)) seen.set(system.surface.kind, system);
    }
    return [...seen.values()];
}

describe('what one world is', () => {
    const systems = landable();

    it('is said for every kind of world she can land on, the same each time it is asked', () => {
        expect(systems.map((s) => s.surface.kind).sort()).toEqual([2, 3, 4, 5, 6]);
        for (const system of systems) {
            const ground = groundFor(system)!, spec = specFor(system, ground)!;
            expect(spec).toBe(specFor(system, ground));
            // Made again from the same voyage, it is the same world.
            const again = makeSystem(1, system.index);
            expect(specFor(again, groundFor(again))).toEqual(spec);
            expect(spec.lush).toBeGreaterThanOrEqual(0);
            expect(spec.lush).toBeLessThanOrEqual(1);
            expect(spec.size).toBeGreaterThanOrEqual(1);
            expect(spec.sea).toBe(ground.sea !== null);
            for (const c of [spec.leaf.r, spec.leaf.g, spec.leaf.b]) expect(Number.isFinite(c) && c > 0).toBe(true);
        }
    });

    it('grows nothing on a lava world and trees several times their grown size on a terran one', () => {
        const lava = systems.find((s) => s.surface.kind === 3)!, terran = systems.find((s) => s.surface.kind === 6)!;
        expect(specFor(lava, groundFor(lava))!.lush).toBe(0);
        const spec = specFor(terran, groundFor(terran))!;
        expect(spec.size).toBeGreaterThanOrEqual(1.8);
        expect(spec.lush).toBeGreaterThan(0.5);
    });

    it('has rules whose biomes name only recipes and layers the rules have', () => {
        for (const system of systems) {
            const rules = floraRules('t', specFor(system, groundFor(system))!);
            const recipes = new Set(rules.recipes.map((r) => r.id)), layers = new Set(rules.layers.map((l) => l.id));
            expect(rules.biomes.length).toBeGreaterThan(0);
            for (const biome of rules.biomes) for (const r of biome.recipes) {
                expect(recipes.has(r.recipe), `${biome.id} names ${r.recipe}`).toBe(true);
                expect(layers.has(r.layer), `${biome.id} names the layer ${r.layer}`).toBe(true);
                expect(r.density).toBeGreaterThanOrEqual(0);
            }
        }
    });
});

describe('where she comes down', () => {
    const system = landable().find((s) => s.surface.kind === 6)!, ground = groundFor(system)!;
    const sample = (world: string, d: [number, number, number]): number =>
        groundSample({ world, seed: ground.seed, radius: ground.radius, directions: new Float32Array(d), count: 1 }).heights[0]!;

    it('is the place of the planet she came in over: the top of the ground she lands on is that place', () => {
        for (const toShip of [{ x: 1, y: 0.2, z: -0.4 }, { x: -0.3, y: -0.9, z: 0.1 }, { x: 0, y: 1, z: 0 }, { x: 0.001, y: -1, z: 0 }]) {
            for (const tilt of [{ x: 0, y: 0, z: 0, w: 1 }, system.surface.tilt]) {
                const turn = siteTurn(tilt, toShip);
                // The place in the planet's own frame: the way to her with the planet's turn taken off.
                const n = Math.hypot(toShip.x, toShip.y, toShip.z);
                const q = { x: -tilt.x, y: -tilt.y, z: -tilt.z, w: tilt.w }, v = { x: toShip.x / n, y: toShip.y / n, z: toShip.z / n };
                const cx = q.y * v.z - q.z * v.y, cy = q.z * v.x - q.x * v.z, cz = q.x * v.y - q.y * v.x;
                const ex = q.y * cz - q.z * cy, ey = q.z * cx - q.x * cz, ez = q.x * cy - q.y * cx;
                const place: [number, number, number] = [v.x + 2 * (q.w * cx + ex), v.y + 2 * (q.w * cy + ey), v.z + 2 * (q.w * cz + ez)];
                expect(sample(`${ground.world}@${turn}`, [0, 1, 0])).toBeCloseTo(sample(ground.world, place), 0);
            }
        }
    });

    it('leaves the ground as it was where no place is named', () => {
        expect(sample(`${ground.world}@0,0,0,1`, [0.3, 0.8, -0.52])).toBeCloseTo(sample(ground.world, [0.3, 0.8, -0.52]), 3);
    });
});

describe('the world as a map', () => {
    it('holds, at each of its texels, the ground\'s own height and paint there', () => {
        const system = landable().find((s) => s.surface.kind === 6)!, ground = groundFor(system)!;
        const maker = worldMapMaker(ground);
        let pixels: Uint8Array | null = null;
        for (let n = 0; n < 100000 && !pixels; n++) pixels = maker.step(50);
        expect(pixels).not.toBeNull();
        expect(pixels!.length).toBe(WORLD_MAP.width * WORLD_MAP.height * 4);
        const [lo, hi] = groundRange(ground.world);
        let sea = 0;
        for (const [i, row] of [[10, 20], [200, 96], [383, 191], [77, 150]] as const) {
            const polar = ((row + 0.5) / WORLD_MAP.height) * Math.PI, round = ((i + 0.5) / WORLD_MAP.width) * Math.PI * 2 - Math.PI;
            const d = new Float32Array([Math.sin(polar) * Math.cos(round), Math.cos(polar), Math.sin(polar) * Math.sin(round)]);
            const got = groundSample({ world: ground.world, seed: ground.seed, radius: ground.radius, directions: d, count: 1 });
            const at = (row * WORLD_MAP.width + i) * 4;
            expect(pixels![at + 3]! / 255).toBeCloseTo((got.heights[0]! - lo) / (hi - lo), 2);
            expect(pixels![at]! / 255).toBeCloseTo(got.paint[0]!, 2);
        }
        // A terran world has both sea and land in it.
        for (let at = 3; at < pixels!.length; at += 4) if (pixels![at]! / 255 < mapSeaLevel(ground.world)) sea++;
        const share = sea / (WORLD_MAP.width * WORLD_MAP.height);
        expect(share).toBeGreaterThan(0.1);
        expect(share).toBeLessThan(0.9);
    });
});

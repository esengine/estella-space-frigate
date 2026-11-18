import type { BiomeDef, Recipe, RecipeMember, WorldRules } from 'esengine/worldgen';
import type { PlantKind } from 'esengine/foliage';
import type { PlanetSpec } from './planetSpec';

// What grows on a world's ground: rules the engine lays out over the planet as she flies, the same from the same seed every time,
// and made for each world from what that world is (src/planetSpec.ts): how much grows, how large, which trees, what stone.
// A unit is about two metres. The trees are grown by the engine's tree step and made ready by tools/flora-meshes.mjs.
//
// A forest is thousands of trees, and is drawn as one is in any engine that draws forests: a tree is a record of where it stands,
// not a copy of its mesh. Near the eye each is an instance of the tree itself; past `near`, of three cards showing its leaves;
// and past `reach` the same cards merged a square of ground at a time, out to `far`.
type Part = Omit<RecipeMember, 'id'>;
const NEAR = 560, REACH = 1500, FAR = 3800;
const kind = (name: string, near: number, reach: number, far: number, shadows = true, stem = false): PlantKind => {
    const part = (mesh: string, lod: string, material = name): PlantKind['parts'][number] =>
        ({ mesh: `assets/flora/${mesh}.esmesh`, lod1Mesh: lod ? `assets/flora/${lod}.esmesh` : '', material: `assets/flora/${material}.esmaterial`, texture: '', tint: [1, 1, 1, 1], opaque: true, castShadows: shadows });
    // A tree is its leaves and its stem, each a part with a material of its own: the leaves take the world's colour, the bark does not.
    return {
        parts: [part(name, near > 0 ? `${name}-card` : ''), ...(stem ? [part(`${name}-bark`, `${name}-card-bark`, `${name}-bark`)] : [])],
        lodDistance: near, drawDistance: reach,
        far: far > 0 ? [part(`${name}-far`, ''), ...(stem ? [part(`${name}-card-bark`, '', `${name}-bark`)] : [])] : [], farDistance: far,
    };
};
/** The kinds of plant a world's rules name, at that world's size: a larger growth is seen whole from further off. */
const plantsFor = (k: number): Record<string, PlantKind> => ({
    oak: kind('oak', NEAR * Math.sqrt(k), REACH, FAR, true, true),
    birch: kind('birch', NEAR * Math.sqrt(k), REACH, FAR, true, true),
    pine: kind('pine', NEAR * Math.sqrt(k), REACH, FAR, true, true),
    bush: kind('bush', 260, 900, 0),
    // The brush's leaves again, small and many: tall grass in clumps, seen only near, and it casts no shadow.
    grass: kind('bush', 0, 420, 0, false),
    // What covers the ground: a patch of blades, a patch of blooms, each a card lying on it with a few standing in it.
    sward: kind('sward', 0, 700, 0, false),
    meadow: kind('meadow', 0, 900, 0, false),
});
const OAK: Part = { plant: 'oak', footprint: 2.4, canopy: 7, minUp: 0.84 };
const BIRCH: Part = { plant: 'birch', footprint: 1.6, canopy: 4, minUp: 0.84 };
const PINE: Part = { plant: 'pine', footprint: 2, canopy: 4, minUp: 0.78 };
const BUSH: Part = { plant: 'bush', footprint: 1.6, canopy: 2, minUp: 0.72 };
const GRASS: Part = { plant: 'grass', footprint: 0.5, canopy: 0, minUp: 0.7 };
// A patch lies with the slope of the ground it is on; its size is its scale (the card is a unit across).
const SWARD: Part = { plant: 'sward', footprint: 0.5, canopy: 0, minUp: 0.6, attach: 'align' };
const MEADOW: Part = { plant: 'meadow', footprint: 0.5, canopy: 0, minUp: 0.7, attach: 'align' };
const ROCK: Part = { mesh: 'assets/flora/stone.esmesh', material: 'assets/flora/stone.esmaterial', footprint: 2.5, attach: 'align', tags: ['rock'] };

/** The materials what grows is drawn with: a world tints them its own colour (main.ts). */
export const FLORA_MATERIALS = ['oak', 'birch', 'pine', 'bush'].map((name) => `assets/flora/${name}.esmaterial`);
export const STONE_MATERIAL = 'assets/flora/stone.esmaterial';
export const SWARD_MATERIAL = 'assets/flora/sward.esmaterial';
export const MEADOW_MATERIAL = 'assets/flora/meadow.esmaterial';

const times = (range: readonly [number, number], k: number): [number, number] => [range[0] * k, range[1] * k];
/** A part at a world's own size: the plant, what it takes of the ground, and how far it stands from its group's middle. */
const sized = (part: Part, k: number, over: Partial<RecipeMember> = {}): Part => ({
    ...part, ...over,
    footprint: (over.footprint ?? part.footprint) * k,
    ...(part.canopy !== undefined || over.canopy !== undefined ? { canopy: (over.canopy ?? part.canopy!) * k } : {}),
    ...(over.scale ? { scale: times(over.scale as [number, number], k) } : {}),
    ...(over.ring ? { ring: times(over.ring as [number, number], Math.sqrt(k)) } : {}),
});

/**
 * The rules of one world. Its trees are `spec.size` times the size they were grown at (a wood has to read as a wood from a frigate
 * two hundred metres long, and a world is told from another by how large its growth is before anything else), stand as thick
 * as `spec.lush` says, and are of the kinds `spec.trees` weighs; a dry or frozen world keeps its growth to where it is wet or low.
 */
export function floraRules(id: string, spec: PlanetSpec): WorldRules {
    const k = spec.size, lush = spec.lush;
    // The two kinds of tree a world has most of, and how much of the third there is.
    const kinds = ([['oak', OAK], ['birch', BIRCH], ['pine', PINE]] as const).map(([name, part]) => ({ part, weight: spec.trees[name] })).sort((a, b) => b.weight - a.weight);
    const main = kinds[0]!.part, second = kinds[1]!.part, rare = kinds[2]!.part;
    const more = (n: readonly [number, number], share: number): [number, number] => [Math.round(n[0] * share), Math.max(1, Math.round(n[1] * share))];
    const recipes: Recipe[] = [
        {
            // The wood: one tree and its neighbours, placed so close to the next that the crowns meet. A forest is this over and
            // over, broken only where the ground is too steep or too dry for it.
            id: 'forest', version: 1, tags: ['tree'],
            anchor: { id: 'tree', ...sized(main, k, { scale: [0.9, 1.7], footprint: 1.6, canopy: 3 }) },
            members: [
                { id: 'main', ...sized(main, k, { count: [1, 3], ring: [7, 20], scale: [0.7, 1.5], footprint: 1.4, canopy: 3 }) },
                { id: 'second', ...sized(second, k, { count: [0, 2], ring: [6, 22], scale: [0.7, 1.3], footprint: 1.2, canopy: 2 }) },
                { id: 'young', ...sized(second, k, { count: [0, 2], ring: [4, 18], scale: [0.3, 0.6], footprint: 0.8, canopy: 1, chance: 0.6 }) },
                { id: 'brush', ...sized(BUSH, k, { count: [0, 2], ring: [3, 18], scale: [0.7, 1.5], footprint: 0.8, canopy: 1 }) },
            ],
        },
        {
            // The same on high ground, of the tree that grows there, a little thinner.
            id: 'high forest', version: 1, tags: ['tree'],
            anchor: { id: 'tree', ...sized(rare, k, { scale: [0.9, 1.6], footprint: 1.6, canopy: 3 }) },
            members: [
                { id: 'more', ...sized(rare, k, { count: [1, 2], ring: [7, 20], scale: [0.6, 1.4], footprint: 1.4, canopy: 3 }) },
                { id: 'young', ...sized(rare, k, { count: [0, 2], ring: [4, 18], scale: [0.3, 0.6], footprint: 0.8, canopy: 1, chance: 0.6 }) },
            ],
        },
        {
            id: 'grove', version: 3, tags: ['tree'],
            anchor: { id: 'elder', ...sized(main, k, { scale: [1.7, 2.4], footprint: 3.4, canopy: 11 }) },
            members: [
                { id: 'main', ...sized(main, k, { count: more([11, 18], 0.4 + 0.6 * lush), ring: [8, 66], scale: [0.9, 1.6] }) },
                { id: 'second', ...sized(second, k, { count: more([4, 8], lush), ring: [10, 72], scale: [0.8, 1.3] }) },
                { id: 'young', ...sized(second, k, { count: [2, 5], ring: [50, 84], scale: [0.45, 0.75], chance: 0.8 }) },
                { id: 'brush', ...sized(BUSH, k, { count: more([5, 10], lush), ring: [10, 84], scale: [0.9, 1.9] }) },
                { id: 'stone', ...sized(ROCK, k, { count: [0, 2], ring: [8, 40], scale: [0.7, 1.6] }) },
            ],
        },
        {
            id: 'copse', version: 3, tags: ['tree'],
            anchor: { id: 'tree', ...sized(main, k, { scale: [1.1, 1.6] }) },
            members: [
                { id: 'tree', ...sized(second, k, { count: [1, 4], ring: [8, 30], scale: [0.7, 1.2] }) },
                { id: 'brush', ...sized(BUSH, k, { count: [2, 5], ring: [6, 40], scale: [0.8, 1.5] }) },
            ],
        },
        {
            id: 'high wood', version: 3, tags: ['tree'],
            anchor: { id: 'elder', ...sized(rare, k, { scale: [1.4, 1.9], footprint: 2.8 }) },
            members: [
                { id: 'tree', ...sized(rare, k, { count: more([9, 16], 0.4 + 0.6 * lush), ring: [7, 62], scale: [0.9, 1.5] }) },
                { id: 'young', ...sized(rare, k, { count: [2, 5], ring: [40, 80], scale: [0.4, 0.7], chance: 0.8 }) },
                { id: 'stone', ...sized(ROCK, k, { count: [0, 3], ring: [8, 50], scale: [0.8, 2.2] }) },
            ],
        },
        {
            // A giant alone: a world's largest tree, several times the rest, standing where nothing else is as tall.
            id: 'giant', version: 1, tags: ['tree'],
            anchor: { id: 'giant', ...sized(main, k, { scale: [3.2, 4.6], footprint: 7, canopy: 22 }) },
            members: [{ id: 'brush', ...sized(BUSH, k, { count: [3, 7], ring: [10, 44], scale: [1, 2] }) }],
        },
        {
            id: 'outcrop', version: 2, tags: ['rock'],
            anchor: { id: 'boulder', ...sized(ROCK, spec.stone, { scale: [3, 5.5], footprint: 9 }) },
            members: [
                { id: 'rock', ...sized(ROCK, spec.stone, { count: [2, 5], ring: [8, 30], scale: [1.2, 2.6], footprint: 5 }) },
                { id: 'scree', ...sized(ROCK, spec.stone, { count: [3, 8], ring: [14, 46], scale: [0.4, 0.9] }) },
            ],
        },
        {
            // Standing stones: tall, close, a landmark from the air on a world that grows little.
            id: 'spires', version: 1, tags: ['rock'],
            anchor: { id: 'spire', ...sized(ROCK, spec.stone, { scale: [5, 9], footprint: 10, attach: 'upright' }) },
            members: [{ id: 'more', ...sized(ROCK, spec.stone, { count: [2, 6], ring: [10, 40], scale: [2, 6], footprint: 6, attach: 'upright' }) }],
        },
        { id: 'lone tree', version: 3, tags: ['tree'], anchor: { id: 'tree', ...sized(main, k, { scale: [0.8, 1.5] }) } },
        { id: 'lone high tree', version: 3, tags: ['tree'], anchor: { id: 'tree', ...sized(rare, k, { scale: [0.7, 1.4] }) } },
        {
            id: 'thicket', version: 3, tags: ['brush'],
            anchor: { id: 'bush', ...sized(BUSH, k, { scale: [0.9, 1.7] }) },
            members: [{ id: 'more', ...sized(BUSH, k, { count: [0, 3], ring: [3, 10], scale: [0.6, 1.3] }) }],
        },
        {
            // Tall grass in clumps on open ground: the brush's leaves, small, many to a patch.
            id: 'tussock', version: 2, tags: ['grass'],
            anchor: { id: 'tuft', ...GRASS, scale: [0.35, 0.7] },
            members: [{ id: 'more', ...GRASS, count: [4, 9], ring: [1.2, 10], scale: [0.25, 0.6] }],
        },
        { id: 'stones', version: 2, tags: ['rock'], anchor: { id: 'stone', ...sized(ROCK, spec.stone, { scale: [0.6, 1.8] }) } },
        {
            // Long grass: patches of it overlapping, so open ground is rough with it and not a lawn.
            id: 'sward', version: 1, tags: ['grass'],
            anchor: { id: 'patch', ...SWARD, scale: [12, 22] },
            members: [{ id: 'more', ...SWARD, count: [3, 7], ring: [6, 26], scale: [8, 18] }],
        },
        {
            // A drift of flowers: patches of bloom close together, a field of them where a few drifts meet.
            id: 'flowers', version: 1, tags: ['grass'],
            anchor: { id: 'drift', ...MEADOW, scale: [14, 26] },
            members: [{ id: 'more', ...MEADOW, count: [6, 14], ring: [8, 60], scale: [10, 26] }],
        },
    ];

    // Where things grow: above the sea, below the tree line, and (a world that is not wet all over) where its moisture says.
    const dryLand = { field: 'height', min: spec.sea ? 10 : -100000, blend: 8 } as const;
    const wet = spec.wet;
    const biomes: BiomeDef[] = [];
    if (lush > 0.02) {
        biomes.push({
            id: 'woodland', transition: 240,
            conditions: [dryLand, { field: 'height', max: spec.treeLine, blend: 90 }, { field: 'moisture', min: 1 - wet, blend: 0.07 }, { field: 'up', min: 0.84, blend: 0.05 }],
            recipes: [
                { recipe: 'giant', layer: 'stands', density: 0.05 + 0.07 * lush },
                { recipe: 'forest', layer: 'forest', density: 0.55 + 0.4 * lush },
                { recipe: 'thicket', layer: 'scatter', density: 0.2 * lush },
                { recipe: 'stones', layer: 'scatter', density: 0.03 },
                { recipe: 'tussock', layer: 'grass', density: 0.3 * lush },
                { recipe: 'sward', layer: 'cover', density: 0.35 * lush },
                { recipe: 'flowers', layer: 'cover', density: 0.15 * spec.flowers },
            ],
        });
        biomes.push({
            id: 'highland', transition: 200,
            conditions: [{ field: 'height', min: spec.treeLine, max: spec.treeLine + 630, blend: 90 }, { field: 'up', min: 0.76, blend: 0.06 }],
            recipes: [
                { recipe: 'high forest', layer: 'forest', density: 0.2 + 0.5 * lush },
                { recipe: 'lone high tree', layer: 'scatter', density: 0.1 * lush },
                { recipe: 'stones', layer: 'scatter', density: 0.14 },
                { recipe: 'thicket', layer: 'scatter', density: 0.08 * lush },
                { recipe: 'tussock', layer: 'grass', density: 0.28 * lush },
                { recipe: 'sward', layer: 'cover', density: 0.4 * lush },
                { recipe: 'flowers', layer: 'cover', density: 0.35 * spec.flowers },
            ],
        });
    }
    biomes.push({
        id: 'open', transition: 240,
        conditions: [dryLand, { field: 'height', max: spec.treeLine + 40, blend: 90 }, { field: 'moisture', max: 1 - wet, blend: 0.07 }, { field: 'up', min: 0.8, blend: 0.06 }],
        recipes: [
            { recipe: 'grove', layer: 'stands', density: 0.22 * lush },
            { recipe: 'copse', layer: 'stands', density: 0.3 * lush },
            { recipe: 'giant', layer: 'stands', density: 0.03 * lush },
            { recipe: 'outcrop', layer: 'stands', density: 0.05 + 0.25 * spec.rocky },
            { recipe: 'spires', layer: 'stands', density: 0.12 * spec.rocky },
            { recipe: 'lone tree', layer: 'scatter', density: 0.1 * lush },
            { recipe: 'thicket', layer: 'scatter', density: 0.34 * lush },
            { recipe: 'tussock', layer: 'grass', density: 0.75 * lush },
            { recipe: 'sward', layer: 'cover', density: 0.5 + 0.4 * lush },
            { recipe: 'flowers', layer: 'cover', density: 0.8 * spec.flowers },
            { recipe: 'stones', layer: 'scatter', density: 0.06 + 0.2 * spec.rocky },
        ],
    });
    biomes.push({
        id: 'crag', transition: 120,
        conditions: [dryLand, { field: 'up', max: 0.8, blend: 0.06 }],
        recipes: [{ recipe: 'outcrop', layer: 'stands', density: 0.5 }, { recipe: 'stones', layer: 'scatter', density: 0.2 }, { recipe: 'tussock', layer: 'grass', density: 0.12 * lush }],
    });
    if (spec.sea) {
        biomes.push({
            id: 'shore', transition: 60,
            conditions: [{ field: 'height', min: 1.5, max: 10, blend: 3 }],
            recipes: [{ recipe: 'stones', layer: 'scatter', density: 0.1 }, { recipe: 'tussock', layer: 'grass', density: 0.22 * lush }],
        });
    }
    return {
        id,
        versions: [1],
        noise: { moisture: { scale: 3200, octaves: 4 }, temperature: { scale: 9000, octaves: 3 }, rock: { scale: 1100, octaves: 4 } },
        biomes,
        recipes,
        plants: plantsFor(k),
        // What stands alone or leads a group is placed first (a giant, a grove, an outcrop); the forest fills in round it, close;
        // then what is scattered between, and tall grass, which keeps clear of nothing and nothing of it. A layer is laid out as
        // far as its plants are drawn tree by tree; their cards beyond that are a layer the engine keeps of its own.
        layers: [
            { id: 'stands', spacing: 150 * Math.sqrt(k), drawDistance: REACH, chunkSize: 750 },
            { id: 'forest', spacing: 30 * Math.sqrt(k), drawDistance: REACH, chunkSize: 500 },
            { id: 'scatter', spacing: 30 * Math.sqrt(k), drawDistance: 900, chunkSize: 450 },
            { id: 'grass', spacing: 12, drawDistance: 420, chunkSize: 210, occupies: false },
            // Grass and flowers in patches: seen further than a clump of grass, since a patch is tens of units across.
            { id: 'cover', spacing: 20, drawDistance: 900, chunkSize: 450, occupies: false },
        ],
    };
}

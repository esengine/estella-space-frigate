import type { BiomeDef, Recipe, RecipeMember, WorldRules } from 'esengine/worldgen';
import type { PlanetSpec } from './planetSpec';

// What grows on a world's ground: rules the engine lays out over the planet as she flies, the same from the same seed every time,
// and made for each world from what that world is (src/planetSpec.ts): how much grows, how large, which trees, what stone.
// A unit is about two metres. The trees are grown by the engine's tree step and made ready for a wood by tools/flora-meshes.mjs:
// one mesh, one picture in the tree's colours, and the foliage material. A wood is drawn merged, a square of ground at a time;
// past its layer's `lodDistance` a tree is a tent of two cards showing the sprig of leaves in its picture.
const SPRIG = { u0: 0.16, v0: 0.08, u1: 0.84, v1: 0.76, tent: true } as const;
type Part = Omit<RecipeMember, 'id'>;
const tree = (name: string, footprint: number, canopy: number, minUp: number): Part =>
    ({ mesh: `assets/flora/${name}.esmesh`, material: `assets/flora/${name}.esmaterial`, footprint, canopy, minUp, far: SPRIG });
const OAK = tree('oak', 2.4, 7, 0.84);
const BIRCH = tree('birch', 1.6, 4, 0.84);
const PINE = tree('pine', 2, 4, 0.78);
const BUSH = tree('bush', 1.6, 2, 0.72);
const ROCK: Part = { mesh: 'assets/flora/stone.esmesh', material: 'assets/flora/stone.esmaterial', footprint: 2.5, attach: 'align', tags: ['rock'] };

/** The materials what grows is drawn with: a world tints them its own colour (main.ts). */
export const FLORA_MATERIALS = ['oak', 'birch', 'pine', 'bush'].map((name) => `assets/flora/${name}.esmaterial`);
export const STONE_MATERIAL = 'assets/flora/stone.esmaterial';

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
            anchor: { id: 'tuft', ...BUSH, footprint: 0.5, canopy: 0, scale: [0.3, 0.55] },
            members: [{ id: 'more', ...BUSH, footprint: 0.4, canopy: 0, count: [3, 7], ring: [1.2, 9], scale: [0.2, 0.5] }],
        },
        { id: 'stones', version: 2, tags: ['rock'], anchor: { id: 'stone', ...sized(ROCK, spec.stone, { scale: [0.6, 1.8] }) } },
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
                { recipe: 'grove', layer: 'stands', density: 0.3 + 0.6 * lush },
                { recipe: 'giant', layer: 'stands', density: 0.04 + 0.06 * lush },
                { recipe: 'lone tree', layer: 'scatter', density: 0.16 * lush },
                { recipe: 'thicket', layer: 'scatter', density: 0.36 * lush },
                { recipe: 'stones', layer: 'scatter', density: 0.03 },
                { recipe: 'tussock', layer: 'grass', density: 0.3 * lush },
            ],
        });
        biomes.push({
            id: 'highland', transition: 200,
            conditions: [{ field: 'height', min: spec.treeLine, max: spec.treeLine + 630, blend: 90 }, { field: 'up', min: 0.76, blend: 0.06 }],
            recipes: [
                { recipe: 'high wood', layer: 'stands', density: 0.5 * lush },
                { recipe: 'lone high tree', layer: 'scatter', density: 0.1 * lush },
                { recipe: 'stones', layer: 'scatter', density: 0.14 },
                { recipe: 'thicket', layer: 'scatter', density: 0.08 * lush },
                { recipe: 'tussock', layer: 'grass', density: 0.28 * lush },
            ],
        });
    }
    biomes.push({
        id: 'open', transition: 240,
        conditions: [dryLand, { field: 'height', max: spec.treeLine + 40, blend: 90 }, { field: 'moisture', max: 1 - wet, blend: 0.07 }, { field: 'up', min: 0.8, blend: 0.06 }],
        recipes: [
            { recipe: 'copse', layer: 'stands', density: 0.26 * lush },
            { recipe: 'giant', layer: 'stands', density: 0.03 * lush },
            { recipe: 'outcrop', layer: 'stands', density: 0.05 + 0.25 * spec.rocky },
            { recipe: 'spires', layer: 'stands', density: 0.12 * spec.rocky },
            { recipe: 'lone tree', layer: 'scatter', density: 0.07 * lush },
            { recipe: 'thicket', layer: 'scatter', density: 0.2 * lush },
            { recipe: 'tussock', layer: 'grass', density: 0.6 * lush },
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
        // Stands of trees are placed first and seen from far; what is scattered between them is small and drawn only near, and
        // tall grass nearer still (it keeps clear of nothing and nothing of it). A larger growth stands further apart.
        layers: [
            { id: 'stands', spacing: 120 * Math.sqrt(k), drawDistance: 3200, lodDistance: 650 * Math.sqrt(k), chunkSize: 1000 },
            { id: 'scatter', spacing: 34 * Math.sqrt(k), drawDistance: 800, lodDistance: 400 * Math.sqrt(k), chunkSize: 450 },
            { id: 'grass', spacing: 14, drawDistance: 420, chunkSize: 210, occupies: false },
        ],
    };
}

import { registerWorldRules, type RecipeMember, type WorldRules } from 'esengine/worldgen';

// What grows on a world's ground: rules the engine lays out over the planet as she flies, the same from the same seed every time.
// A unit is about two metres, so a broadleaf is some thirty metres tall and a wood is seen as a wood from where she flies.
const STONE = 'assets/flora/stone.esmaterial';

// A tree is a model grown by the engine's tree step (a trunk that forks into limbs, leaves as cut-out tufts on them, bark laid
// along every limb), made ready for a wood by tools/flora-meshes.mjs: one mesh, one picture in the tree's colours, and the
// foliage material. A wood is drawn merged, a square of ground at a time; past its layer's `lodDistance` a tree is a tent of two
// cards showing the sprig of leaves in its picture.
const SPRIG = { u0: 0.16, v0: 0.08, u1: 0.84, v1: 0.76, tent: true } as const;
type Part = Omit<RecipeMember, 'id'>;
const tree = (name: string, footprint: number, canopy: number, minUp: number): Part =>
    ({ mesh: `assets/flora/${name}.esmesh`, material: `assets/flora/${name}.esmaterial`, footprint, canopy, minUp, far: SPRIG });
const OAK = tree('oak', 2.4, 7, 0.84);
const BIRCH = tree('birch', 1.6, 4, 0.84);
const PINE = tree('pine', 2, 4, 0.78);
const BUSH = tree('bush', 1.6, 2, 0.72);
const ROCK: Part = { mesh: 'assets/flora/stone.esmesh', material: STONE, footprint: 2.5, attach: 'align', tags: ['rock'] };

export const TERRAN_FLORA = 'space-frigate:terran';

// The ground of a terran world (src/planetGround.ts): the sea is at 0, coast and plain to a few hundred, ranges to two thousand.
const DRY_LAND = { field: 'height', min: 10, blend: 8 } as const;
const terran: WorldRules = {
    id: TERRAN_FLORA,
    versions: [1],
    noise: { moisture: { scale: 3200, octaves: 4 }, temperature: { scale: 9000, octaves: 3 }, rock: { scale: 1100, octaves: 4 } },
    biomes: [
        {
            id: 'woodland', transition: 240,
            conditions: [DRY_LAND, { field: 'height', max: 520, blend: 90 }, { field: 'moisture', min: 0.5, blend: 0.07 }, { field: 'up', min: 0.84, blend: 0.05 }],
            recipes: [
                { recipe: 'grove', layer: 'stands', density: 0.85 },
                { recipe: 'lone broadleaf', layer: 'scatter', density: 0.16 },
                { recipe: 'thicket', layer: 'scatter', density: 0.2 },
            ],
        },
        {
            id: 'grassland', transition: 240,
            conditions: [DRY_LAND, { field: 'height', max: 560, blend: 90 }, { field: 'moisture', max: 0.5, blend: 0.07 }, { field: 'up', min: 0.8, blend: 0.06 }],
            recipes: [
                { recipe: 'copse', layer: 'stands', density: 0.1 },
                { recipe: 'lone broadleaf', layer: 'scatter', density: 0.025 },
                { recipe: 'thicket', layer: 'scatter', density: 0.07 },
                { recipe: 'tussock', layer: 'scatter', density: 0.34 },
                { recipe: 'stones', layer: 'scatter', density: 0.02 },
            ],
        },
        {
            id: 'highland', transition: 200,
            conditions: [{ field: 'height', min: 520, max: 1150, blend: 90 }, { field: 'up', min: 0.76, blend: 0.06 }],
            recipes: [
                { recipe: 'pinewood', layer: 'stands', density: 0.5 },
                { recipe: 'lone conifer', layer: 'scatter', density: 0.1 },
                { recipe: 'stones', layer: 'scatter', density: 0.06 },
            ],
        },
        {
            id: 'crag', transition: 120,
            conditions: [DRY_LAND, { field: 'up', max: 0.8, blend: 0.06 }],
            recipes: [{ recipe: 'outcrop', layer: 'stands', density: 0.35 }, { recipe: 'stones', layer: 'scatter', density: 0.08 }],
        },
        {
            id: 'shore', transition: 60,
            conditions: [{ field: 'height', min: 1.5, max: 10, blend: 3 }],
            recipes: [{ recipe: 'stones', layer: 'scatter', density: 0.04 }],
        },
    ],
    recipes: [
        {
            id: 'grove', version: 2, tags: ['tree'],
            anchor: { id: 'elder', ...OAK, scale: [1.5, 2.0], footprint: 3.4, canopy: 11 },
            members: [
                { id: 'oak', ...OAK, count: [7, 12], ring: [8, 66], scale: [0.8, 1.4] },
                { id: 'birch', ...BIRCH, count: [4, 8], ring: [10, 72], scale: [0.8, 1.3] },
                { id: 'young', ...BIRCH, count: [2, 5], ring: [50, 84], scale: [0.45, 0.75], chance: 0.8 },
                { id: 'brush', ...BUSH, count: [5, 10], ring: [10, 84], scale: [0.8, 1.6] },
                { id: 'stone', ...ROCK, count: [0, 2], ring: [8, 40], scale: [0.7, 1.6] },
            ],
        },
        {
            id: 'copse', version: 2, tags: ['tree'],
            anchor: { id: 'tree', ...OAK, scale: [1.1, 1.6] },
            members: [
                { id: 'tree', ...BIRCH, count: [1, 4], ring: [8, 30], scale: [0.7, 1.2] },
                { id: 'brush', ...BUSH, count: [2, 5], ring: [6, 40], scale: [0.8, 1.5] },
            ],
        },
        {
            id: 'pinewood', version: 2, tags: ['tree'],
            anchor: { id: 'elder', ...PINE, scale: [1.4, 1.9], footprint: 2.8 },
            members: [
                { id: 'pine', ...PINE, count: [9, 16], ring: [7, 62], scale: [0.8, 1.4] },
                { id: 'young', ...PINE, count: [2, 5], ring: [40, 80], scale: [0.4, 0.7], chance: 0.8 },
                { id: 'stone', ...ROCK, count: [0, 3], ring: [8, 50], scale: [0.8, 2.2] },
            ],
        },
        {
            id: 'outcrop', version: 1, tags: ['rock'],
            anchor: { id: 'boulder', ...ROCK, scale: [3, 5.5], footprint: 9 },
            members: [
                { id: 'rock', ...ROCK, count: [2, 5], ring: [8, 30], scale: [1.2, 2.6], footprint: 5 },
                { id: 'scree', ...ROCK, count: [3, 8], ring: [14, 46], scale: [0.4, 0.9] },
            ],
        },
        { id: 'lone broadleaf', version: 2, tags: ['tree'], anchor: { id: 'tree', ...OAK, scale: [0.8, 1.5] } },
        { id: 'lone conifer', version: 2, tags: ['tree'], anchor: { id: 'pine', ...PINE, scale: [0.7, 1.4] } },
        {
            id: 'thicket', version: 2, tags: ['brush'],
            anchor: { id: 'bush', ...BUSH, scale: [0.9, 1.7] },
            members: [{ id: 'more', ...BUSH, count: [0, 3], ring: [3, 10], scale: [0.6, 1.3] }],
        },
        {
            // Tall grass in clumps on open ground: the brush's leaves, small, many to a patch.
            id: 'tussock', version: 1, tags: ['grass'],
            anchor: { id: 'tuft', ...BUSH, footprint: 0.5, canopy: 0, scale: [0.22, 0.4] },
            members: [{ id: 'more', ...BUSH, footprint: 0.4, canopy: 0, count: [5, 11], ring: [1.5, 14], scale: [0.16, 0.36] }],
        },
        { id: 'stones', version: 1, tags: ['rock'], anchor: { id: 'stone', ...ROCK, scale: [0.6, 1.8] } },
    ],
    // Stands of trees are placed first and seen from far; what is scattered between them is small and drawn only near.
    layers: [
        { id: 'stands', spacing: 120, drawDistance: 3200, lodDistance: 650, chunkSize: 800 },
        { id: 'scatter', spacing: 34, drawDistance: 800, lodDistance: 400, chunkSize: 400 },
    ],
};

/** The rules a world's ground is grown by, or '' for one where nothing grows. */
export function floraFor(world: string): string {
    return world === 'terran' ? TERRAN_FLORA : '';
}

let registered = false;
export function registerFlora(): void {
    if (registered) return;
    registered = true;
    registerWorldRules(terran);
}

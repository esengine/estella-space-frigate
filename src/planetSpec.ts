import type { Color } from 'esengine';
import type { Ground } from './grounds';
import { groundRange, groundSample } from './planetGround';
import { randomFrom, type Kind, type StarSystem, type Vec } from './worlds';

// What one world is, said once and read by everything that shows it: how its ground is seen from space, where she comes down on
// it, and what grows there. A world is made from the voyage's seed like the rest of its system; nothing of it is chosen when she
// arrives, so the planet she saw from orbit is the planet she lands on.

export interface PlanetSpec {
    /** Whether it has a sea (a lava world's is molten). */
    sea: boolean;
    /** How much grows, 0 (bare rock) to 1 (wooded wherever it can be). */
    lush: number;
    /** How much of the land is wet enough for woods, 0 to 1: the rest is open ground. */
    wet: number;
    /** How many times the size they were grown at its plants are. */
    size: number;
    /** How far up its woods go before the trees of high ground take over, in units above the sea. */
    treeLine: number;
    /** How much of each kind of tree: the two it has most of make its woods, the third its high ground. */
    trees: { oak: number; birch: number; pine: number };
    /** How much bare stone lies about, 0 to 1, and how many times its grown size the stone is. */
    rocky: number;
    stone: number;
    /** What its leaves and its stone are multiplied by: its growth in its own colour and not every world's in one green. */
    leaf: Color;
    rock: Color;
    /** The colour its grass is (its plains', lifted: grass stands in the light) and the colour its flowers are. */
    grass: Color;
    bloom: Color;
    /** How much of its open ground is in flower, 0 to 1. */
    flowers: number;
}

const rgb = (r: number, g: number, b: number): Color => ({ r, g, b, a: 1 });
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function toHsl(c: { r: number; g: number; b: number }): [number, number, number] {
    const hi = Math.max(c.r, c.g, c.b), lo = Math.min(c.r, c.g, c.b), l = (hi + lo) / 2, d = hi - lo;
    if (d < 1e-6) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1) || 1);
    const h = hi === c.r ? ((c.g - c.b) / d + 6) % 6 : hi === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
    return [h / 6, clamp(s, 0, 1), l];
}

function fromHsl(h: number, s: number, l: number): Color {
    const k = (n: number): number => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return rgb(f(0), f(8), f(4));
}

// What the leaves and the stone were grown in (tools/flora-meshes.mjs, tools/make-flora.mjs): a tint is what takes that to a world's colour.
const LEAF_GROWN = rgb(0.16, 0.33, 0.09);

// Each kind of world, as ranges a world of that kind is drawn from: [least, most].
type Span = readonly [number, number];
interface Climate { sea: boolean; lush: Span; wet: Span; size: Span; treeLine: Span; rocky: Span; stone: Span; pines: number }
const CLIMATES: Partial<Record<Kind, Climate>> = {
    2: { sea: false, lush: [0.05, 0.3], wet: [0.12, 0.3], size: [1.3, 2.4], treeLine: [700, 900], rocky: [0.6, 1], stone: [1.8, 3.2], pines: 0.2 },
    3: { sea: true, lush: [0, 0], wet: [0, 0], size: [1, 1], treeLine: [400, 400], rocky: [0.8, 1], stone: [1.8, 3.2], pines: 0 },
    4: { sea: true, lush: [0.5, 0.9], wet: [0.5, 0.75], size: [1.6, 3], treeLine: [300, 450], rocky: [0.2, 0.5], stone: [1, 1.8], pines: 0.2 },
    5: { sea: false, lush: [0, 0.22], wet: [0.15, 0.3], size: [1.4, 2.4], treeLine: [150, 300], rocky: [0.4, 0.8], stone: [1.4, 2.6], pines: 1 },
    6: { sea: true, lush: [0.55, 1], wet: [0.35, 0.65], size: [1.8, 3.4], treeLine: [420, 620], rocky: [0.1, 0.4], stone: [1, 1.6], pines: 0.4 },
};

const made = new WeakMap<StarSystem, PlanetSpec | null>();

/** What the system's world is, or null for one with no ground to stand on. The same system gives the same answer always. */
export function specFor(system: StarSystem, ground: Ground | null): PlanetSpec | null {
    const known = made.get(system);
    if (known !== undefined) return known;
    const climate = CLIMATES[system.surface.kind];
    let spec: PlanetSpec | null = null;
    if (climate && ground) {
        // A stream of its own, from what names the world: what the system was drawn from stays as it was.
        let seed = 0x51ed270b;
        for (const ch of `spec:${system.body}:${system.index}:${system.surface.seed.x}:${system.surface.seed.z}`) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0;
        const rand = randomFrom(seed);
        const within = (s: Span): number => s[0] + (s[1] - s[0]) * rand();
        const pine = clamp(climate.pines * (0.6 + 0.8 * rand()), 0, 1.4);
        // Its leaves take after its ground (the colour its plains are), turned a little round the wheel and deepened: a world of ochre
        // plains has rust-coloured woods, not the green of another world.
        const [h, s, l] = toHsl(ground.colors[0]);
        const leaf = fromHsl((h + (rand() - 0.5) * 0.16 + 1) % 1, clamp(s * 1.25 + 0.15, 0.25, 0.9), clamp(l * 0.62, 0.1, 0.34));
        const stone = ground.colors[3];
        const plain = ground.colors[0];
        // Its flowers are a colour of their own, well away from its leaves' round the wheel, and bright.
        const bloom = fromHsl((h + 0.33 + rand() * 0.34) % 1, 0.55 + 0.35 * rand(), 0.55 + 0.15 * rand());
        spec = {
            sea: climate.sea && ground.sea !== null,
            lush: within(climate.lush), wet: within(climate.wet), size: within(climate.size), treeLine: within(climate.treeLine),
            trees: { oak: rand(), birch: rand(), pine },
            rocky: within(climate.rocky), stone: within(climate.stone),
            leaf: rgb(clamp(leaf.r / LEAF_GROWN.r, 0.15, 5), clamp(leaf.g / LEAF_GROWN.g, 0.15, 5), clamp(leaf.b / LEAF_GROWN.b, 0.15, 5)),
            rock: rgb(clamp(stone.r * 2.4, 0.2, 2.5), clamp(stone.g * 2.4, 0.2, 2.5), clamp(stone.b * 2.4, 0.2, 2.5)),
            grass: rgb(clamp(plain.r * 1.5 + 0.02, 0, 1.6), clamp(plain.g * 1.5 + 0.02, 0, 1.6), clamp(plain.b * 1.5 + 0.02, 0, 1.6)),
            bloom: rgb(bloom.r * 1.3, bloom.g * 1.3, bloom.b * 1.3),
            flowers: climate.lush[1] > 0 ? 0.3 + 0.7 * rand() : 0,
        };
    }
    made.set(system, spec);
    return spec;
}

// ── the world as a map ─────────────────────────────────────────────────────────────────────────────────────────────────
// What the ground is, all round the planet, as a picture the planet seen from space is drawn from: so its coasts, its plains and
// its ranges are the ground's own, worked out by the one function that makes the ground under her. Its columns go round the
// planet and its rows from pole to pole; a texel holds how the ground is painted there (its first three layers; the fourth is the
// rest) and how high it stands.
export const WORLD_MAP = { width: 384, height: 192 } as const;

/** How high the sea stands in the map's own measure of height (0 to 1 over the ground's whole range). */
export const mapSeaLevel = (world: string): number => { const [lo, hi] = groundRange(world); return (0 - lo) / (hi - lo); };

/** Works the map out a few rows at a time, so a frame is not held up by it: `step` answers the pixels once the last row is done. */
export function worldMapMaker(ground: Ground): { step: (budgetMs: number) => Uint8Array | null } {
    const { width, height } = WORLD_MAP;
    const pixels = new Uint8Array(width * height * 4), directions = new Float32Array(width * 3);
    const [lo, hi] = groundRange(ground.world);
    let row = 0;
    return {
        step: (budgetMs) => {
            const began = performance.now();
            while (row < height && performance.now() - began < budgetMs) {
                const polar = ((row + 0.5) / height) * Math.PI, ring = Math.sin(polar), y = Math.cos(polar);
                for (let i = 0; i < width; i++) {
                    const round = ((i + 0.5) / width) * Math.PI * 2 - Math.PI;
                    directions[i * 3] = ring * Math.cos(round); directions[i * 3 + 1] = y; directions[i * 3 + 2] = ring * Math.sin(round);
                }
                const got = groundSample({ world: ground.world, seed: ground.seed, radius: ground.radius, directions, count: width });
                for (let i = 0; i < width; i++) {
                    const at = (row * width + i) * 4;
                    pixels[at] = Math.round(got.paint[i * 4]! * 255);
                    pixels[at + 1] = Math.round(got.paint[i * 4 + 1]! * 255);
                    pixels[at + 2] = Math.round(got.paint[i * 4 + 2]! * 255);
                    pixels[at + 3] = Math.round(clamp((got.heights[i]! - lo) / (hi - lo), 0, 1) * 255);
                }
                row++;
            }
            return row >= height ? pixels : null;
        },
    };
}

// ── where she comes down ───────────────────────────────────────────────────────────────────────────────────────────────
const turnBy = (q: { x: number; y: number; z: number; w: number }, v: Vec): Vec => {
    const cx = q.y * v.z - q.z * v.y, cy = q.z * v.x - q.x * v.z, cz = q.x * v.y - q.y * v.x;
    const ex = q.y * cz - q.z * cy, ey = q.z * cx - q.x * cz, ez = q.x * cy - q.y * cx;
    return { x: v.x + 2 * (q.w * cx + ex), y: v.y + 2 * (q.w * cy + ey), z: v.z + 2 * (q.w * cz + ez) };
};

/**
 * The turn that puts the place she came in over on top of the ground: `toShip` is the way from the planet's middle to her, and
 * `tilt` how the planet is turned in space. The ground is made with her under its top, so the top has to be that place. Answered
 * as the text a ground's name carries after its `@` (src/planetGround.ts).
 */
export function siteTurn(tilt: { x: number; y: number; z: number; w: number }, toShip: Vec): string {
    const d = Math.hypot(toShip.x, toShip.y, toShip.z) || 1;
    // The place, in the planet's own frame: the way to her, with the planet's turn taken off.
    const place = turnBy({ x: -tilt.x, y: -tilt.y, z: -tilt.z, w: tilt.w }, { x: toShip.x / d, y: toShip.y / d, z: toShip.z / d });
    // The shortest turn from straight up to it.
    let q = { x: place.z, y: 0, z: -place.x, w: 1 + place.y };
    const n = Math.hypot(q.x, q.y, q.z, q.w);
    q = n < 1e-6 ? { x: 1, y: 0, z: 0, w: 0 } : { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
    return [q.x, q.y, q.z, q.w].map((v) => v.toFixed(6)).join(',');
}

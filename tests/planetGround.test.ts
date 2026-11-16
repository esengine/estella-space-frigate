import { GROUND_ID, GROUND_VERSION, groundRange, groundSample, groundWorkerSource } from '../src/planetGround';

const around = (n: number): Float32Array => {
    const dirs = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * 2.399963;
        dirs.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
    }
    return dirs;
};

describe.each(['desert', 'lava', 'ocean'])('the ground of %s', (world) => {
    const region = { world, seed: 7, radius: 50000, directions: around(4000), count: 4000 };

    it('stays inside the range the GPU encodes it over, and is not flat', () => {
        const { heights } = groundSample(region);
        const [lo, hi] = groundRange(world);
        let least = Infinity, most = -Infinity;
        for (const h of heights) { least = Math.min(least, h); most = Math.max(most, h); }
        expect(least).toBeGreaterThan(lo);
        expect(most).toBeLessThan(hi);
        expect(most - least).toBeGreaterThan(900);
    });

    it('paints every sample with weights that add to one', () => {
        const { paint } = groundSample(region);
        for (let i = 0; i < region.count; i++) {
            const sum = paint[i * 4]! + paint[i * 4 + 1]! + paint[i * 4 + 2]! + paint[i * 4 + 3]!;
            expect(sum).toBeCloseTo(1, 5);
        }
    });

    it('is the same ground every time, and a neighbouring point is near in height', () => {
        const a = groundSample(region).heights, b = groundSample(region).heights;
        expect(Array.from(a)).toEqual(Array.from(b));
        const near = new Float32Array([0.6, 0.48, 0.64, 0.6 + 2 / 50000, 0.48, 0.64]);
        const pair = groundSample({ ...region, directions: near, count: 2 }).heights;
        expect(Math.abs(pair[0]! - pair[1]!)).toBeLessThan(8);
    });

    it('is a different ground under another seed', () => {
        const other = groundSample({ ...region, seed: 8 }).heights, mine = groundSample(region).heights;
        expect(Array.from(other)).not.toEqual(Array.from(mine));
    });
});

it('hands a worker a module that makes exactly the ground the game reads', async () => {
    const source = groundWorkerSource();
    const loaded = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
    expect(loaded.id).toBe(GROUND_ID);
    expect(loaded.versions).toEqual([GROUND_VERSION]);
    const region = { world: 'lava', seed: 11, radius: 52000, directions: around(500), count: 500 };
    expect(Array.from(loaded.sample(region).heights)).toEqual(Array.from(groundSample(region).heights));
    expect(Array.from(loaded.sample(region).paint)).toEqual(Array.from(groundSample(region).paint));
});

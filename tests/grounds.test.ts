import { SITE_TRIES, groundFor, heightAt } from '../src/grounds';
import { makeSystem, type Kind, type StarSystem } from '../src/worlds';

const systemsOf = (kind: Kind, wanted: number): { voyage: number; system: StarSystem }[] => {
    const found: { voyage: number; system: StarSystem }[] = [];
    for (let voyage = 1; voyage < 4000 && found.length < wanted; voyage++) {
        for (let index = 0; index < 4 && found.length < wanted; index++) {
            const system = makeSystem(voyage, index);
            if (system.surface.kind === kind) found.push({ voyage, system });
        }
    }
    return found;
};

const WORLDS: Record<number, string> = { 2: 'desert', 3: 'lava', 4: 'ocean', 5: 'frozen', 6: 'terran' };
const SITES: Record<number, [number, number]> = { 2: [200, 1100], 3: [-150, 250], 4: [60, 500], 5: [-100, 600], 6: [80, 700] };

it('gives the giants no ground to land on', () => {
    for (const kind of [0, 1] as const) {
        for (const { system } of systemsOf(kind, 5)) expect(groundFor(system)).toBeNull();
    }
});

describe.each([2, 3, 4, 5, 6] as const)('the ground of a planet of kind %i', (kind) => {
    const made = systemsOf(kind, 12), systems = made.map((each) => each.system);

    it('is made for every planet of the kind, as the world its look belongs to', () => {
        expect(systems.length).toBe(12);
        for (const system of systems) expect(groundFor(system)?.world).toBe(WORLDS[kind]);
    });

    it('is painted in colours a material can take', () => {
        for (const system of systems) {
            const ground = groundFor(system)!;
            for (const c of [...ground.colors, ground.fog, ground.ambient, ...(ground.sea ? [ground.sea] : [])]) {
                for (const v of [c.r, c.g, c.b]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
            }
        }
    });

    it('takes its colours from the planet seen from space, so two planets of the kind are not painted alike', () => {
        const painted = new Set(systems.map((system) => JSON.stringify(groundFor(system)!.colors)));
        expect(painted.size).toBeGreaterThan(systems.length / 2);
    });

    it('is the same ground every time the same system is made', () => {
        for (const { voyage, system } of made.slice(0, 4)) expect(groundFor(makeSystem(voyage, system.index))).toEqual(groundFor(system));
    });

    it('puts her down over the ground the kind is best seen from', () => {
        let inside = 0;
        for (const system of systems) {
            const ground = groundFor(system)!;
            const h = heightAt(ground.world, ground.seed, ground.radius, { x: 0, y: 1, z: 0 });
            if (h >= SITES[kind]![0] && h <= SITES[kind]![1]) inside++;
        }
        expect(SITE_TRIES).toBeGreaterThan(8);
        expect(inside).toBeGreaterThanOrEqual(systems.length - 1);
    });
});

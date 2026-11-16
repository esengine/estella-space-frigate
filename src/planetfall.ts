import { Light, PostProcessVolume, Transform } from 'esengine';
import type { Color, Entity, PostProcessVolumeData, World } from 'esengine';

type PostProcessEffectData = PostProcessVolumeData['effects'][number];
import { Planet, registerPlanetProvider } from 'esengine/terrain';
import { groundFor, heightAt, type Ground } from './grounds';
import { GROUND_ID, GROUND_VERSION, groundRange, groundSample, groundWorkerSource } from './planetGround';
import { lookRotation } from './flight';
import { helm, mulQuat, type Quat, type Vec } from './helm';
import { ship } from './shipState';
import { systemAt } from './worlds';

const rgb = (r: number, g: number, b: number): Color => ({ r, g, b, a: 1 });

export const PLANETFALL = {
    entry: 3.4,
    swap: 2.1,
    exit: 2.4,
    startAbove: 1900,
    floor: 70,
    leaveAbove: 11000,
    unitsPerKm: 550,
    skyLight: 0.42,
    skyReflection: 0.3,
    sunHeight: 0.75,
    descent: -0.16,
    gasFloor: 0.995,
    entryShell: 1.03,
    skim: 1.006,
    surge: 7,
};

export type FallStage = 'space' | 'entry' | 'surface' | 'exit';

export const fall = {
    stage: 'space' as FallStage,
    t: 0,
    cover: 0,
    heat: 0,
    distance: Infinity,
    altitude: Infinity,
    ground: 0,
    landable: false,
    body: '',
    note: '',
    entries: 0,
    centre: { x: 0, y: 0, z: 0 } as Vec,
    target: null as Vec | null,
    planet: null as Vec | null,
    warned: false,
};

let registered = false;
function register(): void {
    if (registered) return;
    registered = true;
    registerPlanetProvider({
        id: GROUND_ID,
        versions: [GROUND_VERSION],
        range: () => groundRange(''),
        workerSource: groundWorkerSource(),
        sample: (region) => groundSample(region),
    });
}

const length = (v: Vec): number => Math.hypot(v.x, v.y, v.z);
const scale = (v: Vec, k: number): Vec => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const smooth = (a: number, b: number, v: number): number => {
    const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
};

export const groundUnder = (ground: Ground, up: Vec): number => heightAt(ground.world, ground.seed, ground.radius, up);

const levelFacing = (yaw: number, pitch: number): Quat =>
    mulQuat({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, { x: -Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) });

export interface PlanetfallHooks {
    parts: (world: World) => Entity[];
    hideSpace: (world: World, hidden: boolean) => void;
}

export function createPlanetfall(hooks: PlanetfallHooks): (world: World, dt: number, drift: number) => void {
    register();
    let surface: Entity | null = null;
    let lens: Record<string, number> | null = null;
    let daylight: { intensity: number; reflectionScale: number; color: Color } | null = null;
    let sunWas: Quat | null = null;
    const ambient = (world: World, ground: Ground | null): void => {
        const sun = world.findEntityByName('Sun');
        if (sun !== null && ground) {
            sunWas ??= { ...world.get(sun, Transform).rotation };
            const way = systemAt(ship.system).sun, flat = Math.hypot(way.x, way.z);
            const across = flat > 1e-3 ? { x: way.x / flat, z: way.z / flat } : { x: 0.6, z: 0.8 };
            const level = Math.cos(PLANETFALL.sunHeight), drop = Math.sin(PLANETFALL.sunHeight);
            world.update(sun, Transform, (t) => { t.rotation = lookRotation([0, 0, 0], [across.x * level, -drop, across.z * level]); });
        } else if (sun !== null && sunWas) {
            const was = sunWas;
            world.update(sun, Transform, (t) => { t.rotation = was; });
            sunWas = null;
        }
        const sky = world.findEntityByName('Sky');
        if (sky === null) return;
        const light = world.get(sky, Light) as { intensity: number; reflectionScale: number; color: Color };
        if (ground) {
            daylight ??= { intensity: light.intensity, reflectionScale: light.reflectionScale, color: { ...light.color } };
            world.insert(sky, Light, { ...light, intensity: PLANETFALL.skyLight, reflectionScale: PLANETFALL.skyReflection, color: ground.ambient });
        } else if (daylight) {
            world.insert(sky, Light, { ...light, ...daylight });
            daylight = null;
        }
    };
    let graded = false;

    const spacePlanet = (world: World): { centre: Vec; radius: number; air: number; entry: number } => {
        const here = systemAt(ship.system);
        const t = world.get(hooks.parts(world)[0]!, Transform);
        return { centre: { ...t.position }, radius: here.radius, air: here.radius * here.air, entry: here.radius * Math.max(here.air, PLANETFALL.entryShell) };
    };

    const moveParts = (world: World, by: Vec): void => {
        for (const part of hooks.parts(world)) world.update(part, Transform, (t) => { t.position = add(t.position, by); });
    };

    const placeParts = (world: World, centre: Vec): void => {
        for (const part of hooks.parts(world)) world.update(part, Transform, (t) => { t.position = { ...centre }; });
    };

    const grade = (world: World, ground: Ground | null, centre: Vec, altitude: number, inAir: number): void => {
        const camera = world.findEntityByName('Camera');
        if (camera === null) return;
        const volume = world.get(camera, PostProcessVolume);
        const on = inAir > 0.001 && ground !== null;
        const atmosphere: PostProcessEffectData = {
            type: 'skyAtmosphere', enabled: on,
            uniforms: {
                u_planetRadius: ground?.radius ?? 0, u_planetX: centre.x, u_planetY: centre.y, u_planetZ: centre.z,
                u_unitsPerKm: PLANETFALL.unitsPerKm, u_altitude: Math.min(Math.max(altitude / PLANETFALL.unitsPerKm, 0), 20),
                u_intensity: 1.15 * inAir, u_haze: ground?.haze ?? 1, u_clouds: ground?.clouds ?? 0.12, u_cloudBase: 2.4, u_cloudThickness: 1.6,
                u_lightScene: 1, u_panorama: 0, u_groundAlbedo: 0.25, u_sunBrightness: 30, u_stars: 0.6, u_followSun: 1,
            },
        };
        const fog: PostProcessEffectData = {
            type: 'heightFog', enabled: on,
            uniforms: {
                u_density: (ground?.fogDensity ?? 0) * inAir, u_heightFalloff: 0.0009, u_baseHeight: 0,
                u_planetRadius: ground?.radius ?? 0, u_planetX: centre.x, u_planetY: centre.y, u_planetZ: centre.z,
                u_startDistance: 400, u_maxOpacity: 0.92, u_followSun: 1, u_inscatter: 0.7, u_skyFog: ground?.skyFog ?? 0.6,
            },
            colors: { u_fogColor: ground?.fog ?? rgb(0.6, 0.7, 0.8) },
        };
        const space = 1 - inAir;
        const effects = volume.effects.filter((e) => e.type !== 'skyAtmosphere' && e.type !== 'heightFog').map((e) => {
            if (e.type === 'nebula') return { ...e, enabled: space > 0.02 };
            if (e.type === 'starfield') return { ...e, enabled: space > 0.02 };
            if (e.type === 'colorGrade') return { ...e, uniforms: { ...e.uniforms, ...flare() } };
            return e;
        });
        world.insert(camera, PostProcessVolume, { ...volume, effects: [atmosphere, fog, ...effects] });
    };

    const flare = (): Record<string, number> => {
        const base = lens ?? {};
        return {
            u_exposure: (base.u_exposure ?? 0) + 2.6 * fall.cover + 0.7 * fall.heat,
            u_temperature: (base.u_temperature ?? 0) + 0.55 * fall.heat,
            u_saturation: (base.u_saturation ?? 1) * (1 - 0.35 * fall.cover),
        };
    };

    const tone = (world: World): void => {
        const camera = world.findEntityByName('Camera');
        if (camera === null) return;
        const volume = world.get(camera, PostProcessVolume);
        lens ??= { ...volume.effects.find((e) => e.type === 'colorGrade')!.uniforms };
        world.insert(camera, PostProcessVolume, { ...volume, effects: volume.effects.map((e) => (e.type === 'colorGrade' ? { ...e, uniforms: { ...e.uniforms, ...flare() } } : e)) });
    };

    const ensureSurface = (world: World, ground: Ground): Entity => {
        if (surface !== null && world.valid(surface)) return surface;
        const e = world.spawn('PlanetSurface');
        world.insert(e, Transform, { position: { ...fall.centre } });
        world.insert(e, Planet, {
            radius: ground.radius, provider: GROUND_ID, world: ground.world, generatorVersion: GROUND_VERSION, seed: ground.seed,
            cellSize: 2, detail: 1.6, layerColor0: ground.colors[0], layerColor1: ground.colors[1], layerColor2: ground.colors[2], layerColor3: ground.colors[3],
            macroScale: 1400, macroVariation: 0.4, collision: false, gravity: 0,
            sea: ground.sea !== null, seaLevel: 0, seaColor: ground.sea ?? rgb(0, 0, 0), seaOpacity: 0.86,
        });
        surface = e;
        return e;
    };

    const dropSurface = (world: World): void => {
        if (surface !== null && world.valid(surface)) world.despawn(surface);
        surface = null;
    };

    return (world, dt, drift) => {
        const here = systemAt(ship.system);
        const ground = groundFor(here);
        fall.landable = ground !== null;
        fall.body = here.body;
        const step = scale(helm.forward, -drift);

        if (fall.stage === 'space' || fall.stage === 'entry') {
            if (ship.jump < 0) moveParts(world, step);
            const p = spacePlanet(world);
            fall.distance = length(p.centre);
            fall.altitude = fall.distance - p.radius;
            fall.target = p.centre;
            fall.planet = ship.away ? null : p.centre;
            if (fall.stage === 'entry' && !ship.away && fall.distance < p.radius * PLANETFALL.skim) {
                moveParts(world, scale(p.centre, (p.radius * PLANETFALL.skim) / fall.distance - 1));
                fall.distance = p.radius * PLANETFALL.skim;
                fall.altitude = fall.distance - p.radius;
            }
            if (fall.stage === 'space' && ship.jump < 0 && fall.distance < (ground ? p.entry : p.air)) {
                if (ground) {
                    fall.stage = 'entry';
                    fall.t = 0;
                    fall.entries++;
                    fall.note = `ATMOSPHERIC ENTRY   ${here.body}`;
                } else if (fall.distance < p.radius / PLANETFALL.gasFloor + (p.air - p.radius) * 0.4) {
                    moveParts(world, scale(p.centre, (p.radius / PLANETFALL.gasFloor + (p.air - p.radius) * 0.4) / fall.distance - 1));
                    if (!fall.warned) fall.note = `${here.body} IS ${here.surface.kind === 1 ? 'AN ICE' : 'A GAS'} GIANT   NO SURFACE TO REACH`;
                    fall.warned = true;
                }
            }
            if (fall.distance > p.air * 1.2) fall.warned = false;
        }

        if (fall.stage === 'entry' && ground) {
            fall.t += dt;
            fall.heat = smooth(0, 1.4, fall.t) * (1 - smooth(PLANETFALL.swap + 0.3, PLANETFALL.entry, fall.t));
            fall.cover = smooth(PLANETFALL.swap - 0.9, PLANETFALL.swap, fall.t) * (1 - smooth(PLANETFALL.swap + 0.15, PLANETFALL.entry, fall.t));
            if (fall.t >= PLANETFALL.swap && !ship.away) {
                ship.away = true;
                fall.planet = null;
                hooks.hideSpace(world, true);
                ambient(world, ground);
                const level = levelFacing(helm.yaw, PLANETFALL.descent);
                helm.level = level;
                helm.frame = level;
                helm.pitchRate = 0;
                helm.rollRate = 0;
                helm.mode = 'manual';
                helm.rudder = 0;
                helm.elevation = 0;
                fall.ground = groundUnder(ground, { x: 0, y: 1, z: 0 });
                fall.centre = { x: 0, y: -(ground.radius + fall.ground + PLANETFALL.startAbove), z: 0 };
                ensureSurface(world, ground);
                fall.note = `${here.body}   ${ground.site}   GROUND MAPPED`;
            }
            if (fall.t >= PLANETFALL.entry) { fall.stage = 'surface'; fall.t = 0; }
        }

        if (ship.away && ground && (fall.stage === 'entry' || fall.stage === 'surface' || fall.stage === 'exit')) {
            fall.centre = add(fall.centre, step);
            const d = length(fall.centre) || 1;
            const up = scale(fall.centre, -1 / d);
            fall.ground = groundUnder(ground, up);
            fall.altitude = d - ground.radius - Math.max(fall.ground, ground.sea ? 0 : -Infinity);
            if (fall.altitude < PLANETFALL.floor) {
                fall.centre = add(fall.centre, scale(up, -(PLANETFALL.floor - fall.altitude)));
                fall.altitude = PLANETFALL.floor;
            }
            fall.distance = d;
            if (surface !== null) world.update(surface, Transform, (t) => { t.position = { ...fall.centre }; });
            const above = length(fall.centre) - ground.radius;
            const inAir = fall.stage === 'exit' && fall.t >= PLANETFALL.exit * 0.5 ? 0 : 1 - smooth(PLANETFALL.leaveAbove * 0.7, PLANETFALL.leaveAbove * 1.1, above);
            grade(world, ground, fall.centre, above, inAir);
            if (fall.stage === 'surface') {
                fall.heat *= Math.exp(-dt * 2);
                if (fall.altitude > PLANETFALL.leaveAbove && helm.forward.x * up.x + helm.forward.y * up.y + helm.forward.z * up.z > 0) {
                    fall.stage = 'exit';
                    fall.t = 0;
                    fall.note = `LEAVING ${here.body}`;
                }
            }
        }

        if (fall.stage === 'exit' && ground) {
            fall.t += dt;
            const half = PLANETFALL.exit * 0.5;
            fall.cover = smooth(0, half, fall.t) * (1 - smooth(half + 0.1, PLANETFALL.exit, fall.t));
            if (fall.t >= half && ship.away) {
                const d = length(fall.centre) || 1;
                const below = scale(fall.centre, 1 / d);
                ship.away = false;
                dropSurface(world);
                hooks.hideSpace(world, false);
                ambient(world, null);
                placeParts(world, scale(below, here.radius * Math.max(here.air, PLANETFALL.entryShell) * 1.25));
                grade(world, null, { x: 0, y: 0, z: 0 }, 0, 0);
            }
            if (fall.t >= PLANETFALL.exit) { fall.stage = 'space'; fall.t = 0; fall.cover = 0; }
        }
        if (fall.stage === 'space') { fall.cover = 0; fall.heat *= Math.exp(-dt * 3); }
        if (!ship.away) {
            const lit = fall.heat > 0.002 || fall.cover > 0.002;
            if (lit || graded) tone(world);
            graded = lit;
        }
        if (ship.away && ground) {
            const d = length(fall.centre) || 1, up = scale(fall.centre, -1 / d);
            const ahead = add(helm.forward, scale(up, -(helm.forward.x * up.x + helm.forward.y * up.y + helm.forward.z * up.z)));
            const level = length(ahead) > 1e-3 ? scale(ahead, 1 / length(ahead)) : { x: 0, y: 0, z: 1 };
            fall.target = add(scale(up, 2000), scale(level, 1000));
            helm.surge = helm.mode === 'planet' && fall.stage === 'surface' ? 1 + (PLANETFALL.surge - 1) * smooth(600, 4000, fall.altitude) : 1;
        } else {
            helm.surge = fall.stage !== 'space' || helm.mode !== 'planet' ? 1 : 1 + (PLANETFALL.surge - 1) * smooth(250, 3500, fall.altitude);
        }
        helm.target = fall.target;
        if (helm.mode === 'planet' && fall.stage === 'exit' && fall.t >= PLANETFALL.exit * 0.5) { helm.mode = 'manual'; helm.rudder = 0; helm.elevation = 0; }
    };
}

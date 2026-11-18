import { addPlugin, Assets, defineSystem, Particle, Device, GetWorld, Res, Time, Input, Transform, MeshRenderer, Light, Material, ParticleEmitter, Playthrough, Camera, PostProcessVolume } from 'esengine';
import type { Entity, World } from 'esengine';
import { installAudio } from './audio';
import { SHOTS, SHOT_SECONDS, clamp, eyeOf, lookRotation, tourOrbit, type Orbit } from './flight';
import { createGunnery, guns } from './gunnery';
import { helm, mulQuat, turnBack, turnBy, type Quat } from './helm';
import { installHud } from './hud';
import { createImpacts } from './impacts';
import { createRaiders, foes } from './raiders';
import { JUMP, jumpAt, nextSystem } from './jump';
import { ship, TOP_SPEED, FIELD_DRIFT } from './shipState';
import { driveShip } from './shared/steer';
import { installLoading, loading } from './loading';
import { configureOnline, online } from './online';
import { installSky } from './sky';
import { PLANETFALL, createPlanetfall, fall } from './planetfall';
import { DIRECTOR, director, handOver, stepDirector, type Rig } from './director';
import { pendingShaders } from './shaders';
import { graphics } from './hudSettings';
import { KINDS, galaxy, ringSun, systemAt, voyageSeed } from './worlds';
import { readyKind, showKind } from './planetKinds';

const PLUMES = [
    { name: 'PlumeL', width: 4.0, length: 2.3 },
    { name: 'PlumeR', width: 4.0, length: 2.3 },
    { name: 'PlumeNL', width: 3.0, length: 1.7 },
    { name: 'PlumeNR', width: 3.0, length: 1.7 },
] as const;

const GLOWS = ['EngineGlowL', 'EngineGlowR', 'EngineGlowNL', 'EngineGlowNR'] as const;
const GATES = ['GateA', 'GateB'] as const;
const BODY = ['Planet', 'Atmosphere', 'Ring'] as const;
const GATE_RADIUS = 170;
const PLANET_MATERIAL = 'assets/materials/world-planet.esmaterial';
// Dust in the space she sails through, to give her way something to be seen against: sparse, short and dim, a few motes at a time.
// The long lines belong to a jump, which gets them by itself from the speed it runs the field past at.
const DUST = { from: 0.3, full: 1, rate: 150, glow: 1.9 } as const;
const SPEED_WIDEN = 4;
/** The most the air shakes the camera and the hull on the way down to a world: radians, and units. */
const SHAKE = { pitch: 0.011, yaw: 0.008, roll: 0.016, slide: 0.7, hullRoll: 0.035, hullNod: 0.022, hullSlide: 0.45 };
const STROBES = [
    { name: 'StrobeMast', size: 0.55, every: 1.7, flashes: 2 },
    { name: 'StrobeKeel', size: 0.5, every: 1.3, flashes: 1 },
    { name: 'BowPort', size: 0.34, every: 2.3, flashes: 1 },
    { name: 'BowStarboard', size: 0.34, every: 2.3, flashes: 1 },
    { name: 'GateAStrobe', size: 2.6, every: 2.9, flashes: 3 },
    { name: 'GateBStrobe', size: 2.6, every: 2.9, flashes: 3 },
] as const;
const STEADY = ['NavPort', 'NavStarboard'] as const;
// Each thruster: the turn it works at, and the way its gas pushes the hull (a jet on the starboard side blows to starboard and pushes her to port).
const JETS = [
    { name: 'JetBowStarboard', turn: 'yaw', sign: 1, push: 'port' }, { name: 'JetSternPort', turn: 'yaw', sign: 1, push: 'starboard' }, { name: 'JetBowPort', turn: 'yaw', sign: -1, push: 'starboard' }, { name: 'JetSternStarboard', turn: 'yaw', sign: -1, push: 'port' },
    { name: 'JetBowDown', turn: 'pitch', sign: 1, push: 'up' }, { name: 'JetSternUp', turn: 'pitch', sign: 1, push: 'down' }, { name: 'JetBowUp', turn: 'pitch', sign: -1, push: 'down' }, { name: 'JetSternDown', turn: 'pitch', sign: -1, push: 'up' },
    { name: 'JetPortDown', turn: 'roll', sign: 1, push: 'up' }, { name: 'JetStarboardUp', turn: 'roll', sign: 1, push: 'down' }, { name: 'JetPortUp', turn: 'roll', sign: -1, push: 'down' }, { name: 'JetStarboardDown', turn: 'roll', sign: -1, push: 'up' },
] as const;
/** How hard the thrusters are seen to burn at the station's full pace. */
const TUG_BURN = 0.8;
const WAVE_SECONDS = 0.9;
const FOV = 34;
const LOOK = 0.55;
const EXPOSURE = -0.15;
const SIGHT = { height: 15, yaw: Math.PI + 0.45, pitch: 0.02, distance: 100, low: -0.6, high: 0.9 };

function strobe(time: number, every: number, flashes: number): number {
    const phase = (time % every) / 0.16;
    const lit = phase < flashes * 2 - 1 && Math.floor(phase) % 2 === 0;
    return lit ? 1 : 0;
}

addPlugin({
    name: 'space-frigate',
    build(app) {
        const facts = { ready: false, frame: 0, time: 0, throttle: 0, tour: true, shot: 0, eyeX: 0, eyeY: 0, eyeZ: 0, gate: 0, gatePassed: 0, transits: 0, flash: 0, wave: 0, dust: 0, dustAlive: 0, strobe: 0, gunView: false, gunSource: 'stowed', gunBearing: 0, gunReady: 0, gunShots: 0, gunHits: 0, gunRange: 0, gunTrain: '', jets: '', gunAuto: false, gunSpread: 0, gunLead: 0, gunHeld: 0, system: 0, systemName: '', seed: 0, planetKind: '', planetX: 0, planetY: 0, planetZ: 0, planetRadius: 0, sunX: 0, sunY: 0, sunZ: 0, jump: -1, jumps: 0, fov: FOV, planets: '', shield: 1, hull: 1, impacts: 0, gap: 9999, closest: 9999, speed: 0, foes: 0, kills: 0, foeShots: 0, stung: 0, foeBerth: 9999, foeRange: 9999, fall: 'space', altitude: 9999999, cover: 0, shake: 0, heat: 0, camSlide: 0, camTilt: 0, jetsBurning: 0, camX: 0, camY: 0, camZ: 0, gpuMs: 0, gpuDraws: 0, gpuBytes: 0 };
        galaxy.seed = voyageSeed((globalThis as { location?: { search?: string } }).location?.search ?? '', Math.random);
        configureOnline((globalThis as { location?: { search?: string } }).location?.search ?? '');
        if (online.enabled) { helm.fixed = true; foes.peace = true; }
        app.insertResource(Playthrough, { facts });
        installSky();
        installLoading(app, async () => {
            const assets = app.getResource(Assets);
            const { handle } = await assets.loadMaterial(PLANET_MATERIAL);
            showKind(handle, systemAt(ship.system).surface.kind);
            assets.releaseMaterial(handle);
        });
        installHud(app);
        installAudio(app);
        const ids = new Map<string, Entity>();
        let clock = 0;
        let wanted = 0.65;
        let throttle = 0.65;
        let tour = true;
        let hand: Orbit = { ...SHOTS[0] };
        // For a tool that looks at something from where it chooses (tools/probe-flora.mjs): the view by hand, set whole.
        (globalThis as { __spaceView?: (to: Partial<Orbit>) => void }).__spaceView = (to) => { hand = { ...hand, ...to }; tour = false; };
        let grabbed = false;
        let last = { x: 0, y: 0 };
        let ahead = 1;
        let arrivals = -1;
        let gateFacing: Quat = { x: 0, y: 0, z: 0, w: 1 };
        let passedFacing: Quat = { x: 0, y: 0, z: 0, w: 1 };
        let passedSide = 0;
        let flash = 0;
        let since = 60;
        let pace = 0;
        const downs = new Map<string, boolean>();
        const jets = JETS.map(() => 0);
        let sight = 0;
        let swing: { yaw: number; pitch: number } | null = null;
        let leaving = 0;
        let shown = -1;
        let travel = 0;
        let wide = FOV;
        let open = false;
let veiled = false, fallen = 0;
let welcomed = 0;
        const gunnery = createGunnery(app);
        const impacts = createImpacts(app);
        const raiders = createRaiders(app);
        const parked = new Map<Entity, { x: number; y: number; z: number }>();
        const spaceOnly = (world: World): Entity[] => {
            const out: Entity[] = [];
            for (let i = 0; ; i++) { const e = world.findEntityByName(`Rock${i}`); if (e === null) break; out.push(e); }
            return out;
        };
        const planetfall = createPlanetfall({
            parts: (world) => BODY.map((name) => get(world, name)),
            hideSpace: (world, hidden) => {
                const ringed = systemAt(ship.system).ring !== null;
                for (const name of BODY) world.update(get(world, name), MeshRenderer, (m) => { m.enabled = !hidden && (name !== 'Ring' || ringed); });
                for (const e of spaceOnly(world)) {
                    if (hidden) {
                        const at = world.get(e, Transform).position;
                        parked.set(e, { ...at });
                        world.update(e, Transform, (t) => { t.position = { x: at.x + 1e6, y: at.y + 1e6, z: at.z + 1e6 }; });
                    } else {
                        const at = parked.get(e);
                        if (at) world.update(e, Transform, (t) => { t.position = { ...at }; });
                    }
                }
                if (!hidden) parked.clear();
                for (const name of GATES) world.update(get(world, name), Transform, (t) => { const size = hidden ? 0.0001 : 1; t.scale = { x: size, y: size, z: size }; });
            },
        });

        const mix = (a: number, b: number, k: number): number => a + (b - a) * k;
        const light = (world: World, name: string, way: { x: number; y: number; z: number }, color: { r: number; g: number; b: number; a: number }, intensity: number): void => {
            const e = get(world, name);
            world.update(e, Light, (l) => { l.color = color; l.intensity = intensity; });
            world.update(e, Transform, (t) => { t.rotation = lookRotation([0, 0, 0], [way.x, way.y, way.z]); });
        };
        const dress = (world: World, from: number, to: number, k: number): void => {
            const a = systemAt(from), b = systemAt(to);
            const way = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => ({ x: mix(p.x, q.x, k), y: mix(p.y, q.y, k), z: mix(p.z, q.z, k) });
            const tone = (p: { r: number; g: number; b: number }, q: { r: number; g: number; b: number }) => ({ r: mix(p.r, q.r, k), g: mix(p.g, q.g, k), b: mix(p.b, q.b, k), a: 1 });
            light(world, 'Sun', way(a.sun, b.sun), tone(a.sunColor, b.sunColor), mix(a.sunPower, b.sunPower, k));
            light(world, 'PlanetShine', way(a.shine, b.shine), tone(a.shineColor, b.shineColor), mix(a.shinePower, b.shinePower, k));
            const sky = get(world, 'Sky'), here = k < 0.5 ? a : b;
            world.update(sky, Light, (l) => { l.color = { r: here.skyTint.r / here.skyVeil.r, g: here.skyTint.g / here.skyVeil.g, b: here.skyTint.b / here.skyVeil.b, a: 1 }; });
        };
        let stars: Record<string, number> | null = null;
        const grade = (world: World, exposure: number, system: number, clear: number): void => {
            const here = systemAt(system);
            const camera = get(world, 'Camera');
            const volume = world.get(camera, PostProcessVolume);
            stars ??= { ...volume.effects.find((effect) => effect.type === 'starfield')!.uniforms };
            const sky = stars;
            world.insert(camera, PostProcessVolume, {
                ...volume,
                effects: volume.effects.map((effect) => effect.type === 'colorGrade' ? { ...effect, uniforms: { ...effect.uniforms, u_exposure: exposure } }
                    : effect.type === 'nebula' ? { ...effect, uniforms: { ...effect.uniforms, u_turn: here.skyTurn }, colors: { ...effect.colors, u_tint: { ...here.skyVeil } } }
                    : effect.type === 'starfield' ? { ...effect, uniforms: { ...effect.uniforms, u_bandTurn: here.bandTurn, u_intensity: sky.u_intensity! * clear, u_sunSize: sky.u_sunSize! * clear, u_sunGlow: sky.u_sunGlow! * clear } } : effect),
            });
        };
        const tone = (t: { r: number; g: number; b: number }): number[] => [t.r, t.g, t.b, 1];
        const stage = (world: World, system: number): void => {
            const here = systemAt(system), look = here.surface, toSun = { x: -here.sun.x, y: -here.sun.y, z: -here.sun.z };
            const planet = get(world, 'Planet'), air = get(world, 'Atmosphere'), ring = get(world, 'Ring');
            world.update(planet, Transform, (t) => { t.position = { ...here.at }; t.rotation = { ...look.tilt }; t.scale = { x: here.radius, y: here.radius, z: here.radius }; });
            const ground = world.get(planet, MeshRenderer).material;
            showKind(ground, look.kind);
            look.palette.forEach((color, i) => Material.setUniform(ground, `u_c${i}`, tone(color)));
            Material.setUniform(ground, 'u_accent', tone(look.accent));
            Material.setUniform(ground, 'u_pole', tone(look.pole));
            Material.setUniform(ground, 'u_glow', tone(look.glow));
            Material.setUniform(ground, 'u_seed', { ...look.seed });
            Material.setUniform(ground, 'u_shape', { ...look.shape });
            Material.setUniform(ground, 'u_spot', { ...look.spot });
            Material.setUniform(ground, 'u_sun', toSun);
            Material.setUniform(ground, 'u_sunColor', tone(here.sunColor));
            Material.setUniform(ground, 'u_power', here.sunPower);
            const shell = here.radius * here.air;
            world.update(air, Transform, (t) => { t.position = { ...here.at }; t.scale = { x: shell, y: shell, z: shell }; });
            const sky = world.get(air, MeshRenderer).material;
            Material.setUniform(sky, 'u_rim', tone(here.rim));
            Material.setUniform(sky, 'u_power', here.rimPower);
            Material.setUniform(sky, 'u_strength', here.rimStrength);
            Material.setUniform(sky, 'u_sun', toSun);
            world.update(ring, MeshRenderer, (m) => { m.enabled = here.ring !== null; });
            if (here.ring) {
                const band = here.ring, reach = here.radius * band.outer;
                world.update(ring, Transform, (t) => {
                    t.position = { ...here.at };
                    t.rotation = lookRotation([0, 0, 0], [band.normal.x, band.normal.y, band.normal.z]);
                    t.scale = { x: reach, y: reach, z: reach };
                });
                const disc = world.get(ring, MeshRenderer).material;
                Material.setUniform(disc, 'u_bright', tone(band.bright));
                Material.setUniform(disc, 'u_dim', tone(band.dim));
                Material.setUniform(disc, 'u_inner', band.inner / band.outer);
                Material.setUniform(disc, 'u_planet', 1 / band.outer);
                Material.setUniform(disc, 'u_sun', ringSun(band, here.sun));
                Material.setUniform(disc, 'u_split', { x: band.split, y: band.gap, z: 0, w: 0 });
                Material.setUniform(disc, 'u_second', tone(band.second));
            }
            shown = system;
        };

        const get = (world: World, name: string): Entity => {
            const known = ids.get(name);
            if (known !== undefined) return known;
            const found = world.findEntityByName(name);
            if (found === null) throw new Error(`space-frigate entity missing: ${name}`);
            ids.set(name, found);
            return found;
        };

        app.addSystem(defineSystem([GetWorld(), Res(Time), Res(Input)], (world, time, input) => {
            if (world.findEntityByName('Ship') === null || loading.cover) return;
            if (world.findEntityByName('Camera') === null) return;
            const dt = Math.min(time.delta, 0.05);
            clock += dt;

            wanted = helm.order;
            if (online.enabled) throttle = ship.throttle;
            else { const engine = { throttle, speed: ship.speed }; driveShip(engine, wanted, dt); throttle = engine.throttle; ship.speed = engine.speed; }

            for (const plume of PLUMES) {
                const wide = plume.width * (0.8 + 0.2 * throttle);
                world.update(get(world, plume.name), Transform, (t) => { t.scale = { x: wide, y: wide, z: plume.length * (0.22 + 1.05 * throttle) }; });
            }
            Material.setUniform(world.get(get(world, 'PlumeL'), MeshRenderer).material, 'u_strength', 0.25 + 1.5 * throttle * throttle);
            Material.setUniform(world.get(get(world, 'PlumeLCore'), MeshRenderer).material, 'u_strength', 0.6 + 7 * throttle * throttle);
            for (const name of GLOWS) world.update(get(world, name), Light, (l) => { l.intensity = 0.1 + 0.7 * throttle * throttle; });

            const struck = (code: string): boolean => {
                const now = input.isKeyDown(code), was = downs.get(code) ?? false;
                downs.set(code, now);
                return now && !was;
            };
            const held = input.isMouseButtonDown(0);
            const pointer = input.getMousePosition();
            const looking = Device.state().pointerLocked;
            const moved = input.getMouseDelta();
            const drag = looking ? { x: moved.x * LOOK, y: moved.y * LOOK } : held && grabbed && !guns.holding && !graphics.open ? { x: pointer.x - last.x, y: pointer.y - last.y } : { x: 0, y: 0 };
            grabbed = held;
            last = { x: pointer.x, y: pointer.y };
            const wheel = graphics.open ? 0 : input.getScrollDelta().y;
            const viewBefore = { tour, guns: guns.view, hand: { ...hand } };
            const live = tour ? tourOrbit(clock) : hand;
            if (drag.x !== 0 || drag.y !== 0 || wheel !== 0) {
                if (tour) hand = { ...live };
                tour = false;
            }
            for (let n = 0; n < SHOTS.length; n++) {
                if (struck(`Digit${n + 1}`)) { hand = { ...SHOTS[n]! }; tour = false; guns.view = false; }
            }
            if (struck('KeyG') || guns.toggle) {
                guns.toggle = false;
                guns.view = !guns.view;
                if (guns.view) {
                    if (tour) hand = { ...live, yaw: SIGHT.yaw, pitch: SIGHT.pitch, distance: SIGHT.distance };
                    tour = false;
                }
            }
            if ((struck('KeyL') || guns.look) && helm.aim) {
                if (tour) hand = { ...live };
                tour = false;
                const to = turnBack(helm.frame, helm.aim), seat = guns.view ? { height: SIGHT.height, along: 0 } : hand;
                const bearing = { x: to.x, y: to.y - seat.height, z: to.z - seat.along }, far = Math.hypot(bearing.x, bearing.y, bearing.z) || 1;
                swing = { yaw: Math.atan2(-bearing.x, -bearing.z), pitch: clamp(Math.asin(clamp(-bearing.y / far, -1, 1)), -1.2, 1.2) };
            }
            guns.look = false;
            if (drag.x !== 0 || drag.y !== 0) swing = null;
            if (swing && !tour) {
                let turn = swing.yaw - hand.yaw;
                turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
                const share = Math.min(1, dt * 7);
                hand.yaw += turn * share;
                hand.pitch += (swing.pitch - hand.pitch) * share;
                if (Math.abs(turn) + Math.abs(swing.pitch - hand.pitch) < 0.004) swing = null;
            }
            if (struck('KeyC')) guns.auto = !guns.auto;
            const space = struck('Space');
            if (!guns.view && space) {
                tour = !tour;
                if (!tour) hand = { ...live };
            }
            if (!tour) {
                hand.yaw -= drag.x * 0.005;
                hand.pitch = clamp(hand.pitch + drag.y * 0.004, -1.2, 1.2);
                hand.distance = clamp(hand.distance * (1 + wheel * 0.001), 22, Math.max(260, hand.distance));
            }
            // Taking the view from the harbour's director: by a drag, the wheel, or asking for any view of her own. Her view then
            // begins where the director's camera stands, whatever view she asked for, and this frame's drag turns it from there:
            // the camera never has to travel through anything to reach a place she chose from inside a berth.
            const asked = drag.x !== 0 || drag.y !== 0 || wheel !== 0 || tour !== viewBefore.tour || guns.view !== viewBefore.guns
                || hand.yaw !== viewBefore.hand.yaw || hand.pitch !== viewBefore.hand.pitch || hand.distance !== viewBefore.hand.distance || hand.height !== viewBefore.hand.height || hand.along !== viewBefore.hand.along;
            const from = online.enabled && asked ? handOver(online.pos) : null;
            if (from) {
                const rel = turnBack(helm.frame, { x: from[0], y: from[1], z: from[2] }), about = { height: 4, along: 0 };
                const v = { x: rel.x, y: rel.y - about.height, z: rel.z - about.along }, far = Math.hypot(v.x, v.y, v.z) || 1;
                hand = { yaw: Math.atan2(v.x, v.z) - drag.x * 0.005, pitch: clamp(Math.asin(clamp(v.y / far, -1, 1)) + drag.y * 0.004, -1.2, 1.2), distance: far, height: about.height, along: about.along };
                tour = false;
                guns.view = false;
            }
            sight += ((guns.view ? 1 : 0) - sight) * Math.min(1, dt * 5);
            const base = tour ? tourOrbit(clock) : hand;
            const orbit = { ...base, height: base.height + (SIGHT.height - base.height) * sight, along: base.along * (1 - sight), pitch: guns.view ? clamp(base.pitch, SIGHT.low, SIGHT.high) : base.pitch };
            const { eye, target } = eyeOf(orbit);
            const camera = get(world, 'Camera');
            const cam = { position: turnBy(helm.frame, { x: eye[0], y: eye[1], z: eye[2] }), rotation: mulQuat(helm.frame, lookRotation(eye, target)) };
            // While the station has her in hand the harbour's director has the camera, unless her pilot has taken the view back.
            // It works in the sector's coordinates; she is drawn at the origin, so its camera is put about her afterwards.
            let staged: Rig | null = null;
            if (online.enabled) {
                const here = online.pos, look = turnBy(helm.frame, { x: target[0], y: target[1], z: target[2] });
                const before = director.action;
                staged = stepDirector({
                    dt, mooring: online.mooring, berth: online.berth, ship: here, aspect: (globalThis.innerWidth || 16) / (globalThis.innerHeight || 9),
                    own: { eye: [here[0] + cam.position.x, here[1] + cam.position.y, here[2] + cam.position.z], target: [here[0] + look.x, here[1] + look.y, here[2] + look.z], fov: wide },
                    took: asked,
                    arrivedDocked: online.welcomes !== welcomed,
                });
                welcomed = online.welcomes;
                // Cast off, the view she will be handed is made ready behind her: astern and above, her bow ahead.
                if (director.action === 'out' && before !== 'out') { hand = { ...DIRECTOR.chase }; tour = false; }
                if (staged) {
                    const at = [staged.eye[0] - here[0], staged.eye[1] - here[1], staged.eye[2] - here[2]], to = [staged.target[0] - here[0], staged.target[1] - here[1], staged.target[2] - here[2]];
                    cam.position = { x: at[0]!, y: at[1]!, z: at[2]! };
                    cam.rotation = lookRotation(at, to);
                }
            }
            // Where the camera is this frame in the sector's own coordinates, whoever placed it.
            facts.camX = (online.enabled ? online.pos[0] : 0) + cam.position.x; facts.camY = (online.enabled ? online.pos[1] : 0) + cam.position.y; facts.camZ = (online.enabled ? online.pos[2] : 0) + cam.position.z;
            // Falling through air she is shaken: a few rates at once that never fall into step, so it reads as buffeting and not as a hum.
            const rattle = fall.shake;
            const jolt = rattle <= 0.002 ? { a: 0, b: 0, c: 0 } : {
                a: (Math.sin(clock * 61.3) + 0.6 * Math.sin(clock * 37.7 + 1.3) + 0.35 * Math.sin(clock * 97.1 + 4.1)) / 1.95,
                b: (Math.sin(clock * 53.9 + 2.2) + 0.6 * Math.sin(clock * 29.3 + 0.4) + 0.35 * Math.sin(clock * 83.7 + 5.0)) / 1.95,
                c: (Math.sin(clock * 44.1 + 0.9) + 0.6 * Math.sin(clock * 71.9 + 3.3) + 0.35 * Math.sin(clock * 19.7 + 1.7)) / 1.95,
            };
            if (rattle > 0.002) {
                const pitch = jolt.a * SHAKE.pitch * rattle, yaw = jolt.b * SHAKE.yaw * rattle, lean = jolt.c * SHAKE.roll * rattle;
                cam.rotation = mulQuat(cam.rotation, { x: pitch / 2, y: yaw / 2, z: lean / 2, w: Math.sqrt(Math.max(0, 1 - (pitch * pitch + yaw * yaw + lean * lean) / 4)) });
                const push = turnBy(cam.rotation, { x: jolt.b * SHAKE.slide * rattle, y: jolt.a * SHAKE.slide * rattle, z: 0 });
                cam.position = { x: cam.position.x + push.x, y: cam.position.y + push.y, z: cam.position.z + push.z };
                facts.camSlide = jolt.b * SHAKE.slide * rattle; facts.camTilt = pitch;
            } else { facts.camSlide = 0; facts.camTilt = 0; }
            world.update(camera, Transform, (t) => { t.position = cam.position; t.rotation = cam.rotation; });

            const roll = Math.sin(clock * 0.31) * 0.012 + jolt.c * SHAKE.hullRoll * rattle, nod = Math.sin(clock * 0.23 + 1.3) * 0.006 + jolt.a * SHAKE.hullNod * rattle;
            const hull = {
                rotation: mulQuat(helm.attitude, { x: Math.sin(nod / 2), y: 0, z: Math.sin(roll / 2), w: Math.cos(nod / 2) * Math.cos(roll / 2) }),
                position: { x: jolt.b * SHAKE.hullSlide * rattle, y: Math.sin(clock * 0.19) * 0.35 + jolt.c * SHAKE.hullSlide * rattle, z: 0 },
            };
            world.update(get(world, 'Ship'), Transform, (t) => { t.rotation = hull.rotation; t.position = hull.position; });

            const gaze = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]], far = Math.hypot(gaze[0]!, gaze[1]!, gaze[2]!) || 1;
            gunnery(world, dt, guns.view ? { from: cam.position, way: turnBy(helm.frame, { x: gaze[0]! / far, y: gaze[1]! / far, z: gaze[2]! / far }) } : null, guns.view && (input.isKeyDown('Space') || guns.squeeze));
            facts.gunView = guns.view;
            facts.gunSource = guns.source;
            facts.gunBearing = guns.bearing;
            facts.gunReady = guns.ready;
            facts.gunShots = guns.shots;
            facts.gunHits = guns.hits;
            facts.gunRange = guns.range;
            facts.gunAuto = guns.auto;
            facts.gunSpread = (guns.spread * 180) / Math.PI;
            facts.gunLead = guns.lead;
            facts.gunHeld = guns.held;
            facts.gunTrain = guns.turrets.map((t) => `${t.key}${Math.round((t.yaw * 180) / Math.PI)}/${Math.round((t.pitch * 180) / Math.PI)}`).join(' ');

            ship.time = clock;
            ship.throttle = throttle;
            ship.wanted = wanted;
            ship.tour = tour;
            ship.shot = Math.floor(clock / SHOT_SECONDS) % SHOTS.length;

            if (shown < 0) {
                stage(world, ship.system);
                dress(world, ship.system, ship.system, 1);
                grade(world, EXPOSURE, ship.system, 1);
            }
            if (ship.jump >= 0) ship.jump += dt;
            const leap = jumpAt(ship.jump);
            if (ship.jump >= 0) {
                if (leap.swapped && ship.system !== ship.bound) {
                    ship.system = ship.bound;
                    stage(world, ship.system);
                }
                dress(world, leaving, ship.bound, leap.blend);
                grade(world, EXPOSURE + JUMP.glare * leap.flash, ship.system, 1 - leap.tunnel);
                travel = (travel + dt * JUMP.travel * (0.2 + leap.rush)) % 100000;
                if (leap.over) ship.jump = -1;
            }
            pace += (clamp(ship.speed / TOP_SPEED, 0, 1) - pace) * Math.min(1, dt * 1.5);
            const tunnel = leap.tunnel, fov = staged ? staged.fov : FOV + SPEED_WIDEN * pace * pace + JUMP.widen * leap.stretch + PLANETFALL.widen * fall.heat;
            if (Math.abs(fov - wide) > 0.01) {
                wide = fov;
                world.update(camera, Camera, (c) => { c.fov = fov; });
            }
            if (tunnel > 0 !== open) {
                open = tunnel > 0;
                world.update(get(world, 'Warp'), Transform, (t) => { const size = open ? 1 : 0.001; t.scale = { x: size, y: size, z: size }; });
            }
            // The air on the way down to a world, and up out of one: burning first, then cloud. It streams past faster the hotter it is.
            const veil = tunnel <= 0 && Math.max(fall.heat, fall.cover) > 0.004;
            if (veil !== veiled) {
                veiled = veil;
                world.update(get(world, 'Entry'), Transform, (t) => { const size = veil ? 1 : 0.001; t.scale = { x: size, y: size, z: size }; });
            }
            if (veil) {
                fallen = (fallen + dt * (700 + 1500 * fall.heat + 1100 * fall.cover)) % 100000;
                const air = world.get(get(world, 'Entry'), MeshRenderer).material;
                Material.setUniform(air, 'u_heat', fall.heat);
                Material.setUniform(air, 'u_cloud', fall.cover);
                Material.setUniform(air, 'u_travel', fallen);
                // Where the camera is and which way it looks, as the sheath has it: in the hull's own frame, which is the sheath's.
                const from = turnBack(hull.rotation, { x: cam.position.x - hull.position.x, y: cam.position.y - hull.position.y, z: cam.position.z - hull.position.z });
                const sightline = turnBack(hull.rotation, turnBy(helm.frame, { x: (target[0] - eye[0]) / far, y: (target[1] - eye[1]) / far, z: (target[2] - eye[2]) / far }));
                const glass = world.get(camera, Camera);
                Material.setUniform(air, 'u_eye', from);
                Material.setUniform(air, 'u_look', sightline);
                Material.setUniform(air, 'u_near', glass.nearPlane);
                Material.setUniform(air, 'u_far', glass.farPlane);
            }
            // What the frame cost the GPU, as the engine measured it: for a check, and for anyone asking why it is slow.
            const meter = (app as unknown as { wasmModule?: { renderer_getGpuTimeMs?: () => number; renderer_getGpuDrawCalls?: () => number; renderer_getEstimatedGpuBytes?: () => number } }).wasmModule;
            facts.gpuMs = meter?.renderer_getGpuTimeMs?.() ?? 0;
            facts.gpuDraws = meter?.renderer_getGpuDrawCalls?.() ?? 0;
            facts.gpuBytes = meter?.renderer_getEstimatedGpuBytes?.() ?? 0;
            (globalThis as { __spaceMeter?: unknown }).__spaceMeter = { gpuMs: facts.gpuMs, draws: facts.gpuDraws, bytes: facts.gpuBytes, pending: meter ? pendingShaders(app) : 0, frame: clock };
            facts.shake = fall.shake;
            facts.heat = fall.heat;
            if (open) {
                const field = world.get(get(world, 'Warp'), MeshRenderer).material;
                Material.setUniform(field, 'u_cover', tunnel);
                Material.setUniform(field, 'u_travel', travel);
                Material.setUniform(field, 'u_flash', 0.2 * leap.flash);
            }
            facts.system = ship.system;
            facts.systemName = systemAt(ship.system).name;
            facts.seed = galaxy.seed;
            const world0 = systemAt(ship.system), bearing = turnBack(helm.frame, world.get(get(world, 'Planet'), Transform).position);
            facts.planetKind = KINDS[world0.surface.kind];
            facts.planetX = bearing.x;
            facts.planetY = bearing.y;
            facts.planetZ = bearing.z;
            facts.planetRadius = world0.radius;
            const toSun = turnBack(helm.frame, { x: -world0.sun.x, y: -world0.sun.y, z: -world0.sun.z });
            facts.sunX = toSun.x;
            facts.sunY = toSun.y;
            facts.sunZ = toSun.z;
            facts.jump = ship.jump;
            facts.jumps = ship.jumps;
            facts.fov = world.get(camera, Camera).fov;
            facts.planets = `${world.get(get(world, 'Planet'), MeshRenderer).enabled ? 1 : 0}${world.get(get(world, 'Ring'), MeshRenderer).enabled ? 1 : 0}`;

            const cruise = ship.speed * FIELD_DRIFT * dt * helm.surge, drift = cruise * (1 + JUMP.rush * leap.rush);
            const leavingField = ship.jump >= 0 && !leap.swapped, past = leavingField ? drift : cruise;
            planetfall(world, dt, drift);
            facts.fall = fall.stage;
            facts.altitude = Number.isFinite(fall.altitude) ? fall.altitude : 9999999;
            facts.cover = fall.cover;
            if (!ship.away) impacts(world, dt, cruise, past, leavingField);
            raiders(world, dt);
            facts.foes = foes.list.filter((foe) => foe.alive).length;
            facts.kills = foes.kills;
            facts.foeShots = foes.shots;
            facts.stung = foes.stung;
            facts.foeBerth = Number.isFinite(foes.berth) ? foes.berth : 9999;
            facts.foeRange = foes.list.reduce((least, foe) => (foe.alive ? Math.min(least, Math.hypot(foe.mind.at.x, foe.mind.at.y, foe.mind.at.z)) : least), 9999);
            facts.shield = ship.shield;
            facts.hull = ship.hull;
            facts.impacts = ship.impacts;
            facts.gap = Number.isFinite(ship.gap) ? ship.gap : 9999;
            facts.closest = Number.isFinite(ship.closest) ? ship.closest : 9999;
            facts.speed = ship.speed;

            if (helm.arrivals !== arrivals) {
                arrivals = helm.arrivals;
                ahead = 1 - ahead;
                passedFacing = gateFacing;
                passedSide = 0;
                const yaw = Math.atan2(helm.gate.x, helm.gate.z);
                const pitch = Math.atan2(helm.gate.y, Math.hypot(helm.gate.x, helm.gate.z) || 1e-6);
                gateFacing = mulQuat({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, { x: -Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) });
            }
            world.update(get(world, GATES[ahead]!), Transform, (t) => {
                // In a sector the waypoint is the station, which has a model of its own: the gate's ring is put out of sight.
                t.position = online.enabled ? { x: 0, y: -60000, z: 0 } : { x: helm.gate.x, y: helm.gate.y, z: helm.gate.z };
                t.rotation = gateFacing;
            });
            const behind = get(world, GATES[1 - ahead]!);
            const was = world.get(behind, Transform).position;
            const passed = { x: was.x - helm.forward.x * drift, y: was.y - helm.forward.y * drift, z: was.z - helm.forward.z * drift };
            world.update(behind, Transform, (t) => { t.position = passed; });
            facts.gate = Math.hypot(helm.gate.x, helm.gate.y, helm.gate.z);
            facts.gatePassed = Math.hypot(passed.x, passed.y, passed.z);

            const axis = turnBy(passedFacing, { x: 0, y: 0, z: 1 });
            const along = passed.x * axis.x + passed.y * axis.y + passed.z * axis.z;
            const side = Math.sign(along);
            if (passedSide !== 0 && side !== 0 && side !== passedSide && facts.gatePassed < GATE_RADIUS) {
                flash = 1;
                since = 0;
                facts.transits++;
                if (ship.jump < 0 && !online.enabled) {
                    leaving = ship.system;
                    ship.bound = nextSystem(ship.system);
                    readyKind(app, world, get(world, 'Planet'), systemAt(ship.bound).surface.kind);
                    ship.jump = 0;
                    ship.jumps++;
                }
            }
            if (side !== 0) passedSide = side;
            flash *= Math.exp(-dt * 2.2);
            since = Math.min(since + dt, 60);
            const front = Math.min(since / WAVE_SECONDS, 4);
            const burst = get(world, 'GateFlash');
            world.update(burst, Light, (l) => { l.intensity = 4 * flash + 2.4 * tunnel; });
            for (const name of GATES) {
                const field = world.get(get(world, `${name}Field`), MeshRenderer).material;
                Material.setUniform(field, 'u_strength', 0.45 + 0.9 * flash);
                Material.setUniform(field, 'u_front', front);
                Material.setUniform(field, 'u_burst', front < 1.6 ? 2.6 * Math.exp(-since * 1.4) : 0);
            }
            facts.flash = flash;
            facts.wave = front;

            const lift = clamp((ship.speed / TOP_SPEED - DUST.from) / (DUST.full - DUST.from), 0, 1), show = lift * lift * (3 - 2 * lift);
            const flow = dt > 0 ? past / dt : 0, stream = { x: -helm.forward.x * flow, y: -helm.forward.y * flow, z: -helm.forward.z * flow };
            const dust = get(world, 'SpeedDust');
            world.update(dust, Transform, (t) => { t.position = { ...hull.position }; t.rotation = { ...hull.rotation }; });
            world.update(dust, ParticleEmitter, (p) => {
                p.rate = DUST.rate * show;
                p.intensity = DUST.glow * show;
                p.addedVelocityMin = stream;
                p.addedVelocityMax = stream;
            });
            facts.dust = show;
            facts.dustAlive = app.getResource(Particle).getAliveCount(dust);

            for (const lamp of STROBES) {
                const lit = strobe(clock, lamp.every, lamp.flashes);
                const size = lamp.size * (0.04 + 0.96 * lit);
                world.update(get(world, lamp.name), Transform, (t) => { t.scale = { x: size, y: size, z: size }; });
                const glow = world.findEntityByName(`${lamp.name}Light`);
                if (glow !== null) world.update(glow, Light, (l) => { l.intensity = 0.9 * lit; });
            }
            for (const name of STEADY) world.update(get(world, `${name}Light`), Light, (l) => { l.intensity = 0.32 + 0.06 * Math.sin(clock * 2.1); });
            facts.strobe = strobe(clock, STROBES[0].every, STROBES[0].flashes);

            // Carried by the station she is moved by her own thrusters, and they are seen at it: the ones whose gas goes the way
            // she is leaving burn, harder the faster she is carried, and the turning pairs burn as she is brought round.
            const tug = online.enabled ? online.tug : null;
            JETS.forEach((jet, i) => {
                const carried = !tug ? 0 : TUG_BURN * (
                    (jet.push === 'port' ? Math.max(0, tug.x) : jet.push === 'starboard' ? Math.max(0, -tug.x) : jet.push === 'up' ? Math.max(0, tug.y) : Math.max(0, -tug.y))
                    + (jet.turn === 'yaw' ? Math.max(0, tug.yaw * jet.sign) : 0));
                const want = clamp(helm.jets[jet.turn] * jet.sign + carried, 0, 1);
                jets[i] = jets[i]! + (want - jets[i]!) * Math.min(1, dt * 14);
                const burn = jets[i]! * (0.7 + 0.3 * Math.sin(clock * 53 + i * 1.7) * Math.sin(clock * 17 + i));
                const wide = burn > 0.02 ? 0.5 + 0.3 * burn : 0.001;
                world.update(get(world, jet.name), Transform, (t) => { t.scale = { x: wide, y: wide, z: burn > 0.02 ? 0.25 + 0.35 * burn : 0.001 }; });
                const gas = get(world, `${jet.name}Gas`), rate = jets[i]! > 0.03 ? Math.round(70 + 260 * jets[i]!) : 0;
                if (world.get(gas, ParticleEmitter).rate !== rate) world.update(gas, ParticleEmitter, (p) => { p.rate = rate; });
            });
            facts.jets = `${helm.jets.yaw.toFixed(2)} ${helm.jets.pitch.toFixed(2)} ${helm.jets.roll.toFixed(2)}`;
            facts.jetsBurning = jets.filter((burn) => burn > 0.15).length;

            facts.ready = true;
            facts.frame++;
            facts.time = clock;
            facts.throttle = throttle;
            facts.tour = tour;
            facts.shot = Math.floor(clock / SHOT_SECONDS) % SHOTS.length;
            facts.eyeX = eye[0];
            facts.eyeY = eye[1];
            facts.eyeZ = eye[2];
        }));
    },
});

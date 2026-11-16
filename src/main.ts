import { addPlugin, defineSystem, GetWorld, Res, Time, Input, Transform, MeshRenderer, Light, Material, ParticleEmitter, Playthrough, Camera, PostProcessVolume } from 'esengine';
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
import { installSky } from './sky';
import { SYSTEMS } from './systems';

const PLUMES = [
    { name: 'PlumeL', width: 4.0, length: 2.3 },
    { name: 'PlumeR', width: 4.0, length: 2.3 },
    { name: 'PlumeNL', width: 3.0, length: 1.7 },
    { name: 'PlumeNR', width: 3.0, length: 1.7 },
] as const;

const GLOWS = ['EngineGlowL', 'EngineGlowR', 'EngineGlowNL', 'EngineGlowNR'] as const;
const GATES = ['GateA', 'GateB'] as const;
const GATE_RADIUS = 170;
const MOTE_FIELD = { x: 170, y: 100, z: 240 };
const MOTE_CLEAR = 34;
const STROBES = [
    { name: 'StrobeMast', size: 0.55, every: 1.7, flashes: 2 },
    { name: 'StrobeKeel', size: 0.5, every: 1.3, flashes: 1 },
    { name: 'BowPort', size: 0.34, every: 2.3, flashes: 1 },
    { name: 'BowStarboard', size: 0.34, every: 2.3, flashes: 1 },
    { name: 'GateAStrobe', size: 2.6, every: 2.9, flashes: 3 },
    { name: 'GateBStrobe', size: 2.6, every: 2.9, flashes: 3 },
] as const;
const STEADY = ['NavPort', 'NavStarboard'] as const;
const JETS = [
    { name: 'JetBowStarboard', turn: 'yaw', sign: 1 }, { name: 'JetSternPort', turn: 'yaw', sign: 1 }, { name: 'JetBowPort', turn: 'yaw', sign: -1 }, { name: 'JetSternStarboard', turn: 'yaw', sign: -1 },
    { name: 'JetBowDown', turn: 'pitch', sign: 1 }, { name: 'JetSternUp', turn: 'pitch', sign: 1 }, { name: 'JetBowUp', turn: 'pitch', sign: -1 }, { name: 'JetSternDown', turn: 'pitch', sign: -1 },
    { name: 'JetPortDown', turn: 'roll', sign: 1 }, { name: 'JetStarboardUp', turn: 'roll', sign: 1 }, { name: 'JetPortUp', turn: 'roll', sign: -1 }, { name: 'JetStarboardDown', turn: 'roll', sign: -1 },
] as const;
const WAVE_SECONDS = 0.9;
const FOV = 34;
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
        const facts = { ready: false, frame: 0, time: 0, throttle: 0, tour: true, shot: 0, eyeX: 0, eyeY: 0, eyeZ: 0, gate: 0, gatePassed: 0, transits: 0, flash: 0, wave: 0, motes: 0, strobe: 0, gunView: false, gunSource: 'stowed', gunBearing: 0, gunReady: 0, gunShots: 0, gunHits: 0, gunRange: 0, gunTrain: '', jets: '', gunAuto: false, gunSpread: 0, gunLead: 0, gunHeld: 0, system: 0, systemName: SYSTEMS[0].name as string, jump: -1, jumps: 0, fov: FOV, planets: '', shield: 1, hull: 1, impacts: 0, gap: 9999, closest: 9999, speed: 0, foes: 0, kills: 0, foeShots: 0, stung: 0, foeBerth: 9999, foeRange: 9999 };
        app.insertResource(Playthrough, { facts });
        installSky();
        installHud(app);
        installAudio(app);
        const ids = new Map<string, Entity>();
        let clock = 0;
        let wanted = 0.65;
        let throttle = 0.65;
        let tour = true;
        let hand: Orbit = { ...SHOTS[0] };
        let grabbed = false;
        let last = { x: 0, y: 0 };
        let ahead = 1;
        let arrivals = -1;
        let gateFacing: Quat = { x: 0, y: 0, z: 0, w: 1 };
        let passedFacing: Quat = { x: 0, y: 0, z: 0, w: 1 };
        let passedSide = 0;
        let flash = 0;
        let since = 60;
        let motes = -1;
        const downs = new Map<string, boolean>();
        const jets = JETS.map(() => 0);
        let sight = 0;
        let swing: { yaw: number; pitch: number } | null = null;
        let leaving = 0;
        let shown = -1;
        let travel = 0;
        let wide = FOV;
        let open = false;
        const gunnery = createGunnery(app);
        const impacts = createImpacts(app);
        const raiders = createRaiders(app);

        const mix = (a: number, b: number, k: number): number => a + (b - a) * k;
        const light = (world: World, name: string, way: { x: number; y: number; z: number }, color: { r: number; g: number; b: number; a: number }, intensity: number): void => {
            const e = get(world, name);
            world.insert(e, Light, { ...world.get(e, Light), color, intensity });
            world.update(e, Transform, (t) => { t.rotation = lookRotation([0, 0, 0], [way.x, way.y, way.z]); });
        };
        const dress = (world: World, from: number, to: number, k: number): void => {
            const a = SYSTEMS[from]!, b = SYSTEMS[to]!;
            const way = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => ({ x: mix(p.x, q.x, k), y: mix(p.y, q.y, k), z: mix(p.z, q.z, k) });
            const tone = (p: { r: number; g: number; b: number }, q: { r: number; g: number; b: number }) => ({ r: mix(p.r, q.r, k), g: mix(p.g, q.g, k), b: mix(p.b, q.b, k), a: 1 });
            light(world, 'Sun', way(a.sun, b.sun), tone(a.sunColor, b.sunColor), mix(a.sunPower, b.sunPower, k));
            light(world, 'PlanetShine', way(a.shine, b.shine), tone(a.shineColor, b.shineColor), mix(a.shinePower, b.shinePower, k));
            const sky = get(world, 'Sky'), here = k < 0.5 ? a : b;
            world.insert(sky, Light, { ...world.get(sky, Light), color: { r: here.skyTint.r / here.skyVeil.r, g: here.skyTint.g / here.skyVeil.g, b: here.skyTint.b / here.skyVeil.b, a: 1 } });
        };
        let stars: Record<string, number> | null = null;
        const grade = (world: World, exposure: number, system: number, clear: number): void => {
            const here = SYSTEMS[system]!;
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
        const stage = (world: World, system: number): void => {
            SYSTEMS.forEach((each, i) => {
                for (const part of each.parts) world.update(get(world, part), MeshRenderer, (m) => { m.enabled = i === system; });
            });
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
            if (world.findEntityByName('Camera') === null) return;
            const dt = Math.min(time.delta, 0.05);
            clock += dt;

            wanted = helm.order;
            throttle += (wanted - throttle) * Math.min(1, dt * 2.2);

            for (const plume of PLUMES) {
                const e = get(world, plume.name);
                const t = world.get(e, Transform);
                const wide = plume.width * (0.8 + 0.2 * throttle);
                t.scale = { x: wide, y: wide, z: plume.length * (0.22 + 1.05 * throttle) };
                world.insert(e, Transform, t);
            }
            Material.setUniform(world.get(get(world, 'PlumeL'), MeshRenderer).material, 'u_strength', 0.25 + 1.5 * throttle * throttle);
            Material.setUniform(world.get(get(world, 'PlumeLCore'), MeshRenderer).material, 'u_strength', 0.6 + 7 * throttle * throttle);
            for (const name of GLOWS) {
                const e = get(world, name);
                world.insert(e, Light, { ...world.get(e, Light), intensity: 0.1 + 0.7 * throttle * throttle });
            }

            const struck = (code: string): boolean => {
                const now = input.isKeyDown(code), was = downs.get(code) ?? false;
                downs.set(code, now);
                return now && !was;
            };
            const held = input.isMouseButtonDown(0);
            const pointer = input.getMousePosition();
            const drag = held && grabbed && !guns.holding ? { x: pointer.x - last.x, y: pointer.y - last.y } : { x: 0, y: 0 };
            grabbed = held;
            last = { x: pointer.x, y: pointer.y };
            const wheel = input.getScrollDelta().y;
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
            if (struck('KeyC') && guns.view) guns.auto = !guns.auto;
            if (!guns.view) guns.auto = false;
            const space = struck('Space');
            if (!guns.view && space) {
                tour = !tour;
                if (!tour) hand = { ...live };
            }
            if (!tour) {
                hand.yaw -= drag.x * 0.005;
                hand.pitch = clamp(hand.pitch + drag.y * 0.004, -1.2, 1.2);
                hand.distance = clamp(hand.distance * (1 + wheel * 0.001), 22, 260);
            }
            sight += ((guns.view ? 1 : 0) - sight) * Math.min(1, dt * 5);
            const base = tour ? tourOrbit(clock) : hand;
            const orbit = { ...base, height: base.height + (SIGHT.height - base.height) * sight, along: base.along * (1 - sight), pitch: guns.view ? clamp(base.pitch, SIGHT.low, SIGHT.high) : base.pitch };
            const { eye, target } = eyeOf(orbit);
            const camera = get(world, 'Camera');
            const cam = world.get(camera, Transform);
            cam.position = turnBy(helm.frame, { x: eye[0], y: eye[1], z: eye[2] });
            cam.rotation = mulQuat(helm.frame, lookRotation(eye, target));
            world.insert(camera, Transform, cam);

            const root = get(world, 'Ship');
            const hull = world.get(root, Transform);
            const roll = Math.sin(clock * 0.31) * 0.012, nod = Math.sin(clock * 0.23 + 1.3) * 0.006;
            hull.rotation = mulQuat(helm.attitude, { x: Math.sin(nod / 2), y: 0, z: Math.sin(roll / 2), w: Math.cos(nod / 2) * Math.cos(roll / 2) });
            hull.position = { x: 0, y: Math.sin(clock * 0.19) * 0.35, z: 0 };
            world.insert(root, Transform, hull);

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
            ship.speed += (throttle * TOP_SPEED - ship.speed) * Math.min(1, dt * 0.8);
            ship.tour = tour;
            ship.shot = Math.floor(clock / SHOT_SECONDS) % SHOTS.length;

            if (shown < 0) stage(world, ship.system);
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
            const tunnel = leap.tunnel, fov = FOV + JUMP.widen * leap.stretch;
            if (fov !== wide) {
                wide = fov;
                world.update(camera, Camera, (c) => { c.fov = fov; });
            }
            if (tunnel > 0 !== open) {
                open = tunnel > 0;
                world.update(get(world, 'Warp'), Transform, (t) => { const size = open ? 1 : 0.001; t.scale = { x: size, y: size, z: size }; });
            }
            if (open) {
                const field = world.get(get(world, 'Warp'), MeshRenderer).material;
                Material.setUniform(field, 'u_cover', tunnel);
                Material.setUniform(field, 'u_travel', travel);
                Material.setUniform(field, 'u_flash', 0.2 * leap.flash);
            }
            facts.system = ship.system;
            facts.systemName = SYSTEMS[ship.system]!.name;
            facts.jump = ship.jump;
            facts.jumps = ship.jumps;
            facts.fov = world.get(camera, Camera).fov;
            facts.planets = SYSTEMS.map((each) => (world.get(get(world, each.parts[0]), MeshRenderer).enabled ? 1 : 0)).join('');

            const cruise = ship.speed * FIELD_DRIFT * dt, drift = cruise * (1 + JUMP.rush * leap.rush);
            const leavingField = ship.jump >= 0 && !leap.swapped, past = leavingField ? drift : cruise;
            impacts(world, dt, cruise, past, leavingField);
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
            const next = get(world, GATES[ahead]!);
            const there = world.get(next, Transform);
            there.position = { x: helm.gate.x, y: helm.gate.y, z: helm.gate.z };
            there.rotation = gateFacing;
            world.insert(next, Transform, there);
            const behind = get(world, GATES[1 - ahead]!);
            const left = world.get(behind, Transform);
            left.position = { x: left.position.x - helm.forward.x * drift, y: left.position.y - helm.forward.y * drift, z: left.position.z - helm.forward.z * drift };
            world.insert(behind, Transform, left);
            facts.gate = Math.hypot(helm.gate.x, helm.gate.y, helm.gate.z);
            facts.gatePassed = Math.hypot(left.position.x, left.position.y, left.position.z);

            const axis = turnBy(passedFacing, { x: 0, y: 0, z: 1 });
            const along = left.position.x * axis.x + left.position.y * axis.y + left.position.z * axis.z;
            const side = Math.sign(along);
            if (passedSide !== 0 && side !== 0 && side !== passedSide && facts.gatePassed < GATE_RADIUS) {
                flash = 1;
                since = 0;
                facts.transits++;
                if (ship.jump < 0) {
                    leaving = ship.system;
                    ship.bound = nextSystem(ship.system, SYSTEMS.length);
                    ship.jump = 0;
                    ship.jumps++;
                }
            }
            if (side !== 0) passedSide = side;
            flash *= Math.exp(-dt * 2.2);
            since = Math.min(since + dt, 60);
            const front = Math.min(since / WAVE_SECONDS, 4);
            const burst = get(world, 'GateFlash');
            world.insert(burst, Light, { ...world.get(burst, Light), intensity: 4 * flash + 2.4 * tunnel });
            for (const name of GATES) {
                const field = world.get(get(world, `${name}Field`), MeshRenderer).material;
                Material.setUniform(field, 'u_strength', 0.45 + 0.9 * flash);
                Material.setUniform(field, 'u_front', front);
                Material.setUniform(field, 'u_burst', front < 1.6 ? 2.6 * Math.exp(-since * 1.4) : 0);
            }
            facts.flash = flash;
            facts.wave = front;

            if (motes < 0) {
                motes = 0;
                while (world.findEntityByName(`Mote${motes}`) !== null) motes++;
            }
            for (let i = 0; i < motes; i++) {
                const e = get(world, `Mote${i}`);
                const t = world.get(e, Transform);
                const wrap = (v: number, half: number): number => (leavingField ? v : v < -half ? v + half * 2 * Math.ceil((-half - v) / (half * 2)) : v > half ? v - half * 2 * Math.ceil((v - half) / (half * 2)) : v);
                let x = wrap(t.position.x - helm.forward.x * past, MOTE_FIELD.x);
                let y = wrap(t.position.y - helm.forward.y * past, MOTE_FIELD.y);
                const z = wrap(t.position.z - helm.forward.z * past, MOTE_FIELD.z);
                const off = Math.hypot(x, y);
                if (!leavingField && off < MOTE_CLEAR && Math.abs(z) < 80) {
                    const out = MOTE_CLEAR / (off || 1);
                    x = off ? x * out : MOTE_CLEAR;
                    y *= out;
                }
                t.position = { x, y, z };
                world.insert(e, Transform, t);
            }
            facts.motes = motes;

            for (const lamp of STROBES) {
                const lit = strobe(clock, lamp.every, lamp.flashes);
                const e = get(world, lamp.name);
                const t = world.get(e, Transform);
                const size = lamp.size * (0.04 + 0.96 * lit);
                t.scale = { x: size, y: size, z: size };
                world.insert(e, Transform, t);
                const glow = world.findEntityByName(`${lamp.name}Light`);
                if (glow !== null) world.insert(glow, Light, { ...world.get(glow, Light), intensity: 0.9 * lit });
            }
            for (const name of STEADY) {
                const glow = get(world, `${name}Light`);
                world.insert(glow, Light, { ...world.get(glow, Light), intensity: 0.32 + 0.06 * Math.sin(clock * 2.1) });
            }
            facts.strobe = strobe(clock, STROBES[0].every, STROBES[0].flashes);

            JETS.forEach((jet, i) => {
                const want = clamp(helm.jets[jet.turn] * jet.sign, 0, 1);
                jets[i] = jets[i]! + (want - jets[i]!) * Math.min(1, dt * 14);
                const burn = jets[i]! * (0.7 + 0.3 * Math.sin(clock * 53 + i * 1.7) * Math.sin(clock * 17 + i));
                const e = get(world, jet.name);
                const t = world.get(e, Transform);
                const wide = burn > 0.02 ? 0.5 + 0.3 * burn : 0.001;
                t.scale = { x: wide, y: wide, z: burn > 0.02 ? 0.25 + 0.35 * burn : 0.001 };
                world.insert(e, Transform, t);
                const gas = get(world, `${jet.name}Gas`), rate = jets[i]! > 0.03 ? Math.round(70 + 260 * jets[i]!) : 0;
                if (world.get(gas, ParticleEmitter).rate !== rate) world.update(gas, ParticleEmitter, (p) => { p.rate = rate; });
            });
            facts.jets = `${helm.jets.yaw.toFixed(2)} ${helm.jets.pitch.toFixed(2)} ${helm.jets.roll.toFixed(2)}`;

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

import { Light, Particle, ParticleEmitter, Transform } from 'esengine';
import type { App, Entity, World } from 'esengine';
import { lookRotation } from './flight';
import { guns } from './gunnery';
import { helm, turnBack, type Vec } from './helm';
import { hullBlocks } from './hudKit';
import { RAIDER, advance, formUp, waveSize, type Hazard, type Mind } from './raiderMind';
import { FIELD_DRIFT, ship } from './shipState';

export interface Foe { slot: number; alive: boolean; hull: number; mind: Mind }

export const foes = { peace: false, due: Infinity, wave: 0, kills: 0, shots: 0, stung: 0, note: '', list: [] as Foe[], berth: Infinity };

interface Rig { root: Entity; smoke: Entity | null; home: Vec }
interface Bolt { entity: Entity; at: Vec; way: Vec; flown: number; live: boolean }

const REACH = 420;
const NOSE = 24;

export function createRaiders(app: App): (world: World, dt: number) => void {
    let rigs: Rig[] | null = null;
    let rocks: Entity[] = [], bolts: Bolt[] = [];
    let fire: Entity | null = null, sparks: Entity | null = null, smoke: Entity | null = null, blast: Entity | null = null, hullSparks: Entity | null = null, lamp: Entity | null = null;
    let seed = 20261116, nextBolt = 0, flash = 0;
    const roll = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const puff = (emitter: Entity | null, count: number, at: Vec): void => { if (emitter !== null) app.getResource(Particle).emitAt(emitter, count, at); };

    const build = (world: World): Rig[] => {
        const made: Rig[] = [];
        for (let i = 0; ; i++) {
            const root = world.findEntityByName(`Raider${i}`);
            if (root === null) break;
            made.push({ root, smoke: world.findEntityByName(`Raider${i}Smoke`), home: { ...world.get(root, Transform).position } });
            foes.list.push({ slot: i, alive: false, hull: 0, mind: formUp(0, i, { x: 0, y: 0, z: 1 }, roll) });
        }
        for (let i = 0; ; i++) { const e = world.findEntityByName(`Rock${i}`); if (e === null) break; rocks.push(e); }
        for (let i = 0; ; i++) { const e = world.findEntityByName(`FoeBolt${i}`); if (e === null) break; bolts.push({ entity: e, at: { x: 0, y: 0, z: 0 }, way: { x: 0, y: 0, z: 1 }, flown: 0, live: false }); }
        fire = world.findEntityByName('FoeFire');
        sparks = world.findEntityByName('FoeSparks');
        smoke = world.findEntityByName('FoeSmoke');
        blast = world.findEntityByName('FoeBlast');
        lamp = world.findEntityByName('FoeFlash');
        hullSparks = world.findEntityByName('HullSparks');
        guns.marks = foes.list.map((foe) => ({ at: foe.mind.at, radius: RAIDER.radius, live: false }));
        return made;
    };

    const park = (world: World, foe: Foe): void => {
        foe.alive = false;
        const rig = rigs![foe.slot]!;
        world.update(rig.root, Transform, (t) => { t.position = { ...rig.home }; });
        if (rig.smoke !== null && world.get(rig.smoke, ParticleEmitter).rate !== 0) world.update(rig.smoke, ParticleEmitter, (p) => { p.rate = 0; });
    };

    return (world, dt) => {
        if (world.findEntityByName('Raider0') === null) return;
        rigs ??= build(world);
        const speed = ship.speed * FIELD_DRIFT, way = { x: helm.forward.x * speed, y: helm.forward.y * speed, z: helm.forward.z * speed };
        const flying = foes.list.filter((foe) => foe.alive);

        if (ship.jump >= 0) {
            for (const foe of flying) park(world, foe);
            for (const bolt of bolts) bolt.live = false;
            foes.due = Infinity;
        } else if (flying.length === 0) {
            if (foes.peace || ship.tour) foes.due = Infinity;
            else {
                if (foes.due === Infinity) foes.due = ship.time + (foes.wave === 0 ? RAIDER.first : RAIDER.gap);
                if (ship.time >= foes.due) {
                    const count = Math.min(waveSize(foes.wave), foes.list.length);
                    for (let slot = 0; slot < count; slot++) Object.assign(foes.list[slot]!, { alive: true, hull: RAIDER.hull, mind: formUp(foes.wave, slot, helm.forward, roll) });
                    foes.wave++;
                    foes.due = Infinity;
                    foes.note = `HOSTILES   ${count} RAIDERS INBOUND`;
                }
            }
        }

        guns.hurt = (slot, at) => {
            const foe = foes.list[slot];
            if (!foe || !foe.alive) return;
            foe.hull--;
            if (foe.hull > 0) return;
            park(world, foe);
            foes.kills++;
            foes.note = `RAIDER ${slot + 1} DESTROYED`;
            puff(fire, 90, at);
            puff(sparks, 260, at);
            puff(smoke, 60, at);
            puff(blast, 2, at);
            flash = 1;
            if (lamp !== null) world.update(lamp, Transform, (t) => { t.position = { ...at }; });
        };

        const spots: Hazard[] = [];
        for (const rock of rocks) {
            const t = world.get(rock, Transform);
            spots.push({ at: t.position, radius: t.scale.x });
        }
        let berth = Infinity;
        for (const foe of foes.list) {
            const mark = guns.marks[foe.slot]!;
            mark.live = foe.alive;
            if (!foe.alive) continue;
            const mind = foe.mind;
            const near = spots.filter((spot) => Math.hypot(spot.at.x - mind.at.x, spot.at.y - mind.at.y, spot.at.z - mind.at.z) < spot.radius + REACH);
            for (const other of foes.list) if (other.alive && other !== foe) near.push({ at: other.mind.at, radius: RAIDER.radius * 1.6 });
            const shot = advance(mind, way, near, dt, roll);
            for (const spot of near) berth = Math.min(berth, Math.hypot(spot.at.x - mind.at.x, spot.at.y - mind.at.y, spot.at.z - mind.at.z) - spot.radius);
            mark.at = mind.at;
            if (shot) {
                const bolt = bolts[nextBolt++ % Math.max(1, bolts.length)];
                if (bolt) {
                    bolt.at = { x: mind.at.x + mind.way.x * NOSE, y: mind.at.y + mind.way.y * NOSE, z: mind.at.z + mind.way.z * NOSE };
                    bolt.way = shot;
                    bolt.flown = 0;
                    bolt.live = true;
                    foes.shots++;
                }
            }
            const rig = rigs[foe.slot]!;
            world.update(rig.root, Transform, (t) => {
                t.position = { ...mind.at };
                t.rotation = lookRotation([mind.at.x + mind.way.x, mind.at.y + mind.way.y, mind.at.z + mind.way.z], [mind.at.x, mind.at.y, mind.at.z]);
            });
            const rate = foe.hull <= RAIDER.hull / 2 ? 45 : 0;
            if (rig.smoke !== null && world.get(rig.smoke, ParticleEmitter).rate !== rate) world.update(rig.smoke, ParticleEmitter, (p) => { p.rate = rate; });
        }
        foes.berth = Math.min(foes.berth, berth);

        for (const bolt of bolts) {
            if (!bolt.live && bolt.flown < 0) continue;
            if (bolt.live) {
                const before = bolt.at;
                bolt.at = { x: before.x + (bolt.way.x * RAIDER.boltSpeed - way.x) * dt, y: before.y + (bolt.way.y * RAIDER.boltSpeed - way.y) * dt, z: before.z + (bolt.way.z * RAIDER.boltSpeed - way.z) * dt };
                bolt.flown += RAIDER.boltSpeed * dt;
                if (Math.hypot(bolt.at.x, bolt.at.y, bolt.at.z) < 140 && hullBlocks(before, bolt.at)) {
                    bolt.live = false;
                    if (ship.shield > 0) ship.shield = Math.max(0, ship.shield - RAIDER.shieldCost);
                    else ship.hull = Math.max(0, ship.hull - RAIDER.hullCost);
                    ship.struck = ship.time;
                    ship.stings.push({ at: turnBack(helm.attitude, bolt.at), weight: 0.55 });
                    foes.stung++;
                    puff(hullSparks, 40, bolt.at);
                } else if (bolt.flown > RAIDER.reach) {
                    bolt.live = false;
                }
            }
            const lit = bolt.live;
            world.update(bolt.entity, Transform, (t) => {
                t.position = { ...bolt.at };
                t.rotation = lookRotation([bolt.at.x, bolt.at.y, bolt.at.z], [bolt.at.x + bolt.way.x, bolt.at.y + bolt.way.y, bolt.at.z + bolt.way.z]);
                t.scale = lit ? { x: 0.55, y: 0.55, z: 6.5 } : { x: 0.001, y: 0.001, z: 0.001 };
            });
            if (!lit) bolt.flown = -1;
        }

        if (lamp !== null) {
            flash *= Math.exp(-dt * 3.2);
            world.update(lamp, Light, (l) => { l.intensity = flash > 0.01 ? 26 * flash : 0; });
        }
    };
}

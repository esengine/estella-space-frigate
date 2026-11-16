import { Material, MeshRenderer, Particle, Transform } from 'esengine';
import type { App, Entity, World } from 'esengine';
import { IMPACT, absorb, clearance, rockMass, spinFrom, strike, touch } from './collision';
import { helm, setEngine, turnBack, turnBy, type Vec } from './helm';
import { SHIELD } from './shieldShape';
import { DRIFTING_ROCKS, FIELD_DRIFT, FIELD_HALF_LENGTH, TOP_SPEED, ship } from './shipState';

const REACH = 70;

export function createImpacts(app: App): (world: World, dt: number, cruise: number, past: number, leaving: boolean) => void {
    let rocks: Entity[] | null = null;
    let sparks: Entity | null = null, dust: Entity | null = null, shield: Entity | null = null;
    const still = (): Vec => ({ x: 0, y: 0, z: 0 });
    const speeds: Vec[] = [], seen: (Vec | null)[] = [], quiet: number[] = [];
    let glow = 0, shown = false, down = -1;

    return (world, dt, cruise, past, leaving) => {
        if (rocks === null) {
            rocks = [];
            for (let i = 0; ; i++) {
                const found = world.findEntityByName(`Rock${i}`);
                if (found === null) break;
                rocks.push(found);
                speeds.push(still());
                seen.push(null);
                quiet.push(0);
            }
            sparks = world.findEntityByName('HullSparks');
            dust = world.findEntityByName('HullDust');
            shield = world.findEntityByName('Shield');
        }
        const forward = helm.forward, way = { x: forward.x * ship.speed * FIELD_DRIFT, y: forward.y * ship.speed * FIELD_DRIFT, z: forward.z * ship.speed * FIELD_DRIFT };
        const halves = [FIELD_HALF_LENGTH * 1.2, FIELD_HALF_LENGTH * 0.7, FIELD_HALF_LENGTH];
        let nearest = Infinity;
        rocks.forEach((rock, i) => {
            const t = world.get(rock, Transform), speed = speeds[i]!, before = seen[i]!;
            if (before && Math.hypot(t.position.x - before.x, t.position.y - before.y, t.position.z - before.z) > 150) speeds[i] = still();
            const drifts = i < DRIFTING_ROCKS, run = !drifts ? 0 : leaving ? past : cruise, v = speeds[i]!;
            const at = [t.position.x - forward.x * run + v.x * dt, t.position.y - forward.y * run + v.y * dt, t.position.z - forward.z * run + v.z * dt];
            if (!leaving && drifts) {
                for (let axis = 0; axis < 3; axis++) {
                    const half = halves[axis]!;
                    if (at[axis]! < -half) { at[axis] = at[axis]! + half * 2; speeds[i] = still(); }
                    else if (at[axis]! > half) { at[axis] = at[axis]! - half * 2; speeds[i] = still(); }
                }
            }
            const slow = Math.exp(-IMPACT.settle * dt);
            speeds[i] = { x: speeds[i]!.x * slow, y: speeds[i]!.y * slow, z: speeds[i]!.z * slow };
            quiet[i] = Math.max(0, quiet[i]! - dt);
            let place = { x: at[0]!, y: at[1]!, z: at[2]! };
            const radius = t.scale.x * IMPACT.rockBody;
            if (!leaving && Math.hypot(place.x, place.y, place.z) < radius + REACH) {
                const local = turnBack(helm.attitude, place);
                const contact = touch(local, radius);
                if (contact) {
                    const normal = turnBy(helm.attitude, contact.normal), point = turnBy(helm.attitude, contact.point);
                    place = { x: place.x + normal.x * contact.depth, y: place.y + normal.y * contact.depth, z: place.z + normal.z * contact.depth };
                    const rate = speeds[i]!;
                    const blow = strike({ x: rate.x - way.x, y: rate.y - way.y, z: rate.z - way.z }, normal, IMPACT.shipMass, rockMass(t.scale.x), IMPACT.restitution);
                    if (blow) {
                        speeds[i] = { x: rate.x + blow.rock.x, y: rate.y + blow.rock.y, z: rate.z + blow.rock.z };
                        const lost = (blow.ship.x * forward.x + blow.ship.y * forward.y + blow.ship.z * forward.z) / FIELD_DRIFT;
                        ship.speed = Math.max(-TOP_SPEED * 0.4, ship.speed + lost);
                        const spin = turnBack(helm.level, spinFrom(point, blow.ship));
                        helm.yawRate += spin.y;
                        helm.pitchRate -= spin.x;
                        helm.rollRate += spin.z;
                        if (blow.closing > IMPACT.felt && quiet[i] === 0) {
                            quiet[i] = 0.4;
                            const had = ship.shield;
                            const left = absorb(ship.shield, ship.hull, blow.energy);
                            ship.shield = left.shield;
                            ship.hull = left.hull;
                            ship.impacts++;
                            ship.struck = ship.time;
                            ship.blow = { rock: i, closing: blow.closing, shielded: had > 0 };
                            const weight = Math.min(1, blow.energy / (IMPACT.toll * 0.2));
                            const flash = app.getResource(Particle);
                            if (sparks !== null) flash.emitAt(sparks, Math.round(30 + 150 * weight), point);
                            if (dust !== null) flash.emitAt(dust, Math.round(8 + 20 * weight), point);
                            if (had > 0 && shield !== null) {
                                glow = Math.min(1, 0.45 + 0.55 * weight);
                                const from = { x: (contact.point.x - SHIELD.at.x) / SHIELD.scale.x, y: (contact.point.y - SHIELD.at.y) / SHIELD.scale.y, z: (contact.point.z - SHIELD.at.z) / SHIELD.scale.z };
                                const reach = Math.hypot(from.x, from.y, from.z) || 1;
                                Material.setUniform(world.get(shield, MeshRenderer).material, 'u_hit', { x: from.x / reach, y: from.y / reach, z: from.z / reach });
                            }
                        }
                    }
                }
                nearest = Math.min(nearest, clearance(turnBack(helm.attitude, place), radius));
            }
            t.position = place;
            world.insert(rock, Transform, t);
            seen[i] = { ...place };
        });
        ship.gap = nearest;
        ship.closest = Math.min(ship.closest, nearest);

        if (ship.time - ship.struck > IMPACT.regenAfter && ship.hull > 0) ship.shield = Math.min(1, ship.shield + IMPACT.regen * dt);
        if (ship.hull <= 0) {
            if (down < 0) { down = ship.time; ship.breaches++; }
            setEngine(0);
            if (ship.time - down > IMPACT.refit) { ship.hull = IMPACT.patched; down = -1; }
        }
        if (helm.arrived && ship.hull > 0) ship.hull = 1;

        for (const sting of ship.stings.splice(0)) {
            if (shield === null || ship.shield <= 0) continue;
            glow = Math.max(glow, sting.weight);
            const from = { x: (sting.at.x - SHIELD.at.x) / SHIELD.scale.x, y: (sting.at.y - SHIELD.at.y) / SHIELD.scale.y, z: (sting.at.z - SHIELD.at.z) / SHIELD.scale.z };
            const reach = Math.hypot(from.x, from.y, from.z) || 1;
            Material.setUniform(world.get(shield, MeshRenderer).material, 'u_hit', { x: from.x / reach, y: from.y / reach, z: from.z / reach });
        }
        if (shield !== null) {
            glow *= Math.exp(-dt * 2.4);
            const lit = glow > 0.01;
            if (lit !== shown) {
                shown = lit;
                world.update(shield, Transform, (t) => { t.scale = lit ? { ...SHIELD.scale } : { x: 0.001, y: 0.001, z: 0.001 }; });
            }
            if (lit) Material.setUniform(world.get(shield, MeshRenderer).material, 'u_glow', glow);
        }
    };
}

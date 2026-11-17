import { MeshRenderer, Transform, UIWorldAnchor } from 'esengine';
import type { Entity } from 'esengine';
import { helm, mulQuat, turnBy } from './helm';
import { AMBER, HAZE, ICE, KEPT_CLEAR, reach, rgb, type Frame, type Kit, type Rock } from './hudKit';
import { SHARED_ROCK, connectOnline, online, parkedRock } from './online';
import { tonnage, type Quat4, type Vec3 } from './shared/sector';
import { ship } from './shipState';

interface Seen { entity: Entity; tag: Entity; name: Entity; note: Entity; p: Vec3; q: Quat4; here: boolean }

export const pilotsSeen: { account: string; x: number; y: number; z: number; mining: boolean; sx: number; sy: number; sz: number }[] = [];

export function installSector(kit: Kit, rocks: readonly Rock[]): (frame: Frame) => void {
    if (!online.enabled) return () => undefined;
    const { world, root, textures, node, image, label, centred, say, ink, fade } = kit;
    const hull = world.findEntityByName('Hull');
    const hullMesh = hull === null ? null : { ...world.get(hull, MeshRenderer) };
    const hullAt = hull === null ? { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } : world.get(hull, Transform);
    const seat = { position: { ...hullAt.position }, rotation: { ...hullAt.rotation }, scale: { ...hullAt.scale } };
    const majors = rocks.filter((rock) => rock.big && rock.foe === undefined);
    rocks.forEach((rock, i) => {
        if (!parkedRock(i)) return;
        world.update(rock.entity, Transform, (t) => { t.position = { x: 1e7 + i * 1e4, y: 1e7, z: 1e7 }; });
        world.update(rock.entity, MeshRenderer, (m) => { m.enabled = false; });
    });
    const shared = rocks[SHARED_ROCK]!;
    const seen = new Map<string, Seen>();
    connectOnline();

    const meet = (account: string, p: Vec3, q: Quat4): Seen => {
        const entity = world.spawn(`Pilot ${account}`);
        world.insert(entity, Transform, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { ...seat.scale } });
        if (hullMesh) world.insert(entity, MeshRenderer, { ...hullMesh });
        const tag = centred(node(root, `PilotTag ${account}`, { left: 0, top: 0, width: 44, height: 44 }), 44, 44);
        world.insert(tag, UIWorldAnchor, { clampToEdges: true, edgeMargin: 96, edgeInsets: { ...KEPT_CLEAR } });
        world.update(tag, UIWorldAnchor, (anchored) => { anchored.target = entity; });
        image(tag, `PilotBracket ${account}`, { left: 0, top: 0, width: 44, height: 44 }, textures.bracket, rgb(AMBER, 0.9));
        const name = label(tag, `PilotName ${account}`, { left: 52, top: 6, width: 240, height: 14 }, { size: 11, color: rgb(AMBER), spacing: 2.6 });
        const note = label(tag, `PilotNote ${account}`, { left: 52, top: 23, width: 240, height: 14 }, { size: 10, color: rgb(HAZE), spacing: 1.6, strong: false });
        return { entity, tag, name, note, p: [...p] as Vec3, q: [...q] as Quat4, here: true };
    };

    return (frame) => {
        if (online.leap) {
            const by = { x: online.leap[0], y: online.leap[1], z: online.leap[2] };
            for (const major of majors) world.update(major.entity, Transform, (t) => { t.position = { x: t.position.x - by.x, y: t.position.y - by.y, z: t.position.z - by.z }; });
            online.leap = null;
        }
        const me = online.pos, rock = online.rock.at;
        // In a sector the helm's waypoint is the station: its marker, its range and the autopilot that steers for it all lead there.
        const station = online.station;
        helm.gate = { x: station.at[0] - me[0], y: station.at[1] - me[1], z: station.at[2] - me[2] };
        helm.gateName = station.name;
        const there = { x: rock[0] - me[0], y: rock[1] - me[1], z: rock[2] - me[2] };
        world.update(shared.entity, Transform, (t) => { t.position = there; });
        shared.at.x = there.x; shared.at.y = there.y; shared.at.z = there.z;

        for (const one of seen.values()) one.here = false;
        // Each ship is drawn where her last report puts her now, carried on by the way she was making, and eased toward it so a late report does not jerk her.
        const share = Math.min(1, frame.dt * 12), since = Math.min(0.25, Math.max(0, (Date.now() - online.othersAt) / 1000));
        pilotsSeen.length = 0;
        for (const other of online.others) {
            let one = seen.get(other.account);
            if (!one) { one = meet(other.account, other.p, other.q); seen.set(other.account, one); }
            one.here = true;
            for (let axis = 0; axis < 3; axis++) one.p[axis] = one.p[axis]! + (other.p[axis]! + other.v[axis]! * since - one.p[axis]!) * share;
            const same = one.q[0] * other.q[0] + one.q[1] * other.q[1] + one.q[2] * other.q[2] + one.q[3] * other.q[3] < 0 ? -1 : 1;
            for (let axis = 0; axis < 4; axis++) one.q[axis] = one.q[axis]! + (other.q[axis]! * same - one.q[axis]!) * share;
            const length = Math.hypot(one.q[0], one.q[1], one.q[2], one.q[3]) || 1;
            const facing = { x: one.q[0] / length, y: one.q[1] / length, z: one.q[2] / length, w: one.q[3] / length };
            const off = turnBy(facing, seat.position);
            const at = { x: one.p[0] - me[0] + off.x, y: one.p[1] - me[1] + off.y, z: one.p[2] - me[2] + off.z };
            const turned = mulQuat(facing, seat.rotation);
            world.update(one.entity, Transform, (t) => { t.position = at; t.rotation = turned; });
            if (hullMesh && !world.get(one.entity, MeshRenderer).enabled) world.update(one.entity, MeshRenderer, (m) => { m.enabled = true; });
            fade(one.tag, ship.away ? 0 : 1);
            say(one.name, other.name);
            say(one.note, `${reach(Math.hypot(at.x, at.y, at.z))}   ${other.docked ? 'DOCKED   ' : other.mining ? 'MINING   ' : ''}${tonnage(other.cargo)} T`);
            ink(one.note, other.mining ? rgb(AMBER) : rgb(HAZE));
            ink(one.name, rgb(other.mining ? AMBER : ICE));
            pilotsSeen.push({ account: other.account, x: at.x, y: at.y, z: at.z, mining: other.mining, sx: one.p[0], sy: one.p[1], sz: one.p[2] });
        }
        for (const one of seen.values()) {
            if (one.here) continue;
            fade(one.tag, 0);
            if (hullMesh && world.get(one.entity, MeshRenderer).enabled) world.update(one.entity, MeshRenderer, (m) => { m.enabled = false; });
        }
    };
}

import { berthOf, type Mooring, type Vec3 } from './shared/sector';
import { HULL, HULL_BALL, STRUCTURE, crosses } from './shared/stationShape';

// The camera while the station has the ship in hand: a harbour's way of showing a heavy ship brought to her berth and taken out
// of it. Which shot is up is read from where the server has her and what it says of her, never from a clock, so it cannot run
// ahead of the manoeuvre, repeat itself, or call her docked before the server does.

export type Shot = 'takeover' | 'settle' | 'berthed' | 'lift' | 'clear' | 'handover';
/** A camera in the sector's own coordinates: where it stands, what it looks at, and its field of view in degrees. */
export interface Rig { eye: Vec3; target: Vec3; fov: number }

export const DIRECTOR = {
    /** She is "coming down" once this far below the height she crosses at, and "nearly in" within this of her berth. */
    descending: 1, nearBerth: 35,
    /** On the way out she is "handed back" within this of the point she is let go at. */
    nearRelease: 32,
    /** How quickly the camera follows a new shot, seconds: about eight tenths of a second to be there. */
    ease: 0.28,
    /** How long the hand-back to the pilot's own view takes once she is let go, seconds. */
    release: 0.7,
    /** The warehouse panel waits this long after she is confirmed docked, and takes this long to come up. */
    panelAfter: 0.55, panelFade: 0.45,
    /** How far the composed target is carried to the right of her when she lies in her berth, so she sits left and the panel has the right. */
    aside: 70,
    /** The pilot's own view she is handed back to: astern and above, bow away. */
    chase: { yaw: Math.PI, pitch: 0.26, distance: 150, height: 6, along: 10 },
} as const;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mix = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const apart = (a: Vec3, b: Vec3): number => length(sub(a, b));

/**
 * The shot for a ship in the station's hands, from where she is. Coming in: the harbour's long view until she starts down,
 * the three-quarter view while she comes down, and the settled view for the last of it and for as long as she lies there,
 * docked or still waiting to be written down. Going out: with her as she lifts, drawn back as she is carried clear, and round
 * behind her for the last of the way to where she is let go. Null when she is her pilot's.
 */
export function shotFor(mooring: Mooring, ship: Vec3, berthId: number): Shot | null {
    const berth = berthOf(berthId);
    if (!berth) return null;
    if (mooring === 'docked') return 'berthed';
    if (mooring === 'docking') {
        if (ship[1] >= berth.over[1] - DIRECTOR.descending || Math.hypot(ship[0] - berth.at[0], ship[2] - berth.at[2]) > 0.5) return 'takeover';
        return ship[1] - berth.at[1] > DIRECTOR.nearBerth ? 'settle' : 'berthed';
    }
    if (mooring === 'undocking') {
        if (ship[1] < berth.over[1] - DIRECTOR.descending) return 'lift';
        return apart(ship, [...berth.approach] as Vec3) > DIRECTOR.nearRelease ? 'clear' : 'handover';
    }
    return null;
}

/** Outward from the wing at a berth: +x for the berth on that side, -x for the other. Up is +y and a berthed bow points +z. */
export const outward = (berthId: number): number => ((berthOf(berthId)?.at[0] ?? 1) >= 0 ? 1 : -1);

/**
 * Where the camera stands for a shot. Every offset is in the berth's own directions (outward, up, bow), so the two berths get
 * the same pictures mirrored; all of it is in sector coordinates, to be drawn about the ship afterwards.
 */
export function rigFor(shot: Shot, ship: Vec3, berthId: number): Rig {
    const berth = berthOf(berthId)!, P: Vec3 = [...berth.at] as Vec3, o = outward(berthId);
    const off = (out: number, up: number, bow: number): Vec3 => [o * out, up, bow];
    switch (shot) {
        // The harbour's view: outside and high, the ship, the berth she is bound for and the wing between them all in frame.
        case 'takeover': return { eye: add(P, off(250, 215, 190)), target: mix(ship, add(P, [0, 30, 0]), 0.45), fov: 42 };
        // Off her bow quarter and above, coming down with her as the berth closes round her.
        case 'settle': return { eye: add(ship, off(165, 79, 114)), target: add(ship, [0, 4, 4]), fov: 36 };
        // The same quarter, still: she sits left of frame and the right is left clear for the warehouse.
        case 'berthed': return { eye: add(ship, off(215, 100, 150)), target: add(ship, asideOf(off(215, 100, 150), DIRECTOR.aside)), fov: 36 };
        // Off her quarter astern and above: the berth falls away below and the station stands behind for height.
        case 'lift': return { eye: add(ship, off(168, 125, -150)), target: add(ship, [0, 4, 0]), fov: 40 };
        // The same side, drawn back, so the water between her and the station is seen to widen.
        case 'clear': return { eye: add(ship, off(205, 140, -186)), target: add(ship, [0, 4, 0]), fov: 40 };
        // Round behind her and above, her bow ahead: the view her pilot is handed.
        case 'handover': return { eye: add(ship, off(40, 55, -200)), target: add(ship, [0, 0, 50]), fov: 34 };
    }
}

/** A point `by` units to the camera's right of what it stands `from`, level: looking there puts the ship that far left of centre. */
function asideOf(from: Vec3, by: number): Vec3 {
    // Looking from `from` toward the origin, right is the level direction a quarter turn clockwise from the line of sight.
    const flat = Math.hypot(from[0], from[2]) || 1, sight: Vec3 = [-from[0] / flat, 0, -from[2] / flat];
    return [-sight[2] * by, 4, sight[0] * by];
}

/** The fall-back when a shot's camera would be in the station or have it across the ship: outside and high, looking at her. */
export function fallbackRig(ship: Vec3, berthId: number): Rig {
    const berth = berthOf(berthId)!, o = outward(berthId);
    return { eye: [berth.at[0] + o * 300, berth.at[1] + 250, berth.at[2] + 220], target: [...ship] as Vec3, fov: 42 };
}

/**
 * Whether a camera at `eye` looking at the ship is in the station, or has part of it between it and her. The line is taken
 * to the edge of the ball that holds her, not to her middle: the berth frame she lies in is close about her and is meant to be seen.
 */
export function blocked(eye: Vec3, ship: Vec3): boolean {
    const far = apart(eye, ship);
    if (far <= HULL_BALL) return true;
    const edge = mix(ship, eye, HULL_BALL / far);
    return STRUCTURE.some((part) => crosses(eye, edge, part, 2));
}

/** Where a point lands on the screen for a rig: x and y from 0 to 1, left to right and top to bottom, and whether it is in front. */
export function project(rig: Rig, point: Vec3, aspect: number): { x: number; y: number; ahead: boolean } {
    const f = sub(rig.target, rig.eye), fl = length(f) || 1, fwd: Vec3 = [f[0] / fl, f[1] / fl, f[2] / fl];
    let right: Vec3 = [-fwd[2], 0, fwd[0]];
    const rl = length(right) || 1;
    right = [right[0] / rl, 0, right[2] / rl];
    const up: Vec3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const d = sub(point, rig.eye), z = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
    const tan = Math.tan((rig.fov * Math.PI) / 360), depth = Math.max(z, 1e-6);
    const x = (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) / (depth * tan * aspect), y = (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / (depth * tan);
    return { x: 0.5 + x / 2, y: 0.5 - y / 2, ahead: z > 0 };
}

/** The frigate's box on the screen, lying to the berths' heading at `ship`: its edges from 0 to 1, and whether all of it is in frame. */
export function frameOf(rig: Rig, ship: Vec3, aspect: number): { left: number; right: number; top: number; bottom: number; whole: boolean; width: number } {
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, ahead = true;
    for (let corner = 0; corner < 8; corner++) {
        const at: Vec3 = [ship[0] + (corner & 1 ? HULL.max[0] : HULL.min[0]), ship[1] + (corner & 2 ? HULL.max[1] : HULL.min[1]), ship[2] + (corner & 4 ? HULL.max[2] : HULL.min[2])];
        const seen = project(rig, at, aspect);
        ahead &&= seen.ahead;
        left = Math.min(left, seen.x); right = Math.max(right, seen.x); top = Math.min(top, seen.y); bottom = Math.max(bottom, seen.y);
    }
    return { left, right, top, bottom, whole: ahead && left >= 0 && right <= 1 && top >= 0 && bottom <= 1, width: right - left };
}

export type Action = '' | 'in' | 'out';
const actionOf = (mooring: Mooring): Action => (mooring === 'docking' || mooring === 'docked' ? 'in' : mooring === 'undocking' ? 'out' : '');

export const director = {
    /** Whether the director has the camera this frame, the shot it is on, and how much of the picture is its (0 to 1, eased). */
    on: false, shot: null as Shot | null, presence: 0,
    /** The camera it is holding, eased, in sector coordinates. */
    eye: [0, 0, 0] as Vec3, target: [0, 0, 0] as Vec3, fov: 34,
    /** The pilot took the view back during this manoeuvre: it is hers until the next one begins. */
    dismissed: false, action: '' as Action,
    /** The shot's own camera was in the station or had it in the way, and the high view outside is used instead. */
    fellBack: false, fallbacks: 0,
    /** Times the camera went straight to a shot because the way round to it lay through the ship or the station. */
    cuts: 0,
    /** How many times this sign-in she has been confirmed docked by the server while watched: each is one chime, no more. */
    confirmed: 0,
    /** Seconds since the server confirmed her docked (or since she was found docked on signing in), for the panel to come up by. */
    sinceDocked: 0,
    /** How many shots have been shown this sign-in, in order: a check reads it to see none was repeated. */
    shown: [] as Shot[],
    /** The frigate's box on the screen under the director's camera, for a check to read. */
    frame: { left: 0, right: 0, top: 0, bottom: 0, whole: false, width: 0 },
    primed: false,
    lastMooring: 'none' as Mooring,
};

export interface DirectorInput {
    dt: number; mooring: Mooring; berth: number; ship: Vec3; aspect: number;
    /** The pilot's own camera now, in sector coordinates: where the director starts from, and what it hands back to. */
    own: Rig;
    /** The pilot dragged the view, or asked for a view of her own, this frame. */
    took: boolean;
    /** The server's word on her was just received for the first time this sign-in: a ship found docked is not being brought in. */
    arrivedDocked: boolean;
}

/**
 * A frame of the director. Returns the camera to use, or null when the view is the pilot's. It takes the camera only while
 * the station has the ship, gives it up the frame she is let go (easing out of it afterwards costs her no input), and stays
 * out of it for the rest of a manoeuvre once she has taken the view herself.
 */
export function stepDirector(input: DirectorInput): Rig | null {
    const d = director, action = actionOf(input.mooring), was = d.action;
    if (action !== was) {
        d.action = action;
        d.dismissed = false;
        if (action === 'in' && was !== 'in') d.sinceDocked = input.mooring === 'docked' ? DIRECTOR.panelAfter + DIRECTOR.panelFade : 0;
    }
    if (input.took && action !== '') d.dismissed = true;
    const shot = d.dismissed ? null : shotFor(input.mooring, input.ship, input.berth);
    // Confirmed docked: counted once, when the server's word changes to it while she was being brought in.
    if (input.mooring === 'docked') {
        if (d.lastMooring === 'docking' && !input.arrivedDocked) { d.confirmed++; d.sinceDocked = 0; }
        d.sinceDocked += input.dt;
    }
    d.lastMooring = input.mooring;

    const k = 1 - Math.exp(-Math.max(0, input.dt) / DIRECTOR.ease);
    if (shot === null) {
        d.on = false; d.shot = null; d.fellBack = false;
        // Handed back: what is left of the director's picture is eased into the pilot's own, and her helm is already hers.
        d.presence = Math.max(0, d.presence - Math.max(0, input.dt) / DIRECTOR.release);
        if (d.presence <= 0) { d.primed = false; return null; }
        const share = d.presence * d.presence * (3 - 2 * d.presence);
        return { eye: mix(input.own.eye, d.eye, share), target: mix(input.own.target, d.target, share), fov: input.own.fov + (d.fov - input.own.fov) * share };
    }
    let want = rigFor(shot, input.ship, input.berth);
    d.fellBack = blocked(want.eye, input.ship);
    if (d.fellBack) { want = fallbackRig(input.ship, input.berth); if (d.shot !== shot || !d.on) d.fallbacks++; }
    if (!d.primed) {
        // The first frame it has the camera this manoeuvre: from the pilot's own view if she was flying, straight to the shot
        // if she has just signed in to a ship already in the station's hands.
        d.primed = true;
        const start = input.arrivedDocked || d.presence <= 0 && was === action && action !== '' ? want : input.own;
        d.eye = [...start.eye] as Vec3; d.target = [...start.target] as Vec3; d.fov = start.fov;
    }
    if (d.shot !== shot) { d.shown.push(shot); if (d.shown.length > 64) d.shown.shift(); }
    d.on = true; d.shot = shot; d.presence = 1;
    d.eye = mix(d.eye, want.eye, k); d.target = mix(d.target, want.target, k); d.fov += (want.fov - d.fov) * k;
    // A camera on its way between two shots is not left inside the station: if the eased place has it in the way, it goes to where it is bound.
    // That is a cut, not a fall-back: the shot itself is the one meant.
    if (blocked(d.eye, input.ship) && !d.fellBack) { d.eye = [...want.eye] as Vec3; d.target = [...want.target] as Vec3; d.fov = want.fov; d.cuts++; }
    d.frame = frameOf({ eye: d.eye, target: d.target, fov: d.fov }, input.ship, input.aspect);
    return { eye: [...d.eye] as Vec3, target: [...d.target] as Vec3, fov: d.fov };
}

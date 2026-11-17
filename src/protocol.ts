import { defineContract, proto } from 'esengine/session';
import * as pb from './proto/sector';
import type { Quat4, Refusal, Vec3 } from './shared/sector';
import { unitQuat, type Flight } from './shared/steer';

export const contract = defineContract({
    requests: {
        enter: { req: proto(pb.Empty), res: proto(pb.EnterReply) },
        // The helm's orders and nothing else: there is no request by which a client says where its ship is.
        steer: { req: proto(pb.SteerRequest, (steer) => { if (steer.orders.length > 32) throw new Error('too many orders in one request'); }), res: proto(pb.SteerReply) },
        mine: { req: proto(pb.MineRequest), res: proto(pb.MineReply) },
    },
    events: { state: proto(pb.StateEvent) },
});

export interface Credentials { account: string; token: string; contract: string }

export const toVec = (v: Vec3): pb.Vec3 => ({ x: v[0], y: v[1], z: v[2] });
export const toQuat = (q: Quat4): pb.Quat => ({ x: q[0], y: q[1], z: q[2], w: q[3] });
export const fromVec = (v: pb.Vec3 | undefined): Vec3 => [v?.x ?? 0, v?.y ?? 0, v?.z ?? 0];
export const fromQuat = (q: pb.Quat | undefined): Quat4 => [q?.x ?? 0, q?.y ?? 0, q?.z ?? 0, q?.w ?? 1];

export const toFlight = (f: Flight): pb.Flight => ({ p: { ...f.pos }, level: { ...f.level }, yawRate: f.yawRate, pitchRate: f.pitchRate, rollRate: f.rollRate, bank: f.bank, throttle: f.throttle, speed: f.speed });
export const fromFlight = (f: pb.Flight | undefined): Flight => ({
    pos: { x: f?.p?.x ?? 0, y: f?.p?.y ?? 0, z: f?.p?.z ?? 0 }, level: unitQuat({ x: f?.level?.x ?? 0, y: f?.level?.y ?? 0, z: f?.level?.z ?? 0, w: f?.level?.w ?? 1 }),
    yawRate: f?.yawRate ?? 0, pitchRate: f?.pitchRate ?? 0, rollRate: f?.rollRate ?? 0, bank: f?.bank ?? 0, throttle: f?.throttle ?? 0, speed: f?.speed ?? 0,
});

const REFUSALS: Record<Refusal, pb.Refusal> = {
    '': pb.Refusal.REFUSAL_NONE,
    'NOT MINING': pb.Refusal.REFUSAL_NOT_MINING,
    'OUT OF RANGE': pb.Refusal.REFUSAL_OUT_OF_RANGE,
    'ROCK EXHAUSTED': pb.Refusal.REFUSAL_ROCK_EXHAUSTED,
    'HOLD FULL': pb.Refusal.REFUSAL_HOLD_FULL,
};
export const toRefusal = (why: Refusal): pb.Refusal => REFUSALS[why];
export const fromRefusal = (why: pb.Refusal): Refusal => (Object.keys(REFUSALS) as Refusal[]).find((text) => REFUSALS[text] === why) ?? 'NOT MINING';

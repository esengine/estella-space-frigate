import { defineContract, proto } from 'esengine/session';
import * as pb from './proto/sector';
import type { Quat4, Refusal, Vec3 } from './shared/sector';

const real = (...values: (number | undefined)[]): void => { for (const v of values) if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('not a finite number'); };

export const contract = defineContract({
    requests: {
        enter: { req: proto(pb.Empty), res: proto(pb.EnterReply) },
        pose: {
            req: proto(pb.PoseRequest, (pose) => {
                if (!pose.p || !pose.q) throw new Error('a pose needs a position and a facing');
                real(pose.p.x, pose.p.y, pose.p.z, pose.q.x, pose.q.y, pose.q.z, pose.q.w, pose.throttle);
            }),
            res: proto(pb.Empty),
        },
        mine: { req: proto(pb.MineRequest), res: proto(pb.MineReply) },
    },
    events: { state: proto(pb.StateEvent) },
});

export interface Credentials { account: string; token: string; contract: string }

export const toVec = (v: Vec3): pb.Vec3 => ({ x: v[0], y: v[1], z: v[2] });
export const toQuat = (q: Quat4): pb.Quat => ({ x: q[0], y: q[1], z: q[2], w: q[3] });
export const fromVec = (v: pb.Vec3 | undefined): Vec3 => [v?.x ?? 0, v?.y ?? 0, v?.z ?? 0];
export const fromQuat = (q: pb.Quat | undefined): Quat4 => [q?.x ?? 0, q?.y ?? 0, q?.z ?? 0, q?.w ?? 1];

const REFUSALS: Record<Refusal, pb.Refusal> = {
    '': pb.Refusal.REFUSAL_NONE,
    'NOT MINING': pb.Refusal.REFUSAL_NOT_MINING,
    'OUT OF RANGE': pb.Refusal.REFUSAL_OUT_OF_RANGE,
    'ROCK EXHAUSTED': pb.Refusal.REFUSAL_ROCK_EXHAUSTED,
    'HOLD FULL': pb.Refusal.REFUSAL_HOLD_FULL,
};
export const toRefusal = (why: Refusal): pb.Refusal => REFUSALS[why];
export const fromRefusal = (why: pb.Refusal): Refusal => (Object.keys(REFUSALS) as Refusal[]).find((text) => REFUSALS[text] === why) ?? 'NOT MINING';

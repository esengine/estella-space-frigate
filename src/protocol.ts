import { defineContract, proto } from 'esengine/session';
import * as pb from './proto/sector';
import type { DockRefusal, Mooring, Quat4, Refusal, TransferRefusal, Vec3 } from './shared/sector';
import { unitQuat, type Flight } from './shared/steer';

export const contract = defineContract({
    requests: {
        enter: { req: proto(pb.Empty), res: proto(pb.EnterReply) },
        // The helm's orders and nothing else: there is no request by which a client says where its ship is.
        steer: { req: proto(pb.SteerRequest, (steer) => { if (steer.orders.length > 32) throw new Error('too many orders in one request'); }), res: proto(pb.SteerReply) },
        mine: { req: proto(pb.MineRequest), res: proto(pb.MineReply) },
        dock: { req: proto(pb.DockRequest), res: proto(pb.DockReply) },
        // Between the sender's own hold and the sender's own warehouse. What is wrong with an amount is the rules' to say, as a refusal: nothing is checked here.
        transfer: { req: proto(pb.TransferRequest), res: proto(pb.TransferReply) },
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

const DOCKS: Record<DockRefusal, pb.DockRefusal> = {
    '': pb.DockRefusal.DOCK_REFUSAL_NONE, 'TOO FAR': pb.DockRefusal.DOCK_REFUSAL_TOO_FAR, 'TOO FAST': pb.DockRefusal.DOCK_REFUSAL_TOO_FAST,
    'NO BERTH FREE': pb.DockRefusal.DOCK_REFUSAL_NO_BERTH_FREE, 'MANEUVERING': pb.DockRefusal.DOCK_REFUSAL_MANEUVERING, 'NOT SAVED': pb.DockRefusal.DOCK_REFUSAL_NOT_SAVED,
};
const MOORED: Record<Mooring, pb.Mooring> = {
    none: pb.Mooring.MOORING_NONE, assigned: pb.Mooring.MOORING_ASSIGNED, docking: pb.Mooring.MOORING_DOCKING, docked: pb.Mooring.MOORING_DOCKED, undocking: pb.Mooring.MOORING_UNDOCKING,
};
export const toMooring = (mooring: Mooring): pb.Mooring => MOORED[mooring];
export const fromMooring = (mooring: pb.Mooring): Mooring => (Object.keys(MOORED) as Mooring[]).find((text) => MOORED[text] === mooring) ?? 'none';
export const toDockRefusal = (why: DockRefusal): pb.DockRefusal => DOCKS[why];
export const fromDockRefusal = (why: pb.DockRefusal): DockRefusal => (Object.keys(DOCKS) as DockRefusal[]).find((text) => DOCKS[text] === why) ?? 'TOO FAR';

const TRANSFERS: Record<TransferRefusal, pb.TransferRefusal> = {
    '': pb.TransferRefusal.TRANSFER_REFUSAL_NONE,
    'NOT DOCKED': pb.TransferRefusal.TRANSFER_REFUSAL_NOT_DOCKED,
    'BAD AMOUNT': pb.TransferRefusal.TRANSFER_REFUSAL_BAD_AMOUNT,
    'NOT ENOUGH IN THE HOLD': pb.TransferRefusal.TRANSFER_REFUSAL_NOT_ENOUGH_IN_HOLD,
    'NOT ENOUGH IN THE WAREHOUSE': pb.TransferRefusal.TRANSFER_REFUSAL_NOT_ENOUGH_IN_WAREHOUSE,
    'HOLD FULL': pb.TransferRefusal.TRANSFER_REFUSAL_HOLD_FULL,
    'BAD ORDER': pb.TransferRefusal.TRANSFER_REFUSAL_BAD_ORDER,
    'EXPIRED': pb.TransferRefusal.TRANSFER_REFUSAL_EXPIRED,
    'OUT OF ORDER': pb.TransferRefusal.TRANSFER_REFUSAL_OUT_OF_ORDER,
    'NOT SAVED': pb.TransferRefusal.TRANSFER_REFUSAL_NOT_SAVED,
};
export const toTransferRefusal = (why: TransferRefusal): pb.TransferRefusal => TRANSFERS[why];
export const fromTransferRefusal = (why: pb.TransferRefusal): TransferRefusal => (Object.keys(TRANSFERS) as TransferRefusal[]).find((text) => TRANSFERS[text] === why) ?? 'BAD ORDER';

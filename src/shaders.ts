import type { App } from 'esengine';

export const SETTLED_FRAMES = 12;

export const pendingShaders = (app: App): number =>
    (app as unknown as { wasmModule?: { renderer_getPendingShaders?: () => number } }).wasmModule?.renderer_getPendingShaders?.() ?? 0;

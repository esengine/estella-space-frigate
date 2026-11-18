import type { App } from 'esengine';

export const SETTLED_FRAMES = 12;

export const pendingShaders = (app: App): number => {
    // While the browser has the drawing context away the engine's programs are gone and asking after them throws; nothing is
    // compiling then, and the question must not be what stops the system that asked it.
    try { return (app as unknown as { wasmModule?: { renderer_getPendingShaders?: () => number } }).wasmModule?.renderer_getPendingShaders?.() ?? 0; } catch { return 0; }
};

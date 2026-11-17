import { Material, MeshRenderer } from 'esengine';
import type { App, Entity, World } from 'esengine';
import { kindSwitches, type Kind } from './worlds';

interface Programs {
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAPU32: Uint32Array;
    engine_prepareMeshPrograms?(rowsPtr: number, count: number, outPtr: number): void;
}

export function showKind(material: number, kind: Kind): void {
    Material.recompile(material, kindSwitches(kind));
}

export function readyKind(app: App, world: World, planet: Entity, kind: Kind): void {
    const module = (app as unknown as { wasmModule?: Programs }).wasmModule;
    if (!module?.engine_prepareMeshPrograms) return;
    const drawn = world.get(planet, MeshRenderer);
    const spare = Material.createInstance(drawn.material);
    try {
        Material.recompile(spare, kindSwitches(kind));
        const row = [drawn.mesh, drawn.lit ? 1 : 0, drawn.normalMap, 0, spare];
        const rows = module._malloc(row.length * 4), out = module._malloc(11 * 4);
        try {
            module.HEAPU32.set(row, rows >> 2);
            module.engine_prepareMeshPrograms(rows, 1, out);
        } finally {
            module._free(rows);
            module._free(out);
        }
    } finally {
        Material.release(spare);
    }
}

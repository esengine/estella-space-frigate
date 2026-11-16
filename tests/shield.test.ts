import { readFileSync } from 'node:fs';
import { decodeMesh } from '../../../sdk/src/asset/meshFormat';
import { SHIELD } from '../src/shieldShape';

const radiusAt = (z: number): number => {
    const profile = SHIELD.profile;
    for (let i = 1; i < profile.length; i++) {
        const [r0, z0] = profile[i - 1]!, [r1, z1] = profile[i]!;
        if (z >= z0 && z <= z1) return r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
    }
    return 0;
};

const fill = (p: readonly number[]): number => {
    const across = Math.hypot((p[0]! - SHIELD.at.x) / SHIELD.scale.x, (p[1]! - SHIELD.at.y) / SHIELD.scale.y);
    const room = radiusAt((p[2]! - SHIELD.at.z) / SHIELD.scale.z);
    return room > 0 ? across / room : Infinity;
};

describe('the shield', () => {
    it('wraps every vertex of the hull, with room to spare', () => {
        const mesh = decodeMesh(new Uint8Array(readFileSync('assets/models/frigate.esmesh')));
        const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
        let worst = 0;
        for (let i = 0; i < mesh.vertexCount; i++) {
            const o = i * mesh.vertexStride + mesh.channels[0]!.offset;
            const p = [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)];
            worst = Math.max(worst, fill(p));
        }
        expect(mesh.vertexCount).toBeGreaterThan(1000);
        expect(worst).toBeLessThan(0.94);
    });

    it('wraps the lamps and the guns that stand off the hull', () => {
        const proud = [[0, 23.1, -24.3], [0, -10.95, -12], [17, 3.05, -20], [-17, 3.05, -20], [3.3, -0.1, 59.1], [0, 12, 27], [0, 12, 13], [9, 9, -12], [-9, 9, -12], [0, -13, 10], [0, 4, 36]];
        for (const p of proud) expect(fill(p)).toBeLessThan(0.97);
    });

    it('is not a bubble far bigger than the ship', () => {
        const widest = Math.max(...SHIELD.profile.map(([r]) => r));
        expect(widest * SHIELD.scale.x).toBeLessThan(21.5 * 1.7);
    });
});

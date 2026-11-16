export const GROUND_ID = 'space-frigate:ground';
export const GROUND_VERSION = 1;

export interface GroundRegion { world: string; seed: number; radius: number; directions: Float32Array; count: number }

export function groundSample(region: GroundRegion): { heights: Float32Array; paint: Float32Array } {
    const seed = region.seed | 0;
    const hash = (x: number, y: number, z: number): number => {
        let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593) ^ Math.imul(seed, 0x9e3779b1);
        h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
        h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const noise = (px: number, py: number, pz: number): number => {
        const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        const fx = px - ix, fy = py - iy, fz = pz - iz;
        const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
        const a = hash(ix, iy, iz), b = hash(ix + 1, iy, iz), c = hash(ix, iy + 1, iz), d = hash(ix + 1, iy + 1, iz);
        const e = hash(ix, iy, iz + 1), f = hash(ix + 1, iy, iz + 1), g = hash(ix, iy + 1, iz + 1), k = hash(ix + 1, iy + 1, iz + 1);
        const x0 = a + (b - a) * ux, x1 = c + (d - c) * ux, x2 = e + (f - e) * ux, x3 = g + (k - g) * ux;
        const y0 = x0 + (x1 - x0) * uy, y1 = x2 + (x3 - x2) * uy;
        return (y0 + (y1 - y0) * uz) * 2 - 1;
    };
    const fbm = (px: number, py: number, pz: number, octaves: number): number => {
        let sum = 0, amp = 0.5, total = 0;
        for (let o = 0; o < octaves; o++) {
            sum += amp * noise(px, py, pz);
            total += amp;
            amp *= 0.5;
            px = px * 2.03 + 17.1; py = py * 2.03 + 3.7; pz = pz * 2.03 + 9.3;
        }
        return sum / total;
    };
    const ridged = (px: number, py: number, pz: number, octaves: number): number => {
        let sum = 0, amp = 0.5, total = 0, weight = 1;
        for (let o = 0; o < octaves; o++) {
            const r = 1 - Math.abs(noise(px, py, pz));
            const v = r * r * weight;
            weight = Math.min(1, v * 2);
            sum += amp * v;
            total += amp;
            amp *= 0.5;
            px = px * 2.11 + 5.3; py = py * 2.11 + 11.9; pz = pz * 2.11 + 2.1;
        }
        return sum / total;
    };
    const smooth = (a: number, b: number, v: number): number => {
        const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
        return t * t * (3 - 2 * t);
    };
    const style = region.world === 'ocean' ? 1 : region.world === 'lava' ? 2 : 0;
    const r = region.radius;
    const height = (dx: number, dy: number, dz: number): number => {
        const x = dx * r, y = dy * r, z = dz * r;
        const warp = 1400 * fbm(x / 6000 + 31.7, y / 6000 - 8.2, z / 6000 + 4.4, 3);
        const wx = x + warp, wy = y - warp * 0.6, wz = z + warp * 0.8;
        const land = fbm(wx / 14000, wy / 14000, wz / 14000, 5);
        if (style === 1) {
            const isle = smooth(0.08, 0.32, land);
            const crest = ridged(wx / 2600, wy / 2600, wz / 2600, 6);
            const swell = fbm(wx / 900, wy / 900, wz / 900, 4);
            return -520 + 600 * isle + 1300 * crest * crest * isle + 60 * swell;
        }
        if (style === 2) {
            const flow = ridged(wx / 3000, wy / 3000, wz / 3000, 6);
            const cone = Math.max(0, 1 - Math.abs(fbm(wx / 9000 + 3.3, wy / 9000, wz / 9000, 3)) * 4);
            const crack = 1 - Math.abs(fbm(wx / 1100, wy / 1100, wz / 1100, 4));
            return -260 + 420 * land + 900 * flow * flow + 1300 * cone * cone * cone - 180 * Math.pow(crack, 10);
        }
        const highland = smooth(-0.25, 0.35, land);
        const range = ridged(wx / 4200, wy / 4200, wz / 4200, 6);
        const raw = 520 * land + 1350 * range * range * highland + 60 * fbm(wx / 700, wy / 700, wz / 700, 4);
        const step = 140, terrace = Math.floor(raw / step), within = raw / step - terrace;
        const shelf = terrace + smooth(0.55, 0.95, within);
        return raw + (shelf * step - raw) * 0.7 * highland;
    };
    const lo = -900, hi = 2300;
    const count = region.count, dirs = region.directions;
    const heights = new Float32Array(count), paint = new Float32Array(count * 4);
    const reach = 6 / r;
    for (let i = 0; i < count; i++) {
        const dx = dirs[i * 3]!, dy = dirs[i * 3 + 1]!, dz = dirs[i * 3 + 2]!;
        const h = Math.min(Math.max(height(dx, dy, dz), lo + 1), hi - 1);
        heights[i] = h;
        let ax = Math.abs(dx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1, az = 0;
        const dot = ax * dx + ay * dy + az * dz;
        ax -= dx * dot; ay -= dy * dot; az -= dz * dot;
        const al = Math.hypot(ax, ay, az) || 1;
        ax /= al; ay /= al; az /= al;
        const bx = dy * az - dz * ay, by = dz * ax - dx * az, bz = dx * ay - dy * ax;
        const hu = height(dx + ax * reach, dy + ay * reach, dz + az * reach), hv = height(dx + bx * reach, dy + by * reach, dz + bz * reach);
        const slope = Math.hypot(hu - h, hv - h) / 6;
        const rock = smooth(style === 0 ? 0.42 : 0.55, style === 0 ? 0.8 : 0.95, slope);
        const fleck = fbm(dx * r / 260, dy * r / 260, dz * r / 260, 3);
        const peak = smooth(style === 0 ? 1150 : 600, style === 0 ? 1600 : 1000, h + 120 * fleck) * (1 - rock * 0.8);
        const low = smooth(style === 1 ? -40 : 40, style === 1 ? 120 : 420, h + 160 * fleck) * (1 - peak) * (1 - rock);
        const base = (1 - rock) * (1 - peak) * (1 - low);
        const sum = base + low + peak + rock || 1;
        paint[i * 4] = base / sum;
        paint[i * 4 + 1] = low / sum;
        paint[i * 4 + 2] = peak / sum;
        paint[i * 4 + 3] = rock / sum;
    }
    return { heights, paint };
}

export const groundRange = (_world: string): [number, number] => [-900, 2300];

export const groundWorkerSource = (): string =>
    `const sample = ${groundSample.toString()};\nexport default { id: ${JSON.stringify(GROUND_ID)}, versions: [${GROUND_VERSION}], fields: [], sample };\n`;

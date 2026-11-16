import { defineSkyEffect } from 'esengine';

const GLSL = `float nbHash(vec3 q) {
    vec3 p = fract(q * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

float nbNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(nbHash(i), nbHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(nbHash(i + vec3(0.0, 1.0, 0.0)), nbHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(nbHash(i + vec3(0.0, 0.0, 1.0)), nbHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(nbHash(i + vec3(0.0, 1.0, 1.0)), nbHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
        f.z);
}

float nbCloud(vec3 p, int octaves) {
    float sum = 0.0, weight = 1.0, total = 0.0;
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        sum += weight * nbNoise(p);
        total += weight;
        weight *= 0.55;
        p = p * 2.03 + 11.3;
    }
    return sum / total;
}

float nbRidge(vec3 p, int octaves) {
    float sum = 0.0, weight = 1.0, total = 0.0;
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        sum += weight * (1.0 - abs(nbNoise(p) * 2.0 - 1.0));
        total += weight;
        weight *= 0.55;
        p = p * 2.03 + 11.3;
    }
    return sum / total;
}

vec3 nbWarp(vec3 p, float amount) {
    return p + amount * (vec3(nbCloud(p + 3.1, 2), nbCloud(p + 7.7, 2), nbCloud(p + 13.9, 2)) - 0.5);
}

vec3 skyRadiance(vec3 dir, vec3 sun, vec3 sunColor, float env) {
    float turn = radians(u_turn), c = cos(turn), s = sin(turn);
    vec3 d = vec3(dir.x * c - dir.z * s, dir.y, dir.x * s + dir.z * c);
    vec3 p = d * 1.35;
    float region = smoothstep(-0.35, 0.75, dot(d, normalize(vec3(-0.62, 0.22, -0.75))));
    float along = dot(d, normalize(vec3(0.35, 0.25, 0.9))) / 0.38;
    float band = exp(-along * along);
    vec3 w1 = p + (nbWarp(p * 0.8, 1.4) - p * 0.8);
    vec3 w2 = w1 * 1.7 + (nbWarp(w1 * 2.2, 0.9) - w1 * 2.2);
    float base = nbCloud(w2, 6);
    float wisps = nbRidge((p * 3.1 + (nbWarp(p * 4.6, 1.0) - p * 4.6)) * 2.2, 6);
    float fine = nbCloud(w2 * 6.0, 3);
    float dust = nbCloud((p * 1.9 + (nbWarp(p * 1.9, 1.6) - p * 1.9)) * 2.1, 6);
    float hue = smoothstep(0.35, 0.65, nbCloud(p * 0.7 + 5.0, 2));
    float gas = smoothstep(0.5, 0.8, base + 0.1 * (fine - 0.5)) * (0.1 + 0.9 * region);
    float glow = pow(smoothstep(0.6, 0.95, wisps), 1.5) * smoothstep(0.45, 0.7, base) * region;
    float lanes = 1.0 - 0.92 * smoothstep(0.5, 0.66, dust);
    vec3 neb = gas * mix(vec3(0.015, 0.06, 0.16), vec3(0.03, 0.26, 0.36), hue) * 1.5
        + glow * mix(vec3(0.85, 0.1, 0.16), vec3(1.0, 0.5, 0.16), hue) * 2.2;
    neb = neb * lanes + band * smoothstep(0.4, 0.7, nbCloud(p * 2.5, 3)) * vec3(0.03, 0.026, 0.034);
    neb *= 1.5;
    neb = neb / (1.0 + neb * 0.35) + vec3(0.0015, 0.002, 0.004);
    return neb * u_tint.rgb * u_gain;
}`;

const WGSL = `fn nbHash(q : vec3f) -> f32 {
    var p = fract(q * vec3f(0.1031, 0.1030, 0.0973));
    p = p + dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

fn nbNoise(p : vec3f) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(nbHash(i), nbHash(i + vec3f(1.0, 0.0, 0.0)), f.x), mix(nbHash(i + vec3f(0.0, 1.0, 0.0)), nbHash(i + vec3f(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(nbHash(i + vec3f(0.0, 0.0, 1.0)), nbHash(i + vec3f(1.0, 0.0, 1.0)), f.x), mix(nbHash(i + vec3f(0.0, 1.0, 1.0)), nbHash(i + vec3f(1.0, 1.0, 1.0)), f.x), f.y),
        f.z);
}

fn nbCloud(at : vec3f, octaves : i32) -> f32 {
    var p = at;
    var sum = 0.0;
    var weight = 1.0;
    var total = 0.0;
    for (var i = 0; i < octaves; i = i + 1) {
        sum = sum + weight * nbNoise(p);
        total = total + weight;
        weight = weight * 0.55;
        p = p * 2.03 + 11.3;
    }
    return sum / total;
}

fn nbRidge(at : vec3f, octaves : i32) -> f32 {
    var p = at;
    var sum = 0.0;
    var weight = 1.0;
    var total = 0.0;
    for (var i = 0; i < octaves; i = i + 1) {
        sum = sum + weight * (1.0 - abs(nbNoise(p) * 2.0 - 1.0));
        total = total + weight;
        weight = weight * 0.55;
        p = p * 2.03 + 11.3;
    }
    return sum / total;
}

fn nbWarp(p : vec3f, amount : f32) -> vec3f {
    return p + amount * (vec3f(nbCloud(p + 3.1, 2), nbCloud(p + 7.7, 2), nbCloud(p + 13.9, 2)) - 0.5);
}

fn skyRadiance(dir : vec3f, sun : vec3f, sunColor : vec3f, env : f32) -> vec3f {
    let turn = radians(mc.u_turn);
    let c = cos(turn);
    let s = sin(turn);
    let d = vec3f(dir.x * c - dir.z * s, dir.y, dir.x * s + dir.z * c);
    let p = d * 1.35;
    let region = smoothstep(-0.35, 0.75, dot(d, normalize(vec3f(-0.62, 0.22, -0.75))));
    let along = dot(d, normalize(vec3f(0.35, 0.25, 0.9))) / 0.38;
    let band = exp(-along * along);
    let w1 = p + (nbWarp(p * 0.8, 1.4) - p * 0.8);
    let w2 = w1 * 1.7 + (nbWarp(w1 * 2.2, 0.9) - w1 * 2.2);
    let base = nbCloud(w2, 6);
    let wisps = nbRidge((p * 3.1 + (nbWarp(p * 4.6, 1.0) - p * 4.6)) * 2.2, 6);
    let fine = nbCloud(w2 * 6.0, 3);
    let dust = nbCloud((p * 1.9 + (nbWarp(p * 1.9, 1.6) - p * 1.9)) * 2.1, 6);
    let hue = smoothstep(0.35, 0.65, nbCloud(p * 0.7 + 5.0, 2));
    let gas = smoothstep(0.5, 0.8, base + 0.1 * (fine - 0.5)) * (0.1 + 0.9 * region);
    let glow = pow(smoothstep(0.6, 0.95, wisps), 1.5) * smoothstep(0.45, 0.7, base) * region;
    let lanes = 1.0 - 0.92 * smoothstep(0.5, 0.66, dust);
    var neb = gas * mix(vec3f(0.015, 0.06, 0.16), vec3f(0.03, 0.26, 0.36), hue) * 1.5
        + glow * mix(vec3f(0.85, 0.1, 0.16), vec3f(1.0, 0.5, 0.16), hue) * 2.2;
    neb = neb * lanes + band * smoothstep(0.4, 0.7, nbCloud(p * 2.5, 3)) * vec3f(0.03, 0.026, 0.034);
    neb = neb * 1.5;
    neb = neb / (1.0 + neb * 0.35) + vec3f(0.0015, 0.002, 0.004);
    return neb * mc.u_tint.rgb * mc.u_gain;
}`;

let defined = false;

export function installSky(): void {
    if (defined) return;
    defined = true;
    defineSkyEffect({
        type: 'nebula',
        label: 'Nebula',
        uniforms: [
            { name: 'u_turn', label: 'Turn', min: 0, max: 360, step: 1, defaultValue: 0 },
            { name: 'u_gain', label: 'Gain', min: 0, max: 8, step: 0.05, defaultValue: 1 },
        ],
        colors: [{ name: 'u_tint', label: 'Tint', defaultValue: { r: 1, g: 1, b: 1, a: 1 } }],
        glsl: GLSL,
        wgsl: WGSL,
    });
}

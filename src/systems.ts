export const SYSTEMS = [
    { name: 'KARIS', body: 'KARIS IV', at: { x: -6000, y: -5760, z: -3500 }, radius: 4300, parts: ["Planet0", "Atmosphere0"], sun: { x: 0.62174, y: -0.50141, z: -0.60169 }, sunColor: { r: 1.0, g: 0.94, b: 0.86, a: 1 }, sunPower: 1.5,
      shine: { x: 0.66491, y: 0.63832, z: 0.38787 }, shineColor: { r: 1.0, g: 0.72, b: 0.45, a: 1 }, shinePower: 0.4, skyTurn: 0, skyTint: { r: 1.0, g: 1.0, b: 1.0, a: 1 }, bandTurn: 40 },
    { name: 'VELA', body: 'VELA II', at: { x: 5200, y: 3400, z: 6400 }, radius: 3000, parts: ["Planet1", "Atmosphere1", "Ring1", "Veil1"], sun: { x: -0.4969, y: -0.34783, z: 0.79505 }, sunColor: { r: 0.82, g: 0.92, b: 1.0, a: 1 }, sunPower: 1.7,
      shine: { x: -0.58298, y: -0.38118, z: -0.71752 }, shineColor: { r: 0.45, g: 0.75, b: 1.0, a: 1 }, shinePower: 0.35, skyTurn: 140, skyTint: { r: 0.75, g: 0.95, b: 1.15, a: 1 }, bandTurn: 170 },
    { name: 'MORN', body: 'MORN PRIME', at: { x: 3800, y: -4200, z: -5200 }, radius: 3300, parts: ["Planet2", "Atmosphere2", "Veil2"], sun: { x: 0.7542, y: -0.30168, z: 0.58325 }, sunColor: { r: 1.0, g: 0.86, b: 0.7, a: 1 }, sunPower: 1.6,
      shine: { x: -0.49422, y: 0.54624, z: 0.67629 }, shineColor: { r: 1.0, g: 0.55, b: 0.35, a: 1 }, shinePower: 0.3, skyTurn: 255, skyTint: { r: 1.06, g: 0.96, b: 0.88, a: 1 }, bandTurn: 290 },
] as const;

export type StarSystem = (typeof SYSTEMS)[number];

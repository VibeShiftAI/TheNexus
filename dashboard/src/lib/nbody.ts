/**
 * Pure n-body physics for the planetary simulator.
 *
 * No WebGL, no React — just data, so it can be unit-tested. The three.js page
 * renders body positions; this module computes them. Units are *illustrative*
 * sim units (mass in Earth masses, distance in AU, G scaled for nice on-screen
 * motion), driven by the objects' real parameter ratios. Not research-grade.
 */

export type Vec3 = [number, number, number];

export interface Body {
  id: string;
  name: string;
  mass: number; // Earth masses
  radius: number; // Earth radii (for rendering)
  pos: Vec3;
  vel: Vec3;
  isStar: boolean;
  color: string;
}

export interface SpecLike {
  spec_key: string;
  value_number?: number | null;
  value_text?: string | null;
  value_min?: number | null;
  value_max?: number | null;
  status?: string;
}
export interface ObjectLike {
  id: string;
  name: string;
  object_kind?: string | null;
  spec_values?: SpecLike[];
}

// Scaled gravitational constant: keeps a star-mass (~3.3e5 Earth) system orbiting
// at a few AU at a visually pleasant rate.
export const G_SIM = 1e-4;
const SOFTENING = 0.05; // AU, avoids singular forces on close approach
const M_EARTH_PER_JUPITER = 317.8;
const R_EARTH_PER_JUPITER = 11.21;
const M_EARTH_PER_SUN = 332946;

function specVal(obj: ObjectLike, key: string): number | null {
  const s = (obj.spec_values || []).find((x) => x.spec_key === key);
  if (!s || s.status === 'unknown' || s.status === 'not_applicable') return null;
  if (typeof s.value_number === 'number') return s.value_number;
  if (s.value_min != null && s.value_max != null) return (s.value_min + s.value_max) / 2;
  const n = s.value_text != null ? parseFloat(s.value_text) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function massEarth(obj: ObjectLike): number {
  const me = specVal(obj, 'bulk.mass_earth');
  if (me != null) return me;
  const mj = specVal(obj, 'bulk.mass_jupiter');
  if (mj != null) return mj * M_EARTH_PER_JUPITER;
  // Stars: estimate from host context isn't available per-object; default light.
  return obj.object_kind && /star|dwarf|neutron|pulsar|magnetar/i.test(obj.object_kind) ? M_EARTH_PER_SUN : 1;
}

export function radiusEarth(obj: ObjectLike): number {
  const re = specVal(obj, 'bulk.radius_earth');
  if (re != null) return re;
  const rj = specVal(obj, 'bulk.radius_jupiter');
  if (rj != null) return rj * R_EARTH_PER_JUPITER;
  return 1;
}

export function semiMajorAU(obj: ObjectLike): number | null {
  return specVal(obj, 'orbital.semi_major_axis_au');
}

function colorFor(obj: ObjectLike, isStar: boolean): string {
  if (isStar) return '#ffd27f';
  const teq = specVal(obj, 'energy.equilibrium_temperature_k');
  if (teq != null) {
    if (teq > 1000) return '#ff6b4a'; // scorching
    if (teq > 400) return '#e8a15a'; // hot
    if (teq > 200) return '#5ad1c4'; // temperate
    return '#7aa2ff'; // cold
  }
  return '#9aa7c7';
}

/**
 * Build initial conditions: the most-massive body is the central anchor; the
 * rest are placed by semi-major axis (or indexed spacing) on near-circular
 * orbits. Net momentum is zeroed so the system doesn't drift off-screen.
 */
export function computeInitialConditions(objects: ObjectLike[]): Body[] {
  if (!objects.length) return [];
  const masses = objects.map(massEarth);
  const centralIdx = masses.indexOf(Math.max(...masses));
  const central = objects[centralIdx];
  const mCentral = masses[centralIdx];

  const bodies: Body[] = [];
  let orbitIndex = 0;
  objects.forEach((obj, i) => {
    const isCentral = i === centralIdx;
    const isStar = isCentral || /star|dwarf|neutron|pulsar|magnetar/i.test(obj.object_kind || '');
    if (isCentral) {
      bodies.push({ id: obj.id, name: obj.name, mass: masses[i], radius: radiusEarth(obj), pos: [0, 0, 0], vel: [0, 0, 0], isStar, color: colorFor(obj, true) });
      return;
    }
    orbitIndex += 1;
    const r = semiMajorAU(obj) ?? 1.2 + orbitIndex * 1.1;
    const angle = (orbitIndex * 2.399963); // golden-angle spread
    const pos: Vec3 = [r * Math.cos(angle), 0, r * Math.sin(angle)];
    // Circular speed around the central mass; velocity perpendicular to radius in XZ plane.
    const speed = Math.sqrt((G_SIM * mCentral) / r);
    const vel: Vec3 = [-speed * Math.sin(angle), 0, speed * Math.cos(angle)];
    bodies.push({ id: obj.id, name: obj.name, mass: masses[i], radius: radiusEarth(obj), pos, vel, isStar, color: colorFor(obj, false) });
  });

  zeroNetMomentum(bodies);
  return bodies;
}

export function totalMomentum(bodies: Body[]): Vec3 {
  const p: Vec3 = [0, 0, 0];
  for (const b of bodies) { p[0] += b.mass * b.vel[0]; p[1] += b.mass * b.vel[1]; p[2] += b.mass * b.vel[2]; }
  return p;
}

function zeroNetMomentum(bodies: Body[]): void {
  const totalMass = bodies.reduce((a, b) => a + b.mass, 0);
  if (totalMass <= 0) return;
  const p = totalMomentum(bodies);
  for (const b of bodies) {
    b.vel[0] -= p[0] / totalMass;
    b.vel[1] -= p[1] / totalMass;
    b.vel[2] -= p[2] / totalMass;
  }
}

function accelerations(bodies: Body[]): Vec3[] {
  const acc: Vec3[] = bodies.map(() => [0, 0, 0]);
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = 0; j < bodies.length; j += 1) {
      if (i === j) continue;
      const dx = bodies[j].pos[0] - bodies[i].pos[0];
      const dy = bodies[j].pos[1] - bodies[i].pos[1];
      const dz = bodies[j].pos[2] - bodies[i].pos[2];
      const distSq = dx * dx + dy * dy + dz * dz + SOFTENING * SOFTENING;
      const inv = 1 / (distSq * Math.sqrt(distSq)); // 1/|r|^3
      const f = G_SIM * bodies[j].mass * inv;
      acc[i][0] += f * dx;
      acc[i][1] += f * dy;
      acc[i][2] += f * dz;
    }
  }
  return acc;
}

/** One velocity-Verlet step. Mutates and returns the same array. */
export function step(bodies: Body[], dt: number): Body[] {
  const a0 = accelerations(bodies);
  for (let i = 0; i < bodies.length; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      bodies[i].pos[k] += bodies[i].vel[k] * dt + 0.5 * a0[i][k] * dt * dt;
    }
  }
  const a1 = accelerations(bodies);
  for (let i = 0; i < bodies.length; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      bodies[i].vel[k] += 0.5 * (a0[i][k] + a1[i][k]) * dt;
    }
  }
  return bodies;
}

/**
 * Pick a per-frame timestep so the *innermost* orbit completes in ~targetSeconds
 * regardless of the system's mass/size scale (a star system and a two-planet
 * system both animate at a watchable rate). Keeps the fastest body's per-step
 * angle small enough for the integrator to stay stable.
 */
export function referenceTimeStep(bodies: Body[], targetSeconds = 14, fps = 60): number {
  if (bodies.length < 2) return 0.02;
  const masses = bodies.map((b) => b.mass);
  const centralIdx = masses.indexOf(Math.max(...masses));
  const central = bodies[centralIdx];
  const radii = bodies
    .filter((_, i) => i !== centralIdx)
    .map((b) => Math.hypot(b.pos[0] - central.pos[0], b.pos[1] - central.pos[1], b.pos[2] - central.pos[2]))
    .filter((r) => r > 1e-6);
  if (!radii.length) return 0.02;
  const rMin = Math.min(...radii);
  const omegaMax = Math.sqrt((G_SIM * masses[centralIdx]) / (rMin * rMin * rMin));
  if (!Number.isFinite(omegaMax) || omegaMax <= 0) return 0.02;
  const radiansPerFrame = (2 * Math.PI) / (targetSeconds * fps);
  return radiansPerFrame / omegaMax;
}

export function separation(a: Body, b: Body): number {
  const dx = a.pos[0] - b.pos[0];
  const dy = a.pos[1] - b.pos[1];
  const dz = a.pos[2] - b.pos[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

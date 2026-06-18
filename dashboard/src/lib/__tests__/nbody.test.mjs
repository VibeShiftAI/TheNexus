import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

function loadNbody() {
  const source = fs.readFileSync(path.join(process.cwd(), "src/lib/nbody.ts"), "utf-8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { exports: module.exports, module };
  vm.runInNewContext(compiled, sandbox);
  return module.exports;
}

const nbody = loadNbody();

function obj(id, name, massEarth, radiusEarth, kind, semiMajor) {
  const specs = [
    { spec_key: "bulk.mass_earth", value_number: massEarth, status: "known" },
    { spec_key: "bulk.radius_earth", value_number: radiusEarth, status: "known" },
  ];
  if (semiMajor != null) specs.push({ spec_key: "orbital.semi_major_axis_au", value_number: semiMajor, status: "known" });
  return { id, name, object_kind: kind, spec_values: specs };
}

test("computeInitialConditions makes the most-massive body the central anchor", () => {
  const bodies = nbody.computeInitialConditions([
    obj("p1", "Light", 1, 1, "exoplanet", 1),
    obj("star", "Heavy", 100000, 50, "star"),
    obj("p2", "Mid", 5, 1.5, "exoplanet", 2),
  ]);
  const central = bodies.find((b) => b.id === "star");
  // central placed at origin (spread to a test-realm array to avoid cross-VM identity checks)
  assert.deepEqual([...central.pos], [0, 0, 0]);
  // orbiters placed away from origin with nonzero velocity
  const p1 = bodies.find((b) => b.id === "p1");
  assert.ok(Math.hypot(...p1.pos) > 0.5);
  assert.ok(Math.hypot(...p1.vel) > 0);
});

test("net momentum starts ~zero and is conserved across steps", () => {
  const bodies = nbody.computeInitialConditions([
    obj("star", "Heavy", 100000, 30, "star"),
    obj("p1", "A", 3, 1, "exoplanet", 1.5),
    obj("p2", "B", 8, 1.5, "exoplanet", 3),
  ]);
  const p0 = nbody.totalMomentum(bodies);
  assert.ok(Math.hypot(...p0) < 1e-9, `initial momentum should be ~0, got ${p0}`);
  for (let i = 0; i < 500; i += 1) nbody.step(bodies, 0.02);
  const p1 = nbody.totalMomentum(bodies);
  assert.ok(Math.hypot(...p1) < 1e-6, `momentum should stay ~0, got ${p1}`);
});

test("referenceTimeStep scales the timestep so any system is watchable", () => {
  const planet = nbody.computeInitialConditions([
    obj("c", "Heavy planet", 5, 2, "exoplanet"),
    obj("o", "Orbiter", 1, 1, "exoplanet", 1.2),
  ]);
  const star = nbody.computeInitialConditions([
    obj("c", "Star", 200000, 40, "star"),
    obj("o", "Orbiter", 1, 1, "exoplanet", 1.2),
  ]);
  const dtPlanet = nbody.referenceTimeStep(planet);
  const dtStar = nbody.referenceTimeStep(star);
  assert.ok(Number.isFinite(dtPlanet) && dtPlanet > 0, `planet dt invalid: ${dtPlanet}`);
  assert.ok(Number.isFinite(dtStar) && dtStar > 0, `star dt invalid: ${dtStar}`);
  // Heavier central → faster orbit → smaller timestep needed for the same on-screen cadence.
  assert.ok(dtPlanet > dtStar, `expected planet dt (${dtPlanet}) > star dt (${dtStar})`);
});

test("a single light planet holds a near-circular orbit around a heavy star", () => {
  const bodies = nbody.computeInitialConditions([
    obj("star", "Heavy", 200000, 40, "star"),
    obj("p1", "Orbiter", 1, 1, "exoplanet", 2),
  ]);
  const star = bodies.find((b) => b.id === "star");
  const planet = bodies.find((b) => b.id === "p1");
  const r0 = nbody.separation(star, planet);
  let min = r0;
  let max = r0;
  for (let i = 0; i < 4000; i += 1) {
    nbody.step(bodies, 0.01);
    const r = nbody.separation(star, planet);
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  // Orbit stays bounded and roughly circular (within ~30% of the start radius).
  assert.ok(min > r0 * 0.7, `perihelion too small: ${min} vs ${r0}`);
  assert.ok(max < r0 * 1.3, `aphelion too large: ${max} vs ${r0}`);
});

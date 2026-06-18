const { computeDerivedSpecs, inferMolarMass } = require('../services/astro-parameters');

function spec(value_number, status = 'known', extra = {}) {
  return { value_number, status, ...extra };
}
function byKey(out, key) {
  return out.find((s) => s.spec_key === key);
}

describe('astro parameter calculator', () => {
  test('reproduces Earth gravity, escape velocity and density', () => {
    const out = computeDerivedSpecs({
      'bulk.mass_earth': spec(1),
      'bulk.radius_earth': spec(1),
    });
    expect(byKey(out, 'bulk.surface_gravity_g').value_number).toBeCloseTo(1, 2);
    // Earth escape velocity ≈ 11.2 km/s
    expect(byKey(out, 'bulk.escape_velocity_km_s').value_number).toBeCloseTo(11.2, 0);
    // Earth mean density ≈ 5.51 g/cm3
    expect(byKey(out, 'bulk.density_g_cm3').value_number).toBeCloseTo(5.5, 0);
  });

  test('a 5-Earth-mass, 1.6-radius super-Earth has higher gravity', () => {
    const out = computeDerivedSpecs({
      'bulk.mass_earth': spec(5),
      'bulk.radius_earth': spec(1.6),
    });
    // g = M/R^2 in Earth units = 5 / 2.56 ≈ 1.95
    expect(byKey(out, 'bulk.surface_gravity_g').value_number).toBeCloseTo(1.95, 1);
  });

  test('equilibrium temperature tracks insolation and albedo', () => {
    const out = computeDerivedSpecs({
      'energy.stellar_flux_earth': spec(1),
      'energy.albedo': spec(0.3),
    });
    // 278.5 * (0.7)^.25 ≈ 255 K (Earth's effective temperature)
    expect(byKey(out, 'energy.equilibrium_temperature_k').value_number).toBeCloseTo(255, -1);
  });

  test('derives atmospheric density and scale height from gas law inputs', () => {
    const out = computeDerivedSpecs({
      'bulk.mass_earth': spec(1),
      'bulk.radius_earth': spec(1),
      'atmosphere.pressure_bar': spec(1),
      'atmosphere.composition': { value_text: 'N2, O2', status: 'known' },
      'energy.equilibrium_temperature_k': spec(288),
    });
    const density = byKey(out, 'atmosphere.density_kg_m3');
    // ~1.0–1.3 kg/m3 for an Earth-like surface
    expect(density.value_number).toBeGreaterThan(0.8);
    expect(density.value_number).toBeLessThan(1.6);
    expect(byKey(out, 'atmosphere.scale_height_km').value_number).toBeGreaterThan(3);
  });

  test('never overrides a value flagged as known', () => {
    const out = computeDerivedSpecs({
      'bulk.mass_earth': spec(1),
      'bulk.radius_earth': spec(1),
      'bulk.surface_gravity_g': spec(0.9, 'known'),
    });
    expect(byKey(out, 'bulk.surface_gravity_g')).toBeUndefined();
  });

  test('marks derived values estimated with an auto-derived note', () => {
    const out = computeDerivedSpecs({ 'bulk.mass_earth': spec(1), 'bulk.radius_earth': spec(1) });
    const g = byKey(out, 'bulk.surface_gravity_g');
    expect(g.status).toBe('estimated');
    expect(g.notes).toMatch(/auto-derived/);
  });

  test('infers a plausible mean molar mass from composition text', () => {
    expect(inferMolarMass('mostly CO2')).toBeCloseTo(0.044, 3);
    expect(inferMolarMass('hydrogen and helium')).toBeGreaterThan(0.002);
    expect(inferMolarMass('')).toBeNull();
  });
});

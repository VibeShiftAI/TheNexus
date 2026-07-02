const {
  computeRenderModel,
  computeDerivedSpecs,
  parseSpectralType,
  spectralTypeToTeff,
  blackbodyToRGB,
} = require('../services/astro-parameters');

function spec(value_number, status = 'known', extra = {}) {
  return { value_number, status, ...extra };
}
function textSpec(value_text, status = 'known') {
  return { value_text, status };
}
function byKey(out, key) {
  return out.find((s) => s.spec_key === key);
}

function earthSpecs() {
  return {
    'bulk.mass_earth': spec(1),
    'bulk.radius_earth': spec(1),
    'orbital.semi_major_axis_au': spec(1),
    'orbital.rotation_period_hours': spec(23.93),
    'orbital.obliquity_deg': spec(23.44),
    'energy.stellar_flux_earth': spec(1),
    'energy.albedo': spec(0.306),
    'atmosphere.pressure_bar': spec(1.013),
    'atmosphere.density_kg_m3': spec(1.225),
    'atmosphere.scale_height_km': spec(8.5),
    'atmosphere.composition': textSpec('N2 (78%), O2 (21%), Ar'),
    'atmosphere.clouds_hazes': textSpec('Patchy water clouds'),
    'location.host_star_or_object': textSpec('Sun (G2 V)'),
  };
}

describe('spectral type parsing', () => {
  test('parses the ingestion host-star format and prose forms', () => {
    expect(parseSpectralType('Kepler-22 (G5 V)')).toEqual({ cls: 'G', subclass: 5 });
    expect(parseSpectralType('TRAPPIST-1 (M8V)')).toEqual({ cls: 'M', subclass: 8 });
    expect(parseSpectralType('G2V yellow dwarf')).toEqual({ cls: 'G', subclass: 2 });
    expect(parseSpectralType('a nearby M dwarf')).toEqual({ cls: 'M', subclass: 5 });
  });

  test('does not false-positive on catalog designations', () => {
    // K2-18 is a survey name, not a K2 spectral class.
    expect(parseSpectralType('K2-18')).toBeNull();
    expect(parseSpectralType('Sun')).toBeNull();
    expect(parseSpectralType('White dwarf companion (DA)')).toBeNull();
  });

  test('interpolates effective temperature between class anchors', () => {
    expect(spectralTypeToTeff({ cls: 'G', subclass: 2 })).toBeCloseTo(5860, -2);
    expect(spectralTypeToTeff({ cls: 'M', subclass: 5 })).toBeCloseTo(3100, -2);
    expect(spectralTypeToTeff({ cls: 'A', subclass: 0 })).toBe(10000);
    expect(spectralTypeToTeff(null)).toBeNull();
  });
});

describe('blackbody color', () => {
  test('sun-like temperature is warm white', () => {
    const [r, g, b] = blackbodyToRGB(5772);
    expect(r).toBe(1);
    expect(g).toBeGreaterThan(0.9);
    expect(b).toBeGreaterThan(0.85);
  });

  test('M-dwarf temperature is strongly red-shifted', () => {
    const [r, , b] = blackbodyToRGB(3000);
    expect(r).toBe(1);
    expect(b).toBeLessThan(0.5);
  });

  test('hot star is blue-white', () => {
    const [r, , b] = blackbodyToRGB(10000);
    expect(b).toBe(1);
    expect(r).toBeLessThan(0.9);
  });
});

describe('render model', () => {
  test('Earth reproduces the UE SkyAtmosphere defaults', () => {
    const m = computeRenderModel(earthSpecs());
    expect(m.surface.rayleigh.scale).toBeCloseTo(0.0331, 3);
    expect(m.surface.rayleigh.exp_distribution_km).toBeCloseTo(8.5, 1);
    expect(m.surface.has_atmosphere).toBe(true);
    expect(m.suns[0].illuminance_lux).toBeCloseTo(133000, -3);
    expect(m.suns[0].angular_diameter_deg).toBeCloseTo(0.533, 1);
    expect(m.rotation.period_h).toBeCloseTo(23.93, 1);
    expect(m.rotation.obliquity_deg).toBeCloseTo(23.44, 1);
    expect(m.rotation.tidal_locked).toBe(false);
  });

  test('Mars: thin CO2 air gives near-zero Rayleigh and dusty Mie', () => {
    const m = computeRenderModel({
      'bulk.mass_earth': spec(0.107),
      'bulk.radius_earth': spec(0.532),
      'orbital.semi_major_axis_au': spec(1.524),
      'energy.stellar_flux_earth': spec(0.431),
      'atmosphere.pressure_bar': spec(0.006),
      'atmosphere.density_kg_m3': spec(0.02),
      'atmosphere.composition': textSpec('CO2 (95%), N2, Ar'),
      'atmosphere.clouds_hazes': textSpec('Regional and global dust storms'),
      'location.host_star_or_object': textSpec('Sun (G2 V)'),
    });
    expect(m.surface.rayleigh.scale).toBeGreaterThan(0);
    expect(m.surface.rayleigh.scale).toBeLessThan(0.001);
    expect(m.surface.mie.scale).toBeGreaterThan(0.02);
    // Dust tint is warm: red channel above blue.
    expect(m.surface.mie.color[0]).toBeGreaterThan(m.surface.mie.color[2]);
    // Low gravity supports Olympus-class relief.
    expect(m.surface.max_relief_m).toBeGreaterThan(20000);
  });

  test('airless body: zero scattering, no fog, minimum atmosphere shell', () => {
    const m = computeRenderModel({
      'bulk.mass_earth': spec(0.0123),
      'bulk.radius_earth': spec(0.2727),
      'atmosphere.pressure_bar': spec(0),
    });
    expect(m.surface.has_atmosphere).toBe(false);
    expect(m.surface.rayleigh.scale).toBe(0);
    expect(m.surface.mie.scale).toBe(0);
    expect(m.surface.fog.enabled).toBe(false);
  });

  test('M-dwarf world: dim red light, huge sun disc, tidal lock', () => {
    const m = computeRenderModel({
      'bulk.mass_earth': spec(1.1),
      'bulk.radius_earth': spec(1.05),
      'orbital.semi_major_axis_au': spec(0.028),
      'orbital.tidal_lock_status': textSpec('Likely tidally locked'),
      'energy.stellar_flux_earth': spec(0.66),
      'location.host_star_or_object': textSpec('TRAPPIST-1 (M8 V)'),
    });
    expect(m.rotation.tidal_locked).toBe(true);
    expect(m.suns[0].teff_k).toBeLessThan(3000);
    expect(m.suns[0].rgb[2]).toBeLessThan(0.5); // blue channel crushed
    expect(m.suns[0].illuminance_lux).toBeCloseTo(87780, -3);
    // A cool star this close looms far larger than the Sun from Earth.
    expect(m.suns[0].angular_diameter_deg).toBeGreaterThan(1.5);
  });

  test('negated tidal-lock text does not read as locked', () => {
    const notLocked = (t) => computeRenderModel({
      'orbital.tidal_lock_status': textSpec(t),
    }).rotation.tidal_locked;
    expect(notLocked('Not locked; 3:2 resonance')).toBe(false);
    expect(notLocked('Not locked; Moon slowing spin by ~1.7 ms/century')).toBe(false);
    expect(notLocked('Likely tidally locked')).toBe(true);
    expect(notLocked('Synchronous rotation with its star')).toBe(true);
  });

  test('missing spectral type falls back to a G2V sun at low confidence', () => {
    const m = computeRenderModel({
      'location.host_star_or_object': textSpec('K2-18'),
    });
    expect(m.suns[0].teff_k).toBe(5772);
    expect(m.suns[0].confidence).toBe('low');
  });

  test('thick global clouds enable fog and a cloud deck', () => {
    const m = computeRenderModel({
      'atmosphere.pressure_bar': spec(92),
      'atmosphere.composition': textSpec('CO2, N2, sulfuric acid aerosols'),
      'atmosphere.clouds_hazes': textSpec('Thick, global sulfuric-acid cloud deck'),
    });
    expect(m.surface.clouds.enabled).toBe(true);
    expect(m.surface.fog.enabled).toBe(true);
    expect(m.surface.fog.density).toBeGreaterThan(0);
  });
});

describe('new derived spec rows', () => {
  test('emits host-star Teff and daylight illuminance', () => {
    const out = computeDerivedSpecs({
      'location.host_star_or_object': textSpec('Kepler-22 (G5 V)'),
      'energy.stellar_flux_earth': spec(0.75),
    });
    expect(byKey(out, 'energy.star_effective_temperature_k').value_number).toBeCloseTo(5650, -2);
    expect(byKey(out, 'human_experience.daylight_illuminance_lux').value_number).toBeCloseTo(99750, -3);
  });

  test('omits them when inputs are missing', () => {
    const out = computeDerivedSpecs({ 'bulk.mass_earth': spec(1), 'bulk.radius_earth': spec(1) });
    expect(byKey(out, 'energy.star_effective_temperature_k')).toBeUndefined();
    expect(byKey(out, 'human_experience.daylight_illuminance_lux')).toBeUndefined();
  });
});

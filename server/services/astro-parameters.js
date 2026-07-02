/**
 * Astro Parameter Calculator
 *
 * Pure, deterministic physics. No LLM, no I/O. Given an object's *known* spec
 * values it derives surface conditions so field-guide scripts stay mathematically
 * sound: surface gravity, escape velocity, density, equilibrium temperature,
 * atmospheric density, scale height, and a qualitative sky-appearance string.
 *
 * Every derived value is returned with status 'estimated', a confidence, and a
 * note naming the formula + inputs. Callers persist these; the calculator never
 * touches the database.
 */

// SI constants
const G = 6.674e-11; // m^3 kg^-1 s^-2
const R_GAS = 8.314462618; // J mol^-1 K^-1
const G_EARTH = 9.80665; // m/s^2

// Reference bodies
const M_EARTH = 5.972e24; // kg
const R_EARTH = 6.371e6; // m
const M_JUP = 1.898e27; // kg
const R_JUP = 6.9911e7; // m

// Equilibrium temperature of a zero-albedo fast-rotator at Earth's insolation.
// T = 278.5 K * (1-A)^0.25 * (S/S_earth)^0.25
const T_EQ_REF = 278.5; // K

// Render-model reference values (Unreal SkyAtmosphere ships Earth defaults;
// we scale those by the real physics so the renderer stays honest).
const T_SUN = 5772; // K, solar effective temperature
const SUN_ANGULAR_DIAMETER_DEG = 0.5334; // apparent solar diameter from 1 AU
const EARTH_AIR_DENSITY_KG_M3 = 1.225; // sea-level air density
const EARTH_NOON_ILLUMINANCE_LUX = 133000; // direct overhead sunlight
const UE_EARTH_RAYLEIGH_SCALE = 0.0331; // UE SkyAtmosphere default
const UE_EARTH_RAYLEIGH_COLOR = [0.1752, 0.4096, 1.0]; // UE default scattering tint
const UE_EARTH_MIE_SCALE = 0.003996; // UE SkyAtmosphere default

// Effective temperature at subclass 0 and 9 for each spectral class (main
// sequence anchors; linear interpolation across the subclass digit).
const SPECTRAL_TEFF_ANCHORS = {
  O: [45000, 30000],
  B: [30000, 10000],
  A: [10000, 7300],
  F: [7300, 6000],
  G: [6000, 5300],
  K: [5300, 3900],
  M: [3900, 2300],
};

// Mean molar masses (kg/mol) for composition keyword inference
const MOLAR_MASSES = {
  h2: 0.002016,
  helium: 0.004003,
  he: 0.004003,
  ch4: 0.016043,
  methane: 0.016043,
  water: 0.018015,
  h2o: 0.018015,
  steam: 0.018015,
  nh3: 0.017031,
  ammonia: 0.017031,
  n2: 0.028014,
  nitrogen: 0.028014,
  co: 0.028010,
  o2: 0.031998,
  oxygen: 0.031998,
  h2s: 0.034081,
  ar: 0.039948,
  argon: 0.039948,
  co2: 0.044010,
  'carbon dioxide': 0.044010,
  so2: 0.064066,
};

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a usable numeric value for a spec_key from a spec map.
 * specMap: { [spec_key]: { value_number, value_text, value_min, value_max, status, unit } }
 * Only returns values that are not explicitly unknown / not_applicable.
 */
function val(specMap, key) {
  const s = specMap[key];
  if (!s) return null;
  if (s.status === 'unknown' || s.status === 'not_applicable') return null;
  const n = num(s.value_number);
  if (n != null) return n;
  if (s.value_min != null && s.value_max != null) {
    const lo = num(s.value_min);
    const hi = num(s.value_max);
    if (lo != null && hi != null) return (lo + hi) / 2;
  }
  return num(s.value_text);
}

function statusOf(specMap, key) {
  return specMap[key] ? specMap[key].status : undefined;
}

/** Convert a mass spec (earth or jupiter units) into kilograms. */
function massKg(specMap) {
  const me = val(specMap, 'bulk.mass_earth');
  if (me != null) return me * M_EARTH;
  const mj = val(specMap, 'bulk.mass_jupiter');
  if (mj != null) return mj * M_JUP;
  return null;
}

/** Convert a radius spec (earth or jupiter units) into meters. */
function radiusM(specMap) {
  const re = val(specMap, 'bulk.radius_earth');
  if (re != null) return re * R_EARTH;
  const rj = val(specMap, 'bulk.radius_jupiter');
  if (rj != null) return rj * R_JUP;
  return null;
}

/** Infer a mean molar mass (kg/mol) from a free-text composition description. */
function inferMolarMass(composition) {
  if (!composition) return null;
  const text = String(composition).toLowerCase();
  const hits = [];
  for (const [keyword, molar] of Object.entries(MOLAR_MASSES)) {
    // Word-boundary match so "co2" doesn't also fire "co" and "o2".
    const re = new RegExp(`(^|[^a-z0-9])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    if (re.test(text)) hits.push(molar);
  }
  if (!hits.length) return null;
  // Keep it simple: average the identified species' molar masses.
  return hits.reduce((a, b) => a + b, 0) / hits.length;
}

function round(n, digits = 3) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/**
 * Compute all derivable specs from a known-spec map.
 * Returns an array of { spec_key, value_number, unit, status, confidence, notes }.
 * A derived value is skipped if the target spec is already explicitly 'known'.
 */
function computeDerivedSpecs(specMap = {}) {
  const out = [];
  const add = (spec_key, value_number, unit, confidence, notes) => {
    if (value_number == null || !Number.isFinite(value_number)) return;
    if (statusOf(specMap, spec_key) === 'known') return; // never override measured truth
    out.push({
      spec_key,
      value_number: round(value_number, 4),
      unit,
      status: 'estimated',
      confidence,
      notes: `[auto-derived] ${notes}`,
    });
  };

  const m = massKg(specMap);
  const r = radiusM(specMap);

  // Surface gravity (in Earth g) and escape velocity (km/s) from mass + radius
  if (m != null && r != null && r > 0) {
    const gSi = (G * m) / (r * r);
    add('bulk.surface_gravity_g', gSi / G_EARTH, 'g',
      m && r ? 'high' : 'medium',
      `g = G·M/R²; M=${m.toExponential(3)} kg, R=${r.toExponential(3)} m → ${round(gSi, 3)} m/s².`);

    const vEsc = Math.sqrt((2 * G * m) / r) / 1000;
    add('bulk.escape_velocity_km_s', vEsc, 'km/s', 'high',
      `v_esc = sqrt(2·G·M/R); M=${m.toExponential(3)} kg, R=${r.toExponential(3)} m.`);

    const volume = (4 / 3) * Math.PI * r * r * r;
    const densityGcc = (m / volume) / 1000; // kg/m3 -> g/cm3
    add('bulk.density_g_cm3', densityGcc, 'g/cm3', 'high',
      `ρ = M / (4/3·π·R³); M=${m.toExponential(3)} kg, R=${r.toExponential(3)} m.`);
  }

  // Equilibrium temperature from stellar flux + albedo
  const flux = val(specMap, 'energy.stellar_flux_earth');
  let albedo = val(specMap, 'energy.albedo');
  if (albedo == null) albedo = 0.3; // assume Earth-like bond albedo when unknown
  if (flux != null && flux > 0) {
    const tEq = T_EQ_REF * Math.pow(1 - albedo, 0.25) * Math.pow(flux, 0.25);
    add('energy.equilibrium_temperature_k', tEq, 'K',
      val(specMap, 'energy.albedo') == null ? 'medium' : 'high',
      `T_eq = 278.5·(1-A)^¼·(S/S⊕)^¼; A=${round(albedo, 2)}${val(specMap, 'energy.albedo') == null ? ' (assumed)' : ''}, S/S⊕=${round(flux, 3)}.`);
  }

  // Effective temperature for gas-law steps: prefer known equilibrium temp,
  // else the value we just derived, else skip.
  const tempForGas = val(specMap, 'energy.equilibrium_temperature_k')
    || (out.find((s) => s.spec_key === 'energy.equilibrium_temperature_k') || {}).value_number
    || null;

  // Surface gravity in SI for atmosphere steps
  const gForAtm = (m != null && r != null && r > 0)
    ? (G * m) / (r * r)
    : (val(specMap, 'bulk.surface_gravity_g') != null ? val(specMap, 'bulk.surface_gravity_g') * G_EARTH : null);

  const composition = specMap['atmosphere.composition'] && specMap['atmosphere.composition'].value_text;
  const molar = inferMolarMass(composition);
  const pressureBar = val(specMap, 'atmosphere.pressure_bar');

  // Atmospheric density via ideal gas: ρ = P·M_molar / (R·T)
  if (pressureBar != null && pressureBar > 0 && tempForGas && molar) {
    const pPa = pressureBar * 1e5;
    const density = (pPa * molar) / (R_GAS * tempForGas);
    add('atmosphere.density_kg_m3', density, 'kg/m3',
      molar && tempForGas ? 'medium' : 'low',
      `ρ = P·M/(R·T); P=${pressureBar} bar, M=${round(molar * 1000, 1)} g/mol, T=${round(tempForGas, 1)} K.`);
  }

  // Atmospheric scale height: H = R·T / (M_molar·g)
  if (tempForGas && molar && gForAtm && gForAtm > 0) {
    const hKm = (R_GAS * tempForGas) / (molar * gForAtm) / 1000;
    add('atmosphere.scale_height_km', hKm, 'km', 'medium',
      `H = R·T/(M·g); T=${round(tempForGas, 1)} K, M=${round(molar * 1000, 1)} g/mol, g=${round(gForAtm, 2)} m/s².`);
  }

  // Host-star effective temperature from spectral type (drives light color)
  const hostText = specMap['location.host_star_or_object'] && specMap['location.host_star_or_object'].value_text;
  const spect = parseSpectralType(hostText);
  const teff = spectralTypeToTeff(spect);
  if (teff != null) {
    add('energy.star_effective_temperature_k', teff, 'K', 'medium',
      `Teff interpolated from spectral type ${spect.cls}${spect.subclass != null ? spect.subclass : ''} between class anchors.`);
  }

  // Daylight illuminance: overhead sunlight on Earth ≈ 133,000 lux, ∝ insolation.
  if (flux != null && flux > 0) {
    add('human_experience.daylight_illuminance_lux', EARTH_NOON_ILLUMINANCE_LUX * flux, 'lux', 'medium',
      `E = 133,000 lux × S/S⊕; S/S⊕=${round(flux, 3)}.`);
  }

  // Qualitative sky appearance from Rayleigh-scattering reasoning
  const sky = describeSky({ composition, pressureBar, hostStar: hostText });
  if (sky && statusOf(specMap, 'human_experience.sky_appearance') !== 'known') {
    out.push({
      spec_key: 'human_experience.sky_appearance',
      value_text: sky.text,
      status: 'estimated',
      confidence: 'low',
      notes: `[auto-derived] ${sky.note}`,
    });
  }

  return out;
}

/**
 * Qualitative sky color / light-distortion reasoning. Rayleigh scattering goes as
 * 1/λ⁴, so a thick clear atmosphere scatters blue; thin atmospheres look black;
 * dense/hazy ones wash toward white/orange. Host-star color shifts the tint.
 */
function describeSky({ composition, pressureBar, hostStar }) {
  if (pressureBar == null && !composition) return null;
  const parts = [];
  let note = 'Rayleigh scattering ∝ 1/λ⁴';

  if (pressureBar != null) {
    if (pressureBar < 0.01) {
      parts.push('a near-black daytime sky with sharp, unscattered sunlight — too little gas to scatter blue');
    } else if (pressureBar < 1.5) {
      parts.push('a blue-toned sky from Rayleigh scattering, deepening overhead');
    } else if (pressureBar < 20) {
      parts.push('a hazy, washed-out sky as thick air scatters across all wavelengths');
    } else {
      parts.push('a dense, twilight-grey sky where sunlight is heavily diffused and the horizon may glow orange-red');
    }
  }

  const comp = String(composition || '').toLowerCase();
  if (comp.includes('co2') || comp.includes('carbon dioxide')) parts.push('a faintly tan-pink cast from CO₂ and dust');
  if (comp.includes('methane') || comp.includes('ch4')) parts.push('a blue-green absorption tint from methane');
  if (comp.includes('sulfur') || comp.includes('so2') || comp.includes('sulfuric')) parts.push('a yellow sulphurous pall');

  if (hostStar) {
    const hs = String(hostStar).toLowerCase();
    if (/(m[\s-]?dwarf|red dwarf|m\d)/.test(hs)) { parts.push('reddened overall by a cool red-dwarf primary'); note += '; cool host star shifts tint red'; }
    else if (/(o|b)[\s-]?type|blue/.test(hs)) { parts.push('with a harsh blue-white glare from a hot primary'); note += '; hot host star shifts tint blue'; }
  }

  if (!parts.length) return null;
  return { text: `Expect ${parts.join(', ')}.`, note };
}

/**
 * Extract a stellar spectral class from free text. Handles the ingestion
 * format "Kepler-22 (G5 V)" (parenthetical preferred), compact "M8V", and
 * prose forms like "G2V yellow dwarf" or "M dwarf". Catalog names such as
 * "K2-18" must NOT parse as class K — a hyphen right after the subclass
 * digit rejects the match.
 */
function parseSpectralType(text) {
  if (!text) return null;
  const s = String(text).toUpperCase();
  const paren = s.match(/\(([^)]+)\)/);
  const target = paren ? paren[1] : s;
  const m = target.match(/\b([OBAFGKM])\s?(\d(?:\.\d)?)(?![\d.-])/);
  if (m) return { cls: m[1], subclass: parseFloat(m[2]) };
  if (!paren) {
    const prose = s.match(/\b([OBAFGKM])[-\s](?:TYPE|DWARF|STAR|GIANT|SUBGIANT|CLASS)/);
    if (prose) return { cls: prose[1], subclass: 5 };
  }
  return null;
}

/** Interpolate an effective temperature (K) from a parsed spectral type. */
function spectralTypeToTeff(spect) {
  if (!spect || !SPECTRAL_TEFF_ANCHORS[spect.cls]) return null;
  const [t0, t9] = SPECTRAL_TEFF_ANCHORS[spect.cls];
  const sub = Number.isFinite(spect.subclass) ? Math.min(Math.max(spect.subclass, 0), 9.9) : 5;
  return t0 + (t9 - t0) * (sub / 10);
}

/**
 * Blackbody temperature → normalized linear RGB (max channel = 1), via the
 * Tanner-Helland piecewise fit. 5772 K ≈ warm white, 3000 K red, 10000 K blue.
 */
function blackbodyToRGB(teffK) {
  if (!Number.isFinite(teffK) || teffK <= 0) return null;
  const t = Math.min(Math.max(teffK, 1000), 40000) / 100;
  let r; let g; let b;
  if (t <= 66) r = 255;
  else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
  if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
  else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = (x) => Math.min(255, Math.max(0, x));
  const rgb = [clamp(r), clamp(g), clamp(b)];
  const max = Math.max(rgb[0], rgb[1], rgb[2], 1);
  return rgb.map((x) => round(x / max, 4));
}

/**
 * Quantitative render parameters for the Unreal surface stage. Same contract
 * as computeDerivedSpecs (pure, deterministic, never overrides knowns — it
 * only reads) but returns a structured model instead of spec rows, because
 * scattering coefficients and RGB triples don't fit the value_number schema.
 */
function computeRenderModel(specMap = {}) {
  const derived = computeDerivedSpecs(specMap);
  const dByKey = {};
  for (const d of derived) if (d.value_number != null) dByKey[d.spec_key] = d.value_number;
  const get = (key) => {
    const v = val(specMap, key);
    return v != null ? v : (dByKey[key] != null ? dByKey[key] : null);
  };
  const text = (key) => ((specMap[key] && specMap[key].value_text) ? String(specMap[key].value_text) : null);

  // "Tidally locked" only counts when not negated in the same clause
  // (seed values read "Not locked; 3:2 resonance" and similar).
  const lockText = text('orbital.tidal_lock_status') || '';
  const rotation = {
    period_h: get('orbital.rotation_period_hours'),
    obliquity_deg: get('orbital.obliquity_deg'),
    tidal_locked: /locked|synchronous/i.test(lockText)
      && !/\b(not|never|no|isn't|un-?locked)\b[^.;]*\b(locked|synchronous)/i.test(lockText),
  };

  // --- host star: color, brightness, apparent size ---
  const hostText = text('location.host_star_or_object');
  const spect = parseSpectralType(hostText);
  let teff = spectralTypeToTeff(spect);
  let starConfidence = 'medium';
  if (teff == null) { teff = T_SUN; starConfidence = 'low'; }
  const flux = get('energy.stellar_flux_earth');
  const aAU = get('orbital.semi_major_axis_au');
  // L/L☉ = S/S⊕ · a²; R★/R☉ = √L · (T☉/T★)²; θ = θ☉ · (R★/R☉)/a
  let angular = SUN_ANGULAR_DIAMETER_DEG;
  if (flux != null && flux > 0 && aAU != null && aAU > 0) {
    const lSun = flux * aAU * aAU;
    const rStar = Math.sqrt(lSun) * Math.pow(T_SUN / teff, 2);
    angular = SUN_ANGULAR_DIAMETER_DEG * (rStar / aAU);
  }
  const sun = {
    name: hostText ? (hostText.replace(/\s*\([^)]*\)\s*/g, '').trim() || 'Host star') : 'Host star',
    teff_k: Math.round(teff),
    rgb: blackbodyToRGB(teff),
    illuminance_lux: (flux != null && flux > 0) ? Math.round(EARTH_NOON_ILLUMINANCE_LUX * flux) : null,
    angular_diameter_deg: round(angular, 4),
    confidence: starConfidence,
  };

  // --- atmosphere: Rayleigh/Mie coefficients as scalings of UE Earth defaults ---
  const pressureBar = get('atmosphere.pressure_bar');
  const airDensity = get('atmosphere.density_kg_m3');
  const scaleHeightKm = get('atmosphere.scale_height_km');
  const composition = (text('atmosphere.composition') || '').toLowerCase();
  const cloudsText = (text('atmosphere.clouds_hazes') || '').toLowerCase();
  const hasAtmosphere = (pressureBar != null && pressureBar > 1e-6)
    || (airDensity != null && airDensity > 1e-6);

  // Rayleigh scattering ∝ molecular number density → scale Earth's coefficient
  // by surface air density (fallback: surface pressure as a crude proxy).
  let rayleighScale = 0;
  if (hasAtmosphere && airDensity != null) rayleighScale = UE_EARTH_RAYLEIGH_SCALE * (airDensity / EARTH_AIR_DENSITY_KG_M3);
  else if (hasAtmosphere && pressureBar != null) rayleighScale = UE_EARTH_RAYLEIGH_SCALE * pressureBar;
  let rayleighColor = UE_EARTH_RAYLEIGH_COLOR.slice();
  if (/ch4|methane/.test(composition)) rayleighColor = [0.05, 0.35, 1.0];
  else if (/so2|sulfur|sulphur|sulfuric/.test(composition)) rayleighColor = [0.6, 0.5, 0.3];

  let mie = { scale: hasAtmosphere ? UE_EARTH_MIE_SCALE : 0, anisotropy: 0.8, color: [1.0, 1.0, 1.0] };
  let fog = { enabled: false, density: 0 };
  const clouds = { enabled: false };
  const dusty = /dust/.test(cloudsText)
    || (/co2|carbon dioxide/.test(composition) && pressureBar != null && pressureBar < 0.1);
  if (hasAtmosphere) {
    if (dusty) mie = { scale: 0.03, anisotropy: 0.6, color: [0.9, 0.7, 0.5] };
    else if (/haz|smog|aerosol/.test(cloudsText)) mie = { scale: 0.02, anisotropy: 0.7, color: [1.0, 0.95, 0.85] };
    if (/thick|global|dense|opaque|perpetual/.test(cloudsText)) {
      clouds.enabled = true;
      fog = { enabled: true, density: Math.min(Math.max(0.02 * (pressureBar || 1), 0.005), 0.5) };
      if (mie.scale < 0.01) mie = { scale: 0.01, anisotropy: 0.75, color: mie.color };
    }
  }

  // Ground palette from the dominant surface materials: tints applied over
  // the renderer's photo textures (desat = how far the red-sand photo gets
  // neutralized first; icy worlds need nearly full desaturation).
  const materials = (text('surface.dominant_materials') || '').toLowerCase();
  let palette = { ground: [0.95, 0.9, 0.85], rock: [0.9, 0.88, 0.86], dust: [0.62, 0.44, 0.3], desat: 0.35 };
  if (/\bice|snow|frost|frozen/.test(materials)) {
    palette = { ground: [0.72, 0.78, 0.88], rock: [0.5, 0.55, 0.63], dust: [0.78, 0.84, 0.95], desat: 0.9 };
  } else if (/iron|oxide|rust|hematite/.test(materials)) {
    palette = { ground: [0.95, 0.88, 0.8], rock: [0.75, 0.72, 0.7], dust: [0.62, 0.44, 0.3], desat: 0.35 };
  } else if (/basalt|volcanic|lava|mafic/.test(materials)) {
    palette = { ground: [0.55, 0.53, 0.52], rock: [0.42, 0.41, 0.4], dust: [0.6, 0.55, 0.5], desat: 0.75 };
  } else if (/sulfur|sulphur/.test(materials)) {
    palette = { ground: [0.95, 0.85, 0.45], rock: [0.75, 0.65, 0.35], dust: [0.9, 0.8, 0.5], desat: 0.8 };
  }

  const r = radiusM(specMap);
  const gG = get('bulk.surface_gravity_g');
  const albedo = get('energy.albedo');
  const surface = {
    planet_radius_km: r != null ? round(r / 1000, 1) : null,
    ground_albedo: albedo != null ? albedo : 0.3,
    has_atmosphere: hasAtmosphere,
    atmosphere_height_km: (hasAtmosphere && scaleHeightKm != null)
      ? round(Math.min(Math.max(11 * scaleHeightKm, 60), 200), 1)
      : 60,
    // Isostatic limit: tallest supportable mountains shrink as gravity grows.
    max_relief_m: (gG != null && gG > 0)
      ? Math.round(Math.min(Math.max(10000 / gG, 500), 30000))
      : 10000,
    rayleigh: {
      scale: round(rayleighScale, 6),
      color: rayleighColor,
      exp_distribution_km: scaleHeightKm != null ? round(Math.min(Math.max(scaleHeightKm, 1), 100), 2) : 8.0,
    },
    mie: { scale: round(mie.scale, 6), anisotropy: mie.anisotropy, color: mie.color },
    fog,
    clouds,
    palette,
  };

  return { rotation, surface, suns: [sun] };
}

module.exports = {
  computeDerivedSpecs,
  computeRenderModel,
  parseSpectralType,
  spectralTypeToTeff,
  blackbodyToRGB,
  inferMolarMass,
  describeSky,
  // exported for tests
  _internals: { massKg, radiusM, val, G, M_EARTH, R_EARTH },
};

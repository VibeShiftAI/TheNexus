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

  // Qualitative sky appearance from Rayleigh-scattering reasoning
  const sky = describeSky({ composition, pressureBar, hostStar: specMap['location.host_star_or_object'] && specMap['location.host_star_or_object'].value_text });
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

module.exports = {
  computeDerivedSpecs,
  inferMolarMass,
  describeSky,
  // exported for tests
  _internals: { massKg, radiusM, val, G, M_EARTH, R_EARTH },
};

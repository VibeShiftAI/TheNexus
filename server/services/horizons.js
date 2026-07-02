/**
 * NASA JPL Horizons state-vector fetcher.
 *
 * For Solar System bodies we pull the *true* position + velocity at a fixed
 * epoch (J2000, barycentric, ecliptic frame) from the Horizons API, so the
 * Unreal N-body sim starts from real initial conditions instead of an idealized
 * circular guess. Returns strict SI: metres and metres/second.
 *
 * Bodies not in the Solar System (exoplanets) return null here; the exporter
 * falls back to deriving initial conditions from orbital elements.
 */

const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api';

// Planet/Sun *center* ids (x99), keyed by lowercase name.
const SOLAR_BODY_IDS = {
  sun: '10',
  mercury: '199',
  venus: '299',
  earth: '399',
  mars: '499',
  jupiter: '599',
  saturn: '699',
  uranus: '799',
  neptune: '899',
};

const KM = 1000; // km -> m, km/s -> m/s

function isSolarBody(name) {
  return Object.prototype.hasOwnProperty.call(SOLAR_BODY_IDS, String(name || '').trim().toLowerCase());
}

function num(token) {
  // Horizons uses Fortran-style scientific notation, e.g. -1.234567890E+08
  const n = parseFloat(String(token).replace(/D/i, 'E'));
  return Number.isFinite(n) ? n : null;
}

/** Parse the $$SOE..$$EOE vector block: X/Y/Z (km), VX/VY/VZ (km/s). */
function parseVectors(text) {
  const start = text.indexOf('$$SOE');
  const end = text.indexOf('$$EOE');
  if (start === -1 || end === -1) return null;
  const block = text.slice(start + 5, end);
  const pick = (re) => { const m = block.match(re); return m ? num(m[1]) : null; };
  const X = pick(/X\s*=\s*([-+0-9.eED]+)/);
  const Y = pick(/Y\s*=\s*([-+0-9.eED]+)/);
  const Z = pick(/Z\s*=\s*([-+0-9.eED]+)/);
  const VX = pick(/VX\s*=\s*([-+0-9.eED]+)/);
  const VY = pick(/VY\s*=\s*([-+0-9.eED]+)/);
  const VZ = pick(/VZ\s*=\s*([-+0-9.eED]+)/);
  if ([X, Y, Z, VX, VY, VZ].some((v) => v == null)) return null;
  return {
    position_m: [X * KM, Y * KM, Z * KM],
    velocity_mps: [VX * KM, VY * KM, VZ * KM],
  };
}

async function fetchStateVectorById(id, { epoch = '2000-01-01' } = {}) {
  const params = new URLSearchParams({
    format: 'text',
    COMMAND: `'${id}'`,
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'VECTORS'",
    CENTER: "'@0'", // Solar System barycenter
    REF_PLANE: "'ECLIPTIC'",
    START_TIME: `'${epoch}'`,
    STOP_TIME: `'${epoch} 01:00'`,
    STEP_SIZE: "'1 d'",
    OUT_UNITS: "'KM-S'",
    VEC_TABLE: "'2'",
  });
  const res = await fetch(`${HORIZONS}?${params.toString()}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Horizons HTTP ${res.status}`);
  const text = await res.text();
  const v = parseVectors(text);
  if (!v) throw new Error('Horizons response had no parseable vector block');
  return v;
}

/** SI state vector for a Solar System body by name, or null if not a known body. */
async function getSolarSystemState(name, opts) {
  const id = SOLAR_BODY_IDS[String(name || '').trim().toLowerCase()];
  if (!id) return null;
  return fetchStateVectorById(id, opts);
}

module.exports = { getSolarSystemState, isSolarBody, parseVectors, SOLAR_BODY_IDS };

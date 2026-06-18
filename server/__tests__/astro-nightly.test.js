const createAstroNightly = require('../services/astro-nightly');
const { buildNasaQuery, advanceNasaCursor, advanceArxivCursor } = createAstroNightly;

// The parsing/mapping functions are pure; construct with no-op deps.
function make() {
  return createAstroNightly({
    sql: {}, uuid: () => 'x', now: () => 'now',
    ingestion: {}, getChannel: () => ({ id: 'impossible-worlds-field-guide', name: 'Impossible Worlds Field Guide' }),
    callAI: async () => ({ text: '{}' }),
  });
}

describe('astro nightly data mapping', () => {
  test('maps a NASA Exoplanet Archive row into a known-status object record', () => {
    const agent = make();
    const rec = agent.nasaRowToRecord({
      pl_name: 'Kepler-22 b', hostname: 'Kepler-22', pl_bmasse: 9.1, pl_rade: 2.4,
      pl_orbper: 289.9, pl_eqt: 262, pl_insol: 1.1, st_spectype: 'G5V', sy_dist: 190, disc_year: 2011, discoverymethod: 'Transit',
    });
    expect(rec.name).toBe('Kepler-22 b');
    expect(rec.object_kind).toBe('exoplanet');
    expect(rec.reality_status).toBe('observed');
    const byKey = Object.fromEntries(rec.spec_values.map((s) => [s.spec_key, s]));
    expect(byKey['bulk.mass_earth'].value_number).toBe(9.1);
    expect(byKey['bulk.mass_earth'].status).toBe('known');
    // distance converted pc -> ly
    expect(byKey['discovery.distance_from_earth_ly'].value_number).toBeCloseTo(190 * 3.2616, 0);
    expect(byKey['location.host_star_or_object'].value_text).toContain('Kepler-22');
  });

  test('omits spec values that are null/non-numeric', () => {
    const agent = make();
    const rec = agent.nasaRowToRecord({ pl_name: 'Sparse b', pl_rade: 1, pl_bmasse: null, pl_eqt: '' });
    const keys = rec.spec_values.map((s) => s.spec_key);
    expect(keys).toContain('bulk.radius_earth');
    expect(keys).not.toContain('bulk.mass_earth');
    expect(keys).not.toContain('energy.equilibrium_temperature_k');
  });

  test('NASA backfill cursor keyset-paginates then flips to incremental', () => {
    // Full batch keeps backfilling and advances the resume key to the last name.
    const start = { mode: 'backfill', position: '', processed_count: 0 };
    const q1 = buildNasaQuery(start, 2);
    expect(q1).toMatch(/order by pl_name asc/);
    expect(q1).not.toMatch(/pl_name >/); // first page has no gate
    const afterFull = advanceNasaCursor(start, [{ pl_name: 'Aa b' }, { pl_name: 'Bb c' }], 2);
    expect(afterFull.mode).toBe('backfill');
    expect(afterFull.position).toBe('Bb c');
    expect(afterFull.processed_count).toBe(2);
    expect(buildNasaQuery(afterFull, 2)).toMatch(/pl_name > 'Bb c'/);

    // A short page means the archive is drained — switch to incremental.
    const afterShort = advanceNasaCursor(afterFull, [{ pl_name: 'Cc d' }], 2);
    expect(afterShort.mode).toBe('incremental');
    expect(afterShort.last_run_at).toBeTruthy();
    expect(buildNasaQuery(afterShort, 2)).toMatch(/rowupdate >/);
  });

  test('ArXiv cursor walks by offset and wraps when a page is short', () => {
    expect(advanceArxivCursor({ position: '0', processed_count: 0 }, 6, 6).position).toBe('6');
    expect(advanceArxivCursor({ position: '6' }, 6, 6).position).toBe('12');
    expect(advanceArxivCursor({ position: '12' }, 2, 6).position).toBe('0'); // short page wraps
  });

  test('parses ArXiv atom entries into title/summary pairs', () => {
    const agent = make();
    const xml = `<feed>
      <entry><title>Rogue planet survey</title><summary>We report free-floating planets.</summary><id>http://arxiv.org/abs/1234.5678</id></entry>
      <entry><title>Neutron star crust</title><summary>Magnetar physics summary.</summary><id>http://arxiv.org/abs/2222.3333</id></entry>
    </feed>`;
    const entries = agent.parseArxiv(xml);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe('Rogue planet survey');
    expect(entries[1].summary).toContain('Magnetar');
  });
});

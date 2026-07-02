const { parseVectors, isSolarBody, SOLAR_BODY_IDS } = require('../services/horizons');

// A trimmed real-shaped Horizons VECTORS response (KM, KM/S).
const SAMPLE = `*******************************************************************************
$$SOE
2451544.500000000 = A.D. 2000-Jan-01 00:00:00.0000 TDB
 X =-2.649903422085761E+07 Y = 1.327574563590418E+08 Z = 1.123966286993364E+04
 VX=-2.979426004078798E+01 VY=-5.018052890373040E+00 VZ= 1.072872701731360E-04
$$EOE
*******************************************************************************`;

describe('horizons vector parser', () => {
  test('parses position + velocity and converts km -> m, km/s -> m/s', () => {
    const v = parseVectors(SAMPLE);
    expect(v).not.toBeNull();
    // Earth ~ 1 AU from the barycenter (1.496e11 m); magnitude check.
    const r = Math.hypot(...v.position_m);
    expect(r).toBeGreaterThan(1.3e11);
    expect(r).toBeLessThan(1.6e11);
    // Speed ~ 29.8 km/s -> ~2.98e4 m/s.
    const s = Math.hypot(...v.velocity_mps);
    expect(s).toBeGreaterThan(2.8e4);
    expect(s).toBeLessThan(3.1e4);
    // Unit conversion: X in km was ~ -2.65e7 km -> -2.65e10 m.
    expect(v.position_m[0]).toBeCloseTo(-2.649903422e10, -7);
  });

  test('returns null when there is no vector block', () => {
    expect(parseVectors('no data here')).toBeNull();
  });

  test('recognizes Solar System bodies by name', () => {
    expect(isSolarBody('Earth')).toBe(true);
    expect(isSolarBody('  jupiter ')).toBe(true);
    expect(isSolarBody('TRAPPIST-1 e')).toBe(false);
    expect(SOLAR_BODY_IDS.earth).toBe('399');
  });
});

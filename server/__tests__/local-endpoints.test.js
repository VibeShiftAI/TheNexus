const { resolveEndpoints } = require('@praxis/contract');

afterEach(() => { jest.resetModules(); });

test('server-to-server HTTP calls use loopback even with legacy localhost overrides', () => {
    const old = { PRAXIS_URL: process.env.PRAXIS_URL, CORTEX_API_URL: process.env.CORTEX_API_URL };
    try {
        process.env.PRAXIS_URL = 'http://localhost:54322';
        process.env.CORTEX_API_URL = 'http://localhost:8100';
        jest.resetModules();
        const endpoints = require('../shared/constants');
        expect(endpoints.PRAXIS_URL).toBe('http://127.0.0.1:54322');
        expect(endpoints.CORTEX_URL).toBe('http://127.0.0.1:8100');
    } finally {
        for (const [key, value] of Object.entries(old)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});

test('dashboard proxy endpoint resolution preserves a configured remote API', () => {
    expect(resolveEndpoints({ NEXUS_API_URL: 'https://api.example.test' }).nexus).toBe('https://api.example.test');
    expect(resolveEndpoints({ NEXUS_API_URL: 'http://localhost:4000' }).nexus).toBe('http://127.0.0.1:4000');
});

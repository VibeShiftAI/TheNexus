// Many suites `delete process.env.NEXUS_DB_PATH` after each test; restore the
// throwaway default before the next one so a later require of db/index.js
// never falls through to the live nexus.db (see setup-model-registry.js).
beforeEach(() => {
    if (!process.env.NEXUS_DB_PATH && global.__NEXUS_TEST_DB_PATH__) {
        process.env.NEXUS_DB_PATH = global.__NEXUS_TEST_DB_PATH__;
    }
});

// No Nexus test reads the live model registry, price catalog or database
// Praxis and The Nexus write; a test that needs a registry installs a fixture
// (see fixtures/model-registry.js). Prices come from a fixed catalog fixture
// so cost figures stay deterministic.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.PRAXIS_MODEL_REGISTRY_PATH = path.join(os.tmpdir(), `nexus-tests-no-model-registry-${process.pid}.json`);
process.env.PRAXIS_OPENROUTER_CATALOG_PATH = path.join(__dirname, 'fixtures', 'openrouter-catalog.json');

// db/index.js opens NEXUS_DB_PATH, else the live nexus.db, and runs its
// migrations on load. Default every test to a throwaway database instead.
const testDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tests-db-')), 'nexus.db');
global.__NEXUS_TEST_DB_PATH__ = testDbPath;
if (!process.env.NEXUS_DB_PATH) process.env.NEXUS_DB_PATH = testDbPath;
// Whole texts that fitToWindow keeps when a model input is cut go to a
// throwaway folder, never the live data/model-inputs.
process.env.NEXUS_MODEL_INPUTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tests-model-inputs-'));

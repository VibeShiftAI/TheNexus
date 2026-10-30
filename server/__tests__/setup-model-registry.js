// No Nexus test reads the live model registry Praxis writes; a test that
// needs one installs a fixture (see fixtures/model-registry.js).
const os = require('os');
const path = require('path');
process.env.PRAXIS_MODEL_REGISTRY_PATH = path.join(os.tmpdir(), `nexus-tests-no-model-registry-${process.pid}.json`);

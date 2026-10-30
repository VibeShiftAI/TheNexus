module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/server', '<rootDir>/services'],
  testMatch: [
    '<rootDir>/server/**/__tests__/**/*.test.js',
    '<rootDir>/services/**/__tests__/**/*.test.js',
  ],
  // Keep every test off the live model registry, price catalog and database.
  setupFiles: ['<rootDir>/server/__tests__/setup-model-registry.js'],
  setupFilesAfterEnv: ['<rootDir>/server/__tests__/setup-test-db.js'],
  modulePathIgnorePatterns: ['<rootDir>/.worktrees/'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/.worktrees/',
    '/\\._[^/]+$',
  ],
};

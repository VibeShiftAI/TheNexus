module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/server', '<rootDir>/services'],
  testMatch: [
    '<rootDir>/server/**/__tests__/**/*.test.js',
    '<rootDir>/services/**/__tests__/**/*.test.js',
  ],
  modulePathIgnorePatterns: ['<rootDir>/.worktrees/'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/.worktrees/',
    '/\\._[^/]+$',
  ],
};

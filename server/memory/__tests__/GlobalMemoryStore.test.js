/**
 * Tests for GlobalMemoryStore
 */

const { GlobalMemoryStore } = require('../GlobalMemoryStore');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

describe('GlobalMemoryStore', () => {
  let store;
  let testPath;

  beforeEach(async () => {
    testPath = path.join(os.tmpdir(), `test_memory_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    store = new GlobalMemoryStore(testPath);
    await store.initialize();
  });

  afterEach(async () => {
    store.destroy();
    try {
      await fs.unlink(testPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should create default memory file if not exists', async () => {
      const exists = await fs.access(testPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should load existing memory file', async () => {
      await store.setPreference('styling', 'framework', 'tailwind', 'user-explicit');
      await store.save();

      const newStore = new GlobalMemoryStore(testPath);
      await newStore.initialize();
      const pref = await newStore.getPreference('styling', 'framework');

      expect(pref?.value).toBe('tailwind');
      newStore.destroy();
    });

    it('should create directory if not exists', async () => {
      const deepPath = path.join(os.tmpdir(), `test_dir_${Date.now()}`, 'nested', 'memory.json');
      const deepStore = new GlobalMemoryStore(deepPath);
      await deepStore.initialize();

      const exists = await fs.access(deepPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      deepStore.destroy();
      // Cleanup
      await fs.rm(path.dirname(path.dirname(deepPath)), { recursive: true, force: true });
    });
  });

  describe('preferences', () => {
    it('should set and get preferences', async () => {
      await store.setPreference('styling', 'framework', 'tailwind');
      const pref = await store.getPreference('styling', 'framework');

      expect(pref?.value).toBe('tailwind');
      expect(pref?.occurrences).toBe(1);
    });

    it('should increase confidence on repeated use', async () => {
      await store.setPreference('styling', 'framework', 'tailwind');
      const first = await store.getPreference('styling', 'framework');

      await store.setPreference('styling', 'framework', 'tailwind');
      const second = await store.getPreference('styling', 'framework');

      expect(second.confidence).toBeGreaterThan(first.confidence);
      expect(second.occurrences).toBe(2);
    });

    it('should preserve user-explicit source', async () => {
      await store.setPreference('styling', 'framework', 'tailwind', 'user-explicit');
      await store.setPreference('styling', 'framework', 'tailwind', 'inferred');

      const pref = await store.getPreference('styling', 'framework');
      expect(pref?.source).toBe('user-explicit');
    });

    it('should handle multiple categories', async () => {
      await store.setPreference('styling', 'framework', 'tailwind');
      await store.setPreference('linting', 'tool', 'eslint');
      await store.setPreference('testing', 'framework', 'vitest');

      const allPrefs = await store.getAllPreferences();
      expect(Object.keys(allPrefs)).toHaveLength(3);
      expect(allPrefs.styling.framework.value).toBe('tailwind');
      expect(allPrefs.linting.tool.value).toBe('eslint');
      expect(allPrefs.testing.framework.value).toBe('vitest');
    });

    it('should remove preferences', async () => {
      await store.setPreference('styling', 'framework', 'tailwind');
      const removed = await store.removePreference('styling', 'framework');
      
      expect(removed).toBe(true);
      const pref = await store.getPreference('styling', 'framework');
      expect(pref).toBeUndefined();
    });

    it('should return false when removing non-existent preference', async () => {
      const removed = await store.removePreference('nonexistent', 'key');
      expect(removed).toBe(false);
    });

    it('should cap confidence at 1.0', async () => {
      // Set preference many times
      for (let i = 0; i < 20; i++) {
        await store.setPreference('styling', 'framework', 'tailwind');
      }
      
      const pref = await store.getPreference('styling', 'framework');
      expect(pref.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  describe('explicit rules', () => {
    it('should add and retrieve explicit rules', async () => {
      const id = await store.addExplicitRule('Always use TypeScript');
      const rules = await store.getExplicitRules();

      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe(id);
      expect(rules[0].rule).toBe('Always use TypeScript');
      expect(rules[0].enabled).toBe(true);
    });

    it('should remove explicit rules', async () => {
      const id = await store.addExplicitRule('Always use TypeScript');
      const removed = await store.removeExplicitRule(id);
      const rules = await store.getExplicitRules();

      expect(removed).toBe(true);
      expect(rules).toHaveLength(0);
    });

    it('should return false when removing non-existent rule', async () => {
      const removed = await store.removeExplicitRule('nonexistent_id');
      expect(removed).toBe(false);
    });

    it('should toggle rule enabled state', async () => {
      const id = await store.addExplicitRule('Always use TypeScript');
      
      await store.toggleRule(id, false);
      let rules = await store.getExplicitRules();
      expect(rules[0].enabled).toBe(false);

      await store.toggleRule(id, true);
      rules = await store.getExplicitRules();
      expect(rules[0].enabled).toBe(true);
    });

    it('should filter enabled rules', async () => {
      await store.addExplicitRule('Rule 1');
      const id2 = await store.addExplicitRule('Rule 2');
      await store.toggleRule(id2, false);

      const allRules = await store.getExplicitRules();
      const enabledRules = await store.getExplicitRules(true);

      expect(allRules).toHaveLength(2);
      expect(enabledRules).toHaveLength(1);
    });
  });

  describe('project history', () => {
    it('should record project access', async () => {
      await store.recordProjectAccess('/projects/my-app', 'react');
      await store.save();

      const exported = await store.export();
      const data = JSON.parse(exported);

      expect(data.projectHistory).toHaveLength(1);
      expect(data.projectHistory[0].path).toBe('/projects/my-app');
      expect(data.projectHistory[0].type).toBe('react');
    });

    it('should update existing project entry', async () => {
      await store.recordProjectAccess('/projects/my-app', 'react');
      await store.recordProjectAccess('/projects/my-app', 'react-updated');
      await store.save();

      const history = await store.getProjectHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('react-updated');
    });

    it('should limit project history to 50 entries', async () => {
      for (let i = 0; i < 60; i++) {
        await store.recordProjectAccess(`/projects/app-${i}`, 'react');
      }
      await store.save();

      const exported = await store.export();
      const data = JSON.parse(exported);

      expect(data.projectHistory).toHaveLength(50);
    });

    it('should get limited history', async () => {
      for (let i = 0; i < 10; i++) {
        await store.recordProjectAccess(`/projects/app-${i}`, 'react');
      }

      const history = await store.getProjectHistory(5);
      expect(history).toHaveLength(5);
    });
  });

  describe('patterns', () => {
    it('should set and get patterns', async () => {
      await store.setPattern('fileNaming', 'kebab-case');
      const pattern = await store.getPattern('fileNaming');
      
      expect(pattern).toBe('kebab-case');
    });

    it('should get all patterns', async () => {
      await store.setPattern('fileNaming', 'kebab-case');
      await store.setPattern('componentStyle', 'functional');
      
      const patterns = await store.getAllPatterns();
      expect(patterns.fileNaming).toBe('kebab-case');
      expect(patterns.componentStyle).toBe('functional');
    });
  });

  describe('project templates', () => {
    it('should update and get project templates', async () => {
      await store.updateProjectTemplate('react-app', {
        defaultDependencies: ['react', 'react-dom'],
        devDependencies: ['vitest']
      });

      const template = await store.getProjectTemplate('react-app');
      expect(template.usageCount).toBe(1);
      expect(template.defaultDependencies).toContain('react');
    });

    it('should increment usage count on update', async () => {
      await store.updateProjectTemplate('react-app', {});
      await store.updateProjectTemplate('react-app', {});
      
      const template = await store.getProjectTemplate('react-app');
      expect(template.usageCount).toBe(2);
    });
  });

  describe('export/import', () => {
    it('should export and import memory', async () => {
      await store.setPreference('styling', 'framework', 'tailwind');
      await store.addExplicitRule('Always use TypeScript');
      const exported = await store.export();

      const newPath = testPath + '.new';
      const newStore = new GlobalMemoryStore(newPath);
      await newStore.initialize();
      await newStore.import(exported);

      const pref = await newStore.getPreference('styling', 'framework');
      expect(pref?.value).toBe('tailwind');

      const rules = await newStore.getExplicitRules();
      expect(rules).toHaveLength(1);

      newStore.destroy();
      await fs.unlink(newPath).catch(() => {});
    });

    it('should reject invalid schema on import', async () => {
      const invalidData = JSON.stringify({ $schema: 'invalid' });
      await expect(store.import(invalidData)).rejects.toThrow('Invalid memory schema');
    });
  });

  describe('clear', () => {
    it('should clear all memory', async () => {
      await store.setPreference('styling', 'framework', 'tailwind');
      await store.addExplicitRule('Test rule');
      await store.setPattern('fileNaming', 'kebab-case');

      await store.clear();

      const prefs = await store.getAllPreferences();
      const rules = await store.getExplicitRules();
      const patterns = await store.getAllPatterns();

      expect(Object.keys(prefs)).toHaveLength(0);
      expect(rules).toHaveLength(0);
      expect(Object.keys(patterns)).toHaveLength(0);
    });
  });

  describe('stats', () => {
    it('should return correct statistics', async () => {
      await store.setPreference('styling', 'framework', 'tailwind');
      await store.setPreference('styling', 'theme', 'dark');
      await store.setPreference('linting', 'tool', 'eslint');
      await store.addExplicitRule('Rule 1');
      await store.setPattern('fileNaming', 'kebab-case');
      await store.recordProjectAccess('/test', 'react');

      const stats = await store.getStats();

      expect(stats.categoryCount).toBe(2);
      expect(stats.totalPreferences).toBe(3);
      expect(stats.ruleCount).toBe(1);
      expect(stats.enabledRuleCount).toBe(1);
      expect(stats.patternCount).toBe(1);
      expect(stats.projectHistoryCount).toBe(1);
    });
  });
});

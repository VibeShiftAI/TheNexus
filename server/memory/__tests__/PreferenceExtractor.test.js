/**
 * Tests for PreferenceExtractor
 */

const { PreferenceExtractor } = require('../PreferenceExtractor');
const { GlobalMemoryStore } = require('../GlobalMemoryStore');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;

describe('PreferenceExtractor', () => {
  let extractor;
  let memoryStore;
  let testPath;

  beforeEach(async () => {
    testPath = path.join(os.tmpdir(), `test_memory_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    memoryStore = new GlobalMemoryStore(testPath);
    await memoryStore.initialize();
    extractor = new PreferenceExtractor(memoryStore);
  });

  afterEach(async () => {
    memoryStore.destroy();
    try {
      await fs.unlink(testPath);
    } catch (e) {
      // Ignore
    }
  });

  describe('analyzeProject', () => {
    it('should detect Tailwind from package.json', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          dependencies: { 'tailwindcss': '^3.0.0' }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.styling).toBe('tailwind');
    });

    it('should detect styled-components', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          dependencies: { 'styled-components': '^6.0.0' }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.styling).toBe('styled-components');
    });

    it('should detect Emotion', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          dependencies: { '@emotion/react': '^11.0.0' }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.styling).toBe('emotion');
    });

    it('should detect TypeScript from package.json', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          devDependencies: { 'typescript': '^5.0.0' }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.language).toBe('typescript');
    });

    it('should detect TypeScript from tsconfig.json', async () => {
      const files = new Map([
        ['package.json', '{}'],
        ['tsconfig.json', '{}']
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.language).toBe('typescript');
    });

    it('should detect Vitest with coverage', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          devDependencies: {
            'vitest': '^1.0.0',
            '@vitest/coverage-v8': '^1.0.0'
          }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.testing?.framework).toBe('vitest');
      expect(analysis.testing?.coverage).toBe(true);
    });

    it('should detect Jest', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          devDependencies: { 'jest': '^29.0.0' }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.testing?.framework).toBe('jest');
    });

    it('should detect package manager from pnpm lock file', async () => {
      const files = new Map([
        ['package.json', '{}'],
        ['pnpm-lock.yaml', '']
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.packageManager).toBe('pnpm');
    });

    it('should detect package manager from yarn lock file', async () => {
      const files = new Map([
        ['package.json', '{}'],
        ['yarn.lock', '']
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.packageManager).toBe('yarn');
    });

    it('should detect package manager from npm lock file', async () => {
      const files = new Map([
        ['package.json', '{}'],
        ['package-lock.json', '{}']
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.packageManager).toBe('npm');
    });

    it('should detect package manager from bun lock file', async () => {
      const files = new Map([
        ['package.json', '{}'],
        ['bun.lockb', '']
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.packageManager).toBe('bun');
    });

    it('should detect ESLint with Airbnb config from package.json', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          devDependencies: {
            'eslint': '^8.0.0',
            'eslint-config-airbnb': '^19.0.0'
          }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.linting?.tool).toBe('eslint');
      expect(analysis.linting?.config).toBe('airbnb');
    });

    it('should detect ESLint with Airbnb config from config file', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({ devDependencies: { 'eslint': '^8.0.0' } })],
        ['.eslintrc.json', JSON.stringify({ extends: ['airbnb'] })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.linting?.tool).toBe('eslint');
      expect(analysis.linting?.config).toBe('airbnb');
    });

    it('should detect Biome', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          devDependencies: { '@biomejs/biome': '^1.0.0' }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.linting?.tool).toBe('biome');
    });

    it('should detect Prettier config', async () => {
      const files = new Map([
        ['package.json', '{}'],
        ['.prettierrc', JSON.stringify({
          tabWidth: 2,
          singleQuote: true,
          semi: false
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.formatting?.tool).toBe('prettier');
      expect(analysis.formatting?.config?.tabWidth).toBe(2);
      expect(analysis.formatting?.config?.singleQuote).toBe(true);
      expect(analysis.formatting?.config?.semi).toBe(false);
    });

    it('should detect React framework', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          dependencies: { 'react': '^18.0.0', 'react-dom': '^18.0.0' }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.framework).toBe('react');
    });

    it('should detect Next.js framework', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          dependencies: { 'react': '^18.0.0', 'next': '^14.0.0' }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.framework).toBe('nextjs');
    });

    it('should detect Vue framework', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          dependencies: { 'vue': '^3.0.0' }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.framework).toBe('vue');
    });

    it('should detect Vite build tool', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          devDependencies: { 'vite': '^5.0.0' }
        })]
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis.buildTool).toBe('vite');
    });

    it('should handle invalid package.json gracefully', async () => {
      const files = new Map([
        ['package.json', 'invalid json']
      ]);

      const analysis = await extractor.analyzeProject('/test', files);
      expect(analysis).toBeDefined();
    });
  });

  describe('learnFromProject', () => {
    it('should store learned preferences', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          dependencies: { 'tailwindcss': '^3.0.0' },
          devDependencies: { 'typescript': '^5.0.0' }
        })],
        ['tsconfig.json', '{}']
      ]);

      await extractor.learnFromProject('/test', files);

      const styling = await memoryStore.getPreference('styling', 'framework');
      expect(styling?.value).toBe('tailwind');

      const language = await memoryStore.getPreference('language', 'primary');
      expect(language?.value).toBe('typescript');
    });

    it('should record project access', async () => {
      const files = new Map([
        ['package.json', JSON.stringify({
          dependencies: { 'react': '^18.0.0' }
        })]
      ]);

      await extractor.learnFromProject('/test/my-app', files);
      await memoryStore.save();

      const history = await memoryStore.getProjectHistory();
      expect(history[0].path).toBe('/test/my-app');
    });
  });

  describe('extractFromMessage', () => {
    it('should extract styling preference', async () => {
      const prefs = await extractor.extractFromMessage('Always use Tailwind CSS for styling');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'styling',
        key: 'framework',
        value: 'tailwind'
      }));
    });

    it('should extract language preference', async () => {
      const prefs = await extractor.extractFromMessage('I prefer TypeScript for all projects');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'language',
        key: 'primary',
        value: 'typescript'
      }));
    });

    it('should normalize ts to typescript', async () => {
      const prefs = await extractor.extractFromMessage('prefer ts');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'language',
        key: 'primary',
        value: 'typescript'
      }));
    });

    it('should extract testing framework', async () => {
      const prefs = await extractor.extractFromMessage('use vitest for testing');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'testing',
        key: 'framework',
        value: 'vitest'
      }));
    });

    it('should extract linting tool', async () => {
      const prefs = await extractor.extractFromMessage('use eslint for linting');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'linting',
        key: 'tool',
        value: 'eslint'
      }));
    });

    it('should extract package manager', async () => {
      const prefs = await extractor.extractFromMessage('use pnpm');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'tooling',
        key: 'packageManager',
        value: 'pnpm'
      }));
    });

    it('should extract tab width preference', async () => {
      const prefs = await extractor.extractFromMessage('use 4 spaces for indent');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'formatting',
        key: 'tabWidth',
        value: 4
      }));
    });

    it('should extract quote style preference', async () => {
      const prefs = await extractor.extractFromMessage('single quotes');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'formatting',
        key: 'quotes',
        value: 'single'
      }));
    });

    it('should extract semicolon preference', async () => {
      const prefs = await extractor.extractFromMessage('use semicolons');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'formatting',
        key: 'semi',
        value: true
      }));

      const prefs2 = await extractor.extractFromMessage('use no semicolons');
      expect(prefs2).toContainEqual(expect.objectContaining({
        category: 'formatting',
        key: 'semi',
        value: false
      }));
    });

    it('should extract framework preference', async () => {
      const prefs = await extractor.extractFromMessage('prefer react');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'framework',
        key: 'primary',
        value: 'react'
      }));
    });

    it('should extract file naming pattern', async () => {
      const prefs = await extractor.extractFromMessage('kebab-case for file naming');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'patterns',
        key: 'fileNaming',
        value: 'kebab-case'
      }));
    });

    it('should extract component style preference', async () => {
      const prefs = await extractor.extractFromMessage('functional components');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'patterns',
        key: 'componentStyle',
        value: 'functional'
      }));
    });

    it('should extract export style preference', async () => {
      const prefs = await extractor.extractFromMessage('use named exports');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'patterns',
        key: 'exportStyle',
        value: 'named'
      }));
    });

    it('should return empty array for no matches', async () => {
      const prefs = await extractor.extractFromMessage('Hello, how are you?');
      expect(prefs).toHaveLength(0);
    });

    it('should extract multiple preferences from one message', async () => {
      const prefs = await extractor.extractFromMessage(
        'I prefer TypeScript, use vitest for testing, and always use Tailwind'
      );
      expect(prefs.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('learnFromMessage', () => {
    it('should store preferences from message', async () => {
      await extractor.learnFromMessage('Always use Tailwind CSS');

      const pref = await memoryStore.getPreference('styling', 'framework');
      expect(pref?.value).toBe('tailwind');
      expect(pref?.source).toBe('user-explicit');
    });

    it('should return extracted preferences', async () => {
      const prefs = await extractor.learnFromMessage('prefer TypeScript');
      expect(prefs).toContainEqual(expect.objectContaining({
        category: 'language',
        key: 'primary',
        value: 'typescript'
      }));
    });
  });

  describe('inferProjectType', () => {
    it('should infer framework-based type', () => {
      const type = extractor.inferProjectType({ framework: 'react' });
      expect(type).toBe('react-app');
    });

    it('should infer web-app for tailwind', () => {
      const type = extractor.inferProjectType({ styling: 'tailwind' });
      expect(type).toBe('web-app');
    });

    it('should infer tested-project for testing framework', () => {
      const type = extractor.inferProjectType({ testing: { framework: 'vitest' } });
      expect(type).toBe('tested-project');
    });

    it('should infer typescript-project for typescript', () => {
      const type = extractor.inferProjectType({ language: 'typescript' });
      expect(type).toBe('typescript-project');
    });

    it('should default to generic', () => {
      const type = extractor.inferProjectType({});
      expect(type).toBe('generic');
    });
  });
});

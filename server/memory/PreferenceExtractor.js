/**
 * PreferenceExtractor - Analyzes projects and messages to extract user preferences
 * 
 * This module provides:
 * - Project configuration analysis (package.json, config files)
 * - Message parsing for explicit preferences
 * - Automatic preference learning from projects
 */

const { GlobalMemoryStore } = require('./GlobalMemoryStore');

/**
 * @typedef {Object} ProjectAnalysis
 * @property {string} [styling] - Styling framework detected
 * @property {{ tool: string; config?: string }} [linting] - Linting configuration
 * @property {{ framework: string; coverage?: boolean }} [testing] - Testing setup
 * @property {{ tool: string; config?: Record<string, unknown> }} [formatting] - Formatting configuration
 * @property {string} [language] - Primary language
 * @property {string} [packageManager] - Package manager used
 * @property {Record<string, string>} [patterns] - Code patterns detected
 * @property {string} [framework] - Application framework (react, vue, etc.)
 */

/**
 * @typedef {Object} ExtractedPreference
 * @property {string} category - Preference category
 * @property {string} key - Preference key
 * @property {unknown} value - Preference value
 * @property {number} confidence - Confidence level (0-1)
 */

class PreferenceExtractor {
  /**
   * @param {GlobalMemoryStore} memoryStore - The memory store instance
   */
  constructor(memoryStore) {
    this.memoryStore = memoryStore;

    // Pattern definitions for message extraction
    this.messagePatterns = [
      { regex: /always use (tailwind|tailwindcss|css|sass|scss|styled-components|emotion)/i, category: 'styling', key: 'framework' },
      { regex: /prefer (typescript|javascript|ts|js)/i, category: 'language', key: 'primary' },
      { regex: /use (vitest|jest|mocha|ava) for testing/i, category: 'testing', key: 'framework' },
      { regex: /use (eslint|biome|tslint) for linting/i, category: 'linting', key: 'tool' },
      { regex: /use (npm|yarn|pnpm|bun)(?:\s|$)/i, category: 'tooling', key: 'packageManager' },
      { regex: /use (\d+) spaces? for (?:indent|tab)/i, category: 'formatting', key: 'tabWidth', transform: (v) => parseInt(v, 10) },
      { regex: /(single|double) quotes/i, category: 'formatting', key: 'quotes', transform: (v) => v.toLowerCase() },
      { regex: /use (semicolons|no semicolons)/i, category: 'formatting', key: 'semi', transform: (v) => !v.includes('no') },
      { regex: /prefer (react|vue|angular|svelte|nextjs|next\.js|nuxt|astro)/i, category: 'framework', key: 'primary' },
      { regex: /(functional|class) components/i, category: 'patterns', key: 'componentStyle' },
      { regex: /(kebab-case|camelCase|PascalCase|snake_case) (?:for )?(?:file|naming)/i, category: 'patterns', key: 'fileNaming' },
      { regex: /use (named|default) (?:exports|imports)/i, category: 'patterns', key: 'exportStyle' },
    ];
  }

  /**
   * Analyzes project configuration files and extracts preferences
   * @param {string} projectPath - Path to the project
   * @param {Map<string, string>} files - Map of filename to content
   * @returns {Promise<ProjectAnalysis>}
   */
  async analyzeProject(projectPath, files) {
    const analysis = {};

    // Analyze package.json
    const packageJson = files.get('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        Object.assign(analysis, this.analyzePackageJson(pkg));
      } catch (e) {
        console.warn('Failed to parse package.json:', e.message);
      }
    }

    // Analyze various config files
    for (const [filename, content] of files) {
      try {
        // ESLint config
        if (filename.includes('eslint') || filename === '.eslintrc' || filename === '.eslintrc.json') {
          analysis.linting = this.analyzeEslintConfig(content, filename);
        }

        // Prettier config
        if (filename.includes('prettier') || filename === '.prettierrc' || filename === '.prettierrc.json') {
          analysis.formatting = this.analyzePrettierConfig(content);
        }

        // Tailwind config
        if (filename === 'tailwind.config.js' || filename === 'tailwind.config.ts' || filename === 'tailwind.config.mjs') {
          analysis.styling = 'tailwind';
        }

        // TypeScript config
        if (filename === 'tsconfig.json') {
          analysis.language = 'typescript';
        }

        // Test config files
        if (filename.includes('vitest') || filename.includes('jest') || filename === 'jest.config.js') {
          analysis.testing = this.analyzeTestConfig(content, filename);
        }

        // Biome config
        if (filename === 'biome.json' || filename === 'biome.jsonc') {
          analysis.linting = { tool: 'biome' };
          analysis.formatting = { tool: 'biome' };
        }

        // Framework-specific configs
        if (filename === 'next.config.js' || filename === 'next.config.mjs' || filename === 'next.config.ts') {
          analysis.framework = 'nextjs';
        }
        if (filename === 'nuxt.config.ts' || filename === 'nuxt.config.js') {
          analysis.framework = 'nuxt';
        }
        if (filename === 'astro.config.mjs' || filename === 'astro.config.ts') {
          analysis.framework = 'astro';
        }
        if (filename === 'svelte.config.js') {
          analysis.framework = 'svelte';
        }
        if (filename === 'vite.config.ts' || filename === 'vite.config.js') {
          analysis.buildTool = 'vite';
        }
      } catch (e) {
        console.warn(`Failed to analyze ${filename}:`, e.message);
      }
    }

    // Detect package manager from lock files
    if (files.has('pnpm-lock.yaml')) {
      analysis.packageManager = 'pnpm';
    } else if (files.has('yarn.lock')) {
      analysis.packageManager = 'yarn';
    } else if (files.has('package-lock.json')) {
      analysis.packageManager = 'npm';
    } else if (files.has('bun.lockb')) {
      analysis.packageManager = 'bun';
    }

    return analysis;
  }

  /**
   * Analyze package.json for preferences
   * @param {Object} pkg - Parsed package.json
   * @returns {Partial<ProjectAnalysis>}
   */
  analyzePackageJson(pkg) {
    const analysis = {};
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {})
    };

    // Styling framework detection
    if (deps['tailwindcss']) {
      analysis.styling = 'tailwind';
    } else if (deps['styled-components']) {
      analysis.styling = 'styled-components';
    } else if (deps['@emotion/react'] || deps['@emotion/styled']) {
      analysis.styling = 'emotion';
    } else if (deps['sass'] || deps['node-sass']) {
      analysis.styling = 'sass';
    } else if (deps['less']) {
      analysis.styling = 'less';
    }

    // Testing framework detection
    if (deps['vitest']) {
      analysis.testing = {
        framework: 'vitest',
        coverage: !!(deps['@vitest/coverage-v8'] || deps['@vitest/coverage-istanbul'])
      };
    } else if (deps['jest']) {
      analysis.testing = {
        framework: 'jest',
        coverage: !!(deps['jest-coverage'] || deps['@jest/coverage'])
      };
    } else if (deps['mocha']) {
      analysis.testing = { framework: 'mocha' };
    } else if (deps['ava']) {
      analysis.testing = { framework: 'ava' };
    }

    // Linting detection
    if (deps['eslint']) {
      analysis.linting = { tool: 'eslint' };
      if (deps['eslint-config-airbnb'] || deps['eslint-config-airbnb-base']) {
        analysis.linting.config = 'airbnb';
      } else if (deps['eslint-config-standard']) {
        analysis.linting.config = 'standard';
      } else if (deps['@typescript-eslint/eslint-plugin']) {
        analysis.linting.config = 'typescript';
      }
    } else if (deps['@biomejs/biome'] || deps['biome']) {
      analysis.linting = { tool: 'biome' };
    }

    // Language detection
    if (deps['typescript']) {
      analysis.language = 'typescript';
    }

    // Framework detection
    if (deps['react'] || deps['react-dom']) {
      analysis.framework = deps['next'] ? 'nextjs' : 'react';
    } else if (deps['vue']) {
      analysis.framework = deps['nuxt'] ? 'nuxt' : 'vue';
    } else if (deps['@angular/core']) {
      analysis.framework = 'angular';
    } else if (deps['svelte']) {
      analysis.framework = 'svelte';
    } else if (deps['astro']) {
      analysis.framework = 'astro';
    }

    // Build tool detection
    if (deps['vite']) {
      analysis.buildTool = 'vite';
    } else if (deps['webpack']) {
      analysis.buildTool = 'webpack';
    } else if (deps['esbuild']) {
      analysis.buildTool = 'esbuild';
    } else if (deps['rollup']) {
      analysis.buildTool = 'rollup';
    }

    return analysis;
  }

  /**
   * Analyze ESLint configuration
   * @param {string} content - Config file content
   * @param {string} filename - Config filename
   * @returns {{ tool: string; config?: string }}
   */
  analyzeEslintConfig(content, filename) {
    const result = { tool: 'eslint' };

    try {
      if (filename.endsWith('.json') || filename === '.eslintrc') {
        const config = JSON.parse(content);
        if (config.extends) {
          const extends_ = Array.isArray(config.extends) ? config.extends : [config.extends];
          if (extends_.some(e => e.includes('airbnb'))) {
            result.config = 'airbnb';
          } else if (extends_.some(e => e.includes('standard'))) {
            result.config = 'standard';
          } else if (extends_.some(e => e.includes('prettier'))) {
            result.config = 'prettier';
          }
        }
      } else {
        // Try to extract from JS config
        if (content.includes('airbnb')) {
          result.config = 'airbnb';
        } else if (content.includes('standard')) {
          result.config = 'standard';
        }
      }
    } catch (e) {
      // Ignore parse errors
    }

    return result;
  }

  /**
   * Analyze Prettier configuration
   * @param {string} content - Config file content
   * @returns {{ tool: string; config?: Record<string, unknown> }}
   */
  analyzePrettierConfig(content) {
    const result = { tool: 'prettier' };

    try {
      const config = JSON.parse(content);
      result.config = {};
      
      if (config.tabWidth !== undefined) result.config.tabWidth = config.tabWidth;
      if (config.useTabs !== undefined) result.config.useTabs = config.useTabs;
      if (config.semi !== undefined) result.config.semi = config.semi;
      if (config.singleQuote !== undefined) result.config.singleQuote = config.singleQuote;
      if (config.trailingComma !== undefined) result.config.trailingComma = config.trailingComma;
      if (config.printWidth !== undefined) result.config.printWidth = config.printWidth;
    } catch (e) {
      // Ignore parse errors
    }

    return result;
  }

  /**
   * Analyze test configuration
   * @param {string} content - Config file content
   * @param {string} filename - Config filename
   * @returns {{ framework: string; coverage?: boolean }}
   */
  analyzeTestConfig(content, filename) {
    if (filename.includes('vitest')) {
      return {
        framework: 'vitest',
        coverage: content.includes('coverage')
      };
    }
    if (filename.includes('jest')) {
      return {
        framework: 'jest',
        coverage: content.includes('coverage') || content.includes('collectCoverage')
      };
    }
    return { framework: 'unknown' };
  }

  /**
   * Learn preferences from a project and store them
   * @param {string} projectPath - Path to the project
   * @param {Map<string, string>} files - Map of filename to content
   * @returns {Promise<ProjectAnalysis>}
   */
  async learnFromProject(projectPath, files) {
    const analysis = await this.analyzeProject(projectPath, files);

    // Store detected preferences
    if (analysis.styling) {
      await this.memoryStore.setPreference('styling', 'framework', analysis.styling, 'project-detected');
    }

    if (analysis.linting) {
      await this.memoryStore.setPreference('linting', 'tool', analysis.linting.tool, 'project-detected');
      if (analysis.linting.config) {
        await this.memoryStore.setPreference('linting', 'config', analysis.linting.config, 'project-detected');
      }
    }

    if (analysis.testing) {
      await this.memoryStore.setPreference('testing', 'framework', analysis.testing.framework, 'project-detected');
      if (analysis.testing.coverage !== undefined) {
        await this.memoryStore.setPreference('testing', 'coverage', analysis.testing.coverage, 'project-detected');
      }
    }

    if (analysis.formatting) {
      await this.memoryStore.setPreference('formatting', 'tool', analysis.formatting.tool, 'project-detected');
      if (analysis.formatting.config) {
        for (const [key, value] of Object.entries(analysis.formatting.config)) {
          if (value !== undefined) {
            await this.memoryStore.setPreference('formatting', key, value, 'project-detected');
          }
        }
      }
    }

    if (analysis.language) {
      await this.memoryStore.setPreference('language', 'primary', analysis.language, 'project-detected');
    }

    if (analysis.packageManager) {
      await this.memoryStore.setPreference('tooling', 'packageManager', analysis.packageManager, 'project-detected');
    }

    if (analysis.framework) {
      await this.memoryStore.setPreference('framework', 'primary', analysis.framework, 'project-detected');
    }

    if (analysis.buildTool) {
      await this.memoryStore.setPreference('tooling', 'buildTool', analysis.buildTool, 'project-detected');
    }

    // Record project access
    const projectType = this.inferProjectType(analysis);
    await this.memoryStore.recordProjectAccess(projectPath, projectType);

    return analysis;
  }

  /**
   * Extract preferences from a user message
   * @param {string} message - User message
   * @returns {Promise<ExtractedPreference[]>}
   */
  async extractFromMessage(message) {
    const preferences = [];

    for (const pattern of this.messagePatterns) {
      const match = message.match(pattern.regex);
      if (match) {
        let value = match[1].toLowerCase();
        
        // Apply transformation if defined
        if (pattern.transform) {
          value = pattern.transform(value);
        }

        // Normalize some values
        if (pattern.key === 'primary' && pattern.category === 'language') {
          value = value === 'ts' ? 'typescript' : value === 'js' ? 'javascript' : value;
        }

        preferences.push({
          category: pattern.category,
          key: pattern.key,
          value,
          confidence: 0.9 // High confidence for explicit user statements
        });
      }
    }

    return preferences;
  }

  /**
   * Learn preferences from a user message and store them
   * @param {string} message - User message
   * @returns {Promise<ExtractedPreference[]>}
   */
  async learnFromMessage(message) {
    const preferences = await this.extractFromMessage(message);

    for (const pref of preferences) {
      await this.memoryStore.setPreference(
        pref.category,
        pref.key,
        pref.value,
        'user-explicit'
      );
    }

    return preferences;
  }

  /**
   * Infer project type from analysis
   * @param {ProjectAnalysis} analysis - Project analysis
   * @returns {string}
   */
  inferProjectType(analysis) {
    if (analysis.framework) {
      return `${analysis.framework}-app`;
    }
    if (analysis.styling === 'tailwind') {
      return 'web-app';
    }
    if (analysis.testing?.framework) {
      return 'tested-project';
    }
    if (analysis.language === 'typescript') {
      return 'typescript-project';
    }
    return 'generic';
  }
}

module.exports = { PreferenceExtractor };

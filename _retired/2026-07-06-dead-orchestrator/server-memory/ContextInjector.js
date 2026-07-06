/**
 * ContextInjector - Injects learned preferences into prompts and scaffolding operations
 * 
 * This module provides:
 * - Context generation for AI prompts
 * - Preference-based scaffolding hints
 * - Rule application to operations
 */

const { GlobalMemoryStore } = require('./GlobalMemoryStore');

/**
 * @typedef {Object} ContextBlock
 * @property {string} type - Type of context (preferences, rules, patterns)
 * @property {string} content - The context content
 * @property {number} priority - Priority for ordering (higher = more important)
 */

/**
 * @typedef {Object} ScaffoldingHints
 * @property {string} [language] - Preferred language
 * @property {string} [packageManager] - Preferred package manager
 * @property {string} [styling] - Preferred styling framework
 * @property {string} [testingFramework] - Preferred testing framework
 * @property {string} [lintingTool] - Preferred linting tool
 * @property {string} [framework] - Preferred application framework
 * @property {Record<string, unknown>} [formatting] - Formatting preferences
 * @property {string[]} [rules] - Applicable explicit rules
 */

/**
 * @deprecated DEPRECATED - Python port available at python/context_injector.py
 * Phase 6: Memory & Context Systems migrated to Python for atomic node integration.
 * This Node.js version is kept for reference but should not be used for new development.
 * 
 * To use the Python version:
 *   from context_injector import ContextInjector, ScaffoldingHints
 */
class ContextInjector {
  /**
   * @param {GlobalMemoryStore} memoryStore - The memory store instance
   * @deprecated Use Python context_injector.py instead
   */
  constructor(memoryStore) {
    console.warn('[DEPRECATED] ContextInjector.js is deprecated. Use Python context_injector.py instead.');
    this.memoryStore = memoryStore;
    this.confidenceThreshold = 0.6; // Minimum confidence to include preference
  }

  /**
   * Set the confidence threshold for including preferences
   * @param {number} threshold - Threshold value (0-1)
   */
  setConfidenceThreshold(threshold) {
    this.confidenceThreshold = Math.max(0, Math.min(1, threshold));
  }

  /**
   * Generate context blocks for injection into prompts
   * @param {Object} [options] - Options for context generation
   * @param {string[]} [options.categories] - Specific categories to include
   * @param {boolean} [options.includeRules=true] - Include explicit rules
   * @param {boolean} [options.includePatterns=true] - Include patterns
   * @param {number} [options.maxBlocks] - Maximum number of context blocks
   * @returns {Promise<ContextBlock[]>}
   */
  async generateContextBlocks(options = {}) {
    const {
      categories,
      includeRules = true,
      includePatterns = true,
      maxBlocks
    } = options;

    const blocks = [];

    // Add preference blocks
    const prefs = await this.getHighConfidencePreferences(categories);
    if (Object.keys(prefs).length > 0) {
      blocks.push({
        type: 'preferences',
        content: this.formatPreferencesForPrompt(prefs),
        priority: 2
      });
    }

    // Add explicit rules
    if (includeRules) {
      const rules = await this.memoryStore.getExplicitRules(true);
      if (rules.length > 0) {
        blocks.push({
          type: 'rules',
          content: this.formatRulesForPrompt(rules),
          priority: 3 // Higher priority for explicit rules
        });
      }
    }

    // Add patterns
    if (includePatterns) {
      const patterns = await this.memoryStore.getAllPatterns();
      if (Object.keys(patterns).length > 0) {
        blocks.push({
          type: 'patterns',
          content: this.formatPatternsForPrompt(patterns),
          priority: 1
        });
      }
    }

    // Sort by priority (descending)
    blocks.sort((a, b) => b.priority - a.priority);

    // Limit if requested
    if (maxBlocks && blocks.length > maxBlocks) {
      return blocks.slice(0, maxBlocks);
    }

    return blocks;
  }

  /**
   * Generate a full context string for injection
   * @param {Object} [options] - Options for context generation
   * @returns {Promise<string>}
   */
  async generateContextString(options = {}) {
    const blocks = await this.generateContextBlocks(options);

    if (blocks.length === 0) {
      return '';
    }

    const sections = blocks.map(block => block.content);
    return `## User Preferences & Context\n\n${sections.join('\n\n')}`;
  }

  /**
   * Get preferences above confidence threshold
   * @param {string[]} [categories] - Specific categories to include
   * @returns {Promise<Record<string, Record<string, unknown>>>}
   */
  async getHighConfidencePreferences(categories) {
    const allPrefs = await this.memoryStore.getAllPreferences();
    const result = {};

    for (const [category, prefs] of Object.entries(allPrefs)) {
      // Skip if specific categories requested and this isn't one
      if (categories && !categories.includes(category)) {
        continue;
      }

      const filteredPrefs = {};
      for (const [key, pref] of Object.entries(prefs)) {
        if (pref.confidence >= this.confidenceThreshold) {
          filteredPrefs[key] = pref.value;
        }
      }

      if (Object.keys(filteredPrefs).length > 0) {
        result[category] = filteredPrefs;
      }
    }

    return result;
  }

  /**
   * Get scaffolding hints based on learned preferences
   * @returns {Promise<ScaffoldingHints>}
   */
  async getScaffoldingHints() {
    const hints = {};

    // Get language preference
    const language = await this.memoryStore.getPreference('language', 'primary');
    if (language && language.confidence >= this.confidenceThreshold) {
      hints.language = language.value;
    }

    // Get package manager
    const packageManager = await this.memoryStore.getPreference('tooling', 'packageManager');
    if (packageManager && packageManager.confidence >= this.confidenceThreshold) {
      hints.packageManager = packageManager.value;
    }

    // Get styling framework
    const styling = await this.memoryStore.getPreference('styling', 'framework');
    if (styling && styling.confidence >= this.confidenceThreshold) {
      hints.styling = styling.value;
    }

    // Get testing framework
    const testing = await this.memoryStore.getPreference('testing', 'framework');
    if (testing && testing.confidence >= this.confidenceThreshold) {
      hints.testingFramework = testing.value;
    }

    // Get linting tool
    const linting = await this.memoryStore.getPreference('linting', 'tool');
    if (linting && linting.confidence >= this.confidenceThreshold) {
      hints.lintingTool = linting.value;
    }

    // Get application framework
    const framework = await this.memoryStore.getPreference('framework', 'primary');
    if (framework && framework.confidence >= this.confidenceThreshold) {
      hints.framework = framework.value;
    }

    // Get formatting preferences
    const formattingPrefs = await this.memoryStore.getPreferencesByCategory('formatting');
    const formatting = {};
    for (const [key, pref] of Object.entries(formattingPrefs)) {
      if (pref.confidence >= this.confidenceThreshold) {
        formatting[key] = pref.value;
      }
    }
    if (Object.keys(formatting).length > 0) {
      hints.formatting = formatting;
    }

    // Get applicable explicit rules
    const rules = await this.memoryStore.getExplicitRules(true);
    if (rules.length > 0) {
      hints.rules = rules.map(r => r.rule);
    }

    return hints;
  }

  /**
   * Generate package.json suggestions based on preferences
   * @returns {Promise<Object>}
   */
  async generatePackageJsonSuggestions() {
    const hints = await this.getScaffoldingHints();
    const suggestions = {
      dependencies: {},
      devDependencies: {},
      scripts: {}
    };

    // Language-based suggestions
    if (hints.language === 'typescript') {
      suggestions.devDependencies['typescript'] = '^5.0.0';
      suggestions.devDependencies['@types/node'] = '^20.0.0';
    }

    // Styling suggestions
    if (hints.styling === 'tailwind') {
      suggestions.devDependencies['tailwindcss'] = '^3.0.0';
      suggestions.devDependencies['postcss'] = '^8.0.0';
      suggestions.devDependencies['autoprefixer'] = '^10.0.0';
    } else if (hints.styling === 'sass') {
      suggestions.devDependencies['sass'] = '^1.0.0';
    } else if (hints.styling === 'styled-components') {
      suggestions.dependencies['styled-components'] = '^6.0.0';
    }

    // Testing suggestions
    if (hints.testingFramework === 'vitest') {
      suggestions.devDependencies['vitest'] = '^1.0.0';
      suggestions.scripts['test'] = 'vitest';
      suggestions.scripts['test:coverage'] = 'vitest --coverage';
    } else if (hints.testingFramework === 'jest') {
      suggestions.devDependencies['jest'] = '^29.0.0';
      suggestions.scripts['test'] = 'jest';
    }

    // Linting suggestions
    if (hints.lintingTool === 'eslint') {
      suggestions.devDependencies['eslint'] = '^8.0.0';
      suggestions.scripts['lint'] = 'eslint .';
    } else if (hints.lintingTool === 'biome') {
      suggestions.devDependencies['@biomejs/biome'] = '^1.0.0';
      suggestions.scripts['lint'] = 'biome check .';
    }

    return suggestions;
  }

  /**
   * Format preferences for prompt injection
   * @param {Record<string, Record<string, unknown>>} prefs - Preferences to format
   * @returns {string}
   */
  formatPreferencesForPrompt(prefs) {
    const lines = ['### Learned Preferences'];

    for (const [category, categoryPrefs] of Object.entries(prefs)) {
      const formattedCategory = category.charAt(0).toUpperCase() + category.slice(1);
      const items = Object.entries(categoryPrefs)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join(', ');
      lines.push(`- **${formattedCategory}**: ${items}`);
    }

    return lines.join('\n');
  }

  /**
   * Format rules for prompt injection
   * @param {Array} rules - Rules to format
   * @returns {string}
   */
  formatRulesForPrompt(rules) {
    const lines = ['### User Rules (Must Follow)'];

    for (const rule of rules) {
      lines.push(`- ${rule.rule}`);
    }

    return lines.join('\n');
  }

  /**
   * Format patterns for prompt injection
   * @param {Record<string, string>} patterns - Patterns to format
   * @returns {string}
   */
  formatPatternsForPrompt(patterns) {
    const lines = ['### Code Patterns'];

    for (const [name, value] of Object.entries(patterns)) {
      const formattedName = name.replace(/([A-Z])/g, ' $1').trim();
      lines.push(`- ${formattedName}: ${value}`);
    }

    return lines.join('\n');
  }

  /**
   * Check if preferences suggest a specific technology
   * @param {string} category - Category to check
   * @param {string} value - Value to match
   * @returns {Promise<boolean>}
   */
  async prefersValue(category, key, value) {
    const pref = await this.memoryStore.getPreference(category, key);
    return pref &&
      pref.confidence >= this.confidenceThreshold &&
      pref.value === value;
  }

  /**
   * Get a recommendation summary for the user
   * @returns {Promise<string>}
   */
  async getRecommendationSummary() {
    const hints = await this.getScaffoldingHints();
    const lines = ['Based on your previous projects, I recommend:'];

    if (hints.language) {
      lines.push(`- Language: ${hints.language}`);
    }
    if (hints.framework) {
      lines.push(`- Framework: ${hints.framework}`);
    }
    if (hints.styling) {
      lines.push(`- Styling: ${hints.styling}`);
    }
    if (hints.testingFramework) {
      lines.push(`- Testing: ${hints.testingFramework}`);
    }
    if (hints.lintingTool) {
      lines.push(`- Linting: ${hints.lintingTool}`);
    }
    if (hints.packageManager) {
      lines.push(`- Package Manager: ${hints.packageManager}`);
    }

    if (lines.length === 1) {
      return 'No preferences learned yet. Work on some projects and I\'ll learn your preferences!';
    }

    return lines.join('\n');
  }
}

module.exports = { ContextInjector };

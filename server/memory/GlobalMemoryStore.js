/**
 * GlobalMemoryStore - Core memory storage infrastructure for persistent, cross-project memory
 * 
 * This module provides:
 * - Persistent storage of user preferences in ~/.claude/global_memory.json
 * - Preference management with confidence tracking
 * - Explicit user rules storage
 * - Project history tracking
 * - Import/Export functionality
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * @typedef {Object} Preference
 * @property {unknown} value - The preference value
 * @property {number} confidence - Confidence level (0-1)
 * @property {string} lastUsed - ISO timestamp of last use
 * @property {number} occurrences - Number of times this preference was detected
 * @property {'inferred' | 'user-explicit' | 'project-detected'} source - How the preference was learned
 */

/**
 * @typedef {Object} ExplicitRule
 * @property {string} id - Unique rule identifier
 * @property {string} rule - The rule text
 * @property {string} addedAt - ISO timestamp when rule was added
 * @property {'user-explicit'} source - Always 'user-explicit' for rules
 * @property {boolean} enabled - Whether the rule is active
 */

/**
 * @typedef {Object} ProjectHistoryEntry
 * @property {string} path - Project path
 * @property {string} type - Project type
 * @property {string} lastAccessed - ISO timestamp
 */

/**
 * @typedef {Object} ProjectTemplate
 * @property {number} usageCount - How many times this template was used
 * @property {string[]} defaultDependencies - Default production dependencies
 * @property {string[]} devDependencies - Default dev dependencies
 */

/**
 * @typedef {Object} GlobalMemorySchema
 * @property {string} $schema - Schema identifier
 * @property {string} version - Schema version
 * @property {string} lastUpdated - ISO timestamp of last update
 * @property {Record<string, Record<string, Preference>>} preferences - Nested preferences by category/key
 * @property {Record<string, string>} patterns - Code patterns
 * @property {Record<string, ProjectTemplate>} projectTemplates - Project templates
 * @property {ExplicitRule[]} explicitRules - User-defined rules
 * @property {ProjectHistoryEntry[]} projectHistory - Recent project access history
 */

const DEFAULT_MEMORY_PATH = path.join(os.homedir(), '.claude', 'global_memory.json');
const CURRENT_VERSION = '1.0.0';
const MAX_PROJECT_HISTORY = 50;
const SAVE_DEBOUNCE_MS = 1000;
const MAX_CONFIDENCE = 1.0;
const CONFIDENCE_INCREMENT = 0.05;
const INITIAL_CONFIDENCE = 0.5;

class GlobalMemoryStore {
  /**
   * @param {string} [customPath] - Optional custom path for memory file
   */
  constructor(customPath) {
    this.memoryPath = customPath || DEFAULT_MEMORY_PATH;
    /** @type {GlobalMemorySchema | null} */
    this.memory = null;
    this.isDirty = false;
    /** @type {NodeJS.Timeout | null} */
    this.saveDebounceTimer = null;
  }

  /**
   * Initialize the memory store, loading existing data or creating new
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      const dir = path.dirname(this.memoryPath);
      await fs.mkdir(dir, { recursive: true });

      try {
        const data = await fs.readFile(this.memoryPath, 'utf-8');
        this.memory = JSON.parse(data);
        await this.migrateIfNeeded();
      } catch (error) {
        if (error.code === 'ENOENT') {
          this.memory = this.createDefaultMemory();
          await this.save();
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error('Failed to initialize global memory:', error);
      this.memory = this.createDefaultMemory();
    }
  }

  /**
   * Create a new default memory structure
   * @returns {GlobalMemorySchema}
   */
  createDefaultMemory() {
    return {
      $schema: 'global_memory_schema_v1',
      version: CURRENT_VERSION,
      lastUpdated: new Date().toISOString(),
      preferences: {},
      patterns: {},
      projectTemplates: {},
      explicitRules: [],
      projectHistory: []
    };
  }

  /**
   * Migrate memory schema if needed for version updates
   * @returns {Promise<void>}
   */
  async migrateIfNeeded() {
    if (this.memory && this.memory.version !== CURRENT_VERSION) {
      // Version migration logic for future schema changes
      // Add migration steps here as versions evolve
      
      // Ensure all required fields exist
      if (!this.memory.patterns) this.memory.patterns = {};
      if (!this.memory.projectTemplates) this.memory.projectTemplates = {};
      if (!this.memory.explicitRules) this.memory.explicitRules = [];
      if (!this.memory.projectHistory) this.memory.projectHistory = [];
      
      this.memory.version = CURRENT_VERSION;
      this.isDirty = true;
    }
  }

  /**
   * Get a specific preference
   * @param {string} category - Preference category (e.g., 'styling', 'linting')
   * @param {string} key - Preference key within category
   * @returns {Promise<Preference | undefined>}
   */
  async getPreference(category, key) {
    await this.ensureLoaded();
    return this.memory?.preferences[category]?.[key];
  }

  /**
   * Set or update a preference
   * @param {string} category - Preference category
   * @param {string} key - Preference key
   * @param {unknown} value - Preference value
   * @param {'inferred' | 'user-explicit' | 'project-detected'} [source='inferred'] - Source of preference
   * @returns {Promise<void>}
   */
  async setPreference(category, key, value, source = 'inferred') {
    await this.ensureLoaded();
    if (!this.memory) return;

    if (!this.memory.preferences[category]) {
      this.memory.preferences[category] = {};
    }

    const existing = this.memory.preferences[category][key];
    const now = new Date().toISOString();

    // Calculate new confidence
    let confidence;
    if (existing) {
      confidence = Math.min(existing.confidence + CONFIDENCE_INCREMENT, MAX_CONFIDENCE);
    } else {
      confidence = source === 'user-explicit' ? 0.9 : INITIAL_CONFIDENCE;
    }

    this.memory.preferences[category][key] = {
      value,
      confidence,
      lastUsed: now,
      occurrences: existing ? existing.occurrences + 1 : 1,
      // Preserve user-explicit source once set
      source: source === 'user-explicit' ? source : (existing?.source || source)
    };

    this.markDirty();
  }

  /**
   * Get all preferences
   * @returns {Promise<Record<string, Record<string, Preference>>>}
   */
  async getAllPreferences() {
    await this.ensureLoaded();
    return this.memory?.preferences || {};
  }

  /**
   * Get preferences by category
   * @param {string} category - The category to retrieve
   * @returns {Promise<Record<string, Preference>>}
   */
  async getPreferencesByCategory(category) {
    await this.ensureLoaded();
    return this.memory?.preferences[category] || {};
  }

  /**
   * Remove a preference
   * @param {string} category - Preference category
   * @param {string} key - Preference key
   * @returns {Promise<boolean>}
   */
  async removePreference(category, key) {
    await this.ensureLoaded();
    if (!this.memory?.preferences[category]?.[key]) {
      return false;
    }

    delete this.memory.preferences[category][key];
    
    // Clean up empty categories
    if (Object.keys(this.memory.preferences[category]).length === 0) {
      delete this.memory.preferences[category];
    }

    this.markDirty();
    return true;
  }

  /**
   * Add an explicit user rule
   * @param {string} rule - The rule text
   * @returns {Promise<string>} - The generated rule ID
   */
  async addExplicitRule(rule) {
    await this.ensureLoaded();
    if (!this.memory) throw new Error('Memory not initialized');

    const id = `rule_${Date.now()}`;
    this.memory.explicitRules.push({
      id,
      rule,
      addedAt: new Date().toISOString(),
      source: 'user-explicit',
      enabled: true
    });

    this.markDirty();
    return id;
  }

  /**
   * Remove an explicit rule by ID
   * @param {string} ruleId - The rule ID to remove
   * @returns {Promise<boolean>}
   */
  async removeExplicitRule(ruleId) {
    await this.ensureLoaded();
    if (!this.memory) return false;

    const index = this.memory.explicitRules.findIndex(r => r.id === ruleId);
    if (index !== -1) {
      this.memory.explicitRules.splice(index, 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  /**
   * Toggle a rule's enabled state
   * @param {string} ruleId - The rule ID
   * @param {boolean} [enabled] - New enabled state (toggles if not provided)
   * @returns {Promise<boolean>}
   */
  async toggleRule(ruleId, enabled) {
    await this.ensureLoaded();
    if (!this.memory) return false;

    const rule = this.memory.explicitRules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = enabled !== undefined ? enabled : !rule.enabled;
      this.markDirty();
      return true;
    }
    return false;
  }

  /**
   * Get all explicit rules
   * @param {boolean} [onlyEnabled=false] - Only return enabled rules
   * @returns {Promise<ExplicitRule[]>}
   */
  async getExplicitRules(onlyEnabled = false) {
    await this.ensureLoaded();
    const rules = this.memory?.explicitRules || [];
    return onlyEnabled ? rules.filter(r => r.enabled) : rules;
  }

  /**
   * Record project access for history tracking
   * @param {string} projectPath - Path to the project
   * @param {string} projectType - Type of project
   * @returns {Promise<void>}
   */
  async recordProjectAccess(projectPath, projectType) {
    await this.ensureLoaded();
    if (!this.memory) return;

    const existing = this.memory.projectHistory.findIndex(p => p.path === projectPath);
    const entry = {
      path: projectPath,
      type: projectType,
      lastAccessed: new Date().toISOString()
    };

    if (existing !== -1) {
      this.memory.projectHistory[existing] = entry;
    } else {
      this.memory.projectHistory.unshift(entry);
      // Keep only the most recent projects
      if (this.memory.projectHistory.length > MAX_PROJECT_HISTORY) {
        this.memory.projectHistory = this.memory.projectHistory.slice(0, MAX_PROJECT_HISTORY);
      }
    }

    this.markDirty();
  }

  /**
   * Get project history
   * @param {number} [limit] - Maximum number of entries to return
   * @returns {Promise<ProjectHistoryEntry[]>}
   */
  async getProjectHistory(limit) {
    await this.ensureLoaded();
    const history = this.memory?.projectHistory || [];
    return limit ? history.slice(0, limit) : history;
  }

  /**
   * Set a pattern preference
   * @param {string} patternName - Pattern name (e.g., 'fileNaming')
   * @param {string} patternValue - Pattern value (e.g., 'kebab-case')
   * @returns {Promise<void>}
   */
  async setPattern(patternName, patternValue) {
    await this.ensureLoaded();
    if (!this.memory) return;

    this.memory.patterns[patternName] = patternValue;
    this.markDirty();
  }

  /**
   * Get a pattern
   * @param {string} patternName - Pattern name
   * @returns {Promise<string | undefined>}
   */
  async getPattern(patternName) {
    await this.ensureLoaded();
    return this.memory?.patterns[patternName];
  }

  /**
   * Get all patterns
   * @returns {Promise<Record<string, string>>}
   */
  async getAllPatterns() {
    await this.ensureLoaded();
    return this.memory?.patterns || {};
  }

  /**
   * Update or create a project template
   * @param {string} templateName - Template name
   * @param {Partial<ProjectTemplate>} template - Template data
   * @returns {Promise<void>}
   */
  async updateProjectTemplate(templateName, template) {
    await this.ensureLoaded();
    if (!this.memory) return;

    const existing = this.memory.projectTemplates[templateName];
    this.memory.projectTemplates[templateName] = {
      usageCount: (existing?.usageCount || 0) + 1,
      defaultDependencies: template.defaultDependencies || existing?.defaultDependencies || [],
      devDependencies: template.devDependencies || existing?.devDependencies || []
    };

    this.markDirty();
  }

  /**
   * Get a project template
   * @param {string} templateName - Template name
   * @returns {Promise<ProjectTemplate | undefined>}
   */
  async getProjectTemplate(templateName) {
    await this.ensureLoaded();
    return this.memory?.projectTemplates[templateName];
  }

  /**
   * Get all project templates
   * @returns {Promise<Record<string, ProjectTemplate>>}
   */
  async getAllProjectTemplates() {
    await this.ensureLoaded();
    return this.memory?.projectTemplates || {};
  }

  /**
   * Ensure memory is loaded before operations
   * @returns {Promise<void>}
   */
  async ensureLoaded() {
    if (!this.memory) {
      await this.initialize();
    }
  }

  /**
   * Mark memory as dirty and schedule save
   */
  markDirty() {
    this.isDirty = true;
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
  }

  /**
   * Force immediate save
   * @returns {Promise<void>}
   */
  async save() {
    if (!this.memory || !this.isDirty) return;

    this.memory.lastUpdated = new Date().toISOString();
    await fs.writeFile(
      this.memoryPath,
      JSON.stringify(this.memory, null, 2),
      'utf-8'
    );
    this.isDirty = false;
  }

  /**
   * Clear all memory data
   * @returns {Promise<void>}
   */
  async clear() {
    this.memory = this.createDefaultMemory();
    this.isDirty = true;
    await this.save();
  }

  /**
   * Export memory as JSON string
   * @returns {Promise<string>}
   */
  async export() {
    await this.ensureLoaded();
    return JSON.stringify(this.memory, null, 2);
  }

  /**
   * Import memory from JSON string
   * @param {string} data - JSON string to import
   * @returns {Promise<void>}
   */
  async import(data) {
    const parsed = JSON.parse(data);
    
    // Validate schema
    if (parsed.$schema !== 'global_memory_schema_v1') {
      throw new Error('Invalid memory schema');
    }
    
    this.memory = parsed;
    this.isDirty = true;
    await this.save();
  }

  /**
   * Get memory statistics
   * @returns {Promise<Object>}
   */
  async getStats() {
    await this.ensureLoaded();
    if (!this.memory) return {};

    const categoryCount = Object.keys(this.memory.preferences).length;
    let totalPreferences = 0;
    for (const category of Object.values(this.memory.preferences)) {
      totalPreferences += Object.keys(category).length;
    }

    return {
      version: this.memory.version,
      lastUpdated: this.memory.lastUpdated,
      categoryCount,
      totalPreferences,
      patternCount: Object.keys(this.memory.patterns).length,
      templateCount: Object.keys(this.memory.projectTemplates).length,
      ruleCount: this.memory.explicitRules.length,
      enabledRuleCount: this.memory.explicitRules.filter(r => r.enabled).length,
      projectHistoryCount: this.memory.projectHistory.length
    };
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
  }
}

module.exports = { GlobalMemoryStore };

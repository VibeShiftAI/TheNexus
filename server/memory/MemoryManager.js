/**
 * MemoryManager - High-level interface for the Global Context Memory system
 * 
 * This is the main entry point for the memory system, coordinating:
 * - GlobalMemoryStore for persistence
 * - PreferenceExtractor for learning
 * - ContextInjector for applying preferences
 */

const { GlobalMemoryStore } = require('./GlobalMemoryStore');
const { PreferenceExtractor } = require('./PreferenceExtractor');
const { ContextInjector } = require('./ContextInjector');

class MemoryManager {
  /**
   * @param {string} [customMemoryPath] - Optional custom path for memory storage
   */
  constructor(customMemoryPath) {
    this.store = new GlobalMemoryStore(customMemoryPath);
    this.extractor = new PreferenceExtractor(this.store);
    this.injector = new ContextInjector(this.store);
    this.initialized = false;
  }

  /**
   * Initialize the memory system
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) return;
    await this.store.initialize();
    this.initialized = true;
  }

  /**
   * Ensure the manager is initialized
   * @returns {Promise<void>}
   */
  async ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  // ============ Store Operations ============

  /**
   * Get a preference value
   * @param {string} category - Preference category
   * @param {string} key - Preference key
   * @returns {Promise<unknown | undefined>}
   */
  async getPreference(category, key) {
    await this.ensureInitialized();
    const pref = await this.store.getPreference(category, key);
    return pref?.value;
  }

  /**
   * Set a preference explicitly
   * @param {string} category - Preference category
   * @param {string} key - Preference key
   * @param {unknown} value - Preference value
   * @returns {Promise<void>}
   */
  async setPreference(category, key, value) {
    await this.ensureInitialized();
    await this.store.setPreference(category, key, value, 'user-explicit');
  }

  /**
   * Get all preferences
   * @returns {Promise<Record<string, Record<string, any>>>}
   */
  async getAllPreferences() {
    await this.ensureInitialized();
    const prefs = await this.store.getAllPreferences();
    
    // Simplify to just values
    const result = {};
    for (const [category, categoryPrefs] of Object.entries(prefs)) {
      result[category] = {};
      for (const [key, pref] of Object.entries(categoryPrefs)) {
        result[category][key] = {
          value: pref.value,
          confidence: pref.confidence,
          source: pref.source
        };
      }
    }
    return result;
  }

  /**
   * Remove a preference
   * @param {string} category - Preference category
   * @param {string} key - Preference key
   * @returns {Promise<boolean>}
   */
  async removePreference(category, key) {
    await this.ensureInitialized();
    return this.store.removePreference(category, key);
  }

  // ============ Rule Operations ============

  /**
   * Add an explicit rule
   * @param {string} rule - Rule text
   * @returns {Promise<string>} - Rule ID
   */
  async addRule(rule) {
    await this.ensureInitialized();
    return this.store.addExplicitRule(rule);
  }

  /**
   * Remove a rule
   * @param {string} ruleId - Rule ID
   * @returns {Promise<boolean>}
   */
  async removeRule(ruleId) {
    await this.ensureInitialized();
    return this.store.removeExplicitRule(ruleId);
  }

  /**
   * Get all rules
   * @param {boolean} [onlyEnabled=false] - Only return enabled rules
   * @returns {Promise<Array>}
   */
  async getRules(onlyEnabled = false) {
    await this.ensureInitialized();
    return this.store.getExplicitRules(onlyEnabled);
  }

  /**
   * Toggle a rule's enabled state
   * @param {string} ruleId - Rule ID
   * @param {boolean} [enabled] - New enabled state
   * @returns {Promise<boolean>}
   */
  async toggleRule(ruleId, enabled) {
    await this.ensureInitialized();
    return this.store.toggleRule(ruleId, enabled);
  }

  // ============ Pattern Operations ============

  /**
   * Set a code pattern
   * @param {string} name - Pattern name
   * @param {string} value - Pattern value
   * @returns {Promise<void>}
   */
  async setPattern(name, value) {
    await this.ensureInitialized();
    await this.store.setPattern(name, value);
  }

  /**
   * Get a code pattern
   * @param {string} name - Pattern name
   * @returns {Promise<string | undefined>}
   */
  async getPattern(name) {
    await this.ensureInitialized();
    return this.store.getPattern(name);
  }

  /**
   * Get all patterns
   * @returns {Promise<Record<string, string>>}
   */
  async getAllPatterns() {
    await this.ensureInitialized();
    return this.store.getAllPatterns();
  }

  // ============ Learning Operations ============

  /**
   * Learn preferences from a project
   * @param {string} projectPath - Path to project
   * @param {Map<string, string>} files - Map of filename to content
   * @returns {Promise<Object>} - Analysis results
   */
  async learnFromProject(projectPath, files) {
    await this.ensureInitialized();
    return this.extractor.learnFromProject(projectPath, files);
  }

  /**
   * Learn preferences from a user message
   * @param {string} message - User message
   * @returns {Promise<Array>} - Extracted preferences
   */
  async learnFromMessage(message) {
    await this.ensureInitialized();
    return this.extractor.learnFromMessage(message);
  }

  /**
   * Analyze a project without storing
   * @param {string} projectPath - Path to project
   * @param {Map<string, string>} files - Map of filename to content
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeProject(projectPath, files) {
    await this.ensureInitialized();
    return this.extractor.analyzeProject(projectPath, files);
  }

  /**
   * Extract preferences from message without storing
   * @param {string} message - User message
   * @returns {Promise<Array>} - Extracted preferences
   */
  async extractFromMessage(message) {
    await this.ensureInitialized();
    return this.extractor.extractFromMessage(message);
  }

  // ============ Context Injection ============

  /**
   * Get context string for prompt injection
   * @param {Object} [options] - Options
   * @returns {Promise<string>}
   */
  async getContextForPrompt(options) {
    await this.ensureInitialized();
    return this.injector.generateContextString(options);
  }

  /**
   * Get scaffolding hints
   * @returns {Promise<Object>}
   */
  async getScaffoldingHints() {
    await this.ensureInitialized();
    return this.injector.getScaffoldingHints();
  }

  /**
   * Get package.json suggestions
   * @returns {Promise<Object>}
   */
  async getPackageJsonSuggestions() {
    await this.ensureInitialized();
    return this.injector.generatePackageJsonSuggestions();
  }

  /**
   * Get a human-readable recommendation summary
   * @returns {Promise<string>}
   */
  async getRecommendationSummary() {
    await this.ensureInitialized();
    return this.injector.getRecommendationSummary();
  }

  /**
   * Set confidence threshold for context injection
   * @param {number} threshold - Threshold (0-1)
   */
  setConfidenceThreshold(threshold) {
    this.injector.setConfidenceThreshold(threshold);
  }

  // ============ History & Stats ============

  /**
   * Get project history
   * @param {number} [limit] - Maximum entries
   * @returns {Promise<Array>}
   */
  async getProjectHistory(limit) {
    await this.ensureInitialized();
    return this.store.getProjectHistory(limit);
  }

  /**
   * Get memory statistics
   * @returns {Promise<Object>}
   */
  async getStats() {
    await this.ensureInitialized();
    return this.store.getStats();
  }

  // ============ Import/Export ============

  /**
   * Export all memory data
   * @returns {Promise<string>}
   */
  async export() {
    await this.ensureInitialized();
    return this.store.export();
  }

  /**
   * Import memory data
   * @param {string} data - JSON data to import
   * @returns {Promise<void>}
   */
  async import(data) {
    await this.ensureInitialized();
    await this.store.import(data);
  }

  /**
   * Clear all memory
   * @returns {Promise<void>}
   */
  async clear() {
    await this.ensureInitialized();
    await this.store.clear();
  }

  /**
   * Force save
   * @returns {Promise<void>}
   */
  async save() {
    await this.ensureInitialized();
    await this.store.save();
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.store.destroy();
  }
}

// Singleton instance
let defaultManager = null;

/**
 * Get the default MemoryManager instance
 * @returns {MemoryManager}
 */
function getDefaultMemoryManager() {
  if (!defaultManager) {
    defaultManager = new MemoryManager();
  }
  return defaultManager;
}

/**
 * Reset the default manager (mainly for testing)
 */
function resetDefaultMemoryManager() {
  if (defaultManager) {
    defaultManager.destroy();
    defaultManager = null;
  }
}

module.exports = {
  MemoryManager,
  getDefaultMemoryManager,
  resetDefaultMemoryManager
};

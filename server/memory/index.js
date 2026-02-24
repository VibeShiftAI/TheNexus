/**
 * Global Context Memory Module
 * 
 * This module provides a persistent, cross-project memory layer that allows
 * the AI agent to learn and retain user preferences across sessions and projects.
 * 
 * @example
 * ```javascript
 * const { getDefaultMemoryManager } = require('./memory');
 * 
 * const memory = getDefaultMemoryManager();
 * await memory.initialize();
 * 
 * // Learn from a project
 * const files = new Map([
 *   ['package.json', '{ "dependencies": { "tailwindcss": "^3.0.0" } }']
 * ]);
 * await memory.learnFromProject('/my/project', files);
 * 
 * // Get context for prompt injection
 * const context = await memory.getContextForPrompt();
 * console.log(context);
 * 
 * // Add an explicit rule
 * await memory.addRule('Always use TypeScript for new projects');
 * 
 * // Get scaffolding hints
 * const hints = await memory.getScaffoldingHints();
 * console.log(hints);
 * ```
 */

const { GlobalMemoryStore } = require('./GlobalMemoryStore');
const { PreferenceExtractor } = require('./PreferenceExtractor');
const { ContextInjector } = require('./ContextInjector');
const { 
  MemoryManager, 
  getDefaultMemoryManager, 
  resetDefaultMemoryManager 
} = require('./MemoryManager');

module.exports = {
  // Main classes
  GlobalMemoryStore,
  PreferenceExtractor,
  ContextInjector,
  MemoryManager,
  
  // Singleton helpers
  getDefaultMemoryManager,
  resetDefaultMemoryManager
};

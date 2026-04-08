/**
 * Models Cache
 * 
 * Provides getAvailableModels() with in-memory TTL caching.
 */
const { MODELS_CACHE_TTL } = require('./constants');

let modelsCache = null;
let modelsCacheTime = 0;

/**
 * Get available models from database with caching
 * @param {Object} db - Database module
 * @returns {Promise<Array>} List of available models
 */
async function getAvailableModels(db) {
    const now = Date.now();

    if (modelsCache && (now - modelsCacheTime) < MODELS_CACHE_TTL) {
        return modelsCache;
    }

    const models = await db.getModels(true); // activeOnly = true

    modelsCache = models;
    modelsCacheTime = now;

    console.log(`[Models] Loaded ${models.length} models from database`);
    return models;
}

/** Invalidate the cache (called after model CRUD operations) */
function invalidateModelsCache() {
    modelsCache = null;
    modelsCacheTime = 0;
}

module.exports = { getAvailableModels, invalidateModelsCache };

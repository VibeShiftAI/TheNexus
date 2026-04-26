/**
 * @praxis/contract — Wire-format contract for the Praxis ecosystem.
 *
 * Single source of truth for entities and events that cross process
 * boundaries between:
 *   - Praxis (autonomous agent runtime)
 *   - TheNexus (desktop cockpit + REST API)
 *   - Nexus Mobile (Expo/React Native client)
 *
 * When adding or changing a wire-format field, update it HERE and
 * run `npm run build` to propagate to all consumers.
 */

export * from "./entities/index.js";
export * from "./events/index.js";

// Legacy exports — keep until consumers are migrated to the entity-based shapes.
export * from "./system.js";
export * from "./notes.js";

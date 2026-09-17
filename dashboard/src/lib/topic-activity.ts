import type { TopicMapData } from './ingestion-control';

export interface TopicAccess {
  topicId: number;
  title: string | null;
  at: string;
  communityUpdatedAt: string | null;
  mapIdentity?: string | null;
  entityCount: number;
  entities: string[];
}

export const TOPIC_ACCESS_MS = 12000;

/** Brightness only: the access never changes a node's radius or position. */
export function topicAccessStrength(at: string, now: number) {
  const age = now - Date.parse(at);
  if (!(age >= 0 && age < TOPIC_ACCESS_MS)) return 0;
  const remaining = 1 - age / TOPIC_ACCESS_MS;
  return remaining * remaining * (3 - 2 * remaining);
}

export function visibleTopicAccesses(accesses: TopicAccess[], map: TopicMapData, now: number) {
  const identities = new Map(map.nodes.map(n => [n.id, JSON.stringify([n.title, n.size, n.top_entities])]));
  const computed = Date.parse(map.computed_at);
  return accesses.filter(a => a.mapIdentity != null && identities.get(a.topicId) === a.mapIdentity && topicAccessStrength(a.at, now) > 0
    // Leiden IDs may be reused after a rebuild. Wait for the new map instead
    // of lighting the old community that happened to have the same number.
    && a.communityUpdatedAt != null && Date.parse(a.communityUpdatedAt) <= computed);
}

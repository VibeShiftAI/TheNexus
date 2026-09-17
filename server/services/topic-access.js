/** Read existing Cortex retrieval stamps; polling this query never records access. */
const TOPIC_ACCESS_QUERY = `
  MATCH (e:Entity)
  WHERE e.last_retrieved_at >= datetime($since)
    AND e.last_retrieved_at <= datetime($until)
  MATCH (e)-[:IN_COMMUNITY]->(c:Community)
  WITH c, e ORDER BY e.last_retrieved_at DESC, e.name
  WITH c, max(e.last_retrieved_at) AS accessed_at,
       count(DISTINCT e) AS entity_count, collect(DISTINCT e.name)[0..8] AS entities
  RETURN c.community_id AS topic_id, c.title AS title,
         c.size AS size, coalesce(c.top_entities, []) AS top_entities,
         toString(c.updated_at) AS community_updated_at,
         toString(accessed_at) AS at, entity_count, entities
  ORDER BY at DESC LIMIT 80
`;

async function readTopicAccess({
  now = Date.now(),
  fetchImpl = fetch,
  gatewayUrl = process.env.CORTEX_GATEWAY_URL || 'http://localhost:8100',
  gatewayKey = process.env.CORTEX_GATEWAY_KEY || '',
} = {}) {
  const response = await fetchImpl(`${gatewayUrl.replace(/\/$/, '')}/api/graph/cypher`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(gatewayKey ? {'X-Gateway-Key': gatewayKey} : {}) },
    signal: AbortSignal.timeout(2000),
    body: JSON.stringify({ query: TOPIC_ACCESS_QUERY, params: {
      since: new Date(now - 300000).toISOString(), until: new Date(now).toISOString(),
    } }),
  });
  if (!response.ok) throw new Error('Topic access unavailable');
  const data = await response.json();
  if (!Array.isArray(data?.rows)) throw new Error('Invalid topic access snapshot');
  return data.rows.filter(row => {
    const age = now - Date.parse(row.at);
    return Number.isSafeInteger(row.topic_id) && age >= 0 && age < 300000;
  }).slice(0, 80).map(row => ({
    topicId: row.topic_id,
    title: typeof row.title === 'string' ? row.title : null,
    at: row.at,
    communityUpdatedAt: typeof row.community_updated_at === 'string' ? row.community_updated_at : null,
    // Match the exact displayed topic identity in Praxis's cached map. IDs
    // can be reassigned during Leiden rebuilds; timestamps alone cannot
    // distinguish snapshots arriving on opposite sides of that rebuild.
    mapIdentity: Number.isSafeInteger(row.size) && Array.isArray(row.top_entities)
      ? JSON.stringify([row.title ?? null, row.size, row.top_entities]) : null,
    entityCount: Number.isSafeInteger(row.entity_count) && row.entity_count > 0 ? row.entity_count : 0,
    entities: Array.isArray(row.entities) ? row.entities.filter(e => typeof e === 'string').slice(0, 8) : [],
  }));
}

module.exports = { readTopicAccess, TOPIC_ACCESS_QUERY };

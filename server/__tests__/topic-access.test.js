const { readTopicAccess, TOPIC_ACCESS_QUERY } = require('../services/topic-access');

test('reads real entity retrieval stamps using a bounded authenticated query, without stamping its own reads', async () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ rows: [
    { topic_id: 12, title: 'Memory', size:20, top_entities:['Neo4j'], at: '2026-09-08T11:59:59Z', community_updated_at: '2026-09-06T00:00:00Z', entity_count: 2, entities: ['Neo4j', 'Vectors'] },
    { topic_id: 99, at: 'bad' },
    { topic_id: 14, at: '2026-09-08T12:00:01Z' },
  ] }) }));
  const result = await readTopicAccess({ now, fetchImpl, gatewayUrl: 'http://cortex.test', gatewayKey: 'fixture' });
  expect(result).toEqual([{ topicId: 12, title: 'Memory', at: '2026-09-08T11:59:59Z', communityUpdatedAt: '2026-09-06T00:00:00Z', mapIdentity:JSON.stringify(['Memory',20,['Neo4j']]), entityCount: 2, entities: ['Neo4j', 'Vectors'] }]);
  const [url, opts] = fetchImpl.mock.calls[0];
  expect(url).toBe('http://cortex.test/api/graph/cypher');
  expect(opts.headers['X-Gateway-Key']).toBe('fixture');
  expect(opts.signal).toBeDefined();
  expect(JSON.parse(opts.body).params).toEqual({ since: '2026-09-08T11:55:00.000Z', until: '2026-09-08T12:00:00.000Z' });
  expect(TOPIC_ACCESS_QUERY).toMatch(/last_retrieved_at/);
  expect(TOPIC_ACCESS_QUERY).toMatch(/IN_COMMUNITY/);
  expect(TOPIC_ACCESS_QUERY).not.toMatch(/\b(SET|CREATE|MERGE|DELETE)\b/);
});

test('unavailable or malformed attribution is an error, rather than a successful quiet graph', async () => {
  for (const response of [{ok: false}, {ok: true, json: async () => ({})}]) {
    await expect(readTopicAccess({fetchImpl: async () => response})).rejects.toThrow();
  }
});

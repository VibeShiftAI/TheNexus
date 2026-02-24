import { useState, useEffect } from 'react';
import type { NodeProperty } from '@/components/workflow-nodes/node-config-panel';

interface UseNodeSchemaResult {
  properties: NodeProperty[];
  loading: boolean;
  error: string | null;
}

/**
 * Shared hook for fetching atomic node schemas from the backend.
 * Used by both WorkflowBuilder (for workflow node configuration) and potentially other components.
 *
 * @param typeId - The atomic node type ID (e.g., 'researcher', 'architect', 'builder')
 * @returns Schema properties, loading state, and error state
 */
export function useNodeSchema(typeId: string | null | undefined): UseNodeSchemaResult {
  const [properties, setProperties] = useState<NodeProperty[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!typeId) {
      setProperties([]);
      setLoading(false);
      setError(null);
      return;
    }

    async function fetchSchema() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/langgraph/node-types/atomic/${typeId}`);
        if (!response.ok) {
          throw new Error(`Failed to load schema for ${typeId}: ${response.status}`);
        }
        const data = await response.json();
        if (!data.properties) {
          throw new Error(`No properties found for node type: ${typeId}`);
        }
        setProperties(data.properties);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load node schema';
        setError(message);
        console.error('[useNodeSchema] Schema fetch failed:', message);
      } finally {
        setLoading(false);
      }
    }

    fetchSchema();
  }, [typeId]);

  return { properties, loading, error };
}

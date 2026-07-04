import { useState, useEffect } from 'react';
import type { NodeProperty } from '@/components/workflow-nodes/node-config-panel';

interface UseNodeSchemaResult {
  properties: NodeProperty[];
  loading: boolean;
  error: string | null;
}

/** Shared hook for retired visual workflow node configuration. */
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

    setProperties([]);
    setError(null);
    setLoading(false);
  }, [typeId]);

  return { properties, loading, error };
}

"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { getProject, type Project } from '@/lib/nexus';

/** Project edits and every read share one sequence. An older response must
 * never replace a newer intake brief, revision guard, or refresh outcome. */
export function useProjectRecord(projectId: string, read: (id: string) => Promise<Project> = getProject) {
  const [project, setProject] = useState<Project | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const current = useRef({ id: projectId, sequence: 0, active: true });
  if (current.current.id !== projectId) current.current = { id: projectId, sequence: current.current.sequence + 1, active: true };
  useEffect(() => {
    current.current.active = true;
    setProject(null); setRefreshError(false);
    return () => { current.current.active = false; current.current.sequence++; };
  }, [projectId]);

  const refresh = useCallback(async () => {
    if (current.current.id !== projectId || !current.current.active) return null;
    const sequence = ++current.current.sequence;
    const isCurrent = () => current.current.id === projectId && current.current.sequence === sequence;
    try {
      const result = await read(projectId);
      if (result.id !== projectId) throw new Error('Project response identity mismatch');
      if (isCurrent()) { setProject(result); setRefreshError(false); }
      return result;
    } catch {
      if (isCurrent()) setRefreshError(true);
      return null;
    }
  }, [projectId, read]);

  const apply = useCallback((result: Project) => {
    if (result.id !== projectId || current.current.id !== projectId || !current.current.active) return;
    current.current.sequence++;
    setProject(result); setRefreshError(false);
  }, [projectId]);

  return { project: project?.id === projectId ? project : null, refreshError, refresh, apply };
}

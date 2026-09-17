import type { KnowledgeNeed, ProjectNeed } from "@praxis/contract";
import { API_URL, authFetch } from "./shared";

export type ProjectNeedPatch = Partial<Omit<ProjectNeed, "knowledge">> & {
  knowledge?: Partial<KnowledgeNeed>;
};
export interface ProjectNeedResponse {
  success: boolean;
  need: ProjectNeed;
  needs: ProjectNeed[];
  updated_at: string;
}

async function mutate(
  projectId: string,
  needId: string | null,
  updates: ProjectNeedPatch,
): Promise<ProjectNeedResponse> {
  const url = `${API_URL}/${encodeURIComponent(projectId)}/needs${needId === null ? "" : `/${encodeURIComponent(needId)}`}`;
  const res = await authFetch(url, {
    method: needId === null ? "POST" : "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(data.error || `Could not save need (${res.status})`);
  return data;
}

export const addProjectNeed = (projectId: string, updates: ProjectNeedPatch) =>
  mutate(projectId, null, updates);
export const patchProjectNeed = (
  projectId: string,
  needId: string,
  updates: ProjectNeedPatch,
) => mutate(projectId, needId, updates);

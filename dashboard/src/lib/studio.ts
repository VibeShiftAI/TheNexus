import { getAuthHeader } from './auth';

const API = '/api/studio';

export const STAGES = [
  ['suggested', 'Suggested'],
  ['approved', 'Approved'],
  ['scripted', 'Scripted'],
  ['thumbnail', 'Thumbnail'],
  ['ready', 'Ready'],
  ['published', 'Published'],
] as const;

export type StudioStatus = 'suggested' | 'approved' | 'scripted' | 'thumbnail' | 'ready' | 'published' | 'archived';
export type GenMode = 'local' | 'cloud';

export interface StudioChannel {
  id: string;
  name: string;
  project_path?: string;
  type?: string;
  positioning?: string;
  editorial_promise?: string;
  audience?: string;
  host_style?: string;
  visual_style_notes?: string;
  recurring_episode_format?: string;
  source_strategy?: string;
  monetization_notes?: string;
  risks_and_mitigations?: string;
  default_cadence_target?: number;
  prompt_guardrails?: string;
}

export interface ThumbnailConcept {
  overlay_text?: string;
  visual?: string;
  composition?: string;
  palette?: string;
  emotion?: string;
}

export interface ImagePrompt {
  label?: string;
  prompt?: string;
  negative_prompt?: string;
  intended_use?: string;
}

export interface ChecklistItem {
  label: string;
  done: boolean;
}

export interface PublishKit {
  titles?: string[];
  description?: string;
  tags?: string[];
  pinned_comment?: string;
}

export interface Idea {
  id: string;
  channel_id: string;
  source: string;
  title: string;
  angle?: string;
  build_promise?: string;
  category?: string;
  status: StudioStatus;
  script?: string | null;
  script_model?: string | null;
  thumbnail_concepts?: ThumbnailConcept[] | null;
  image_prompts?: ImagePrompt[] | null;
  checklist?: ChecklistItem[] | null;
  publish_kit?: PublishKit | null;
  youtube_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface StudioSource {
  id: string;
  channel_id: string;
  name: string;
  source_type: string;
  url?: string | null;
  query_template?: string | null;
  enabled: boolean;
  per_run_cap: number;
  relevance_floor: number;
  notes?: string | null;
}

export interface SpaceSpecValue {
  id?: string;
  object_id?: string;
  spec_key: string;
  value_text?: string | null;
  value_number?: number | null;
  unit?: string | null;
  status?: string;
  confidence?: string;
  notes?: string | null;
}

export interface WonderPoint {
  id?: string;
  object_id?: string;
  wonder_type?: string;
  note: string;
  episode_hook_potential?: string | null;
  visual_prompt_seed?: string | null;
  confidence?: string;
}

export interface SpaceObject {
  id: string;
  channel_id: string;
  name: string;
  aliases?: string | null;
  object_kind?: string | null;
  subtype?: string | null;
  reality_status?: string | null;
  description?: string | null;
  field_guide_summary?: string | null;
  sensory_impression?: string | null;
  points_of_wonder_summary?: string | null;
  spec_values?: SpaceSpecValue[];
  wonder_points?: WonderPoint[];
}

export interface ReferenceImage {
  id: string;
  channel_id: string;
  episode_id?: string | null;
  object_id?: string | null;
  file_path_or_url: string;
  prompt?: string | null;
  negative_prompt?: string | null;
  model?: string | null;
  aspect_ratio?: string | null;
  intended_use?: string | null;
  tags?: string | null;
  notes?: string | null;
  created_at?: string;
}

export interface BoardState {
  channel: StudioChannel;
  channels: StudioChannel[];
  ideas: Idea[];
  targetReady: number;
  sources: StudioSource[];
  objects: SpaceObject[];
  referenceImages: ReferenceImage[];
  promptable: string[];
}

export interface GenerateResult {
  success: boolean;
  result: { summary?: string; created?: number };
  idea: Idea | null;
}

export interface IngestionRunResult {
  localOnly: boolean;
  run: {
    id: string;
    channel_id: string;
    trigger: string;
    status: string;
    items_enqueued: number;
    digest?: string;
  };
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = await getAuthHeader();
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return response.json();
}

export const getChannels = (): Promise<StudioChannel[]> => request(`${API}/channels`);
export const getChannel = (channelId: string): Promise<StudioChannel> => request(`${API}/channels/${channelId}`);
export const updateChannel = (channelId: string, body: Partial<StudioChannel>): Promise<StudioChannel> =>
  request(`${API}/channels/${channelId}`, { method: 'PATCH', body: JSON.stringify(body) });

export const getBoard = (channelId: string): Promise<BoardState> =>
  request(`${API}?channelId=${encodeURIComponent(channelId)}`);
export const getIdea = (id: string): Promise<Idea> => request(`${API}/ideas/${id}`);
export const createIdea = (channelId: string, body: Partial<Idea>): Promise<Idea> =>
  request(`${API}/${channelId}/ideas`, { method: 'POST', body: JSON.stringify(body) });
export const updateIdea = (id: string, body: Partial<Idea>): Promise<Idea> =>
  request(`${API}/ideas/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const advanceIdea = (id: string): Promise<Idea> =>
  request(`${API}/ideas/${id}/advance`, { method: 'POST' });
export const archiveIdea = (id: string): Promise<Idea> => updateIdea(id, { status: 'archived' });
export const deleteIdea = (id: string): Promise<{ success: boolean }> =>
  request(`${API}/ideas/${id}`, { method: 'DELETE' });
export const setTargetReady = (channelId: string, targetReady: number): Promise<{ targetReady: number }> =>
  request(`${API}/${channelId}/settings`, { method: 'POST', body: JSON.stringify({ targetReady }) });
export const seedSeries = (channelId: string, force = false): Promise<{ seeded: number; message?: string }> =>
  request(`${API}/${channelId}/seed`, { method: 'POST', body: JSON.stringify({ force }) });
export const generate = (channelId: string, type: string, opts: { ideaId?: string; mode?: GenMode; count?: number } = {}): Promise<GenerateResult> =>
  request(`${API}/${channelId}/generate`, { method: 'POST', body: JSON.stringify({ type, ...opts }) });
export const getPrompt = (channelId: string, type: string, ideaId?: string): Promise<{ label: string; system: string; user: string }> => {
  const q = new URLSearchParams({ type });
  if (ideaId) q.set('ideaId', ideaId);
  return request(`${API}/${channelId}/prompt?${q.toString()}`);
};
export const applyPaste = (channelId: string, type: string, text: string, ideaId?: string): Promise<GenerateResult> =>
  request(`${API}/${channelId}/apply`, { method: 'POST', body: JSON.stringify({ type, text, ideaId }) });

export const createSource = (channelId: string, body: Partial<StudioSource>): Promise<StudioSource> =>
  request(`${API}/${channelId}/sources`, { method: 'POST', body: JSON.stringify(body) });
export const updateSource = (channelId: string, sourceId: string, body: Partial<StudioSource>): Promise<StudioSource> =>
  request(`${API}/${channelId}/sources/${sourceId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const runIngestion = (channelId: string): Promise<IngestionRunResult> =>
  request(`${API}/${channelId}/ingestion/run`, { method: 'POST', body: JSON.stringify({ trigger: 'manual' }) });
export const createObject = (channelId: string, body: Partial<SpaceObject> & { specs?: SpaceSpecValue[]; wonder_points?: WonderPoint[] }): Promise<SpaceObject> =>
  request(`${API}/${channelId}/objects`, { method: 'POST', body: JSON.stringify(body) });
export const updateObject = (channelId: string, objectId: string, body: Partial<SpaceObject> & { specs?: SpaceSpecValue[]; wonder_points?: WonderPoint[] }): Promise<SpaceObject> =>
  request(`${API}/${channelId}/objects/${objectId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const createReferenceImage = (channelId: string, body: Partial<ReferenceImage>): Promise<ReferenceImage> =>
  request(`${API}/${channelId}/reference-images`, { method: 'POST', body: JSON.stringify(body) });
export const updateReferenceImage = (channelId: string, imageId: string, body: Partial<ReferenceImage>): Promise<ReferenceImage> =>
  request(`${API}/${channelId}/reference-images/${imageId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteReferenceImage = (channelId: string, imageId: string): Promise<{ success: boolean }> =>
  request(`${API}/${channelId}/reference-images/${imageId}`, { method: 'DELETE' });

import { getAuthHeader } from './auth';

const API = '/api/studio';
const DEFAULT_CHANNEL_ID = 'praxis-youtube';
const FALLBACK_CHANNEL_NAME = 'Multi-channel production';

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

type BoardResponse = Partial<Omit<BoardState, 'channel' | 'channels'>> & {
  channel?: StudioChannel | null;
  channels?: StudioChannel[];
  projects?: LegacyStudioProject[];
};

interface LegacyStudioProject {
  name?: string;
  type?: string;
  description?: string;
  eligible?: boolean;
}

export interface GenerateResult {
  success: boolean;
  result: { summary?: string; created?: number };
  idea: Idea | null;
}

export interface IngestionRun {
  id: string;
  channel_id: string;
  trigger: string;
  status: string;
  discovered_count?: number;
  deduped_count?: number;
  items_enqueued?: number;
  items_succeeded?: number;
  items_failed?: number;
  digest?: string;
  created_at?: string;
  updated_at?: string;
}

export interface IngestionRunResult {
  localOnly: boolean;
  run: IngestionRun;
}

export interface IngestionCursor {
  source: string;
  mode: string;
  position?: string;
  processed_count?: number;
  total_estimate?: number | null;
  last_run_at?: string | null;
}

export interface IngestionCursorState {
  cursors: IngestionCursor[];
  objectsTotal: number;
  enrichRemaining: number;
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

function legacyProjectToChannel(project: LegacyStudioProject): StudioChannel | null {
  if (!project.eligible || !project.name) return null;
  if (project.name === 'Impossible Worlds Field Guide') {
    return {
      id: 'impossible-worlds-field-guide',
      name: project.name,
      type: project.type,
      positioning: project.description,
      default_cadence_target: 2,
    };
  }
  if (project.name === 'Praxis') {
    return {
      id: DEFAULT_CHANNEL_ID,
      name: 'Praxis YouTube Channel',
      type: project.type,
      positioning: project.description,
      default_cadence_target: 2,
    };
  }
  if (project.type === 'content') {
    return {
      id: project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: project.name,
      type: project.type,
      positioning: project.description,
      default_cadence_target: 2,
    };
  }
  return null;
}

function legacyProjectChannels(projects: LegacyStudioProject[] = []): StudioChannel[] {
  const seen = new Set<string>();
  const channels: StudioChannel[] = [];
  for (const project of projects) {
    const channel = legacyProjectToChannel(project);
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    channels.push(channel);
  }
  return channels;
}

export function normalizeBoardState(data: BoardResponse, channelId = DEFAULT_CHANNEL_ID): BoardState {
  const channels = data.channels?.length ? data.channels : legacyProjectChannels(data.projects);
  const channel =
    data.channel ||
    channels.find((item) => item.id === channelId) ||
    channels[0] ||
    { id: channelId, name: FALLBACK_CHANNEL_NAME, default_cadence_target: 2 };

  return {
    channel,
    channels,
    ideas: data.ideas || [],
    targetReady: data.targetReady || channel.default_cadence_target || 2,
    sources: data.sources || [],
    objects: data.objects || [],
    referenceImages: data.referenceImages || [],
    promptable: data.promptable || [],
  };
}

export const getBoard = (channelId: string): Promise<BoardState> =>
  request<BoardResponse>(`${API}?channelId=${encodeURIComponent(channelId)}`).then((data) => normalizeBoardState(data, channelId));
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

// ---- Catalog "system" jobs: act on a multi-object selection ----
export interface ObjectsGenerateResult {
  success: boolean;
  result: { summary?: string; text?: string; ideaId?: string | null };
  idea: Idea | null;
}
export const generateFromObjects = (channelId: string, type: string, objectIds: string[], mode: GenMode = 'cloud'): Promise<ObjectsGenerateResult> =>
  request(`${API}/${channelId}/generate`, { method: 'POST', body: JSON.stringify({ type, objectIds, mode }) });
export const getObjectsPrompt = (channelId: string, type: string, objectIds: string[]): Promise<{ label: string; system: string; user: string }> =>
  request(`${API}/${channelId}/prompt?type=${encodeURIComponent(type)}&objectIds=${encodeURIComponent(objectIds.join(','))}`);
export const applyFromObjects = (channelId: string, type: string, text: string, objectIds: string[]): Promise<ObjectsGenerateResult> =>
  request(`${API}/${channelId}/apply`, { method: 'POST', body: JSON.stringify({ type, text, objectIds }) });

export const createSource = (channelId: string, body: Partial<StudioSource>): Promise<StudioSource> =>
  request(`${API}/${channelId}/sources`, { method: 'POST', body: JSON.stringify(body) });
export const updateSource = (channelId: string, sourceId: string, body: Partial<StudioSource>): Promise<StudioSource> =>
  request(`${API}/${channelId}/sources/${sourceId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const runIngestion = (channelId: string): Promise<IngestionRunResult> =>
  request(`${API}/${channelId}/ingestion/run`, { method: 'POST', body: JSON.stringify({ trigger: 'manual' }) });
export const runAstroAgent = (channelId: string): Promise<IngestionRunResult> =>
  request(`${API}/${channelId}/ingestion/astro`, { method: 'POST', body: JSON.stringify({}) });
export const runEnrichment = (channelId: string, batch?: number): Promise<IngestionRunResult> =>
  request(`${API}/${channelId}/ingestion/enrich`, { method: 'POST', body: JSON.stringify(batch ? { batch } : {}) });
export const getIngestionRuns = (channelId: string): Promise<IngestionRun[]> =>
  request(`${API}/${channelId}/ingestion/runs`);
export const getIngestionCursors = (channelId: string): Promise<IngestionCursorState> =>
  request(`${API}/${channelId}/ingestion/cursors`);
export const getIngestionRun = (channelId: string, runId: string): Promise<{ run: IngestionRun; items: unknown[] }> =>
  request(`${API}/${channelId}/ingestion/runs/${runId}`);
export const uploadReferenceImage = async (
  channelId: string,
  file: File,
  meta: { episode_id?: string; object_id?: string; intended_use?: string; prompt?: string; notes?: string } = {}
): Promise<ReferenceImage> => {
  const headers = await getAuthHeader();
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(meta)) {
    if (value != null) form.append(key, String(value));
  }
  const response = await fetch(`${API}/${channelId}/reference-images/upload`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers, // do not set Content-Type; the browser sets the multipart boundary
    body: form,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Upload failed (${response.status})`);
  }
  return response.json();
};
export const createObject = (channelId: string, body: Partial<SpaceObject> & { specs?: SpaceSpecValue[]; wonder_points?: WonderPoint[] }): Promise<SpaceObject> =>
  request(`${API}/${channelId}/objects`, { method: 'POST', body: JSON.stringify(body) });
export const updateObject = (channelId: string, objectId: string, body: Partial<SpaceObject> & { specs?: SpaceSpecValue[]; wonder_points?: WonderPoint[] }): Promise<SpaceObject> =>
  request(`${API}/${channelId}/objects/${objectId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const getReferenceImages = (channelId: string, episodeId?: string): Promise<ReferenceImage[]> =>
  request(`${API}/${channelId}/reference-images${episodeId ? `?episodeId=${encodeURIComponent(episodeId)}` : ''}`);
export const createReferenceImage = (channelId: string, body: Partial<ReferenceImage>): Promise<ReferenceImage> =>
  request(`${API}/${channelId}/reference-images`, { method: 'POST', body: JSON.stringify(body) });
export const updateReferenceImage = (channelId: string, imageId: string, body: Partial<ReferenceImage>): Promise<ReferenceImage> =>
  request(`${API}/${channelId}/reference-images/${imageId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteReferenceImage = (channelId: string, imageId: string): Promise<{ success: boolean }> =>
  request(`${API}/${channelId}/reference-images/${imageId}`, { method: 'DELETE' });

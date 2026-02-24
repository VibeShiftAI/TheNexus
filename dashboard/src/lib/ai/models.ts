// Define the specific model IDs
export const modelIds = [
  '3-pro-preview',
  '3-flash-preview',
  'deep-research-pro-preview-12-2025',
] as const;

export type ModelId = (typeof modelIds)[number];

export interface Model {
  id: ModelId;
  label: string;
  apiIdentifier: string;
  description: string;
  family: string;
}

export const models: Model[] = [
  {
    id: '3-pro-preview',
    label: '3 Pro Preview',
    apiIdentifier: '3-pro-preview',
    description: 'Advanced reasoning model (Preview)',
    family: 'Gemini',
  },
  {
    id: '3-flash-preview',
    label: '3 Flash Preview',
    apiIdentifier: '3-flash-preview',
    description: 'High-speed, efficient model (Preview)',
    family: 'Gemini',
  },
  {
    id: 'deep-research-pro-preview-12-2025',
    label: 'Deep Research Pro',
    apiIdentifier: 'deep-research-pro-preview-12-2025',
    description: 'Specialized research model (Dec 2025 Preview)',
    family: 'Gemini',
  },
];

// Ensure the default model is updated to a valid ID
export const DEFAULT_MODEL_NAME: ModelId = '3-pro-preview';

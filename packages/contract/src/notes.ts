/**
 * @praxis/contract — Note Types
 *
 * Canonical type definitions for the Notes/Scratchpad system
 * shared between desktop and mobile. The category enum is the
 * union of everything any client currently emits.
 */

export type NoteCategory =
  | 'general'
  | 'decision'
  | 'blocker'
  | 'reminder'
  | 'daily-log'
  | 'idea'
  | 'bug';

export interface Note {
  id: string;
  project_id: string | null;
  content: string;
  category: NoteCategory | string;
  source: 'praxis' | 'operator' | string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

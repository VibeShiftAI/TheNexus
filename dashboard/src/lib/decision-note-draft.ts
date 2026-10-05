/**
 * decision-note-draft: keep a decision note that has not been recorded yet.
 *
 * The decision card's note is typed into component state, so a refused save
 * followed by the recovery the refusal recommends (reload the app, sign in
 * again) used to lose the text (task a1cc8616, 2026-10-04). The draft is now
 * written to storage as it is typed, keyed by document, together with what it
 * was written for: the revision on screen when typing started, the decision
 * kind and the attempt id. Restoring it after a reload therefore keeps the
 * revision attribution explicit (the card says which revision the note was
 * written for when that is no longer the revision on screen) and lets a retry
 * of the same attempt reuse its id, so a response that was lost after the
 * decision was recorded is answered from the record instead of recorded twice.
 *
 * localStorage first: it survives a reload, the sign-in round trip (a
 * top-level navigation) and a restart of the app shell. sessionStorage is the
 * fallback. Every call is wrapped: storage that is disabled or full must never
 * break typing or recording. Only the note text is stored, never a credential.
 */

import type { DecisionKind } from "./document-review";

export const DECISION_NOTE_DRAFT_PREFIX = "nexus:document-decision-note:";

export interface DecisionNoteDraft {
    /** Which button the note was typed under. */
    kind: DecisionKind;
    /** The revision the current attempt targets. */
    revision_id: string;
    content_hash: string;
    /** The revision on screen when the note was first written; never moved by a later revision. */
    origin_revision_id: string;
    origin_content_hash: string;
    note: string;
    /** The attempt id, so a retry after a reload is the same attempt. */
    client_decision_id: string;
    saved_at: string;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type DraftStores = DraftStorage | DraftStorage[] | null;

function defaultStorage(): DraftStorage[] {
    const stores: DraftStorage[] = [];
    if (typeof window === "undefined") return stores;
    for (const name of ["localStorage", "sessionStorage"] as const) {
        try {
            if (window[name]) stores.push(window[name]);
        } catch {
            /* Access can fail independently for either store. */
        }
    }
    return stores;
}

function storageList(storage: DraftStores): DraftStorage[] {
    return Array.isArray(storage) ? storage : storage ? [storage] : [];
}

export function decisionNoteDraftKey(documentId: string): string {
    return `${DECISION_NOTE_DRAFT_PREFIX}${documentId}`;
}

const isText = (value: unknown): value is string => typeof value === "string";

function parseDraft(raw: string | null): DecisionNoteDraft | null {
    if (!raw) return null;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!value || typeof value !== "object") return null;
    const d = value as Record<string, unknown>;
    if ((d.kind !== "approve" && d.kind !== "request_changes") || !isText(d.note) || !d.note.trim()) return null;
    if (!isText(d.revision_id) || !isText(d.content_hash) || !isText(d.client_decision_id) || !isText(d.saved_at)) return null;
    return {
        kind: d.kind,
        revision_id: d.revision_id,
        content_hash: d.content_hash,
        origin_revision_id: isText(d.origin_revision_id) ? d.origin_revision_id : d.revision_id,
        origin_content_hash: isText(d.origin_content_hash) ? d.origin_content_hash : d.content_hash,
        note: d.note,
        client_decision_id: d.client_decision_id,
        saved_at: d.saved_at,
    };
}

/** Read both stores: a fallback write must not be hidden by an older local copy. */
export function readDecisionNoteDraft(documentId: string, storage: DraftStores = defaultStorage()): DecisionNoteDraft | null {
    let latest: DecisionNoteDraft | null = null;
    for (const store of storageList(storage)) {
        try {
            const draft = parseDraft(store.getItem(decisionNoteDraftKey(documentId)));
            // Writers use Date.toISOString(): UTC ISO timestamps sort chronologically as strings.
            if (draft && (!latest || draft.saved_at >= latest.saved_at)) latest = draft;
        } catch {
            /* A failing read must not prevent trying the other store. */
        }
    }
    return latest;
}

/** Return whether the current draft persisted; a blank note clears both stores. */
export function writeDecisionNoteDraft(documentId: string, draft: DecisionNoteDraft, storage: DraftStores = defaultStorage()): boolean {
    if (!draft.note.trim()) return clearDecisionNoteDraft(documentId, storage);
    const stores = storageList(storage);
    const key = decisionNoteDraftKey(documentId);
    for (const store of stores) {
        try {
            store.setItem(key, JSON.stringify(draft));
        } catch {
            continue; // Quota/security failure: try sessionStorage too.
        }
        // Keep only the successful copy so switching stores cannot resurrect an old note.
        for (const other of stores) {
            if (other === store) continue;
            try { other.removeItem(key); } catch { /* read chooses the newest if removal is blocked */ }
        }
        return true;
    }
    return false; // The mounted textarea is now the only copy we can promise.
}

export function clearDecisionNoteDraft(documentId: string, storage: DraftStores = defaultStorage()): boolean {
    let cleared = true;
    for (const store of storageList(storage)) {
        try {
            store.removeItem(decisionNoteDraftKey(documentId));
        } catch {
            cleared = false;
        }
    }
    return cleared;
}

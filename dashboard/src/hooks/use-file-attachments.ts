"use client";

/**
 * useFileAttachments — the composer's attachment lane: selection (picker or
 * drag-and-drop), size/count limits, image preview thumbnails, removal, and
 * the object-URL bookkeeping that keeps removed previews from leaking.
 *
 * Extracted from ai-terminal.tsx (P2-27, 2026-09-03). The list transitions
 * live in `attachmentsReducer` below — a pure function, so the limits and the
 * revoke discipline are testable without mounting the terminal.
 */

import { useCallback, useRef, useState } from "react";

export interface AttachmentPreview {
    name: string;
    size: number;
    type: string;
    previewUrl?: string;
}

export interface AttachmentState {
    files: File[];
    previews: AttachmentPreview[];
}

/** Accept all file types up to 25 MB each. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Max 5 files — the head of the list wins, so an over-drop can't evict
 *  attachments the operator already picked. */
export const MAX_ATTACHMENTS = 5;

export type AttachmentAction =
    | { type: "add"; files: File[] }
    | { type: "remove"; index: number }
    | { type: "clear" };

export interface AttachmentTransition {
    state: AttachmentState;
    /** Object URLs the caller must revoke — previews that just left the list. */
    revoked: string[];
}

export const EMPTY_ATTACHMENTS: AttachmentState = { files: [], previews: [] };

/**
 * Pure list transition. `createPreviewUrl` is injected so the reducer stays
 * testable outside a browser; it defaults to URL.createObjectURL, and is only
 * called for image/* files (the only type that gets a thumbnail).
 */
export function attachmentsReducer(
    state: AttachmentState,
    action: AttachmentAction,
    createPreviewUrl: (file: File) => string = (file) => URL.createObjectURL(file),
): AttachmentTransition {
    switch (action.type) {
        case "add": {
            const validFiles = action.files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
            if (validFiles.length === 0) return { state, revoked: [] };
            const previews = validFiles.map((f) => {
                const preview: AttachmentPreview = { name: f.name, size: f.size, type: f.type };
                if (f.type.startsWith("image/")) preview.previewUrl = createPreviewUrl(f);
                return preview;
            });
            const nextFiles = [...state.files, ...validFiles].slice(0, MAX_ATTACHMENTS);
            const nextPreviews = [...state.previews, ...previews].slice(0, MAX_ATTACHMENTS);
            // Previews generated for files that overflowed the cap never reach
            // the DOM — revoke them rather than leak the object URL.
            const dropped = [...state.previews, ...previews]
                .slice(MAX_ATTACHMENTS)
                .map((p) => p.previewUrl)
                .filter((u): u is string => !!u);
            return { state: { files: nextFiles, previews: nextPreviews }, revoked: dropped };
        }
        case "remove": {
            const removed = state.previews[action.index];
            return {
                state: {
                    files: state.files.filter((_, i) => i !== action.index),
                    previews: state.previews.filter((_, i) => i !== action.index),
                },
                revoked: removed?.previewUrl ? [removed.previewUrl] : [],
            };
        }
        case "clear":
            return {
                state: EMPTY_ATTACHMENTS,
                revoked: state.previews.map((p) => p.previewUrl).filter((u): u is string => !!u),
            };
    }
}

export interface FileAttachmentsApi {
    attachedFiles: File[];
    attachedPreviews: AttachmentPreview[];
    isDragging: boolean;
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    mediaInputRef: React.RefObject<HTMLInputElement | null>;
    handleFileDrop: (files: FileList | File[]) => void;
    handleDragEnter: (e: React.DragEvent) => void;
    handleDragOver: (e: React.DragEvent) => void;
    handleDragLeave: (e: React.DragEvent) => void;
    handleDrop: (e: React.DragEvent) => void;
    removeFile: (index: number) => void;
    /** Detach everything and revoke previews — used after a send. */
    clearAttachments: () => void;
}

export function useFileAttachments(): FileAttachmentsApi {
    const [attachments, setAttachments] = useState<AttachmentState>(EMPTY_ATTACHMENTS);
    const [isDragging, setIsDragging] = useState(false); // Drag-and-drop state
    // Counter to properly track drag enter/leave across child elements
    const dragCounter = useRef(0);
    const fileInputRef = useRef<HTMLInputElement>(null); // Hidden file input (all types)
    const mediaInputRef = useRef<HTMLInputElement>(null); // Hidden media input (camera/gallery)

    const apply = useCallback((action: AttachmentAction) => {
        setAttachments((prev) => {
            const { state, revoked } = attachmentsReducer(prev, action);
            revoked.forEach((url) => URL.revokeObjectURL(url));
            return state;
        });
    }, []);

    const handleFileDrop = useCallback((files: FileList | File[]) => {
        const fileArray = Array.from(files);
        const validFiles = fileArray.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
        if (validFiles.length > 0) {
            apply({ type: "add", files: fileArray });
            console.log('[Praxis Terminal] Files attached:', validFiles.map(f => `${f.name} (${(f.size / 1024).toFixed(0)} KB)`));
        }
    }, [apply]);

    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current++;
        if (e.dataTransfer.types.includes('Files')) {
            setIsDragging(true);
        }
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current--;
        if (dragCounter.current === 0) {
            setIsDragging(false);
        }
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current = 0;
        setIsDragging(false);

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFileDrop(e.dataTransfer.files);
        }
    }, [handleFileDrop]);

    const removeFile = useCallback((index: number) => {
        apply({ type: "remove", index });
    }, [apply]);

    const clearAttachments = useCallback(() => {
        apply({ type: "clear" });
    }, [apply]);

    return {
        attachedFiles: attachments.files,
        attachedPreviews: attachments.previews,
        isDragging,
        fileInputRef,
        mediaInputRef,
        handleFileDrop,
        handleDragEnter,
        handleDragOver,
        handleDragLeave,
        handleDrop,
        removeFile,
        clearAttachments,
    };
}

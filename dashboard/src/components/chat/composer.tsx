"use client"

/**
 * The chat composer row: draft textarea + send button.
 *
 * Extracted verbatim from ai-terminal.tsx (P2-27, 2026-09-03). Its keystroke
 * state deliberately lives here, in a leaf beside the transcript, so typing
 * cannot re-render (and re-parse) the message list above it.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Loader2, Mic, Square, Paperclip, XCircle, Image } from "lucide-react";

import { AttachmentChips } from "@/components/chat/attachment-chips";
import type { AttachmentPreview } from "@/hooks/use-file-attachments";

export interface ChatComposerProps {
    isInline: boolean;
    isOpen: boolean;
    loading: boolean;
    isRecording: boolean;
    hasAudio: boolean;
    attachedCount: number;
    /** Synchronous dispatch decision: true = message accepted, clear the input. */
    onSend: (text: string) => boolean;
}

/** The composer's keystroke state lives HERE, in a leaf component beside the
 *  transcript — not in AITerminal above it. Typing therefore re-renders only
 *  this input row; the message list cannot even read the draft text. (It used
 *  to live in AITerminal, so every keystroke re-rendered and re-parsed every
 *  message on screen — seconds of lag once a conversation built up history.) */
/** Auto-grow cap, in px, before the textarea scrolls internally instead of
 *  growing further — matches the Claude-app composer behavior. */
const COMPOSER_MAX_HEIGHT = 200;

export function ChatComposer({ isInline, isOpen, loading, isRecording, hasAudio, attachedCount, onSend }: ChatComposerProps) {
    const [input, setInput] = useState("");
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const composerIcon = isInline ? 16 : 18;

    const resizeInput = useCallback(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    }, []);

    // Re-measure whenever the draft text changes (typing, seeding, or clearing after send).
    useEffect(() => {
        resizeInput();
    }, [input, resizeInput]);

    // Focus input when terminal opens (modal only — inline shouldn't steal focus on page load)
    useEffect(() => {
        if (isOpen && !isInline && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen, isInline]);

    // Any deck surface can drop text into the composer (e.g. the notes
    // console's "chat about it"): dispatch `nexus:chat-seed` with
    // { detail: { text } } — the composer fills the input and focuses so the
    // operator can edit before sending.
    useEffect(() => {
        const onSeed = (e: Event) => {
            const text = (e as CustomEvent<{ text?: string }>).detail?.text;
            if (!text) return;
            setInput(text);
            inputRef.current?.focus();
        };
        window.addEventListener("nexus:chat-seed", onSeed);
        return () => window.removeEventListener("nexus:chat-seed", onSeed);
    }, []);

    const submit = () => {
        // Clicking the Send button moves focus to the button; restore it to
        // the composer so typing can continue without a manual re-click,
        // matching the old <input>'s Enter-to-send flow.
        if (onSend(input)) {
            setInput("");
            inputRef.current?.focus();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // isComposing is true while an IME (Japanese, Chinese, etc.) is
        // resolving candidates — that Enter confirms the composition, it
        // doesn't mean "send".
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
        }
        // Shift+Enter falls through to the textarea's default behavior (newline).
    };

    return (<>
        {!isRecording && (
            <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={hasAudio ? "Add a message (optional)..." : (attachedCount > 0 ? "Add a message (optional)..." : "Message Praxis...")}
                className={isInline
                    ? "flex-1 min-w-0 resize-none overflow-y-auto rounded-md bg-slate-900/60 border border-slate-800 px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:border-cyan-500/60 focus:outline-none transition-colors"
                    : "flex-1 resize-none overflow-y-auto rounded-lg bg-slate-800 border border-slate-600 px-4 py-2 text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"}
                style={{ maxHeight: COMPOSER_MAX_HEIGHT }}
                disabled={loading}
            />
        )}

        <button
            onClick={submit}
            aria-label="Send message"
            disabled={loading || (!input.trim() && attachedCount === 0 && !hasAudio) || isRecording}
            className={isInline
                ? "flex items-center justify-center px-3 rounded-md bg-gradient-to-r from-cyan-500 to-purple-500 text-white hover:from-cyan-600 hover:to-purple-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                : "px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-medium hover:from-cyan-600 hover:to-purple-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"}
        >
            {loading ? <Loader2 size={composerIcon} className="animate-spin" /> : <Send size={composerIcon} />}
        </button>
    </>);
}

/**
 * The full composer row: hidden file inputs, attachment chips, the recorded
 * audio preview chip, the voice/photo/file trigger buttons, and ChatComposer
 * itself. Extracted verbatim from ai-terminal.tsx (P2-27) — every title,
 * className and disabled rule is unchanged.
 */
export interface ComposerRowProps {
    isInline: boolean;
    isOpen: boolean;
    loading: boolean;
    isDragging: boolean;
    attachedFiles: File[];
    attachedPreviews: AttachmentPreview[];
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    mediaInputRef: React.RefObject<HTMLInputElement | null>;
    handleFileDrop: (files: FileList | File[]) => void;
    removeFile: (index: number) => void;
    isRecording: boolean;
    recordingTime: number;
    audioBlob: Blob | null;
    audioPreviewUrl: string | null;
    startRecording: () => void;
    stopRecording: () => void;
    clearAudio: () => void;
    onSend: (text: string) => boolean;
}

export function ComposerRow({
    isInline,
    isOpen,
    loading,
    isDragging,
    attachedFiles,
    attachedPreviews,
    fileInputRef,
    mediaInputRef,
    handleFileDrop,
    removeFile,
    isRecording,
    recordingTime,
    audioBlob,
    audioPreviewUrl,
    startRecording,
    stopRecording,
    clearAudio,
    onSend,
}: ComposerRowProps) {
    // Composer control sizing — compact & sleek to match the Bridge panel
    // when embedded inline; roomier in the floating/modal chat overlay.
    const composerIcon = isInline ? 16 : 18;
    const composerBtn = isInline
        ? "flex items-center justify-center p-1.5 rounded-md border border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        : "px-3 py-2 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
    return (
        <div className={isInline ? 'px-1 pt-3 pb-0.5 border-t border-slate-800/60' : 'p-4 border-t border-slate-700 bg-slate-800/50'}>
            {/* Hidden file input — any file type */}
            <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="*/*"
                className="hidden"
                onChange={(e) => {
                    if (e.target.files) handleFileDrop(e.target.files);
                    e.target.value = '';
                }}
            />
            {/* Hidden media input — camera/gallery (images + video) */}
            <input
                ref={mediaInputRef}
                type="file"
                multiple
                accept="image/*,video/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                    if (e.target.files) handleFileDrop(e.target.files);
                    e.target.value = '';
                }}
            />

            {/* Attachment preview chips */}
            <AttachmentChips previews={attachedPreviews} onRemove={removeFile} />

            {/* Audio Preview Chip */}
            {audioPreviewUrl && (
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 mb-3 w-fit text-sm">
                    <Mic size={14} className="text-red-400 font-bold" />
                    <span className="text-red-300 font-mono">{recordingTime}s</span>
                    <audio src={audioPreviewUrl} controls className="h-6 w-48 [&::-webkit-media-controls-enclosure]:bg-transparent [&::-webkit-media-controls-panel]:bg-transparent" />
                    <button onClick={clearAudio} className="text-slate-400 hover:text-red-400 transition-colors ml-2">
                        <XCircle size={16} />
                    </button>
                </div>
            )}

            <div className={isInline ? "flex items-stretch gap-1.5" : "flex gap-2"}>
                {/* Voice Record button */}
                {!isRecording && !audioBlob && (
                    <button
                        onClick={startRecording}
                        disabled={loading || isDragging}
                        className={`${composerBtn} ${isInline ? "hover:text-red-300" : "hover:text-red-400"}`}
                        title="Record voice memo"
                    >
                        <Mic size={composerIcon} />
                    </button>
                )}

                {isRecording && (
                    <div className={`flex items-center gap-3 rounded-md bg-red-500/10 border border-red-500/20 animate-pulse ${isInline ? "px-3 py-1.5" : "px-4 py-2 rounded-lg"}`}>
                        <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                        <span className="text-red-400 font-mono text-sm font-medium">
                            {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                        </span>
                        <button
                            onClick={stopRecording}
                            className="ml-2 text-slate-300 hover:text-red-400 transition-colors"
                            title="Stop recording"
                        >
                            <Square size={16} className="fill-current" />
                        </button>
                    </div>
                )}

                {/* Camera/Gallery picker — hide when recording */}
                {!isRecording && (
                    <button
                        onClick={() => mediaInputRef.current?.click()}
                        disabled={loading}
                        className={`${composerBtn} ${isInline ? "hover:text-violet-300" : "hover:text-violet-400"}`}
                        title="Photo / Gallery"
                    >
                        <Image size={composerIcon} />
                    </button>
                )}

                {/* General file picker — hide when recording */}
                {!isRecording && (
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={loading}
                        className={`${composerBtn} ${isInline ? "hover:text-cyan-300" : "hover:text-cyan-400"}`}
                        title="Attach file"
                    >
                        <Paperclip size={composerIcon} />
                    </button>
                )}

                {/* Text input + send button — a separate component so its
                    per-keystroke state can never re-render the transcript. */}
                <ChatComposer
                    isInline={isInline}
                    isOpen={isOpen}
                    loading={loading}
                    isRecording={isRecording}
                    hasAudio={!!audioBlob}
                    attachedCount={attachedFiles.length}
                    onSend={onSend}
                />
            </div>
        </div>
    );
}

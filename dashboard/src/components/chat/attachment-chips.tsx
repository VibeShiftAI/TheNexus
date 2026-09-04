"use client"

/**
 * Attachment preview chips shown above the composer.
 *
 * Extracted verbatim from ai-terminal.tsx (P2-27, 2026-09-03) — image
 * thumbnails, per-type tinting (image / video / audio / other), the humanised
 * size label, and the per-chip remove button, unchanged.
 */

import { FileText, XCircle, Film, Music, FileArchive } from "lucide-react";

import type { AttachmentPreview } from "@/hooks/use-file-attachments";

export interface AttachmentChipsProps {
    previews: AttachmentPreview[];
    onRemove: (index: number) => void;
}

export function AttachmentChips({ previews, onRemove }: AttachmentChipsProps) {
    if (previews.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-2 mb-3">
            {previews.map((file, idx) => {
                const isImage = file.type.startsWith('image/');
                const isVideo = file.type.startsWith('video/');
                const isAudio = file.type.startsWith('audio/');
                const sizeStr = file.size < 1024 ? `${file.size} B`
                    : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(0)} KB`
                    : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

                return (
                    <div
                        key={idx}
                        className={`group relative flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg border text-sm transition-all ${
                            isImage ? 'bg-violet-500/10 border-violet-500/30 text-violet-300'
                            : isVideo ? 'bg-pink-500/10 border-pink-500/30 text-pink-300'
                            : isAudio ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                            : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300'
                        }`}
                    >
                        {/* Image thumbnail */}
                        {isImage && file.previewUrl ? (
                            <img
                                src={file.previewUrl}
                                alt={file.name}
                                className="w-8 h-8 rounded object-cover border border-white/10"
                            />
                        ) : (
                            <div className="w-8 h-8 rounded bg-black/20 flex items-center justify-center">
                                {isVideo ? <Film size={14} />
                                : isAudio ? <Music size={14} />
                                : file.type.includes('zip') || file.type.includes('archive') ? <FileArchive size={14} />
                                : <FileText size={14} />}
                            </div>
                        )}
                        <div className="flex flex-col min-w-0">
                            <span className="max-w-[140px] truncate text-xs font-medium">{file.name}</span>
                            <span className="text-[10px] opacity-60">{sizeStr}</span>
                        </div>
                        <button
                            onClick={() => onRemove(idx)}
                            className="ml-1 opacity-50 hover:opacity-100 hover:text-red-400 transition-all"
                        >
                            <XCircle size={14} />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

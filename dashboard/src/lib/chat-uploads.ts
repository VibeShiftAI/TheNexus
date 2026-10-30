/**
 * What a chat send carries besides its text: attached files and a recorded
 * voice clip. Moved out of components/ai-terminal.tsx unchanged (2026-10-30,
 * its line-budget ratchet in components/__tests__/ai-terminal-shape.test.ts).
 */

export interface InlineChatFile { name: string; content: string; type: string }
export interface UploadedChatAttachment { fileId: string; url: string; mimeType: string; originalName: string; size: number }

const TEXT_FILE_NAME = /\.(txt|md|json|py|js|ts|tsx|jsx|yaml|yml|csv|xml|html|css|sql|sh|bat|log|cfg|ini|toml|env)$/i;
const INLINE_TEXT_LIMIT = 512 * 1024;

/**
 * Small text files are read inline for the model's context; every file is
 * uploaded to the Nexus file endpoint for persistence and serving. A failed
 * upload is logged and skipped, never fatal to the send.
 */
export async function prepareChatFiles(files: File[]): Promise<{ fileContents: InlineChatFile[]; uploadedAttachments: UploadedChatAttachment[] }> {
    const fileContents: InlineChatFile[] = [];
    const uploadedAttachments: UploadedChatAttachment[] = [];
    await Promise.all(files.map(async (file) => {
        const isTextFile = file.type.startsWith('text/') || TEXT_FILE_NAME.test(file.name);
        if (isTextFile && file.size < INLINE_TEXT_LIMIT) {
            fileContents.push({ name: file.name, content: await file.text(), type: file.type || 'text/plain' });
        }
        try {
            const formData = new FormData();
            formData.append('file', file);
            const uploadRes = await fetch('/api/chat/files/upload', { method: 'POST', credentials: 'include', body: formData });
            if (uploadRes.ok) {
                uploadedAttachments.push(await uploadRes.json());
            } else {
                console.error(`[Praxis Terminal] File upload failed for ${file.name}:`, await uploadRes.text());
            }
        } catch (err) {
            console.error(`[Praxis Terminal] File upload error for ${file.name}:`, err);
        }
    }));
    return { fileContents, uploadedAttachments };
}

/** Base64 of a recorded voice clip, encoded in chunks to stay under call-stack limits. */
export async function voiceClipBase64(blob: Blob | null): Promise<string | undefined> {
    if (!blob) return undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK_SIZE = 32768;
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK_SIZE)));
    }
    return btoa(binary);
}

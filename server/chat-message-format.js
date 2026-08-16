function normalizePraxisVoiceData(voiceData) {
    if (!voiceData) {
        return [];
    }

    if (typeof voiceData === 'string') {
        const trimmed = voiceData.trim();
        return trimmed ? [{ audio: trimmed, mimeType: 'audio/mpeg' }] : [];
    }

    if (!Array.isArray(voiceData)) {
        return [];
    }

    return voiceData
        .filter((item) => item && typeof item.audio === 'string' && item.audio.trim())
        .map((item) => ({
            audio: item.audio.trim(),
            mimeType: item.mimeType || 'audio/mpeg',
        }));
}

function parseMetadata(metadata) {
    if (!metadata) return {};
    if (typeof metadata !== 'string') return metadata;
    try {
        const parsed = JSON.parse(metadata);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function defaultVoiceFileName(mimeType) {
    if (mimeType === 'audio/ogg') return 'praxis-voice-reply.ogg';
    if (mimeType === 'audio/wav') return 'praxis-voice-reply.wav';
    if (mimeType === 'audio/mp4' || mimeType === 'audio/m4a') return 'praxis-voice-reply.m4a';
    return 'praxis-voice-reply.mp3';
}

function buildVoiceAttachments(voiceData) {
    return normalizePraxisVoiceData(voiceData).map((item) => ({
        type: 'audio',
        url: item.audio.startsWith('data:') ? item.audio : `data:${item.mimeType};base64,${item.audio}`,
        name: defaultVoiceFileName(item.mimeType),
        mimeType: item.mimeType,
    }));
}

// Persisted attachment descriptors (URL-backed, e.g. the full morning
// status-report MP3 relayed at /api/praxis/report/…). Only known keys
// survive, and an HTTP/relative URL is NEVER converted into base64 — the
// whole point of URL attachments is keeping audio bytes out of chat rows.
const PRAXIS_ATTACHMENT_KEYS = ['type', 'url', 'name', 'mimeType', 'kind', 'durationMs'];

function normalizePraxisAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];
    return attachments
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item)
            && typeof item.type === 'string' && item.type.trim()
            && typeof item.url === 'string' && item.url.trim())
        .map((item) => {
            const normalized = {};
            for (const key of PRAXIS_ATTACHMENT_KEYS) {
                if (item[key] !== undefined) normalized[key] = item[key];
            }
            return normalized;
        });
}

function buildPraxisAssistantMetadata(data = {}) {
    const normalizedVoiceData = normalizePraxisVoiceData(data.voiceData);
    const persistedAttachments = normalizePraxisAttachments(data.attachments);
    const legacyVoiceAttachments = buildVoiceAttachments(normalizedVoiceData);
    const attachments = persistedAttachments.length > 0 ? persistedAttachments : legacyVoiceAttachments;

    return {
        model: 'praxis-agent',
        provider: 'Praxis',
        hasVoice: normalizedVoiceData.length > 0,
        ...(normalizedVoiceData.length > 0 ? { voiceData: normalizedVoiceData } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
    };
}

function formatStoredChatMessage(message) {
    const metadata = parseMetadata(message?.metadata);
    const voiceData = normalizePraxisVoiceData(metadata.voiceData);
    const persistedAttachments = normalizePraxisAttachments(metadata.attachments);
    const attachments = persistedAttachments.length > 0
        ? persistedAttachments
        : buildVoiceAttachments(voiceData);

    return {
        ...message,
        metadata,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(voiceData.length > 0 ? { voiceData } : {}),
    };
}

function buildChatMessageEvent(message) {
    const formatted = formatStoredChatMessage(message);
    return {
        conversationId: formatted.conversation_id,
        mode: formatted.mode || 'praxis',
        message: formatted,
    };
}

module.exports = {
    buildChatMessageEvent,
    buildPraxisAssistantMetadata,
    buildVoiceAttachments,
    formatStoredChatMessage,
    normalizePraxisAttachments,
    normalizePraxisVoiceData,
};

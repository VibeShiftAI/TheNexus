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

function buildPraxisAssistantMetadata(data = {}) {
    const normalizedVoiceData = normalizePraxisVoiceData(data.voiceData);
    const voiceAttachments = buildVoiceAttachments(normalizedVoiceData);

    return {
        model: 'praxis-agent',
        provider: 'Praxis',
        hasVoice: normalizedVoiceData.length > 0,
        ...(normalizedVoiceData.length > 0 ? { voiceData: normalizedVoiceData } : {}),
        ...(voiceAttachments.length > 0 ? { attachments: voiceAttachments } : {}),
    };
}

function formatStoredChatMessage(message) {
    const metadata = message?.metadata || {};
    const voiceData = normalizePraxisVoiceData(metadata.voiceData);
    const attachments = Array.isArray(metadata.attachments) && metadata.attachments.length > 0
        ? metadata.attachments
        : buildVoiceAttachments(voiceData);

    return {
        ...message,
        metadata,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(voiceData.length > 0 ? { voiceData } : {}),
    };
}

module.exports = {
    buildPraxisAssistantMetadata,
    buildVoiceAttachments,
    formatStoredChatMessage,
    normalizePraxisVoiceData,
};

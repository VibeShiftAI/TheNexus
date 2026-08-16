const {
  buildPraxisAssistantMetadata,
  formatStoredChatMessage,
} = require('../chat-message-format');

describe('chat-message-format', () => {
  it('stores Praxis voice memos as both voiceData and audio attachments', () => {
    const metadata = buildPraxisAssistantMetadata({
      voiceData: [
        {
          audio: 'ZmFrZS1tcDM=',
          mimeType: 'audio/mpeg',
        },
        {
          audio: 'ZmFrZS1vZ2c=',
          mimeType: 'audio/ogg',
        },
      ],
    });

    expect(metadata.hasVoice).toBe(true);
    expect(metadata.voiceData).toEqual([
      {
        audio: 'ZmFrZS1tcDM=',
        mimeType: 'audio/mpeg',
      },
      {
        audio: 'ZmFrZS1vZ2c=',
        mimeType: 'audio/ogg',
      },
    ]);
    expect(metadata.attachments).toEqual([
      {
        type: 'audio',
        url: 'data:audio/mpeg;base64,ZmFrZS1tcDM=',
        name: 'praxis-voice-reply.mp3',
        mimeType: 'audio/mpeg',
      },
      {
        type: 'audio',
        url: 'data:audio/ogg;base64,ZmFrZS1vZ2c=',
        name: 'praxis-voice-reply.ogg',
        mimeType: 'audio/ogg',
      },
    ]);
  });

  it('exposes persisted attachments and voiceData at the top level for clients', () => {
    const formatted = formatStoredChatMessage({
      id: 'msg-1',
      role: 'assistant',
      content: 'Here is the voice note.',
      created_at: '2026-04-04T12:00:00.000Z',
      metadata: {
        attachments: [
          {
            type: 'audio',
            url: 'data:audio/mpeg;base64,ZmFrZQ==',
            name: 'praxis-voice-reply.mp3',
            mimeType: 'audio/mpeg',
          },
        ],
        voiceData: [
          {
            audio: 'ZmFrZQ==',
            mimeType: 'audio/mpeg',
          },
        ],
      },
    });

    expect(formatted.attachments).toEqual([
      {
        type: 'audio',
        url: 'data:audio/mpeg;base64,ZmFrZQ==',
        name: 'praxis-voice-reply.mp3',
        mimeType: 'audio/mpeg',
      },
    ]);
    expect(formatted.voiceData).toEqual([
      {
        audio: 'ZmFrZQ==',
        mimeType: 'audio/mpeg',
      },
    ]);
  });

  it('preserves URL-backed full-report attachments without base64 and bounded metadata', () => {
    const { buildChatMessageEvent, normalizePraxisAttachments } = require('../chat-message-format');
    const attachment = {
      type: 'audio',
      url: '/api/praxis/report/status-report-20260811-1203.mp3',
      name: 'Praxis Morning Status Report.mp3',
      mimeType: 'audio/mpeg',
      kind: 'full_status_report',
    };
    const storedMessage = {
      id: 'msg-report',
      conversation_id: 'conv-1',
      role: 'system',
      content: 'Status report ready',
      created_at: '2026-08-16T11:00:00.000Z',
      metadata: {
        platform: 'system',
        eventType: 'status_report_ready',
        reportFile: 'status-report-20260811-1203.html',
        condition: 'GREEN',
        attachments: [attachment],
      },
    };

    const formatted = formatStoredChatMessage(storedMessage);
    expect(formatted.attachments).toEqual([attachment]);
    expect(formatted.voiceData).toBeUndefined();

    const event = buildChatMessageEvent(storedMessage);
    expect(event.message.attachments[0]).toEqual(attachment);

    const metadataJson = JSON.stringify(formatted.metadata);
    expect(metadataJson.length).toBeLessThan(2048);
    expect(metadataJson).not.toContain('data:audio');
    expect(formatted.metadata.voiceData).toBeUndefined();

    // buildPraxisAssistantMetadata prefers persisted URL attachments over
    // legacy voice attachments and never re-encodes URLs as base64.
    const built = buildPraxisAssistantMetadata({
      attachments: [attachment],
      voiceData: [{ audio: 'ZmFrZQ==', mimeType: 'audio/mpeg' }],
    });
    expect(built.attachments).toEqual([attachment]);
    expect(JSON.stringify(built.attachments)).not.toContain('base64');

    // Normalization drops malformed entries and unknown keys.
    expect(normalizePraxisAttachments([
      null,
      'nope',
      { type: 'audio' },
      { url: '/x.mp3' },
      { ...attachment, evil: 'dropped' },
    ])).toEqual([attachment]);
  });
});

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
});

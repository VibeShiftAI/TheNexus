/** Decode the chat relay stream; partial text alone never confirms completion. */
export async function readPraxisEventStream(
    response: Response,
    onDelta: (delta: string) => void,
): Promise<any> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Streaming response did not include a readable body');

    const decoder = new TextDecoder();
    let buffer = '';
    let finalEvent: any = null;

    const handleFrame = (frame: string) => {
        const data = frame
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (!data || data === '[DONE]') return;

        const event = JSON.parse(data);
        if (event.type === 'error') throw new Error(event.error || 'Praxis response interrupted');
        if (event.type === 'delta' && typeof event.delta === 'string') {
            onDelta(event.delta);
        } else if (event.type === 'final') {
            finalEvent = event;
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        frames.forEach(handleFrame);
    }

    buffer += decoder.decode();
    if (buffer.trim()) handleFrame(buffer);
    if (!finalEvent) throw new Error('Praxis response ended before completion was confirmed');
    return finalEvent;
}

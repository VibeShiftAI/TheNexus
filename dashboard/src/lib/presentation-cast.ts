type CastContext = {
  start(options: Record<string, unknown>): void;
  stop(): void;
  getSenders(): unknown[];
  addEventListener(type: string, callback: () => void): void;
  removeEventListener(type: string, callback: () => void): void;
  getPlayerManager(): { setMessageInterceptor(type: string, callback: () => null): void };
};
export type CastFramework = {
  CastReceiverContext: { getInstance(): CastContext };
  system: { EventType: { SENDER_DISCONNECTED: string } };
  messages: { MessageType: { LOAD: string; QUEUE_LOAD: string } };
};

/** CAF manages the transport only. All content still requires selected-view code pairing. */
export function startCastReceiver(framework: CastFramework | undefined, ended: () => void): () => void {
  if (!framework) throw new Error('The Cast receiver SDK is unavailable. Stop casting and reopen the configured Nexus receiver.');
  const context = framework.CastReceiverContext.getInstance();
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; ended(); context.stop(); };
  const left = () => { if (context.getSenders().length === 0) stop(); };
  // The selected Nexus projection is the sole source of content. Cast media commands
  // must not inject arbitrary URLs, media or controls into this receiver.
  for (const command of [framework.messages.MessageType.LOAD, framework.messages.MessageType.QUEUE_LOAD]) {
    context.getPlayerManager().setMessageInterceptor(command, () => null);
  }
  context.addEventListener(framework.system.EventType.SENDER_DISCONNECTED, left);
  const timer = setTimeout(stop, 30 * 60_000);
  try {
    context.start({ disableIdleTimeout: true, skipPlayersLoad: true, maxInactivity: 15, statusText: 'Nexus read-only presentation' });
  } catch (error) {
    clearTimeout(timer); context.removeEventListener(framework.system.EventType.SENDER_DISCONNECTED, left); throw error;
  }
  return () => { clearTimeout(timer); context.removeEventListener(framework.system.EventType.SENDER_DISCONNECTED, left); if (!stopped) { stopped = true; context.stop(); } };
}

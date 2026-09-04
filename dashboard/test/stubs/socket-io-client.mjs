// Test stand-in for `socket.io-client`. `io()` never opens a network
// connection; it returns an inspectable fake and records every instance so a
// test can assert how many sockets were created, which handlers are attached,
// and whether/when `disconnect()` was called. Events can be injected with
// `socket.__emit(name, ...args)`.
export const __sockets = [];

export function __reset() {
    __sockets.length = 0;
}

export function io(url, opts) {
    const handlers = new Map();
    const socket = {
        url,
        opts,
        connected: false,
        disconnected: false,
        on(event, fn) {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event).add(fn);
            return socket;
        },
        off(event, fn) {
            handlers.get(event)?.delete(fn);
            return socket;
        },
        disconnect() {
            socket.disconnected = true;
            socket.connected = false;
            return socket;
        },
        __emit(event, ...args) {
            for (const fn of handlers.get(event) ?? []) fn(...args);
        },
        __listenerCount(event) {
            return handlers.get(event)?.size ?? 0;
        },
    };
    __sockets.push(socket);
    return socket;
}

export default { io };

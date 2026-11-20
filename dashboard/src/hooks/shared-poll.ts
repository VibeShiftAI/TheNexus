import { useCallback, useSyncExternalStore } from 'react';

// One timer and one outstanding read per resource in this page, even when
// consumers mount at different times. Stop when the last panel unmounts.
export function createSharedPoll<T>(load: () => Promise<T>) {
    const empty = { value: null as T | null, error: false };
    let snapshot = empty;
    const subscribers = new Map<() => void, number>();
    let timer: ReturnType<typeof setInterval> | undefined;
    let interval = 0;
    let pending: Promise<void> | undefined;

    function refresh() {
        if (!subscribers.size || document.hidden || pending) return;
        const request = Promise.resolve().then(load).then(
            value => { if (pending === request) snapshot = { value, error: false }; },
            () => { if (pending === request) snapshot = { ...snapshot, error: true }; },
        ).finally(() => {
            if (pending !== request) return;
            pending = undefined;
            subscribers.forEach((_, notify) => notify());
        });
        pending = request;
        return request;
    }

    function setCadence() {
        const next = subscribers.size ? Math.min(...subscribers.values()) : 0;
        if (next === interval) return;
        clearInterval(timer);
        interval = next;
        if (interval) timer = setInterval(refresh, interval);
    }

    function subscribe(notify: () => void, ms: number) {
        subscribers.set(notify, ms);
        setCadence();
        if (subscribers.size === 1) {
            document.addEventListener('visibilitychange', refresh);
            void refresh();
        }
        return () => {
            subscribers.delete(notify);
            setCadence();
            if (!subscribers.size) {
                document.removeEventListener('visibilitychange', refresh);
                pending = undefined;
                snapshot = empty;
            }
        };
    }
    return {
        refresh,
        useSnapshot(ms: number) {
            const listen = useCallback((notify: () => void) => subscribe(notify, ms), [ms]);
            return useSyncExternalStore(listen, () => snapshot, () => empty);
        },
    };
}

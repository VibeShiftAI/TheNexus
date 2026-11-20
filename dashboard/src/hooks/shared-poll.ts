import { useCallback, useSyncExternalStore } from 'react';

// One timer and one outstanding read per resource in this page, even when
// consumers mount at different times. Stop when the last panel unmounts.
export function createSharedPoll<T>(load: () => Promise<T>) {
    type Cadence = number | ((value: T | null) => number);
    const empty = { value: null as T | null, failures: 0 };
    let snapshot = empty;
    const subscribers = new Map<() => void, Cadence>();
    let timer: ReturnType<typeof setInterval> | undefined;
    let interval = 0;
    let pending: Promise<void> | undefined;

    function refresh() {
        if (!subscribers.size || document.hidden || pending) return;
        pending = Promise.resolve().then(async () => {
            if (!subscribers.size || document.hidden) return;
            try {
                const value = await load();
                if (subscribers.size) snapshot = { value, failures: 0 };
            } catch {
                if (subscribers.size) snapshot = { ...snapshot, failures: snapshot.failures + 1 };
            }
        }).finally(() => {
            pending = undefined;
            setCadence();
            subscribers.forEach((_, notify) => notify());
        });
        return pending;
    }

    function setCadence() {
        const intervals = Array.from(subscribers.values(), cadence =>
            typeof cadence === 'function' ? cadence(snapshot.value) : cadence);
        const next = intervals.length ? Math.min(...intervals) : 0;
        if (next === interval) return;
        clearInterval(timer);
        interval = next;
        if (interval) timer = setInterval(refresh, interval);
    }

    function subscribe(notify: () => void, cadence: Cadence) {
        subscribers.set(notify, cadence);
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
                snapshot = empty;
            }
        };
    }
    return {
        refresh,
        useSnapshot(cadence: Cadence) {
            const listen = useCallback((notify: () => void) => subscribe(notify, cadence), [cadence]);
            return useSyncExternalStore(listen, () => snapshot, () => empty);
        },
    };
}

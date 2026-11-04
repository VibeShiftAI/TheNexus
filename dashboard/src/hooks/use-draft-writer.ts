import { useCallback, useEffect, useRef } from "react";
/** Coalesce keystrokes, flushing the latest snapshot before navigation or page hiding. */
export function useDraftWriter<T>(
  key: string,
  write: (key: string, value: T) => void,
  delay = 150,
) {
  const pending = useRef<{ key: string; value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writer = useRef(write);
  writer.current = write;
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) writer.current(next.key, next.value);
  }, []);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hide);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [key, flush]);
  return useCallback(
    (value: T, immediate = false) => {
      pending.current = { key, value };
      if (immediate) {
        flush();
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [key, flush, delay],
  );
}

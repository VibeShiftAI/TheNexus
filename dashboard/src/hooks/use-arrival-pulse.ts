"use client";
import { useEffect, useRef, useState } from "react";

/** Highlight actual arrivals, never replay the existing history on first load. */
export function useArrivalPulse(ids: string[], ready = true) {
  const key = JSON.stringify(ids);
  const previous = useRef<Set<string> | null>(null);
  const [arrivals, setArrivals] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!ready) return;
    const current = new Set<string>(JSON.parse(key));
    const added = previous.current ? [...current].filter(id => !previous.current!.has(id)) : [];
    previous.current = current;
    if (added.length) setArrivals(new Set(added));
  }, [key, ready]);
  useEffect(() => {
    if (!arrivals.size) return;
    const timer = setTimeout(() => setArrivals(new Set()), 12000);
    return () => clearTimeout(timer);
  }, [arrivals]);
  return arrivals;
}

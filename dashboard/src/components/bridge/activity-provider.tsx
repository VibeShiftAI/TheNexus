"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLiveBoardState } from "@/components/live-board-state";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import {
  deriveBridgeActivity,
  type KnowledgeSnapshot,
} from "@/lib/bridge-activity";

const EMPTY = deriveBridgeActivity({
  now: 0,
  connected: false,
  events: [],
  runs: [],
  runsAvailable: false,
  knowledge: null,
});
const Context = createContext({ ...EMPTY, now: 0 });
export function BridgeActivityProvider({ children }: { children: ReactNode }) {
  const live = useLiveBoardState();
  const dispatch = useDispatchState();
  const [knowledge, setKnowledge] = useState<KnowledgeSnapshot | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let busy = false,
      disposed = false;
    const controller = new AbortController();
    async function refresh() {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const res = await fetch("/api/knowledge-activity", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("Knowledge telemetry unavailable");
        const data = await res.json();
        if (!disposed) setKnowledge(data);
      } catch {
        /* Keep last snapshot; its timestamp expires and marks sources unavailable. */
      } finally {
        busy = false;
      }
    }
    setNow(Date.now());
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    const poll = setInterval(refresh, 5000);
    const visible = () => {
      if (!document.hidden) {
        setNow(Date.now());
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const runsAvailable = Boolean(
    dispatch.updatedAt &&
      !dispatch.error &&
      now - Date.parse(dispatch.updatedAt) >= 0 &&
      now - Date.parse(dispatch.updatedAt) < 45000,
  );
  // A downstream socket can stay open when Praxis is down. Require a real
  // recent producer frame or a successful, fresh registry response.
  const producerLive =
    live.connected &&
    live.recentEvents.some(
      (e) =>
        e.type !== "stream.reset" &&
        now - Date.parse(e.at) >= 0 &&
        now - Date.parse(e.at) < 20000,
    );
  const value = useMemo(
    () => ({
      ...deriveBridgeActivity({
        now,
        connected: producerLive || runsAvailable,
        events: live.recentEvents,
        runs: dispatch.state?.executors?.runs ?? [],
        runsAvailable,
        knowledge,
      }),
      now,
    }),
    [
      now,
      live.connected,
      live.recentEvents,
      dispatch.state,
      dispatch.updatedAt,
      dispatch.error,
      knowledge,
      producerLive,
      runsAvailable,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useBridgeActivity() {
  return useContext(Context);
}

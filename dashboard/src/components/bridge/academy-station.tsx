/**
 * AcademyStation — the growing skillset: totals and category spread from the
 * shared-mind skill bank (Praxis /api/skills), newest acquisitions, and a
 * "skill acquired" flash when a new one lands while the deck is open.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { GraduationCap, ArrowUpRight, Sparkles } from "lucide-react";

export interface SkillSummary {
  id: string;
  name: string;
  category: string;
  summary: string;
  created: string;
  updated: string;
  recallCount: number;
  confidence: number;
  state: string;
  tags: string[];
}

interface SkillsResponse {
  total: number;
  byCategory: Record<string, number>;
  skills: SkillSummary[];
}

const CATEGORY_COLORS: Record<string, string> = {
  operations: "bg-cyan-500/70",
  development: "bg-violet-500/70",
  maintenance: "bg-amber-500/70",
  troubleshooting: "bg-rose-500/70",
};

export function AcademyStation() {
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [err, setErr] = useState(false);
  const [justAcquired, setJustAcquired] = useState<string | null>(null);
  const prevTotal = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/praxis/skills", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const next = (await res.json()) as SkillsResponse;
        if (!active) return;
        if (prevTotal.current != null && next.total > prevTotal.current) {
          const newest = [...next.skills].sort((a, b) => (b.created || "").localeCompare(a.created || ""))[0];
          setJustAcquired(newest?.name ?? "new skill");
          setTimeout(() => setJustAcquired(null), 12_000);
        }
        prevTotal.current = next.total;
        setData(next);
        setErr(false);
      } catch {
        if (active) setErr(true);
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  const newest = data ? [...data.skills].sort((a, b) => (b.created || "").localeCompare(a.created || "")).slice(0, 3) : [];
  const categories = Object.entries(data?.byCategory ?? {}).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(1, ...categories.map(([, n]) => n));

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GraduationCap size={16} className="text-pink-400" />
          <h3 className="text-sm font-bold tracking-tight text-white">ACADEMY — SKILLS</h3>
        </div>
        <Link href="/academy" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          skill tree <ArrowUpRight size={12} />
        </Link>
      </div>

      {justAcquired && (
        <div className="mb-2 flex items-center gap-2 rounded border border-pink-500/40 bg-pink-500/10 px-2 py-1.5 text-[11px] text-pink-200">
          <Sparkles size={12} /> skill acquired: {justAcquired}
        </div>
      )}

      {err && !data ? (
        <div className="py-4 text-center text-xs text-slate-500">Skill bank unavailable</div>
      ) : !data ? (
        <div className="py-4 text-center text-xs text-slate-600">Opening skill bank…</div>
      ) : (
        <div className="flex gap-4">
          <div className="shrink-0">
            <div className="text-3xl font-bold tabular-nums text-white">{data.total}</div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">skills banked</div>
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            {categories.map(([cat, n]) => (
              <div key={cat} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate text-[10px] text-slate-400">{cat}</span>
                <div className="h-2 flex-1 overflow-hidden rounded bg-slate-800/60">
                  <div
                    className={`h-full rounded ${CATEGORY_COLORS[cat] ?? "bg-slate-500/70"}`}
                    style={{ width: `${(n / catMax) * 100}%` }}
                  />
                </div>
                <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-slate-500">{n}</span>
              </div>
            ))}
            {newest.length > 0 && (
              <div className="pt-1 text-[10px] text-slate-600">
                newest: {newest.map((s) => s.name).join(" · ")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

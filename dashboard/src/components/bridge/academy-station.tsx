/**
 * AcademyStation — the growing skillset: totals and category spread from the
 * shared-mind skill bank (Praxis /api/skills), newest acquisitions, and a
 * "skill acquired" flash when a new one lands while the deck is open.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import { useLiveRefetch } from "@/components/live-board-state";
import Link from "next/link";
import { GraduationCap, ArrowUpRight, Sparkles } from "lucide-react";
import { HudPanel, HudModal } from "@/components/bridge/hud";

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
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const prevTotal = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/praxis/skills", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const next = (await res.json()) as SkillsResponse;
      if (prevTotal.current != null && next.total > prevTotal.current) {
        const newest = [...next.skills].sort((a, b) => (b.created || "").localeCompare(a.created || ""))[0];
        setJustAcquired(newest?.name ?? "new skill");
        setTimeout(() => setJustAcquired(null), 12_000);
      }
      prevTotal.current = next.total;
      setData(next);
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);

  // D-1: skill acquisition is a Praxis filesystem change with no stream frame
  // behind it — poll only, through the shared mechanism.
  useLiveRefetch([], () => void load(), { fallbackPollMs: 60_000 });

  const newest = data ? [...data.skills].sort((a, b) => (b.created || "").localeCompare(a.created || "")).slice(0, 3) : [];
  const categories = Object.entries(data?.byCategory ?? {}).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(1, ...categories.map(([, n]) => n));

  const categorySkills = openCategory
    ? (data?.skills ?? [])
        .filter((s) => s.category === openCategory)
        .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""))
    : [];

  return (
    <HudPanel
      icon={<GraduationCap size={16} />}
      title="ACADEMY — SKILLS"
      accent="pink"
      headerRight={
        <Link href="/academy" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          skill tree <ArrowUpRight size={12} />
        </Link>
      }
    >
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
              <button
                key={cat}
                onClick={() => setOpenCategory(cat)}
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-slate-800/50"
                title={`Browse ${cat} skills`}
              >
                <span className="w-24 shrink-0 truncate text-[10px] text-slate-400">{cat}</span>
                <div className="h-2 flex-1 overflow-hidden rounded bg-slate-800/60">
                  <div
                    className={`h-full rounded ${CATEGORY_COLORS[cat] ?? "bg-slate-500/70"}`}
                    style={{ width: `${(n / catMax) * 100}%` }}
                  />
                </div>
                <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-slate-500">{n}</span>
              </button>
            ))}
            {newest.length > 0 && (
              <div className="pt-1 text-[10px] text-slate-600">
                newest: {newest.map((s) => s.name).join(" · ")}
              </div>
            )}
          </div>
        </div>
      )}

      {openCategory && (
        <HudModal
          title={`${openCategory} skills`}
          subtitle={`${categorySkills.length} banked · shared-mind skill bank`}
          icon={<GraduationCap size={15} />}
          accent="pink"
          onClose={() => setOpenCategory(null)}
          wide
        >
          {categorySkills.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">No skills in this category.</p>
          ) : (
            <div className="space-y-2">
              {categorySkills.map((s) => (
                <div key={s.id} className="rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-semibold text-slate-100">{s.name}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                      recalled {s.recallCount}× · {Math.round(s.confidence * 100)}% conf
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">{s.summary}</p>
                  {s.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {s.tags.slice(0, 6).map((t) => (
                        <span
                          key={t}
                          className="rounded border border-pink-500/20 bg-pink-500/10 px-1.5 py-0.5 text-[9px] text-pink-200/80"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </HudModal>
      )}
    </HudPanel>
  );
}

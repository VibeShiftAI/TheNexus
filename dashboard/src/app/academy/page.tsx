/**
 * Academy console — the skill-wiki index for the shared-mind skill bank.
 * Grouped by category, searchable, sorted by recall count; each row expands
 * to the skill's summary, tags, provenance, and usage telemetry, and links
 * through to the skill's wiki page (/academy/skill/<name>) — manifest,
 * evidence, knowledge page, and backlink-graph neighbours.
 *
 * Backed by /api/skill-wiki (vault-direct, read-only) rather than the Praxis
 * proxy, so the library stays browsable even when Praxis is offline.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, BookOpen, GraduationCap, Search, ChevronDown, ChevronRight, Pin } from "lucide-react";
import { getSkillIndex, skillHref, type SkillIndexEntry, type SkillIndexResponse } from "@/lib/skill-wiki";

const CATEGORY_ACCENT: Record<string, string> = {
  operations: "text-cyan-400 border-cyan-500/30",
  development: "text-violet-400 border-violet-500/30",
  maintenance: "text-amber-400 border-amber-500/30",
  troubleshooting: "text-rose-400 border-rose-500/30",
};

function relTime(iso?: string | null) {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default function AcademyPage() {
  const router = useRouter();
  const [data, setData] = useState<SkillIndexResponse | null>(null);
  const [err, setErr] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getSkillIndex()
      .then((d) => active && setData(d))
      .catch(() => active && setErr(true));
    return () => {
      active = false;
    };
  }, []);

  const grouped = useMemo(() => {
    const q = query.toLowerCase().trim();
    const filtered = (data?.skills ?? []).filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.summary?.toLowerCase().includes(q) ||
        s.tags?.some((t) => t.toLowerCase().includes(q))
    );
    const byCat = new Map<string, SkillIndexEntry[]>();
    for (const s of filtered) {
      const cat = s.category || "uncategorized";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(s);
    }
    for (const list of byCat.values()) {
      list.sort((a, b) => (b.recallCount ?? 0) - (a.recallCount ?? 0));
    }
    return [...byCat.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [data, query]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30 pb-12">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
        <div className="container mx-auto flex h-16 items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push("/")}
              className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft size={18} />
              <span className="text-sm">Bridge</span>
            </button>
            <div className="h-6 w-px bg-slate-700" />
            <div className="flex items-center gap-2">
              <GraduationCap size={16} className="text-pink-400" />
              <h1 className="text-xl font-bold tracking-tight text-white">
                ACADEMY — SKILL WIKI
                {data && <span className="ml-2 text-sm font-normal text-slate-500">{data.total} skills</span>}
              </h1>
            </div>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills…"
              className="w-56 rounded-lg border border-slate-800 bg-slate-900/50 py-1.5 pl-8 pr-3 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500/50 focus:outline-none"
            />
          </div>
        </div>
      </header>

      <div className="container mx-auto space-y-6 p-6">
        {err ? (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-4 text-sm text-red-300">
            Skill wiki unavailable — is the vault mounted?
          </div>
        ) : !data ? (
          <div className="py-16 text-center text-sm text-slate-500">Opening skill wiki…</div>
        ) : (
          grouped.map(([category, skills]) => (
            <section key={category}>
              <h2
                className={`mb-2 flex items-center gap-2 border-b border-slate-800/80 pb-1.5 text-sm font-bold uppercase tracking-wider ${
                  CATEGORY_ACCENT[category]?.split(" ")[0] ?? "text-slate-400"
                }`}
              >
                {category}
                <span className="text-xs font-normal normal-case text-slate-600">{skills.length}</span>
              </h2>
              <div className="grid gap-2 md:grid-cols-2">
                {skills.map((s) => {
                  const isOpen = expanded === s.id;
                  return (
                    <div
                      key={s.id}
                      className={`rounded-lg border bg-slate-900/40 transition-colors ${
                        isOpen ? "border-slate-600" : "border-slate-800 hover:border-slate-700"
                      }`}
                    >
                      <div className="flex w-full items-center gap-2 px-3 py-2.5">
                        <button
                          onClick={() => setExpanded(isOpen ? null : s.id)}
                          className="shrink-0"
                          aria-label={isOpen ? `Collapse ${s.name}` : `Expand ${s.name}`}
                        >
                          {isOpen ? (
                            <ChevronDown size={13} className="text-slate-500" />
                          ) : (
                            <ChevronRight size={13} className="text-slate-600" />
                          )}
                        </button>
                        <Link
                          href={skillHref(s.name)}
                          className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200 hover:text-cyan-300"
                          title={`Open wiki page for ${s.name}`}
                        >
                          {s.name}
                        </Link>
                        {s.provenance && (
                          <span
                            className={`shrink-0 rounded border px-1 py-0.5 text-[9px] uppercase ${
                              s.provenance === "user-created"
                                ? "border-emerald-500/40 text-emerald-300"
                                : "border-slate-700 text-slate-500"
                            }`}
                            title={`provenance: ${s.provenance}`}
                          >
                            {s.provenance === "user-created" ? "operator" : s.provenance}
                          </span>
                        )}
                        {s.state && s.state !== "active" && (
                          <span className="shrink-0 rounded border border-slate-700 px-1 py-0.5 text-[9px] uppercase text-slate-500">
                            {s.state}
                          </span>
                        )}
                        {s.pinned && <Pin size={11} className="shrink-0 text-amber-400" />}
                        {s.hasKnowledge && (
                          <BookOpen size={11} className="shrink-0 text-violet-400" aria-label="has knowledge page" />
                        )}
                        {(s.successCount ?? 0) + (s.failureCount ?? 0) > 0 && (
                          <span className="shrink-0 text-[10px] tabular-nums" title="recorded outcomes">
                            <span className="text-emerald-300">{s.successCount}✓</span>
                            <span className="text-rose-300">{s.failureCount}✗</span>
                          </span>
                        )}
                        <span className="shrink-0 text-[10px] tabular-nums text-slate-500" title="recall count">
                          ↺ {s.hasTelemetry ? s.recallCount ?? 0 : "—"}
                        </span>
                      </div>
                      {isOpen && (
                        <div className="border-t border-slate-800/60 px-3 py-2.5">
                          <p className="text-xs leading-relaxed text-slate-400">
                            {s.summary || <span className="italic text-slate-600">No summary in the manifest.</span>}
                          </p>
                          {s.tags && s.tags.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {s.tags.map((t) => (
                                <span
                                  key={t}
                                  className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[10px] text-slate-400"
                                >
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-600">
                            <span>evidence {s.evidenceCount > 0 ? s.evidenceCount : "none"}</span>
                            <span>confidence {s.confidence != null ? s.confidence.toFixed(2) : "—"}</span>
                            <span>updated {relTime(s.updated)}</span>
                            <span>last used {relTime(s.lastUsedAt)}</span>
                            <Link href={skillHref(s.name)} className="text-cyan-400 hover:underline">
                              Open wiki page →
                            </Link>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </main>
  );
}

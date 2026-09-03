"use client";

/**
 * Skill wiki page — one page per shared-mind skill (pattern: SkillWiki,
 * arXiv 2606.16523). Renders the manifest with [[wiki-links]] as in-wiki
 * navigation, plus the skill's provenance (evidence links), accumulated
 * knowledge page, usage/outcome telemetry, and backlink-graph neighbours.
 *
 * Read-only viewport: everything here comes from the vault and the skill
 * index; nothing on this page can edit or execute a skill. Missing evidence,
 * knowledge, or telemetry shows as an explicit empty state.
 */

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  BookOpen,
  ExternalLink,
  FileQuestion,
  GraduationCap,
  Link2,
  Pin,
  ScrollText,
  Sparkles,
} from "lucide-react";
import {
  getSkillDetail,
  remarkWikiLinks,
  skillHref,
  type SkillDetail,
  type SkillEvidence,
} from "@/lib/skill-wiki";

const PROSE_CLASS = `prose prose-invert prose-sm max-w-none
  prose-p:text-slate-300 prose-p:leading-relaxed
  prose-strong:text-white prose-li:text-slate-300
  prose-a:text-cyan-300 prose-a:no-underline hover:prose-a:underline
  prose-code:text-cyan-300 prose-code:bg-slate-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
  prose-headings:text-slate-100 prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
  prose-pre:bg-slate-950 prose-pre:border prose-pre:border-slate-800
  prose-hr:border-slate-700`;

function WikiMarkdown({ content, knownSkills }: { content: string; knownSkills: string[] }) {
  return (
    <div className={PROSE_CLASS}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, () => remarkWikiLinks(knownSkills)]}
        components={{
          a: ({ href, title, children }) =>
            href?.startsWith("/academy/skill/") ? (
              <Link href={href} title={title ?? undefined}>{children}</Link>
            ) : (
              <a href={href} title={title ?? undefined} target="_blank" rel="noreferrer">{children}</a>
            ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function relTime(iso?: string | null) {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * One evidence entry. Vault wiki-links have no cockpit page yet, and Nexus
 * task refs are often short prefixes that /task/<id> cannot resolve — those
 * render as labelled references rather than dead links.
 */
function EvidenceRow({ evidence }: { evidence: SkillEvidence }) {
  const label = (
    <span className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-500">
      {evidence.kind === "nexus-task" ? "task" : evidence.kind}
    </span>
  );
  if (evidence.kind === "url") {
    return (
      <li className="flex items-center gap-2 text-xs">
        {label}
        <a
          href={evidence.target}
          target="_blank"
          rel="noreferrer"
          className="truncate text-cyan-300 hover:underline"
        >
          {evidence.target}
        </a>
        <ExternalLink size={11} className="shrink-0 text-slate-600" />
      </li>
    );
  }
  if (evidence.kind === "nexus-task" && UUID_RE.test(evidence.target)) {
    return (
      <li className="flex items-center gap-2 text-xs">
        {label}
        <Link href={`/task/${encodeURIComponent(evidence.target)}`} className="font-mono text-cyan-300 hover:underline">
          {evidence.target}
        </Link>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 text-xs text-slate-300">
      {label}
      <code className="truncate font-mono text-[11px] text-slate-300">{evidence.target}</code>
    </li>
  );
}

function SideCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="text-xs italic text-slate-600">{children}</p>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className="text-xs tabular-nums text-slate-200">{value}</span>
    </div>
  );
}

export default function SkillWikiPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const router = useRouter();
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSkill(null);
    setErr(null);
    getSkillDetail(name)
      .then((d) => active && setSkill(d))
      .catch((e: Error) => active && setErr(e.message));
    return () => {
      active = false;
    };
  }, [name]);

  const fm = skill?.frontmatter ?? {};
  const telemetry = skill?.telemetry ?? null;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30 pb-12">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
        <div className="container mx-auto flex h-16 items-center gap-4 px-6">
          <button
            onClick={() => router.push("/academy")}
            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
          >
            <ArrowLeft size={18} />
            <span className="text-sm">Academy</span>
          </button>
          <div className="h-6 w-px bg-slate-700" />
          <div className="flex min-w-0 items-center gap-2">
            <GraduationCap size={16} className="text-pink-400" />
            <h1 className="truncate font-mono text-lg font-bold tracking-tight text-white">{name}</h1>
            {skill && (
              <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                {skill.category}
              </span>
            )}
            {telemetry?.pinned && <Pin size={12} className="text-amber-400" />}
            {telemetry?.state && telemetry.state !== "active" && (
              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase text-amber-300">
                {telemetry.state}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="container mx-auto p-6">
        {err ? (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-4 text-sm text-red-300">
            Skill unavailable — {err}
          </div>
        ) : !skill ? (
          <div className="py-16 text-center text-sm text-slate-500">Opening skill page…</div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 space-y-6">
              <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
                <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                  <ScrollText size={13} />
                  Procedure — {skill.relPath}
                </h2>
                <WikiMarkdown content={skill.manifest} knownSkills={skill.knownSkills} />
              </section>

              <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
                <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                  <BookOpen size={13} />
                  Knowledge page
                </h2>
                {skill.knowledge ? (
                  <WikiMarkdown content={skill.knowledge} knownSkills={skill.knownSkills} />
                ) : (
                  <EmptyState>
                    No knowledge page yet — nothing has been written back to skills/_knowledge/{skill.name}.md.
                  </EmptyState>
                )}
              </section>
            </div>

            <div className="space-y-4">
              <SideCard title="Provenance" icon={<FileQuestion size={13} />}>
                <div className="space-y-1.5">
                  <Stat label="provenance" value={typeof fm.provenance === "string" ? fm.provenance : "not declared"} />
                  <Stat label="source" value={typeof fm.source === "string" ? fm.source : "—"} />
                  <Stat
                    label="confidence"
                    value={typeof fm.confidence === "string" ? Number(fm.confidence).toFixed(2) : "—"}
                  />
                  <Stat
                    label="evidence provenance"
                    value={typeof fm.evidence_provenance === "string" ? fm.evidence_provenance : "—"}
                  />
                  <Stat label="created" value={relTime(typeof fm.created === "string" ? fm.created : null)} />
                  <Stat label="updated" value={relTime(typeof fm.updated === "string" ? fm.updated : null)} />
                </div>
                {Array.isArray(fm.tags) && fm.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {fm.tags.map((t) => (
                      <span key={t} className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[10px] text-slate-400">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </SideCard>

              <SideCard title="Evidence" icon={<Link2 size={13} />}>
                {skill.evidence.length > 0 ? (
                  <ul className="space-y-1.5">
                    {skill.evidence.map((e) => (
                      <EvidenceRow key={e.raw} evidence={e} />
                    ))}
                  </ul>
                ) : (
                  <EmptyState>No evidence links — this skill&apos;s manifest cites nothing yet.</EmptyState>
                )}
              </SideCard>

              <SideCard title="Usage telemetry" icon={<Sparkles size={13} />}>
                {telemetry ? (
                  <div className="space-y-1.5">
                    <Stat label="recalls" value={telemetry.recallCount} />
                    <Stat label="prompt injections" value={telemetry.promptInjectionCount} />
                    <Stat
                      label="outcomes"
                      value={
                        telemetry.successCount + telemetry.failureCount > 0 ? (
                          <span>
                            <span className="text-emerald-300">{telemetry.successCount}✓</span>{" "}
                            <span className="text-rose-300">{telemetry.failureCount}✗</span>
                          </span>
                        ) : (
                          "none recorded"
                        )
                      }
                    />
                    <Stat label="last used" value={relTime(telemetry.lastUsedAt)} />
                    {telemetry.archivedReason && (
                      <p className="pt-1 text-[11px] text-amber-300/80">{telemetry.archivedReason}</p>
                    )}
                  </div>
                ) : (
                  <EmptyState>No telemetry recorded for this skill.</EmptyState>
                )}
              </SideCard>

              <SideCard title="Related skills" icon={<GraduationCap size={13} />}>
                {skill.related.inbound.length === 0 && skill.related.outbound.length === 0 ? (
                  <EmptyState>No links to or from other skills in the backlink graph.</EmptyState>
                ) : (
                  <div className="space-y-3">
                    {skill.related.outbound.length > 0 && (
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-600">References</div>
                        <div className="flex flex-wrap gap-1.5">
                          {skill.related.outbound.map((s) => (
                            <Link
                              key={s}
                              href={skillHref(s)}
                              className="rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 font-mono text-[11px] text-cyan-300 hover:border-cyan-500/50"
                            >
                              {s}
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}
                    {skill.related.inbound.length > 0 && (
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-600">Referenced by</div>
                        <div className="flex flex-wrap gap-1.5">
                          {skill.related.inbound.map((s) => (
                            <Link
                              key={s}
                              href={skillHref(s)}
                              className="rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 font-mono text-[11px] text-cyan-300 hover:border-cyan-500/50"
                            >
                              {s}
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </SideCard>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

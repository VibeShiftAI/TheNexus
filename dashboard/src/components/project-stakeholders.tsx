/**
 * ProjectStakeholders — the members attached to a project (client, testers,
 * domain experts), backed by the UNIFIED Members directory (2026-07-16):
 * one person can serve many projects with a different role on each, sit on
 * the Praxis council, and their whole profile — age, communication
 * preferences, expertise, Praxis's interaction notes — travels with them.
 * Praxis's feedback pipeline auto-registers submitters here (source
 * "feedback"), so this panel fills itself as family testers use the widget.
 *
 * Stakeholder governance (2026-08-22): a member flagged **Primary Decision
 * Maker** (crown toggle / editor checkbox → `decision_maker` on the project
 * link) is consulted on status, updates and decisions — their presence turns
 * on the request approval queue and the project's status reports.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Crown, Mail, Plus, Trash2, UserRound, Users, X } from "lucide-react";
import { memberAge } from "@praxis/contract";
import { HudPanel } from "@/components/bridge/hud";
import {
  createContact,
  getProjectContacts,
  linkContactToProject,
  listContacts,
  setProjectDecisionMaker,
  unlinkContactFromProject,
  updateContact,
  updateContactLink,
  type Contact,
  type ProjectContact,
} from "@/lib/nexus";

const ROLE_SUGGESTIONS = ["Client", "Tester", "Domain expert", "Collaborator"];

const PDM_TITLE =
  "Primary Decision Maker — consulted on status, updates and decisions; approves requests before work starts";

function Tags({ values, tone }: { values?: string[] | null; tone: string }) {
  if (!values || values.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((v) => (
        <span key={v} className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>
          {v}
        </span>
      ))}
    </span>
  );
}

/** Comma-separated editor for string-array fields (expertise, interests). */
function csv(values?: string[] | null): string {
  return (values ?? []).join(", ");
}
function parseCsv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function ProjectStakeholders({
  projectId,
  onChanged,
}: {
  projectId: string;
  /** Fires after any membership/PDM change (not on the initial load) so sibling panels can refresh. */
  onChanged?: () => void;
}) {
  const [contacts, setContacts] = useState<ProjectContact[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Latest-callback ref (written in an effect) so an inline onChanged from the
  // parent never re-triggers the load effect below.
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const reload = useCallback(async (notify = true) => {
    try {
      setContacts(await getProjectContacts(projectId));
      setError(null);
      if (notify) onChangedRef.current?.();
    } catch {
      setError("Contacts API unavailable — is the Nexus server up to date?");
    }
  }, [projectId]);

  useEffect(() => {
    void reload(false);
  }, [reload]);

  // Primary Decision Makers first; otherwise keep the server's order.
  const sorted = useMemo(
    () => [...contacts].sort((a, b) => Number(Boolean(b.decision_maker)) - Number(Boolean(a.decision_maker))),
    [contacts],
  );
  const pdmCount = sorted.filter((c) => c.decision_maker).length;

  return (
    <HudPanel
      icon={<Users size={16} />}
      title="Members"
      accent="cyan"
      headerRight={
        <>
          {pdmCount > 0 && (
            <span
              title={PDM_TITLE}
              className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300"
            >
              <Crown size={10} fill="currentColor" /> {pdmCount} PDM
            </span>
          )}
          <button
            onClick={() => setAdding((v) => !v)}
            className="flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-bold text-cyan-300 transition-colors hover:bg-cyan-500/20"
          >
            {adding ? <X size={12} /> : <Plus size={12} />}
            {adding ? "Close" : "Add"}
          </button>
        </>
      }
    >
      {error && <p className="mb-2 text-xs text-amber-400">{error}</p>}

      {adding && (
        <AddStakeholder
          projectId={projectId}
          linkedIds={contacts.map((c) => c.id)}
          onDone={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}

      {contacts.length === 0 && !adding ? (
        <p className="py-3 text-center text-sm text-slate-500">
          No members on this project yet. Add the humans it serves — they join the shared
          Members directory (stakeholders + council advisors), and feedback-widget
          submitters register themselves automatically. Flag one as{" "}
          <span className="text-amber-300">Primary Decision Maker</span> (crown) to turn on the
          request approval queue and status reports for this project.
        </p>
      ) : (
        <div className="space-y-2">
          {sorted.map((c) => (
            <StakeholderRow
              key={c.id}
              contact={c}
              projectId={projectId}
              expanded={expandedId === c.id}
              onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
              onChanged={reload}
            />
          ))}
        </div>
      )}
    </HudPanel>
  );
}

function StakeholderRow({
  contact,
  projectId,
  expanded,
  onToggle,
  onChanged,
}: {
  contact: ProjectContact;
  projectId: string;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(() => ({
    role: contact.role ?? "",
    relationship: contact.relationship ?? "",
    birthday: contact.birthday ?? "",
    notes: contact.notes ?? "",
    expertise: csv(contact.expertise),
    interests: csv(contact.interests),
    tone: contact.preferences?.tone ?? "",
    availability: contact.preferences?.availability ?? "",
    requireApproval: Boolean(contact.preferences?.requireApproval),
    decisionMaker: Boolean(contact.decision_maker),
  }));
  const [saving, setSaving] = useState(false);
  const [pdmBusy, setPdmBusy] = useState(false);
  const isPdm = Boolean(contact.decision_maker);

  // The header crown can flip the flag while the editor is closed — keep the
  // checkbox honest (state adjusted during render, keyed on the last seen flag).
  const [seenPdm, setSeenPdm] = useState(isPdm);
  if (seenPdm !== isPdm) {
    setSeenPdm(isPdm);
    setDraft((d) => ({ ...d, decisionMaker: isPdm }));
  }

  const togglePdm = async () => {
    setPdmBusy(true);
    try {
      await setProjectDecisionMaker(contact.id, projectId, !isPdm);
      onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update decision maker");
    } finally {
      setPdmBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await updateContact(contact.id, {
        relationship: draft.relationship || null,
        birthday: draft.birthday || null,
        notes: draft.notes || null,
        expertise: parseCsv(draft.expertise),
        interests: parseCsv(draft.interests),
        preferences: {
          ...(contact.preferences ?? {}),
          tone: draft.tone || undefined,
          availability: draft.availability || undefined,
          requireApproval: draft.requireApproval || undefined,
        },
      });
      const linkChanged =
        (contact.role ?? "") !== draft.role || Boolean(contact.decision_maker) !== draft.decisionMaker;
      if (linkChanged) {
        await updateContactLink(contact.id, projectId, draft.role || null, contact.link_notes ?? null, {
          decision_maker: draft.decisionMaker,
        });
      }
      onChanged();
      onToggle();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remove ${contact.name} from this project? (They stay in the shared directory.)`)) return;
    await unlinkContactFromProject(contact.id, projectId);
    onChanged();
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40">
      <div className="flex items-center">
      <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left">
        <UserRound size={15} className={`shrink-0 ${isPdm ? "text-amber-300" : "text-cyan-400"}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-bold text-slate-100">{contact.name}</span>
            {contact.role && (
              <span className="rounded bg-cyan-500/15 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-300">
                {contact.role}
              </span>
            )}
            {isPdm && (
              <span
                title={PDM_TITLE}
                className="rounded bg-amber-500/15 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300"
              >
                PDM
              </span>
            )}
            {contact.relationship && (
              <span className="text-[11px] text-slate-500">{contact.relationship}</span>
            )}
            {memberAge(contact.birthday) !== null && (
              <span className="text-[11px] text-slate-500">{memberAge(contact.birthday)}y</span>
            )}
            {contact.kind === "ai" && (
              <span className="rounded bg-violet-500/15 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-violet-300">
                AI seat
              </span>
            )}
          </span>
          {contact.email && (
            <span className="flex items-center gap-1 text-[11px] text-slate-500">
              <Mail size={10} /> {contact.email}
            </span>
          )}
        </span>
        {expanded ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
      </button>
      <button
        onClick={togglePdm}
        disabled={pdmBusy}
        aria-pressed={isPdm}
        title={PDM_TITLE}
        className={`mr-2 shrink-0 rounded border p-1 transition-colors disabled:opacity-50 ${
          isPdm
            ? "border-amber-400/60 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
            : "border-slate-800 text-slate-600 hover:border-amber-500/40 hover:text-amber-300"
        }`}
      >
        <Crown size={13} fill={isPdm ? "currentColor" : "none"} />
      </button>
      </div>

      {!expanded && (contact.expertise?.length || contact.interests?.length) ? (
        <div className="flex flex-wrap gap-1 px-3 pb-2 pl-10">
          <Tags values={contact.expertise} tone="bg-violet-500/15 text-violet-300" />
          <Tags values={contact.interests} tone="bg-emerald-500/15 text-emerald-300" />
        </div>
      ) : null}

      {expanded && (
        <div className="space-y-2 border-t border-slate-800 px-3 py-3">
          <Field label="Role on this project">
            <input
              list="pxfb-role-suggestions"
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value })}
              className="hud-input"
              placeholder="Client / Tester / Domain expert…"
            />
            <datalist id="pxfb-role-suggestions">
              {ROLE_SUGGESTIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Relationship">
              <input value={draft.relationship} onChange={(e) => setDraft({ ...draft, relationship: e.target.value })} className="hud-input" placeholder="nephew, sister, client…" />
            </Field>
            <Field label="Birthday (YYYY-MM-DD or YYYY — age derives)">
              <input value={draft.birthday} onChange={(e) => setDraft({ ...draft, birthday: e.target.value })} className="hud-input" placeholder="1985-06-12" />
            </Field>
          </div>
          <Field label="Expertise (comma-separated — what they know that Praxis can't google)">
            <input value={draft.expertise} onChange={(e) => setDraft({ ...draft, expertise: e.target.value })} className="hud-input" placeholder="board games, video production" />
          </Field>
          <Field label="Interests (comma-separated)">
            <input value={draft.interests} onChange={(e) => setDraft({ ...draft, interests: e.target.value })} className="hud-input" placeholder="dinosaurs, space" />
          </Field>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Comms tone preference">
              <input value={draft.tone} onChange={(e) => setDraft({ ...draft, tone: e.target.value })} className="hud-input" placeholder="kid-friendly / formal / brief" />
            </Field>
            <Field label="Availability">
              <input value={draft.availability} onChange={(e) => setDraft({ ...draft, availability: e.target.value })} className="hud-input" placeholder="weekends only" />
            </Field>
          </div>
          <label className="flex items-start gap-2 text-[11px] text-slate-400">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={draft.decisionMaker}
              onChange={(e) => setDraft({ ...draft, decisionMaker: e.target.checked })}
            />
            <span>
              <span className="font-semibold text-amber-300">Primary Decision Maker</span> — consulted on status,
              updates and decisions; approves requests before work starts; receives the project&apos;s status
              reports
            </span>
          </label>
          <label className="flex items-center gap-2 text-[11px] text-slate-400">
            <input
              type="checkbox"
              checked={draft.requireApproval}
              onChange={(e) => setDraft({ ...draft, requireApproval: e.target.checked })}
            />
            Require Robert&apos;s approval before Praxis contacts them
          </label>
          <Field label="Notes">
            <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className="hud-input min-h-[54px]" />
          </Field>
          {(contact.interaction_log?.length ?? 0) > 0 && (
            <div>
              <p className="mb-0.5 text-[10px] uppercase tracking-widest text-slate-500">Praxis interaction notes</p>
              <ul className="space-y-0.5">
                {(contact.interaction_log ?? []).slice(-4).reverse().map((entry, i) => (
                  <li key={i} className="text-[11px] text-slate-400">
                    <span className="text-slate-600">{entry.at.slice(0, 10)}</span> — {entry.note}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {contact.last_contact_at && (
            <p className="text-[10px] text-slate-600">Last contact: {new Date(contact.last_contact_at).toLocaleString()}</p>
          )}
          <div className="flex items-center justify-between pt-1">
            <button onClick={remove} className="flex items-center gap-1 text-[11px] text-red-400/80 hover:text-red-300">
              <Trash2 size={12} /> Remove from project
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded bg-cyan-500/20 border border-cyan-500/40 px-3 py-1 text-[12px] font-bold text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] uppercase tracking-widest text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function AddStakeholder({
  projectId,
  linkedIds,
  onDone,
}: {
  projectId: string;
  linkedIds: string[];
  onDone: () => void;
}) {
  const [search, setSearch] = useState("");
  const [directory, setDirectory] = useState<Contact[]>([]);
  const [role, setRole] = useState("Tester");
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(async () => {
      try {
        setDirectory(await listContacts(search || undefined));
      } catch {
        setDirectory([]);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const candidates = useMemo(
    () => directory.filter((c) => !linkedIds.includes(c.id)).slice(0, 6),
    [directory, linkedIds],
  );

  const link = async (contactId: string) => {
    setBusy(true);
    try {
      await linkContactToProject(contactId, projectId, role || undefined);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const createAndLink = async () => {
    if (!search.trim()) return;
    setBusy(true);
    try {
      const contact = await createContact({ name: search.trim(), email: newEmail.trim() || undefined });
      await linkContactToProject(contact.id, projectId, role || undefined);
      onDone();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to create contact");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-cyan-500/30 bg-slate-900/60 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Who? (searches the shared directory)">
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} className="hud-input" placeholder="Name…" />
        </Field>
        <Field label="Role on this project">
          <input list="pxfb-role-suggestions" value={role} onChange={(e) => setRole(e.target.value)} className="hud-input" />
        </Field>
      </div>

      {candidates.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-widest text-slate-500">In the directory</p>
          {candidates.map((c) => (
            <button
              key={c.id}
              disabled={busy}
              onClick={() => link(c.id)}
              className="flex w-full items-center justify-between rounded border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 text-left text-[12px] hover:border-cyan-500/40"
            >
              <span className="text-slate-200">
                {c.name}
                {c.email ? <span className="text-slate-500"> · {c.email}</span> : null}
              </span>
              <span className="text-cyan-400">link →</span>
            </button>
          ))}
        </div>
      )}

      {search.trim() && (
        <div className="flex items-end gap-2 border-t border-slate-800 pt-2">
          <div className="flex-1">
            <Field label={`Create "${search.trim()}" as a new contact — email (optional)`}>
              <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="hud-input" placeholder="them@example.com" />
            </Field>
          </div>
          <button
            onClick={createAndLink}
            disabled={busy}
            className="rounded bg-cyan-500/20 border border-cyan-500/40 px-3 py-1.5 text-[12px] font-bold text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-50"
          >
            Create + link
          </button>
        </div>
      )}
    </div>
  );
}

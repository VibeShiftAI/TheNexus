/**
 * ProjectStakeholders — the people attached to a project (client, testers,
 * domain experts), backed by the SHARED contacts directory: one person can
 * serve many projects with a different role on each, and their preferences /
 * expertise / interests travel with them. Praxis's feedback pipeline
 * auto-registers submitters here (source "feedback"), so this panel fills
 * itself as family testers use the widget.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Mail, Plus, Trash2, UserRound, Users, X } from "lucide-react";
import { HudPanel } from "@/components/bridge/hud";
import {
  createContact,
  getProjectContacts,
  linkContactToProject,
  listContacts,
  unlinkContactFromProject,
  updateContact,
  updateContactLink,
  type Contact,
  type ProjectContact,
} from "@/lib/nexus";

const ROLE_SUGGESTIONS = ["Client", "Tester", "Domain expert", "Collaborator"];

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

export function ProjectStakeholders({ projectId }: { projectId: string }) {
  const [contacts, setContacts] = useState<ProjectContact[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setContacts(await getProjectContacts(projectId));
      setError(null);
    } catch {
      setError("Contacts API unavailable — is the Nexus server up to date?");
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <HudPanel
      icon={<Users size={16} />}
      title="Stakeholders"
      accent="cyan"
      headerRight={
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-bold text-cyan-300 transition-colors hover:bg-cyan-500/20"
        >
          {adding ? <X size={12} /> : <Plus size={12} />}
          {adding ? "Close" : "Add"}
        </button>
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
          No stakeholders yet. Add the humans this project serves — feedback-widget
          submitters register themselves automatically.
        </p>
      ) : (
        <div className="space-y-2">
          {contacts.map((c) => (
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
    notes: contact.notes ?? "",
    expertise: csv(contact.expertise),
    interests: csv(contact.interests),
    tone: contact.preferences?.tone ?? "",
  }));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateContact(contact.id, {
        relationship: draft.relationship || null,
        notes: draft.notes || null,
        expertise: parseCsv(draft.expertise),
        interests: parseCsv(draft.interests),
        preferences: { ...(contact.preferences ?? {}), tone: draft.tone || undefined },
      });
      if ((contact.role ?? "") !== draft.role) {
        await updateContactLink(contact.id, projectId, draft.role || null, contact.link_notes ?? null);
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
      <button onClick={onToggle} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <UserRound size={15} className="shrink-0 text-cyan-400" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-bold text-slate-100">{contact.name}</span>
            {contact.role && (
              <span className="rounded bg-cyan-500/15 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-300">
                {contact.role}
              </span>
            )}
            {contact.relationship && (
              <span className="text-[11px] text-slate-500">{contact.relationship}</span>
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
          <Field label="Relationship">
            <input value={draft.relationship} onChange={(e) => setDraft({ ...draft, relationship: e.target.value })} className="hud-input" placeholder="nephew, sister, client…" />
          </Field>
          <Field label="Expertise (comma-separated — what they know that Praxis can't google)">
            <input value={draft.expertise} onChange={(e) => setDraft({ ...draft, expertise: e.target.value })} className="hud-input" placeholder="board games, video production" />
          </Field>
          <Field label="Interests (comma-separated)">
            <input value={draft.interests} onChange={(e) => setDraft({ ...draft, interests: e.target.value })} className="hud-input" placeholder="dinosaurs, space" />
          </Field>
          <Field label="Comms tone preference">
            <input value={draft.tone} onChange={(e) => setDraft({ ...draft, tone: e.target.value })} className="hud-input" placeholder="kid-friendly / formal / brief" />
          </Field>
          <Field label="Notes">
            <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className="hud-input min-h-[54px]" />
          </Field>
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

"use client";

import { useEffect, useMemo, useState } from "react";
import { Cpu, Loader2 } from "lucide-react";
import {
    getModelRoles,
    upsertModelRole,
    getModelControlState,
    type ModelControlRole,
    type ModelControlOptionsResponse,
} from "@/lib/model-control";

/**
 * Call-site role manager — the single place to see and control which model
 * each Praxis function (role) runs on. Local-first by default with a Gemini
 * allowlist; flip any role to a different alias/model from here.
 */
export function ModelRoleManager({ compact = false }: { compact?: boolean }) {
    const [roles, setRoles] = useState<ModelControlRole[]>([]);
    const [state, setState] = useState<ModelControlOptionsResponse>({});
    const [savingRole, setSavingRole] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = async () => {
        const [r, s] = await Promise.all([getModelRoles(), getModelControlState(null)]);
        setRoles(r);
        setState(s);
        setLoading(false);
    };

    useEffect(() => {
        load().catch(err => { setError(err.message); setLoading(false); });
    }, []);

    const assignmentOptions = useMemo(() => {
        const aliases = (state.aliases || []).map(a => ({ value: `alias:${a.alias}`, label: `alias:${a.alias}` }));
        const models = (state.models || []).map(m => ({ value: `model:${m.id}`, label: m.display_name || m.name || m.id }));
        return [...aliases, ...models];
    }, [state]);

    const changeAssignment = async (role: string, assignment: string) => {
        setSavingRole(role);
        setError(null);
        try {
            await upsertModelRole(role, { assignment, is_active: true });
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save role");
        } finally {
            setSavingRole(null);
        }
    };

    return (
        <div className={`rounded-lg border border-slate-800 bg-slate-950/40 ${compact ? "p-3" : "p-4"}`}>
            <div className="mb-3 flex items-center gap-2">
                <Cpu size={14} className="text-cyan-400" />
                <h3 className="text-sm font-semibold text-slate-200">Call-site Roles</h3>
                <span className="text-[11px] text-slate-500">— which model each Praxis function uses</span>
            </div>
            {loading ? (
                <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> Loading…</div>
            ) : (
                <div className="space-y-1">
                    {roles.map(r => (
                        <div key={r.role} className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5">
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-medium text-slate-200">{r.role}</div>
                                <div className="truncate text-[11px] text-slate-500">
                                    → {r.resolvedProvider ? `${r.resolvedProvider}/${r.resolvedModel}` : "(unresolved)"}
                                    {r.description ? ` · ${r.description}` : ""}
                                </div>
                            </div>
                            <div className="flex items-center gap-1">
                                {savingRole === r.role && <Loader2 size={11} className="animate-spin text-slate-500" />}
                                <select
                                    value={r.assignment}
                                    disabled={savingRole === r.role}
                                    onChange={e => changeAssignment(r.role, e.target.value)}
                                    className="max-w-[44%] rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-white outline-none focus:border-cyan-500 disabled:opacity-50"
                                >
                                    {!assignmentOptions.some(o => o.value === r.assignment) && (
                                        <option value={r.assignment}>{r.assignment}</option>
                                    )}
                                    {assignmentOptions.map(o => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {error && <div className="mt-2 text-[11px] text-red-400">{error}</div>}
        </div>
    );
}

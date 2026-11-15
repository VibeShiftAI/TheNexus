"use client";

import { useEffect, useState } from "react";

type Role = 'routine' | 'advanced' | 'apex';
type Settings = Record<Role, string>;
/** Per role: "auto" or the model on the other CLI the tier switches to. */
type Fallbacks = Record<Role, string>;
const roles = [ ['apex', 'Top tier · complexity 5'], ['advanced', 'Advanced work · complexity 4'], ['routine', 'Bulk of the work · complexity 1–3'] ] as const;
const endpoint = '/api/praxis/models/ladder-settings';

/** Models grouped by the CLI that runs them, in list order; one unnamed group when providers are unknown. */
function groupByProvider(models: string[], providers: Record<string, string>): Array<[string, string[]]> {
    const groups = new Map<string, string[]>();
    for (const model of models) {
        const provider = providers[model] || '';
        groups.set(provider, [...(groups.get(provider) || []), model]);
    }
    return [...groups.entries()];
}

function ModelOptions({ models, providers, labels }: { models: string[]; providers: Record<string, string>; labels: Record<string, string> }) {
    return <>{groupByProvider(models, providers).flatMap(([provider, group]) => {
        const options = group.map(model => <option key={model} value={model}>{labels[model] || model}</option>);
        return provider ? [<optgroup key={provider} label={provider}>{options}</optgroup>] : options;
    })}</>;
}

const selectClass = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-sm text-white";

export function ModelLadderSettings() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [models, setModels] = useState<string[]>([]);
    const [modelsByRole, setModelsByRole] = useState<Record<string, string[]>>({});
    // Display names from the model registry, served with the ladder; raw id when absent.
    const [labels, setLabels] = useState<Record<string, string>>({});
    // The CLI that runs each model ("Claude Code", "Codex"), for grouping the menus.
    const [providers, setProviders] = useState<Record<string, string>>({});
    // Null when Praxis predates per-tier fallbacks; the fallback menus stay hidden then.
    const [fallbacks, setFallbacks] = useState<Fallbacks | null>(null);
    // What "auto" resolves to per role, keyed by the CLI of the tier's first choice.
    const [automatic, setAutomatic] = useState<Record<string, Record<string, string>>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    function apply(body: { settings: Settings; models?: string[]; modelsByRole?: Record<string, string[]>; labels?: Record<string, string>; providers?: Record<string, string>; fallbacks?: Fallbacks; automaticFallbacks?: Record<string, Record<string, string>> }) {
        setSettings(body.settings);
        if (body.models) setModels(body.models);
        setModelsByRole(body.modelsByRole || {});
        setLabels(body.labels || {});
        setProviders(body.providers || {});
        setFallbacks(body.fallbacks || null);
        setAutomatic(body.automaticFallbacks || {});
    }
    useEffect(() => {
        let cancelled = false;
        fetch(endpoint).then(async response => {
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Unable to load model ladder');
            if (!cancelled) apply(body);
        }).catch(error => { if (!cancelled) setError(String(error.message || error)); });
        return () => { cancelled = true; };
    }, []);
    async function save() {
        setSaving(true); setError(''); setSaved(false);
        try {
            const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, ...(fallbacks ? { fallbacks } : {}) }) });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Unable to save model ladder');
            apply(body); setSaved(true);
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setSaving(false); }
    }
    function chooseFirst(role: Role, model: string) {
        if (!settings) return;
        // A fallback must run on the other CLI, so moving the first choice across CLIs resets it.
        if (fallbacks && providers[model] !== providers[settings[role]]) setFallbacks({ ...fallbacks, [role]: 'auto' });
        setSettings({ ...settings, [role]: model }); setSaved(false);
    }
    return <section aria-label="Model ladder settings" className="rounded-xl border border-slate-800 bg-slate-950/50 p-5 space-y-4">
        <div><h2 className="text-lg font-semibold text-white">Model ladder</h2>
            <p className="mt-1 text-sm text-slate-400">Choose who handles each level of work. Each tier runs its first choice; when that CLI is suspended, out of quota or cooling down, the tier switches to its fallback on the other CLI, and if both are limited the work waits for a reset.</p>
            <p className="mt-1 text-sm text-slate-400">The lists offer the newest version of every flagship Claude Code and Codex model (Opus, GPT Sol, GPT Astra and any new flagship line), refreshed every morning. Automatic follows the newest GPT Astra or Opus. Opus is the minimum. Fable is never on the ladder: it runs only when you pick it for a task. Changes apply to new routing decisions immediately.</p></div>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        {!settings && !error && <p className="text-sm text-slate-400">Loading ladder…</p>}
        {settings && <><div className="grid gap-4 md:grid-cols-3">{roles.map(([role, label]) => {
            const options = modelsByRole[role] || models;
            const firstCli = providers[settings[role]] || '';
            const auto = automatic[role]?.[firstCli];
            return <div key={role} role="group" aria-label={label} className="space-y-3 rounded-lg border border-slate-800 p-3">
                <div className="text-sm font-medium text-slate-200">{label}</div>
                <label className="block text-xs text-slate-400">First choice
                    <select aria-label={`${label}: first choice`} disabled={saving} className={selectClass} value={settings[role]} onChange={event => chooseFirst(role, event.target.value)}>
                        <ModelOptions models={options} providers={providers} labels={labels} />
                    </select></label>
                {fallbacks && <label className="block text-xs text-slate-400">If {firstCli || 'it'} can&apos;t take it
                    <select aria-label={`${label}: fallback`} disabled={saving} className={selectClass} value={fallbacks[role] || 'auto'} onChange={event => { setFallbacks({ ...fallbacks, [role]: event.target.value }); setSaved(false); }}>
                        <option value="auto">{auto ? `Automatic · ${labels[auto] || auto}` : 'Automatic'}</option>
                        <ModelOptions models={options.filter(model => providers[model] && providers[model] !== firstCli)} providers={providers} labels={labels} />
                    </select></label>}
            </div>;
        })}</div>
            <div className="flex items-center gap-3"><button disabled={saving} onClick={save} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save ladder'}</button>
                {saved && <span role="status" className="text-sm text-emerald-300">Ladder saved</span>}</div></>}
    </section>;
}

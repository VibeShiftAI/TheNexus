"use client";

import { useEffect, useState } from "react";

type Settings = { routine: string; advanced: string; apex: string };
const labels: Record<string, string> = { 'claude-opus-5': 'Opus 5', 'claude-fable-5-1': 'Fable 5.1', 'gpt-6-astra': 'GPT-6 Astra' };
const roles = [ ['apex', 'Top tier · complexity 5'], ['advanced', 'Advanced work · complexity 4'], ['routine', 'Bulk of the work · complexity 1–3'] ] as const;
const endpoint = '/api/praxis/models/ladder-settings';

export function ModelLadderSettings() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [models, setModels] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    useEffect(() => {
        let cancelled = false;
        fetch(endpoint).then(async response => {
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Unable to load model ladder');
            if (!cancelled) { setSettings(body.settings); setModels(body.models); }
        }).catch(error => { if (!cancelled) setError(String(error.message || error)); });
        return () => { cancelled = true; };
    }, []);
    async function save() {
        setSaving(true); setError(''); setSaved(false);
        try {
            const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Unable to save model ladder');
            setSettings(body.settings); setSaved(true);
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setSaving(false); }
    }
    return <section aria-label="Model ladder settings" className="rounded-xl border border-slate-800 bg-slate-950/50 p-5 space-y-4">
        <div><h2 className="text-lg font-semibold text-white">Model ladder</h2>
            <p className="mt-1 text-sm text-slate-400">Choose who handles each level of work. Opus 5 is the minimum; quota fallbacks stay within these three models. Changes apply to new routing decisions immediately.</p></div>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        {!settings && !error && <p className="text-sm text-slate-400">Loading ladder…</p>}
        {settings && <><div className="grid gap-4 md:grid-cols-3">{roles.map(([role, label]) => <label key={role} className="text-sm text-slate-300">{label}
            <select aria-label={label} disabled={saving} className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-white" value={settings[role]} onChange={event => { setSettings({ ...settings, [role]: event.target.value }); setSaved(false); }}>
                {models.map(model => <option key={model} value={model}>{labels[model] || model}</option>)}
            </select></label>)}</div>
            <div className="flex items-center gap-3"><button disabled={saving} onClick={save} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save ladder'}</button>
                {saved && <span role="status" className="text-sm text-emerald-300">Ladder saved</span>}</div></>}
    </section>;
}

"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Settings, X, Save, Loader2, Eye, EyeOff,
    FolderOpen, Key, CheckCircle2, AlertCircle
} from "lucide-react";
import { getEnvSettings, saveEnvSettings, EnvSettings } from "@/lib/nexus";

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const API_KEY_FIELDS: { key: keyof EnvSettings; label: string; provider: string; color: string }[] = [
    { key: "GOOGLE_API_KEY", label: "Google Gemini", provider: "Google", color: "text-blue-400" },
    { key: "ANTHROPIC_API_KEY", label: "Anthropic Claude", provider: "Anthropic", color: "text-orange-400" },
    { key: "OPENAI_API_KEY", label: "OpenAI", provider: "OpenAI", color: "text-emerald-400" },
    { key: "XAI_API_KEY", label: "xAI Grok", provider: "xAI", color: "text-purple-400" },
];

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const [settings, setSettings] = useState<EnvSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

    const loadSettings = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const data = await getEnvSettings();
            setSettings(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load settings");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isOpen) {
            loadSettings();
            setSaved(false);
        }
    }, [isOpen, loadSettings]);

    const handleSave = async () => {
        if (!settings) return;
        try {
            setSaving(true);
            setError(null);
            await saveEnvSettings(settings);
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save settings");
        } finally {
            setSaving(false);
        }
    };

    const updateField = (key: keyof EnvSettings, value: string) => {
        setSettings(prev => prev ? { ...prev, [key]: value } : prev);
        setSaved(false);
    };

    const toggleKeyVisibility = (key: string) => {
        setShowKeys(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const maskValue = (value: string) => {
        if (!value || value.length <= 8) return "••••••••••••";
        return value.substring(0, 4) + "•".repeat(Math.min(value.length - 8, 20)) + value.substring(value.length - 4);
    };

    const hasKey = (value: string) => {
        return value && value.length > 0 && !value.startsWith("your-") && !value.startsWith("your_");
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="relative w-full max-w-lg mx-4 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-gradient-to-r from-slate-900 to-slate-800">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-cyan-500/10">
                            <Settings size={20} className="text-cyan-400" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-white">Environment Settings</h2>
                            <p className="text-xs text-slate-400">API keys are synced to both .env files</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg hover:bg-slate-700 transition-colors text-slate-400 hover:text-white"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Body */}
                <div className="px-6 py-5 max-h-[70vh] overflow-y-auto space-y-5">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="animate-spin text-cyan-400" size={28} />
                        </div>
                    ) : error && !settings ? (
                        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                            <div className="flex items-center gap-2 font-semibold mb-1">
                                <AlertCircle size={16} />
                                Connection Error
                            </div>
                            {error}
                        </div>
                    ) : settings ? (
                        <>
                            {/* Project Root */}
                            <div>
                                <label className="flex items-center gap-2 text-sm font-medium text-slate-300 mb-2">
                                    <FolderOpen size={14} className="text-amber-400" />
                                    Project Root
                                </label>
                                <input
                                    type="text"
                                    value={settings.PROJECT_ROOT}
                                    onChange={(e) => updateField("PROJECT_ROOT", e.target.value)}
                                    placeholder="/path/to/your/projects"
                                    className="w-full px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 transition-all font-mono"
                                />
                                <p className="mt-1 text-xs text-slate-500">
                                    Folder containing your coding projects
                                </p>
                            </div>

                            {/* Divider */}
                            <div className="flex items-center gap-3">
                                <div className="h-px flex-1 bg-slate-800" />
                                <span className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                                    <Key size={12} />
                                    API Keys
                                </span>
                                <div className="h-px flex-1 bg-slate-800" />
                            </div>

                            {/* API Keys */}
                            {API_KEY_FIELDS.map(({ key, label, color }) => (
                                <div key={key}>
                                    <label className="flex items-center justify-between mb-2">
                                        <span className={`text-sm font-medium ${color}`}>
                                            {label}
                                        </span>
                                        {hasKey(settings[key]) && (
                                            <span className="flex items-center gap-1 text-xs text-emerald-400">
                                                <CheckCircle2 size={12} />
                                                Configured
                                            </span>
                                        )}
                                    </label>
                                    <div className="relative">
                                        <input
                                            type={showKeys[key] ? "text" : "password"}
                                            value={settings[key]}
                                            onChange={(e) => updateField(key, e.target.value)}
                                            placeholder={`Enter ${label} API key`}
                                            className="w-full px-3 py-2.5 pr-10 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 transition-all font-mono"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => toggleKeyVisibility(key)}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                                        >
                                            {showKeys[key] ? <EyeOff size={16} /> : <Eye size={16} />}
                                        </button>
                                    </div>
                                </div>
                            ))}

                            <p className="text-xs text-slate-500 mt-1">
                                At least one API key is required. Keys are saved to both <code className="px-1 py-0.5 rounded bg-slate-800 text-slate-400">.env</code> and <code className="px-1 py-0.5 rounded bg-slate-800 text-slate-400">nexus-builder/.env</code>
                            </p>

                            {/* Error */}
                            {error && (
                                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                                    {error}
                                </div>
                            )}
                        </>
                    ) : null}
                </div>

                {/* Footer */}
                {settings && (
                    <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 bg-slate-900/50">
                        <p className="text-xs text-slate-500">
                            Changes require a server restart to take effect
                        </p>
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                                saved
                                    ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-400"
                                    : "bg-gradient-to-r from-cyan-500 to-purple-500 text-white hover:from-cyan-600 hover:to-purple-600 shadow-lg shadow-cyan-500/20"
                            }`}
                        >
                            {saving ? (
                                <Loader2 size={16} className="animate-spin" />
                            ) : saved ? (
                                <CheckCircle2 size={16} />
                            ) : (
                                <Save size={16} />
                            )}
                            {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

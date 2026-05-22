"use client";

import { useEffect, useMemo, useState } from "react";
import { Cpu, Loader2 } from "lucide-react";
import {
    formatResolvedModel,
    getModelControlOptions,
    resolveModelAssignment,
    type ModelControlOption,
    type ResolvedModelControl,
} from "@/lib/model-control";

interface ModelAssignmentControlProps {
    value?: string | null;
    projectId?: string | null;
    role?: string;
    onChange: (value: string) => void;
    className?: string;
}

export function ModelAssignmentControl({ value, projectId, role = "chat", onChange, className = "" }: ModelAssignmentControlProps) {
    const [options, setOptions] = useState<ModelControlOption[]>([]);
    const [resolved, setResolved] = useState<ResolvedModelControl | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getModelControlOptions(projectId)
            .then(items => {
                if (cancelled) return;
                setOptions(items);
                if (!value && items[0]) onChange(items[0].value);
            })
            .catch(err => console.warn("[ModelAssignmentControl] options unavailable:", err.message));
        return () => { cancelled = true; };
    }, [projectId, value, onChange]);

    useEffect(() => {
        if (!value) {
            setResolved(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        resolveModelAssignment({ model_assignment: value, projectId, role })
            .then(result => { if (!cancelled) setResolved(result); })
            .catch(() => { if (!cancelled) setResolved(null); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [value, projectId, role]);

    const selectedDescription = useMemo(() => {
        const option = options.find(item => item.value === value);
        return formatResolvedModel(resolved) || option?.description || "";
    }, [options, resolved, value]);

    return (
        <div className={`space-y-1 ${className}`}>
            <div className="flex items-center gap-2">
                <Cpu size={14} className="text-cyan-400" />
                <select
                    value={value || ""}
                    onChange={(event) => onChange(event.target.value)}
                    className="min-w-0 flex-1 rounded bg-slate-800 border border-slate-600 px-2 py-1.5 text-sm text-white focus:border-cyan-500 focus:outline-none"
                    title="Model assignment"
                >
                    {options.map(option => (
                        <option key={option.value} value={option.value}>
                            {option.label}{option.source ? ` · ${option.source}` : ""}
                        </option>
                    ))}
                </select>
                {loading && <Loader2 size={14} className="animate-spin text-slate-400" />}
            </div>
            {selectedDescription && (
                <div className="truncate pl-6 text-[11px] text-slate-400" title={selectedDescription}>
                    {selectedDescription}
                </div>
            )}
        </div>
    );
}

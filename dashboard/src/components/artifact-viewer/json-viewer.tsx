"use client";

import { useState } from "react";
import { Copy, Check, ChevronRight, ChevronDown } from "lucide-react";

interface JsonViewerProps {
    data: any;
    initialExpanded?: boolean;
}

export function JsonViewer({ data, initialExpanded = true }: JsonViewerProps) {
    const [copied, setCopied] = useState(false);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set([""]));

    const handleCopy = () => {
        navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const togglePath = (path: string) => {
        setExpandedPaths(prev => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    };

    const renderValue = (value: any, path: string, depth: number) => {
        const indent = depth * 16;

        if (value === null) {
            return <span className="text-slate-500 italic">null</span>;
        }

        if (value === undefined) {
            return <span className="text-slate-500 italic">undefined</span>;
        }

        if (typeof value === "boolean") {
            return <span className="text-purple-400">{value ? "true" : "false"}</span>;
        }

        if (typeof value === "number") {
            return <span className="text-amber-400">{value}</span>;
        }

        if (typeof value === "string") {
            // Truncate long strings
            const display = value.length > 100 ? `${value.slice(0, 100)}...` : value;
            return <span className="text-emerald-400">"{display}"</span>;
        }

        if (Array.isArray(value)) {
            const isExpanded = expandedPaths.has(path);
            const isEmpty = value.length === 0;

            if (isEmpty) {
                return <span className="text-slate-500">[]</span>;
            }

            return (
                <div>
                    <button
                        onClick={() => togglePath(path)}
                        className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
                    >
                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        <span className="text-cyan-400">[</span>
                        {!isExpanded && (
                            <span className="text-slate-500 text-xs">{value.length} items</span>
                        )}
                    </button>
                    {isExpanded && (
                        <div style={{ marginLeft: indent }}>
                            {value.map((item, index) => (
                                <div key={index} className="flex items-start gap-2">
                                    <span className="text-slate-600 select-none w-6 text-right flex-shrink-0">{index}</span>
                                    <span className="text-slate-500">:</span>
                                    {renderValue(item, `${path}[${index}]`, depth + 1)}
                                </div>
                            ))}
                        </div>
                    )}
                    {isExpanded && <span className="text-cyan-400">]</span>}
                </div>
            );
        }

        if (typeof value === "object") {
            const isExpanded = expandedPaths.has(path);
            const keys = Object.keys(value);
            const isEmpty = keys.length === 0;

            if (isEmpty) {
                return <span className="text-slate-500">{"{}"}</span>;
            }

            return (
                <div>
                    <button
                        onClick={() => togglePath(path)}
                        className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
                    >
                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        <span className="text-cyan-400">{"{"}</span>
                        {!isExpanded && (
                            <span className="text-slate-500 text-xs">{keys.length} keys</span>
                        )}
                    </button>
                    {isExpanded && (
                        <div style={{ marginLeft: indent }}>
                            {keys.map((key) => (
                                <div key={key} className="flex items-start gap-2">
                                    <span className="text-blue-400 flex-shrink-0">"{key}"</span>
                                    <span className="text-slate-500">:</span>
                                    {renderValue(value[key], `${path}.${key}`, depth + 1)}
                                </div>
                            ))}
                        </div>
                    )}
                    {isExpanded && <span className="text-cyan-400">{"}"}</span>}
                </div>
            );
        }

        return <span className="text-slate-300">{String(value)}</span>;
    };

    return (
        <div className="relative bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/50">
                <span className="text-xs text-slate-500 font-medium">JSON</span>
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded transition-colors"
                >
                    {copied ? (
                        <>
                            <Check size={12} className="text-emerald-400" />
                            Copied!
                        </>
                    ) : (
                        <>
                            <Copy size={12} />
                            Copy
                        </>
                    )}
                </button>
            </div>

            {/* Content */}
            <div className="p-4 font-mono text-sm overflow-x-auto">
                {renderValue(data, "", 1)}
            </div>
        </div>
    );
}

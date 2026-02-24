"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

interface CodeViewerProps {
    content: string;
    language?: string;
    filename?: string;
    showLineNumbers?: boolean;
}

// Language display names
const LANGUAGE_NAMES: Record<string, string> = {
    python: "Python",
    javascript: "JavaScript",
    typescript: "TypeScript",
    tsx: "TypeScript React",
    jsx: "JavaScript React",
    json: "JSON",
    html: "HTML",
    css: "CSS",
    markdown: "Markdown",
    bash: "Bash",
    shell: "Shell",
    sql: "SQL",
    yaml: "YAML",
    text: "Plain Text",
};

export function CodeViewer({
    content,
    language = "text",
    filename,
    showLineNumbers = true
}: CodeViewerProps) {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const lineCount = content.split('\n').length;
    const languageDisplay = LANGUAGE_NAMES[language] || language.toUpperCase();

    return (
        <div className="relative bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/50">
                <div className="flex items-center gap-3">
                    {filename && (
                        <span className="text-sm text-slate-300 font-medium">{filename}</span>
                    )}
                    <span className="text-xs text-slate-500">
                        {languageDisplay} • {lineCount} line{lineCount !== 1 ? 's' : ''}
                    </span>
                </div>
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

            {/* Code content */}
            <div className="overflow-x-auto">
                <SyntaxHighlighter
                    language={language}
                    style={oneDark}
                    showLineNumbers={showLineNumbers}
                    wrapLines={true}
                    customStyle={{
                        margin: 0,
                        padding: '1rem',
                        background: 'transparent',
                        fontSize: '0.875rem',
                        lineHeight: '1.5',
                    }}
                    lineNumberStyle={{
                        color: '#475569',
                        paddingRight: '1rem',
                        minWidth: '2.5rem',
                        textAlign: 'right',
                    }}
                    codeTagProps={{
                        style: {
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        }
                    }}
                >
                    {content}
                </SyntaxHighlighter>
            </div>
        </div>
    );
}

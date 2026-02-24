"use client";

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, BookOpen, Calendar, Tag } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { getCodexDoc, CodexDoc } from '@/lib/codex';
import { VibecodingWorkflowDiagram } from '@/components/visualizations/vibecoding-workflow-diagram';

export default function CodexArticlePage() {
    const params = useParams();
    const slug = params?.slug as string;

    const [doc, setDoc] = useState<CodexDoc | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (slug) {
            getCodexDoc(slug)
                .then(data => {
                    setDoc(data);
                    setLoading(false);
                })
                .catch(err => {
                    console.error(err);
                    setError("Failed to load document");
                    setLoading(false);
                });
        }
    }, [slug]);

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500 animate-pulse">
                Loading Article...
            </div>
        );
    }

    if (error || !doc) {
        return (
            <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-400 gap-4">
                <p>Document not found.</p>
                <Link href="/codex" className="text-cyan-400 hover:underline">Return to Codex</Link>
            </div>
        );
    }

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
            {/* Header HUD */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link
                            href="/codex"
                            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
                        >
                            <ArrowLeft size={18} />
                            <span className="text-sm">Back to Codex</span>
                        </Link>
                    </div>
                    <div className="flex items-center gap-6 text-sm font-medium text-slate-400">
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-pink-500/20 border border-pink-500/30 text-pink-400">
                            <BookOpen size={16} />
                            <span>The Codex</span>
                        </div>
                    </div>
                </div>
            </header>

            {/* Content */}
            <article className="container mx-auto p-6 max-w-4xl space-y-8">
                {/* Article Header */}
                <div className="space-y-4 border-b border-slate-800 pb-6">
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                            {doc.category}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                            <Calendar size={12} />
                            {new Date(doc.updated_at).toLocaleDateString()}
                        </span>
                    </div>

                    <h1 className="text-4xl font-bold text-white tracking-tight">
                        {doc.title}
                    </h1>

                    <div className="flex flex-wrap gap-2">
                        {doc.tags.map(tag => (
                            <div key={tag} className="flex items-center gap-1 text-xs text-slate-500 bg-slate-900 px-2 py-1 rounded-md border border-slate-800">
                                <Tag size={10} />
                                {tag}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Article Content */}
                <div className="prose prose-invert prose-slate max-w-none">
                    {/* Special Handling for Diagram injection */}
                    {slug === 'primary-vibecoding-workflow' && (
                        <div className="my-8 not-prose">
                            <VibecodingWorkflowDiagram />
                        </div>
                    )}

                    <ReactMarkdown
                        components={{
                            // Custom renderer to strip out the <VibecodingWorkflowDiagram /> string if it exists in MD
                            p: ({ children }) => {
                                // Safe check for children content
                                const content = Array.isArray(children) ? children[0] : children;
                                if (typeof content === 'string' && content.includes('<VibecodingWorkflowDiagram />')) {
                                    return <></>;
                                }
                                return <p>{children}</p>;
                            }
                        }}
                    >
                        {doc.content}
                    </ReactMarkdown>
                </div>
            </article>
        </main>
    );
}

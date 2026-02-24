"use client";

import { useEffect, useRef, useState } from "react";

interface ActiveGraphProps {
    definition: string;
    activeNode?: string | null;
}

declare global {
    interface Window {
        mermaid: any;
    }
}

export function ActiveGraph({ definition, activeNode }: ActiveGraphProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [svg, setSvg] = useState<string>('');
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        if (!window.mermaid) {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js';
            script.onload = () => {
                window.mermaid.initialize({
                    startOnLoad: false,
                    theme: 'dark',
                    securityLevel: 'loose',
                    flowchart: { curve: 'basis' }
                });
                setIsLoaded(true);
            };
            document.body.appendChild(script);
        } else {
            setIsLoaded(true);
        }
    }, []);

    useEffect(() => {
        if (isLoaded && definition) {
            renderChart();
        }
    }, [isLoaded, definition, activeNode]);

    const renderChart = async () => {
        try {
            // Inject styling for active node
            let chart = definition;

            // Define the active class style (Amber/Orange glow)
            chart += `\nclassDef active fill:#f59e0b,stroke:#d97706,stroke-width:2px,color:#fff,stroke-dasharray: 5 5;`;
            chart += `\nclassDef default fill:#1e293b,stroke:#475569,stroke-width:1px,color:#94a3b8;`;

            // Apply class to active node if exists
            if (activeNode) {
                chart += `\nclass ${activeNode} active;`;
            }

            const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
            const { svg } = await window.mermaid.render(id, chart);
            setSvg(svg);
        } catch (err) {
            console.error('Mermaid render error:', err);
        }
    };

    return (
        <div className="w-full h-full overflow-hidden bg-slate-950/50 rounded-lg border border-slate-800 flex flex-col">
            <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
                <span className="text-xs font-medium text-slate-400">Workflow Topology</span>
                {activeNode && (
                    <span className="flex items-center gap-1.5 text-xs text-amber-400">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                        </span>
                        {activeNode}
                    </span>
                )}
            </div>
            <div className="flex-1 overflow-auto p-4 flex items-center justify-center">
                {!isLoaded && <div className="text-slate-600 text-xs animate-pulse">Initializing Diagram...</div>}
                {svg && (
                    <div
                        dangerouslySetInnerHTML={{ __html: svg }}
                        className="w-full h-full flex items-center justify-center [&_svg]:max-w-full [&_svg]:max-h-full"
                    />
                )}
            </div>
        </div>
    );
}

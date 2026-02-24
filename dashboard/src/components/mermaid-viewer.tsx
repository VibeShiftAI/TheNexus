"use client";

import { useEffect, useRef, useState } from "react";

interface MermaidViewerProps {
    chart: string;
}

declare global {
    interface Window {
        mermaid: any;
    }
}

export function MermaidViewer({ chart }: MermaidViewerProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [svg, setSvg] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        // Load mermaid from CDN if not present
        if (!window.mermaid) {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js';
            script.onload = () => {
                window.mermaid.initialize({
                    startOnLoad: false,
                    theme: 'dark',
                    securityLevel: 'loose',
                });
                setIsLoaded(true);
            };
            document.body.appendChild(script);
        } else {
            setIsLoaded(true);
        }
    }, []);

    useEffect(() => {
        if (isLoaded && chart && containerRef.current) {
            renderChart();
        }
    }, [isLoaded, chart]);

    const renderChart = async () => {
        try {
            setError(null);
            const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
            const { svg } = await window.mermaid.render(id, chart);
            setSvg(svg);
        } catch (err) {
            console.error('Mermaid render error:', err);
            setError('Failed to render diagram. Check syntax.');
        }
    };

    if (!chart) return null;

    return (
        <div className="w-full h-full overflow-auto bg-slate-900/50 p-4 rounded-lg">
            {!isLoaded && <div className="text-slate-500 text-xs">Loading renderer...</div>}
            {error && <div className="text-red-400 text-xs font-mono">{error}</div>}
            {svg && (
                <div
                    ref={containerRef}
                    dangerouslySetInnerHTML={{ __html: svg }}
                    className="flex justify-center"
                />
            )}
        </div>
    );
}

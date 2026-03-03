"use client";

import React from 'react';

export interface Annotation {
    id: string;
    x: number; // percentage 0-100
    y: number; // percentage 0-100
    title: string;
    description: string;
    align?: 'left' | 'right' | 'top' | 'bottom';
}

interface AnnotatedScreenshotProps {
    src: string;
    alt: string;
    annotations: Annotation[];
}

export function AnnotatedScreenshot({ src, alt, annotations }: AnnotatedScreenshotProps) {
    return (
        <div className="relative w-full rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden shadow-2xl">
            <img src={src} alt={alt} className="w-full h-auto object-cover opacity-90" />

            {annotations.map((ann) => (
                <div
                    key={ann.id}
                    className="absolute z-10 group"
                    style={{
                        left: `${ann.x}%`,
                        top: `${ann.y}%`,
                    }}
                >
                    {/* The Dot */}
                    <div className="absolute -translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-cyan-500 rounded-full shadow-[0_0_15px_rgba(34,211,238,0.8)] border-[3px] border-slate-900 cursor-pointer hover:scale-125 transition-transform duration-200">
                        <div className="absolute inset-0 rounded-full bg-white opacity-30 animate-ping" />
                    </div>

                    {/* The Hover Card */}
                    <div className={`absolute w-64 bg-slate-900/95 backdrop-blur-md border border-cyan-500/50 rounded-lg p-4 shadow-2xl opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100 transition-all duration-200 pointer-events-none z-20 ${ann.align === 'left' ? 'right-5 top-0 -translate-y-1/2' :
                            ann.align === 'top' ? 'bottom-5 left-1/2 -translate-x-1/2' :
                                ann.align === 'bottom' ? 'top-5 left-1/2 -translate-x-1/2' :
                                    'left-5 top-0 -translate-y-1/2' // right default
                        }`}>
                        <h4 className="text-cyan-400 font-bold text-sm mb-1 uppercase tracking-wider">{ann.title}</h4>
                        <p className="text-slate-300 text-xs leading-relaxed">{ann.description}</p>
                    </div>
                </div>
            ))}
        </div>
    );
}

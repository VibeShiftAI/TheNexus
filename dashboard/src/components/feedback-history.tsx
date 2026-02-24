"use client";

import { Feedback } from "@/lib/nexus";
import { MessageSquare, Clock } from "lucide-react";

interface FeedbackHistoryProps {
    feedback: Feedback[];
}

export function FeedbackHistory({ feedback }: FeedbackHistoryProps) {
    if (!feedback || feedback.length === 0) return null;

    return (
        <div className="mt-8 pt-6 border-t border-slate-800">
            <div className="flex items-center gap-2 mb-4">
                <MessageSquare size={14} className="text-slate-500" />
                <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Feedback History
                </span>
            </div>

            <div className="space-y-4">
                {feedback.map((item, idx) => (
                    <div key={idx} className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
                        <div className="flex items-center gap-2 mb-2 text-xs text-slate-500">
                            <Clock size={12} />
                            <span>{new Date(item.createdAt).toLocaleString()}</span>
                            <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
                                {item.action || 'User'}
                            </span>
                        </div>
                        <p className="text-sm text-slate-300 leading-relaxed">
                            {item.content}
                        </p>
                    </div>
                ))}
            </div>
        </div>
    );
}

"use client";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { TopicMapData, TopicMapNode } from "@/lib/ingestion-control";
import { topicLabel } from "./topic-constellation";

export function KnowledgeCommunity({ topic, data, onSelect }: { topic: TopicMapNode; data: TopicMapData; onSelect: (topic: TopicMapNode) => void }) {
  const bridges = data.links.filter(l => l.source === topic.id || l.target === topic.id).sort((a, b) => b.weight - a.weight);
  return <div className="space-y-5">
    <p className="text-sm text-slate-400">{topic.size.toLocaleString()} entities · {bridges.length} connections to other communities</p>
    <div><h4 className="mb-2 text-xs uppercase tracking-wider text-teal-300">Entities in this community</h4>
      <div className="flex flex-wrap gap-2">{topic.top_entities.map(entity => <Link key={entity} href={`/knowledge-ingestion?term=${encodeURIComponent(entity)}#knowledge-explorer`} className="inline-flex items-center gap-1 rounded-md border border-teal-500/20 bg-teal-500/5 px-2.5 py-2 text-xs text-slate-200 hover:border-teal-300/60">{entity}<ArrowUpRight size={11}/></Link>)}</div>
    </div>
    {bridges.length > 0 && <div><h4 className="mb-2 text-xs uppercase tracking-wider text-slate-400">Connected communities</h4>
      <div className="grid gap-2 sm:grid-cols-2">{bridges.slice(0, 12).map(l => {
        const other = data.nodes.find(n => n.id === (l.source === topic.id ? l.target : l.source));
        return other && <button type="button" key={other.id} onClick={() => onSelect(other)} className="flex items-center justify-between gap-3 rounded-md border border-slate-800 p-2 text-left text-xs text-slate-300 hover:bg-slate-800"><span>{topicLabel(other.title, other.top_entities, other.id)}</span><span className="shrink-0 text-teal-400">{l.weight} links →</span></button>;
      })}</div>
    </div>}
    <Link href={`/knowledge-ingestion?term=${encodeURIComponent(topic.top_entities[0] ?? topic.title ?? String(topic.id))}#knowledge-explorer`} className="inline-flex items-center gap-1 text-sm text-cyan-300 hover:text-white">Open full knowledge report <ArrowUpRight size={14}/></Link>
  </div>;
}

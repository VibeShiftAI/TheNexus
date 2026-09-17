"use client";
import {useState} from 'react';
import Link from 'next/link';
import {ArrowUpRight,Check,MessageCircle,Radio} from 'lucide-react';
import {HudModal} from './hud';
import type {ChatActivityView} from '@/lib/chat-activity';

export function ChatSessionCore({chat}:{chat:ChatActivityView}) {
  const [open,setOpen]=useState(false);
  const color=chat.phase==='failed'?'#fb7185':chat.phase==='completed'?'#6ee7b7':chat.phase==='received'?'#c4b5fd':chat.active?'#67e8f9':'#94a3b8';
  return <>
    <button type="button" className="dispatch-chat-core" data-phase={chat.phase} data-active={chat.active} style={{color}} aria-label={`Inspect Praxis chat: ${chat.label}`} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(true)}>
      <span className="dispatch-chat-name">PRAXIS CHAT</span>
      <span className="dispatch-chat-signal" aria-hidden="true">
        <svg viewBox="0 0 64 30"><path d="M2 15 H15 L20 7 L25 23 L30 10 L35 20 L40 7 L45 15 H62" fill="none" stroke="currentColor" strokeWidth="1.5" opacity={chat.active?'.3':'.12'}/>{chat.active && <path d="M2 15 H15 L20 7 L25 23 L30 10 L35 20 L40 7 L45 15 H62" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="12 66" className="module-flow"/>}</svg>
        {!chat.active && <span>{chat.phase==='completed'?<Check size={16}/>:<MessageCircle size={16}/>}</span>}
      </span>
      <span className="dispatch-chat-label">{chat.label}</span>
    </button>
    {open && <HudModal title="Praxis chat session" icon={<Radio size={15}/>} accent="cyan" onClose={()=>setOpen(false)}>
      <div className="space-y-4">
        <div><p className="text-lg font-semibold" style={{color}}>{chat.label}</p><p className="mt-1 text-sm text-slate-400">{chat.detail}</p></div>
        {chat.turn && <>
          {chat.turn.preview && <blockquote className="rounded border border-slate-700/60 bg-slate-950/50 p-3 text-sm text-slate-300">{chat.turn.preview}</blockquote>}
          <dl className="grid grid-cols-2 gap-3 text-xs"><div><dt className="text-slate-500">{chat.acceptedAt?'Message receipt':'Send started'}</dt><dd className="mt-1 text-slate-300">{new Date(chat.acceptedAt??chat.turn.receivedAt).toLocaleTimeString()}</dd></div><div><dt className="text-slate-500">Last response update</dt><dd className="mt-1 text-slate-300">{new Date(chat.turn.updatedAt).toLocaleTimeString()}</dd></div></dl>
        </>}
        <Link href="/#station-core" onClick={()=>setOpen(false)} className="inline-flex items-center gap-1 text-sm text-cyan-300">Open Praxis conversation <ArrowUpRight size={14}/></Link>
      </div>
    </HudModal>}
  </>;
}

"use client";
import {useEffect,useState,useSyncExternalStore} from 'react';
import {acquireLiveSocket} from '@/lib/live-socket';
import {deriveChatActivity,type ChatActivitySnapshot,type ChatTurn,type ChatPhase} from '@/lib/chat-activity';

let local:ChatTurn|null=null;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
/** Immediate feedback from the actual send path, before a network round trip. */
export function noteChatSend(id:string,phase:ChatPhase,options:{conversationId?:string|null;preview?:string;detail?:string}={}) {
  const at=new Date().toISOString();
  if(phase==='sending') local={id,phase,conversationId:options.conversationId??null,preview:options.preview,receivedAt:at,updatedAt:at};
  else if(local?.id===id) {
    if(local.phase===phase && local.detail===options.detail) return;
    local={...local,phase,updatedAt:at,detail:options.detail,acceptedAt:local.acceptedAt??(phase!=='failed'?at:undefined)};
  }
  else return;
  listeners.forEach(fn=>fn());
}
export function useChatActivity(conversationId:string|null,now:number) {
  const hint=useSyncExternalStore(subscribe,()=>local,()=>null);
  const [snapshot,setSnapshot]=useState<ChatActivitySnapshot|null>(null);
  useEffect(()=>{
    let disposed=false,busy=false;const controller=new AbortController();
    const accept=(value:ChatActivitySnapshot)=>{
      if(!disposed && typeof value?.at==='string' && Array.isArray(value.turns)) setSnapshot(previous=>!previous || Date.parse(value.at)>=Date.parse(previous.at) ? value : previous);
    };
    const refresh=async()=>{
      if(document.hidden || busy) return;busy=true;
      try {const res=await fetch('/api/ai/chat/activity',{cache:'no-store',signal:controller.signal});if(res.ok)accept(await res.json());}
      catch {/* Prior snapshot expires; a missing connection must not look busy forever. */}
      finally {busy=false;}
    };
    const handle=acquireLiveSocket();
    handle?.socket.on('chat-activity',accept);handle?.socket.on('connect',refresh);
    void refresh();const timer=setInterval(refresh,5000);
    document.addEventListener('visibilitychange',refresh);
    return()=>{disposed=true;controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',refresh);handle?.socket.off('chat-activity',accept);handle?.socket.off('connect',refresh);handle?.release();};
  },[]);
  return deriveChatActivity({snapshot,local:hint,conversationId,now});
}

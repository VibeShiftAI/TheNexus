export type ChatPhase = 'sending' | 'received' | 'working' | 'replying' | 'completed' | 'failed';
export interface ChatTurn {
  id:string; conversationId:string|null; preview?:string; phase:ChatPhase;
  receivedAt:string; updatedAt:string; detail?:string; acceptedAt?:string;
}
export interface ChatActivitySnapshot {at:string;turns:ChatTurn[]}
export type ChatActivityView = ReturnType<typeof deriveChatActivity>;
const LABELS={sending:'Sending',received:'Received',working:'Working',replying:'Replying',completed:'Replied',failed:'Check chat',idle:'Ready',delayed:'Signal lost'};
const DETAILS={sending:'Sending your message to Nexus…',received:'Message received. Waiting for the Praxis response.',working:'Praxis opened the response stream and is processing your message.',replying:'Reply text is arriving from Praxis.',completed:'Praxis finished the reply.',failed:'The reply could not be confirmed. Open chat for details.',idle:'Ready for your next message.',delayed:'Chat status is delayed. The last receipt is shown below.'};

export function deriveChatActivity({snapshot,local,conversationId,now}:{snapshot:ChatActivitySnapshot|null;local:ChatTurn|null;conversationId:string|null;now:number}) {
  const candidates=(snapshot?.turns??[]).filter(t=>t.conversationId===conversationId);
  if(local && local.conversationId===conversationId) {
    const index=candidates.findIndex(t=>t.id===local.id);
    const remote=candidates[index];
    if(!remote) candidates.push(local);
    else if(local.phase!=='sending' && !['completed','failed'].includes(remote.phase) && Date.parse(local.updatedAt)>=Date.parse(remote.updatedAt)) candidates[index]=local;
  }
  const turn=candidates.sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt))[0]??null;
  const acceptedAt=snapshot?.turns.find(t=>t.id===turn?.id && t.conversationId===conversationId)?.receivedAt ?? turn?.acceptedAt;
  const serverAge=now-Date.parse(snapshot?.at??'');
  // The dashboard clock ticks once per second; a just-arrived receipt may
  // be newer than that tick. Also allow small browser/server clock skew.
  const available=serverAge>=-5000 && serverAge<20000;
  let phase:ChatPhase|'idle'|'delayed'=turn?.phase??'idle';
  if(turn && !['completed','failed'].includes(phase)) {
    const locallySending=turn===local && phase==='sending' && now-Date.parse(turn.updatedAt)<20000;
    if(!available && !locallySending) phase='delayed';
  }
  if(!turn && !available) phase='delayed';
  return {phase,label:LABELS[phase],detail:phase==='delayed'?DETAILS.delayed:turn?.detail??DETAILS[phase],turn,acceptedAt,available,active:['sending','received','working','replying'].includes(phase)};
}

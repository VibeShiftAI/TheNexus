/** Process-local receipt/response telemetry. Never executes or retries chat. */
function createChatActivity({io, now=Date.now}={}) {
  const turns=new Map();
  const rank={received:0,working:1,replying:2,completed:3,failed:3};
  const snapshot=()=>({at:new Date(now()).toISOString(),turns:[...turns.values()]});
  const emit=()=>{try {io?.emit('chat-activity',snapshot());} catch {/* Telemetry must not fail a chat turn. */}};
  return {
    snapshot,
    begin({id,conversationId,preview=''}) {
      const previous=turns.get(id);
      if(previous && previous.phase!=='failed') return previous.attempt;
      const at=new Date(now()).toISOString();
      const attempt=(previous?.attempt??0)+1;
      turns.set(id,{id,attempt,conversationId,preview:String(preview).slice(0,180),phase:'received',receivedAt:at,updatedAt:at});
      while(turns.size>32) {
        const oldest=[...turns.values()].find(t=>rank[t.phase]===3) ?? turns.values().next().value;
        turns.delete(oldest.id);
      }
      emit();
      return attempt;
    },
    update(id,phase,detail,attempt) {
      const previous=turns.get(id);
      if(attempt!==undefined && previous?.attempt!==attempt) return;
      if(!previous || rank[phase]==null || rank[previous.phase]===3 || rank[phase]<=rank[previous.phase]) return;
      turns.set(id,{...previous,phase,updatedAt:new Date(now()).toISOString(),...(detail?{detail:String(detail).slice(0,240)}:{})});
      emit();
    },
  };
}
module.exports={createChatActivity};

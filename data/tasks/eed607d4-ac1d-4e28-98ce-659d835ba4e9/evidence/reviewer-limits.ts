import { ChatTurnSteps, STEP_TEXT_MAX, REASONING_TEXT_MAX, MAX_STEPS_PER_TURN } from '../../../../../Praxis/src/chat-turn-steps.ts';
import { createTurnStepsStore, MAX_FOLDED_TURNS } from '../../../../dashboard/src/lib/chat-turn-steps.ts';
const recorder = new ChatTurnSteps(Date.now());
const label = 'Review the complete change '.repeat(20) + 'END_OF_LABEL';
const reasoning = 'Compare the evidence before deciding. '.repeat(100) + 'END_OF_REASONING';
recorder.record({type:'tool_start', id:'long-label', name:'Bash', input:{description:label}});
recorder.record({type:'tool_end', id:'long-label', failed:false});
recorder.record({type:'reasoning', id:'reasoning', text:reasoning});
console.log(JSON.stringify({STEP_TEXT_MAX, REASONING_TEXT_MAX, labelTailRetained:JSON.stringify(recorder.snapshot()).includes('END_OF_LABEL'), reasoningTailRetained:JSON.stringify(recorder.snapshot()).includes('END_OF_REASONING')}));
for(let i=0;i<MAX_STEPS_PER_TURN;i++) {
  recorder.record({type:'tool_start',id:`tool-${i}`,name:'Read',input:{file_path:`file-${i}`}});
  recorder.record({type:'tool_end',id:`tool-${i}`,failed:false});
}
const snapshot=recorder.snapshot();
console.log(JSON.stringify({MAX_STEPS_PER_TURN, stepCount:snapshot.step_count, replayableSteps:snapshot.steps.length, omitted:snapshot.omitted_steps, firstReplaySeq:snapshot.steps[0]?.seq}));
const store=createTurnStepsStore(()=>100);
for(let i=0;i<=MAX_FOLDED_TURNS;i++) {
  store.begin(`t${i}`,'conversation','Working');
  store.noteStep(`t${i}`,{id:'s1',seq:1,kind:'tool',text:'Read a file',status:'done'});
  store.fold(`t${i}`,`reply${i}`,{duration_ms:10});
}
console.log(JSON.stringify({MAX_FOLDED_TURNS, storedFoldedTurns:store.getFolded().size, firstReplyStillExpandable:store.getFolded().has('reply0')}));

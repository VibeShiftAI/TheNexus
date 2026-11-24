#!/bin/bash
# Task fa032fc0, criterion 9: who restarted TheCortex at 11:50 ET and who unloaded
# Gemma at 11:51:59 ET on 2026-11-24. Read-only: reads the live Praxis log, LM
# Studio's server log and the transcript of Robert's live Praxis chat session
# (bridge tokens redacted). Contacts no service.
PXLOG=/Volumes/Projects/Praxis/data/logs/praxis.log
LMLOG="$HOME/.lmstudio/server-logs/2026-11/2026-11-24.2.log"
CHAT="$HOME/.claude/projects/-Volumes-Projects/57a8c2d7-8e58-4e59-9b45-31960039090f.jsonl"
echo "# Criterion 9 attribution: the TheCortex restart (11:50 ET) and the Gemma unload (11:51:59 ET), 2026-11-24"
echo "# Made $(date '+%Y-%m-%d %H:%M:%S %Z') by a read-only script; no service contacted. Times: praxis.log and the chat transcript are UTC (Z), LM Studio's log is local (EST = UTC-5)."
echo
echo "## 1. Robert's live Praxis chat session (Claude CLI transcript $(basename "$CHAT"), cwd /Volumes/Projects)"
echo "Robert's two turns, the agent's kill and unload commands with their results, and its reply. Bridge tokens redacted."
echo
node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
const lo="2026-11-24T16:46:00",hi="2026-11-24T16:53:30";
const red=s=>s.replace(/X-Praxis-Bridge-Token: [^"\\ ]+/g,"X-Praxis-Bridge-Token: <redacted>").replace(/chat-turn:[0-9a-f]{16,}/g,"chat-turn:<redacted>");
const keep=s=>/mcp_macos_kill_process|lms (ps|unload)/.test(s);
let pending={};
for(const l of lines){let j;try{j=JSON.parse(l)}catch{continue}
  const t=j.timestamp||""; if(t<lo||t>hi)continue;
  const c=j.message&&j.message.content;
  if(typeof c==="string"){const m=c.match(/\]\s+([^\]]+)$/); if(m)console.log(`${t}  ROBERT: "${m[1].trim()}"`); continue;}
  if(!Array.isArray(c))continue;
  for(const b of c){
    if(b.type==="tool_use"&&b.name==="Bash"&&t>="2026-11-24T16:49:00"&&keep(b.input.command||"")){pending[b.id]=1;console.log(`${t}  AGENT RUNS (Bash): ${red(b.input.command).replace(/\n/g," ").slice(0,420)}${(b.input.command||"").length>420?" ...":""}`);}
    if(b.type==="tool_result"&&pending[b.tool_use_id]){const s=typeof b.content==="string"?b.content:(b.content||[]).map(x=>x.text||"").join(" ");console.log(`${t}  RESULT: ${red(s).replace(/\n/g," | ").slice(0,520)}`);}
    // The replies are quoted up to their first findings heading only: what follows is about the research job, not the restart or the unload.
    if(b.type==="text"&&j.message.role==="assistant"&&/^(Stopped|Yes on all three)/.test(b.text)){const cut=b.text.search(/\*\*What I (found|verified)\*\*/);console.log(`${t}  AGENT SAYS: ${b.text.slice(0,cut<0?b.text.length:cut).replace(/\n+/g," ").trim()} [rest of the reply left out]`);}
  }
}' "$CHAT"
echo
echo "## 2. The live Praxis log for the same minutes ($PXLOG, executor report echoes excluded)"
grep -aE "^\[2026-11-24T16:(4[6-9]|5[0-3])" "$PXLOG" | grep -av "Full body" \
  | grep -aE "Remote Chat Request|Operator turn: provenance|AgentBridge\] Tool mcp_macos_(list_processes|kill_process)|TheCortex\] INFO: +(Shutting down|Waiting for background)|TheCortex: DOWN|Level 2\] TheCortex|\[Supervisor\] TheCortex|TheCortex exited|TheCortex.*(respawn|spawned|Spawning)" | cut -c1-240
echo
echo "## 3. LM Studio's server log ($LMLOG): the lms-cli clients at 11:51:58-11:52:00 EST (16:51:58-16:52:00Z)"
grep -aE "^\[2026-11-24 11:5(1:5[89]|2:00)\]" "$LMLOG" | grep -aE "Client=lms-cli|cleaning up" | cut -c1-200
echo
echo "## Reading"
echo "- 16:46:29Z Robert asked whether TheCortex's daytime graph ingestion should be stopped; 16:48:27Z the agent asked for his go (stopping meant restarting TheCortex); 16:49:17Z Robert said \"stop it\"."
echo "- At 16:49:36Z the agent sent SIGTERM to TheCortex pid 68832 through the Praxis tool bridge (mcp_macos_kill_process). TheCortex began shutting down and stopped answering (heartbeat DOWN, failure #2, at 16:50:08Z), so the supervisor's Level 2 heartbeat restart asked for a restart at 16:50:18Z; TheCortex exited on SIGKILL at 16:50:22.269Z and was respawned as pid 8089 (listener on :8100, started 11:50:22 EST). The agent's own force kill was sent in the same second (16:50:22Z)."
echo "- At 16:51:58Z the same session ran \`lms ps\` and \`lms unload google/gemma-4-31b-qat\`; LM Studio logged the matching lms-cli clients (listLoaded, getLoadConfig, getModelInfo, getInstanceProcessingState, then unloadModel at 11:51:59 EST)."
echo "- This task ran neither: its tests used a refusing fake lms (PRAXIS_LMS_BIN) behind an LM Studio guard, its browser check used a fake LM Studio, and its runs were in scratch copies under /Volumes/Projects/.scratch-fa032fc0."

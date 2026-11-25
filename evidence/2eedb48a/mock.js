// Run only inside the offline screenshot fixture. All answers live in this tab.
const { surface, source, icons } = window.fixture;
const chat = surface === "chat";
const items = source.items.slice(0, chat ? 3 : 2);
const answers = new Map();
const modes = new Map(items.map((item, i) => [item.id, i === 2 ? "folded" : "options"]));
const text = value => String(value).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[c]);
const icon = name => icons[name];
const tool = (name, label, style = "") =>
  `<span class="tool ${style}">${icon(name)}${label}</span>`;
const root = document.querySelector("main");

function documentFrame() {
  return `<div class="document">
    <header class="doc-header">
      <div class="between">
        <div class="line crumb">${icon("FileCheck2")} Reviews <span class="desktop">/ &nbsp; Gay I Club</span></div>
        <div class="line">${tool("Pencil", "Edit")}${tool("FileCode", "Source", "desktop")}${tool("ShieldCheck", "Evidence")}${tool("Download", "Download", "desktop")}</div>
      </div>
      <div class="line doc-title"><span class="file-type">MD</span><h1>${text(source.title)}</h1></div>
      <div class="doc-meta">Site plan &nbsp;·&nbsp; v1 &nbsp;·&nbsp; rev ${text(source.content_hash.slice(0, 8))}</div>
    </header>
    <div class="layout">
      <aside class="outline"><div class="kicker">${icon("ListTree")} Contents</div>
        <p>1. Decisions for you</p><p class="indent">Date picking</p><p class="indent active">Sharing work</p>
        <p class="indent">What goes (each is your call)</p><p class="indent">Other</p>
        <p>Background: the short version and the member answers</p>
        <p>2. What exists today: keep, simplify or remove</p><p>3. The resulting site, page by page</p>
      </aside>
      <div id="questions"></div>
      <aside class="rail"><section><h2>Your decision</h2>
        <div class="line">${tool("ThumbsUp", "Approve document", "primary-tool")}${tool("Undo2", "Request changes", "warm-tool")}</div>
      </section><div class="between"><h3 class="line">${icon("MessageSquare")} Your review</h3><span class="muted">Draft</span></div>
      <p class="muted">No comments yet.</p></aside>
    </div>
    <footer class="phone-nav">${tool("ListTree", "Contents")}${tool("MessageSquare", "Review &amp; decide (0)")}</footer>
  </div>`;
}

function chatFrame() {
  return `<div class="chat"><header class="between terminal-head">
    <h1 class="line">${icon("Bot")} Praxis Terminal</h1>
    <div class="line crumb">${icon("Plus")}${icon("History")}${icon("X")}</div>
  </header><div class="chat-body"><article class="message"><span class="avatar">${icon("Bot")}</span>
    <div class="bubble"><div class="author">Praxis</div><p class="prompt">Which meeting and posting features should go in the Gay I Club plan?</p>
    <div id="questions"></div><time>Nov 25, 2026 · 3:18 PM</time></div>
  </article><div id="replies"></div></div>
  <footer class="composer-wrap"><form class="composer"><textarea aria-label="Message Praxis" placeholder="Message Praxis..."></textarea>
    <button class="tool send-text" aria-label="Send message">${icon("Send")}</button></form></footer></div>`;
}

function option(value, label, action, custom = false, selected = false) {
  return `<button class="option ${custom ? "custom" : ""}" data-option="${text(value)}" aria-pressed="${selected}">
    <span class="circle">${selected ? icon("CircleCheck") : ""}</span><span><b>${text(label)}</b><small>${text(action)}</small></span></button>`;
}

function editor(type, value = "") {
  const other = type === "other";
  return `<div class="editor"><label>${other ? "Your answer" : "Note (optional)"}<textarea rows="2" data-input="${type}" placeholder="${other ? "Type your answer" : "Add context to this choice"}">${text(value)}</textarea></label>
    <button class="tool" data-save="${type}" ${other && !value.trim() ? "disabled" : ""}>Save ${other ? "answer" : "note"}</button></div>`;
}

function summary(item, saved, mode) {
  const other = saved.kind === "other";
  const opt = other ? null : item.options.find(opt => opt.id === saved.answer);
  const chosen = other
    ? `<span class="tag">Other · Your answer</span><p class="own">${text(saved.text)}</p>`
    : `<b>${text(opt.label)}</b><small>${text(opt.action)}</small>`;
  const note = saved.note && mode !== "note"
    ? `<div class="note"><span class="line">${icon("MessageSquare")} Your note</span><p>${text(saved.note)}</p></div>` : "";
  const actions = saved.sent ? "" : `<div class="row-actions"><button class="subtle" data-mode="note">${icon("MessageSquare")}${saved.note ? "Edit note" : "Add a note"}</button>
    <button class="subtle" data-mode="options">${icon("Pencil")}Change answer</button></div>`;
  return `<div class="answer"><span class="check">${icon("CircleCheck")}</span><div>${chosen}</div></div>${note}
    ${mode === "note" ? editor("note", saved.note) : actions}`;
}

function card(item) {
  const saved = answers.get(item.id);
  const mode = modes.get(item.id);
  const title = `<div class="question"><span class="qid">${text(item.id)}</span><h3>${text(item.question)}</h3></div>`;
  const rec = `<p class="rec"><strong>Recommended:</strong> ${text(item.recommendation)}</p>`;
  let body;
  if (mode === "folded") {
    body = `<div class="compact"><div>${title}${rec}</div><button class="subtle" data-mode="options">Answer ${icon("ChevronRight")}</button></div>`;
  } else if (mode === "options" || mode === "other") {
    body = title + rec + `<div class="options">${item.options.map(o => option(o.id, o.label, o.action)).join("")}
      ${option("custom", "Other", "Write your own answer.", true, mode === "other")}</div>`;
    if (mode === "other") body += editor("other", saved?.kind === "other" ? saved.text : "");
  } else {
    body = title + rec + summary(item, saved, mode);
  }
  return `<section class="item" data-item="${text(item.id)}">${body}</section>`;
}

function paint() {
  const all = [...answers.values()];
  const sent = all.filter(a => a.sent).length;
  const drafts = all.length - sent;
  const open = items.length - all.length;
  const progress = sent && !drafts ? `${sent} of ${items.length} sent` : `${all.length} of ${items.length} answered`;
  let hint = all.length ? "Saved to your draft review" : "Answers go with your finished review.";
  let label = "Send answers to Praxis";
  if (chat) {
    hint = sent && !drafts ? `${open ? open + (open === 1 ? " question open" : " questions open") : "All answers sent"}` : "You can send a partial set.";
    label = drafts ? `Send ${drafts} answer${drafts === 1 ? "" : "s"}` : "Send answers";
  }
  const sentState = chat && sent && !drafts;
  const footer = `<div class="between foot"><span class="status ${sentState && !open ? "received" : ""}">${icon(sentState && !open ? "CircleCheck" : "Info")}${hint}</span>
    ${sentState ? "" : `<button data-submit class="act" ${!drafts ? "disabled" : ""}>${icon("Send")}${label}</button>`}</div>`;
  document.querySelector("#questions").innerHTML = `<section class="decisions"><div class="between panel-head"><h2 class="line">${icon("ListChecks")}
    ${items.length} decisions for you</h2><span class="progress">${progress}</span></div>${items.map(card).join("")}${footer}</section>`;
}

root.innerHTML = chat ? chatFrame() : documentFrame();
paint();
root.addEventListener("input", ({target}) => {
  if (target.matches('[data-input="other"]')) target.closest(".editor").querySelector("button").disabled = !target.value.trim();
});
root.addEventListener("click", ({target}) => {
  const b = target.closest("button");
  if (!b) return;
  if (b.hasAttribute("data-submit") && chat) {
    answers.forEach(a => { a.sent = true; });
    paint();
    return;
  }
  const id = b.closest(".item")?.dataset.item;
  if (!id) return;
  const saved = answers.get(id);
  if (b.dataset.mode) modes.set(id, b.dataset.mode);
  if (b.dataset.option === "custom") modes.set(id, "other");
  else if (b.dataset.option) {
    if (!saved || saved.kind !== "option" || saved.answer !== b.dataset.option)
      answers.set(id, {kind:"option", answer:b.dataset.option, note:""});
    modes.set(id, "summary");
  }
  if (b.dataset.save) {
    const value = b.closest(".editor").querySelector("textarea").value;
    if (b.dataset.save === "other") {
      if (!value.trim()) return;
      answers.set(id, {kind:"other", answer:"other", text:value, note:saved?.kind === "other" ? saved.note : ""});
    } else saved.note = value;
    modes.set(id, "summary");
  }
  paint();
  document.querySelector(`[data-item="${id}"] textarea`)?.focus();
});
document.querySelector(".composer")?.addEventListener("submit", event => {
  event.preventDefault();
  const field = event.target.querySelector("textarea");
  if (!field.value.trim()) return;
  const reply = document.createElement("p");
  reply.className = "muted";
  reply.textContent = field.value;
  document.querySelector("#replies").append(reply);
  field.value = "";
});

"use strict";
/* TARA phone tools.
   Lets the TARA phone app (full TARA screen) use THIS PC's tools through your cloud relay:
   search/read files, ChatGPT sign-in, Gmail search, make/edit documents ...

   Safety rules (all enforced here, on the PC, never trusted from the phone):
   1. OFF unless you switch it on in Settings -> Phone link ("Let my phone use TARA's PC tools").
   2. Only the actions in FREE / READ / GATED below can be called. Anything else (settings, passwords,
      e-mail login, relay setup, browser control...) is refused.
   3. File access uses the folders YOU approved in TARA on the PC (or Full PC access if you turned it on),
      never folders sent by the phone.
   4. Anything that changes something (write a file, make/edit a document, open a file, send an e-mail,
      save attachments) pops up a confirmation window on the PC first. No answer in 90 s = Deny.
*/
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FREE = new Set(["ping", "chatgptStatus", "chatgptModels", "chatgptResponse", "emailStatus", "emailSearch", "emailRead"]);
const WEB = new Set(["webRead", "webAct", "webDownloads", "webClose"]);      // APT / portal browser; webAct always runs inside the PC's own portal scope
const READ = new Set(["searchFiles", "readFile", "listDir"]);            // run with the PC's own read roots
const GATED = {
  writeFile:            { roots: "write", ask: a => ["Write a file", String(a.path || "") + "\n\n" + String(a.content || "").slice(0, 300)] },
  makeDocument:         { roots: null,    ask: a => ["Create a " + String(a.kind || "") + " document", String(a.filename || "(auto name)")] },
  editDocument:         { roots: "read",  ask: a => ["Edit a " + String(a.kind || "") + " document (a copy is saved)", String(a.path || "")] },
  webOpen:              { roots: null,    ask: a => ["Open a web portal in the TARA browser on this PC", String(a.url || "")] },
  openPath:             { roots: "read",  ask: a => ["Open a file or folder on this PC", String(a.path || a.special || "")] },
  emailSend:            { roots: null,    ask: a => ["Send an e-mail", "To: " + [].concat(a.to || []).join(", ") + "\nSubject: " + String(a.subject || "") + "\n\n" + String(a.body || "").slice(0, 400)] },
  emailSaveAttachments: { roots: null,    ask: a => ["Save e-mail attachments to Downloads", "Message: " + String(a.id || a.uid || "")] }
};

function create(o) {
  // o: { relayCall(method,path,body,timeoutMs), relayOn():bool, enabled():bool, handlers:{}, getRoots():Promise<{read,write}>, confirm(title,detail):Promise<bool> }
  let running = false, calls = [], chain = Promise.resolve();

  const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function run(action, args) {
    if (!o.enabled()) return { ok: false, phoneToolsOff: true, error: "Phone tools are switched off on the PC. Turn on “Let my phone use TARA's PC tools” in TARA Settings → Phone link." };
    const now = Date.now(); calls = calls.filter(t => now - t < 60000);
    if (calls.length >= 120) return { ok: false, error: "Too many requests from the phone in one minute." };
    calls.push(now);

    if (action === "getRoots") { let r = null; try { r = await o.getRoots(); } catch {} return r ? { ok: true, read: r.read || [], write: r.write || [] } : { ok: false, error: "TARA on the PC is not ready." }; }
    const h = o.handlers[action];
    const gate = GATED[action];
    if (!h || !(FREE.has(action) || READ.has(action) || WEB.has(action) || gate)) return { ok: false, error: "The phone is not allowed to use '" + action + "'." };
    args = (args && typeof args === "object") ? { ...args } : {};
    delete args.roots;                                           // never accept folders from the phone

    if (READ.has(action) || (gate && gate.roots)) {
      let r = null;
      try { r = await o.getRoots(); } catch { r = null; }
      if (!r) return { ok: false, error: "TARA on the PC is not ready (its window is still starting). Try again in a moment." };
      const list = gate && gate.roots === "write" ? r.write : r.read;
      if (!Array.isArray(list) || !list.length) return { ok: false, error: "No folders are approved on the PC yet. Add folders in the My PC tab (or turn on Full PC access) in TARA on the PC." };
      args.roots = list;
    }
    if (action === "webOpen" || WEB.has(action)) {                 // scope (allowed sites/sections) always comes from the PC's settings
      let sc = null; try { sc = await o.getScope(); } catch {}
      if (!sc) return { ok: false, error: "TARA on the PC is not ready." };
      args.scope = sc;
    }
    if (gate) {
      const [title, detail] = gate.ask(args);
      const ok = await serial(() => o.confirm("Your phone asks TARA to: " + title, detail));
      if (!ok) return { ok: false, denied: true, error: "You (on the PC) did not allow that." };
    }
    try { return await h(args); }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  async function handle(job) {
    let result;
    try { result = await run(String(job.action || ""), job.args); }
    catch (e) { result = { ok: false, error: String(e && e.message || e) }; }
    let body = JSON.stringify({ result });
    if (body.length > 2800000) body = JSON.stringify({ result: { ok: false, error: "The result was too large to send to the phone (over ~2.8 MB). Ask for a smaller file or part of it." } });
    try { await o.relayCall("POST", "/pc/rpc/" + job.id, JSON.parse(body), 30000); } catch { /* the relay expires the call by itself */ }
  }

  async function loop() {
    if (running) return; running = true;
    let wait = 2000;
    while (o.relayOn()) {
      let r;
      try { r = await o.relayCall("GET", "/pc/rpc/next", null, 35000); wait = 2000; }
      catch { await sleep(wait); wait = Math.min(wait * 2, 30000); continue; }
      if (r && r.rpc) handle(r.rpc);                              // not awaited: several calls can run at once
    }
    running = false;
  }
  return { start: loop, run, isRunning: () => running };
}
module.exports = { create, FREE, READ, WEB, GATED };

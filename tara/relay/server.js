"use strict";
/* TARA cloud relay — a tiny message box between your phone and TARA on your PC.
   Phone  -> POST /phone/command        (voice/text request)
   PC     -> GET  /pc/next              (long-poll: "any work for me?")
   PC     -> POST /pc/job/:id           (progress / final reply / approval request)
   Phone  -> GET  /phone/job/:id        (poll for reply or approval card)
   Phone  -> POST /phone/approve        (Yes / No / choice)
   PC     -> GET  /pc/decision/:id      (long-poll for the phone's answer)
   Everything needs the secret header  x-tara-token  (set TARA_TOKEN on the server).
   Device commands (calls / texts executed by the phone, always confirmed on the phone itself):
   PC     -> POST /pc/cmd               (queue a call/SMS for the phone)
   Phone  -> GET  /phone/cmds           (long-poll: "any command for me?")
   Phone  -> POST /phone/cmd-result     (ok / not ok after the user confirms on the phone)
   PC     -> GET  /pc/cmd/:id           (long-poll for that result)
   Full TARA on the phone (tool calls that run on the PC; only works if the PC owner turned "phone tools" on):
   Phone  -> POST /phone/rpc            ({action,args} -> {id})      Phone -> GET /phone/rpc/:id (long-poll result)
   PC     -> GET  /pc/rpc/next          (long-poll)                  PC    -> POST /pc/rpc/:id   ({result})
   File contents DO pass through here for those calls (held in memory ~10 minutes, never written to disk).
   Apart from that, no files or credentials pass through here — only short text. Jobs live in memory for 1 hour. */
const http = require("http");
const TOKEN = process.env.TARA_TOKEN || "";
const PORT = process.env.PORT || 3000;
if (TOKEN.length < 16) { console.error("Set the TARA_TOKEN environment variable (16+ random characters)."); process.exit(1); }

const jobs = new Map();
const pcWaiters = [];          // PC long-polls waiting for a job
const decWaiters = new Map();  // jobId -> res waiting for phone decision
let seq = 0, pcSeen = 0, phoneSeen = 0;
const cmds = new Map();         // id -> {id, kind, to, name, text, status, result, created}
const phoneWaiters = [];        // phone long-polls waiting for a command
const cmdWaiters = new Map();   // cmdId -> res waiting for the phone's result
const rpcs = new Map();         // id -> {id, action, args, status, result, created}  (phone full-TARA -> PC tool calls)
const rpcPcWaiters = [];        // PC long-polls waiting for a tool call
const rpcResWaiters = new Map();// rpcId -> res (phone) waiting for the result
const RPC_MAX_RESULT = 3e6;     // bytes of JSON the PC may return for one call

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-tara-token", "access-control-allow-methods": "GET,POST,OPTIONS" };
const send = (res, code, obj) => { try { res.writeHead(code, { "content-type": "application/json", ...CORS }); res.end(JSON.stringify(obj)); } catch {} };
const readBody = (req, limit = 1e6) => new Promise(r => { let d = ""; req.on("data", c => { d += c; if (d.length > limit) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });
const str = (v, n) => String(v == null ? "" : v).slice(0, n);

function dispatch() {
  while (pcWaiters.length) {
    const job = [...jobs.values()].find(j => j.status === "queued");
    if (!job) return;
    const w = pcWaiters.shift(); clearTimeout(w.t);
    if (w.res.destroyed || w.res.writableEnded) continue;   // dead connection (PC slept / network blip)
    job.status = "running"; job.updated = Date.now(); job.dispatched = Date.now(); job.acked = false;
    send(w.res, 200, { job: { id: job.id, text: job.text } });
  }
}

function dispatchCmd() {
  while (phoneWaiters.length) {
    const c = [...cmds.values()].find(x => x.status === "queued");
    if (!c) return;
    const w = phoneWaiters.shift(); clearTimeout(w.t);
    if (w.res.destroyed || w.res.writableEnded) continue;
    c.status = "sent";
    send(w.res, 200, { cmd: { id: c.id, kind: c.kind, to: c.to, name: c.name, text: c.text } });
  }
}
function finishCmd(c, ok, msg) {
  c.status = "done"; c.result = { ok: !!ok, msg: str(msg, 500) };
  const w = cmdWaiters.get(c.id);
  if (w) { cmdWaiters.delete(c.id); clearTimeout(w.t); send(w.res, 200, { result: c.result }); c.resultSent = true; }
}

function dispatchRpc() {
  while (rpcPcWaiters.length) {
    const r = [...rpcs.values()].find(x => x.status === "queued");
    if (!r) return;
    const w = rpcPcWaiters.shift(); clearTimeout(w.t);
    if (w.res.destroyed || w.res.writableEnded) continue;
    r.status = "sent"; r.sent = Date.now();
    send(w.res, 200, { rpc: { id: r.id, action: r.action, args: r.args } });
  }
}
function finishRpc(r, result) {
  r.status = "done"; r.result = result;
  const w = rpcResWaiters.get(r.id);
  if (w) { rpcResWaiters.delete(r.id); clearTimeout(w.t); send(w.res, 200, { result }); r.resultSent = true; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (p === "/" || p === "/health") return send(res, 200, { ok: true, service: "tara-relay" });
  if (req.headers["x-tara-token"] !== TOKEN) return send(res, 401, { error: "bad token" });

  // ---------- phone ----------
  if (p === "/phone/cmds") {
    phoneSeen = Date.now();
    const w = { res, t: setTimeout(() => { const i = phoneWaiters.indexOf(w); if (i >= 0) phoneWaiters.splice(i, 1); send(res, 200, { cmd: null }); }, 25000) };
    res.on("close", () => { clearTimeout(w.t); const i = phoneWaiters.indexOf(w); if (i >= 0) phoneWaiters.splice(i, 1); });
    phoneWaiters.push(w); dispatchCmd(); return;
  }
  if (p === "/phone/cmd-result" && req.method === "POST") {
    phoneSeen = Date.now();
    const b = await readBody(req), c = cmds.get(str(b.id, 60));
    if (!c) return send(res, 404, { error: "unknown command" });
    if (c.status !== "done") finishCmd(c, b.ok, b.msg);
    return send(res, 200, { ok: true });
  }
  if (p === "/phone/ping") { phoneSeen = Date.now(); return send(res, 200, { ok: true, pcOnline: Date.now() - pcSeen < 60000 }); }
  if (p === "/phone/command" && req.method === "POST") {
    const b = await readBody(req), text = str(b.text, 4000).trim();
    if (!text) return send(res, 400, { error: "empty" });
    const id = (++seq) + "-" + Math.random().toString(36).slice(2, 8);
    jobs.set(id, { id, text, status: "queued", reply: "", approval: null, decision: null, created: Date.now(), updated: Date.now() });
    dispatch();
    return send(res, 200, { id });
  }
  let m;
  if ((m = p.match(/^\/phone\/job\/([\w-]+)$/))) {
    const j = jobs.get(m[1]); if (!j) return send(res, 404, { error: "unknown job" });
    return send(res, 200, { status: j.status, reply: j.reply, approval: j.approval, pcOnline: Date.now() - pcSeen < 60000 });
  }
  if (p === "/phone/approve" && req.method === "POST") {
    const b = await readBody(req), j = jobs.get(str(b.id, 60));
    if (!j || !j.approval) return send(res, 404, { error: "nothing waiting for approval" });
    j.decision = { ok: !!b.ok, feedback: str(b.feedback, 1000), choice: str(b.choice, 500) };
    j.approval = null; j.status = "running"; j.updated = Date.now();
    const w = decWaiters.get(j.id);
    if (w) { decWaiters.delete(j.id); clearTimeout(w.t); const d = j.decision; j.decision = null; send(w.res, 200, { decision: d }); }
    return send(res, 200, { ok: true });
  }

  // ---- full TARA on the phone: tool calls that run on the PC (files, ChatGPT login, e-mail, documents) ----
  if (p === "/phone/rpc" && req.method === "POST") {
    phoneSeen = Date.now();
    const b = await readBody(req, 4e6), action = str(b.action, 40);
    if (!/^[A-Za-z]+$/.test(action)) return send(res, 400, { error: "bad action" });
    if (Date.now() - pcSeen > 90000) return send(res, 200, { pcOnline: false });
    if ([...rpcs.values()].filter(x => x.status !== "done").length >= 50) return send(res, 429, { error: "too many pending calls" });
    const id = "r" + (++seq) + "-" + Math.random().toString(36).slice(2, 8);
    rpcs.set(id, { id, action, args: (b.args && typeof b.args === "object") ? b.args : {}, status: "queued", result: null, created: Date.now() });
    dispatchRpc();
    return send(res, 200, { id, pcOnline: true });
  }
  let m2;
  if ((m2 = p.match(/^\/phone\/rpc\/([\w-]+)$/))) {
    phoneSeen = Date.now();
    const r = rpcs.get(m2[1]); if (!r) return send(res, 404, { error: "unknown call" });
    if (r.result) { r.resultSent = true; return send(res, 200, { result: r.result }); }
    const w = { res, t: setTimeout(() => { rpcResWaiters.delete(r.id); send(res, 200, { result: null }); }, 25000) };
    res.on("close", () => { clearTimeout(w.t); if (rpcResWaiters.get(r.id) === w) rpcResWaiters.delete(r.id); });
    rpcResWaiters.set(r.id, w); return;
  }

  // ---------- PC ----------
  if (p === "/pc/rpc/next") {
    pcSeen = Date.now();
    const w = { res, t: setTimeout(() => { const i = rpcPcWaiters.indexOf(w); if (i >= 0) rpcPcWaiters.splice(i, 1); send(res, 200, { rpc: null }); }, 25000) };
    res.on("close", () => { clearTimeout(w.t); const i = rpcPcWaiters.indexOf(w); if (i >= 0) rpcPcWaiters.splice(i, 1); });
    rpcPcWaiters.push(w); dispatchRpc(); return;
  }
  if ((m2 = p.match(/^\/pc\/rpc\/([\w-]+)$/)) && req.method === "POST") {
    pcSeen = Date.now();
    const r = rpcs.get(m2[1]); if (!r) return send(res, 404, { error: "unknown call" });
    const b = await readBody(req, RPC_MAX_RESULT);
    if (r.status !== "done") finishRpc(r, (b.result && typeof b.result === "object") ? b.result : { ok: false, error: "empty result" });
    return send(res, 200, { ok: true });
  }
  if (p === "/pc/cmd" && req.method === "POST") {
    pcSeen = Date.now();
    const b = await readBody(req), kind = b.kind === "call" ? "call" : b.kind === "sms" ? "sms" : "";
    const to = str(b.to, 30).replace(/[^\d+]/g, "");
    if (!kind || to.length < 5) return send(res, 400, { error: "bad command" });
    const text = kind === "sms" ? str(b.text, 1000) : "";
    if (kind === "sms" && !text.trim()) return send(res, 400, { error: "empty text" });
    if (Date.now() - phoneSeen > 90000) return send(res, 200, { phoneOnline: false });
    const id = "c" + (++seq) + "-" + Math.random().toString(36).slice(2, 8);
    cmds.set(id, { id, kind, to, name: str(b.name, 80), text, status: "queued", result: null, created: Date.now() });
    dispatchCmd();
    return send(res, 200, { id, phoneOnline: true });
  }
  if ((m = p.match(/^\/pc\/cmd\/([\w-]+)$/))) {
    pcSeen = Date.now();
    const c = cmds.get(m[1]); if (!c) return send(res, 404, { error: "unknown command" });
    if (c.result) return send(res, 200, { result: c.result });
    const w = { res, t: setTimeout(() => { cmdWaiters.delete(c.id); send(res, 200, { result: null }); }, 25000) };
    res.on("close", () => { clearTimeout(w.t); if (cmdWaiters.get(c.id) === w) cmdWaiters.delete(c.id); });
    cmdWaiters.set(c.id, w); return;
  }
  if (p === "/pc/ping") { pcSeen = Date.now(); return send(res, 200, { ok: true }); }
  if (p === "/pc/next") {
    pcSeen = Date.now();
    const w = { res, t: setTimeout(() => { const i = pcWaiters.indexOf(w); if (i >= 0) pcWaiters.splice(i, 1); send(res, 200, { job: null }); }, 25000) };
    res.on("close", () => { clearTimeout(w.t); const i = pcWaiters.indexOf(w); if (i >= 0) pcWaiters.splice(i, 1); });
    pcWaiters.push(w); dispatch(); return;
  }
  if ((m = p.match(/^\/pc\/job\/([\w-]+)$/)) && req.method === "POST") {
    pcSeen = Date.now();
    const j = jobs.get(m[1]); if (!j) return send(res, 404, { error: "unknown job" });
    const b = await readBody(req);
    j.acked = true;
    if (b.reply !== undefined) j.reply = str(b.reply, 20000);
    if (b.approval) { const a = b.approval; j.approval = { title: str(a.title, 300), sub: str(a.sub, 500), preview: str(a.preview, 4000), options: Array.isArray(a.options) ? a.options.slice(0, 8).map(o => str(o, 300)) : null }; j.status = "waiting"; }
    else if (["running", "done", "error"].includes(b.status)) { j.status = b.status; if (b.status !== "running") j.approval = null; }
    j.updated = Date.now();
    return send(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/pc\/beat\/([\w-]+)$/)) && req.method === "POST") {
    pcSeen = Date.now();
    const j = jobs.get(m[1]); if (!j) return send(res, 404, { error: "unknown job" });
    j.acked = true; j.updated = Date.now();
    return send(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/pc\/decision\/([\w-]+)$/))) {
    pcSeen = Date.now();
    const j = jobs.get(m[1]); if (!j) return send(res, 404, { error: "unknown job" });
    if (j.decision) { const d = j.decision; j.decision = null; return send(res, 200, { decision: d }); }
    const w = { res, t: setTimeout(() => { decWaiters.delete(j.id); send(res, 200, { decision: null }); }, 25000) };
    res.on("close", () => { clearTimeout(w.t); if (decWaiters.get(j.id) === w) decWaiters.delete(j.id); });
    decWaiters.set(j.id, w); return;
  }
  send(res, 404, { error: "not found" });
});

setInterval(() => {
  const now = Date.now();
  for (const j of jobs.values()) {
    if (j.status === "running" && !j.acked && j.dispatched && now - j.dispatched > 20000) {   // PC never confirmed: hand it out again
      j.status = "queued"; j.dispatched = 0; j.updated = now; dispatch();
    } else if ((j.status === "running" || j.status === "waiting") && now - j.updated > 120000) {  // PC went silent mid-job
      j.status = "error"; j.approval = null; j.reply = "TARA on your PC stopped responding. Please check that it is open and try again.";
    }
  }
}, 5000);
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of cmds) {
    if (c.status !== "done" && now - c.created > 180000) finishCmd(c, false, "The phone did not confirm in time.");
    if (now - c.created > 3600000) cmds.delete(id);
  }
}, 5000);
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rpcs) {
    if (r.status !== "done" && now - r.created > 120000) finishRpc(r, { ok: false, error: "TARA on the PC did not answer in time." });
    if (now - r.created > 600000) rpcs.delete(id);   // results are only kept briefly, then dropped
  }
}, 5000);
setInterval(() => { const cut = Date.now() - 3600000; for (const [id, j] of jobs) if (j.updated < cut) jobs.delete(id); }, 300000);
server.listen(PORT, () => console.log("TARA relay listening on " + PORT));

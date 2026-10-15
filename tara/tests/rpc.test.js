"use strict";
// Integration test: real relay + PC module (fake handlers) + simulated phone.  Run:  node tests/rpc.test.js
const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");
const rpc = require("../desktop/tara-phone-rpc");
const PORT = 3999, TOKEN = "test-token-1234567890-abcdef", BASE = "http://127.0.0.1:" + PORT;

const api = async (method, p, body, ms = 35000) => {
  const r = await fetch(BASE + p, { method, headers: { "x-tara-token": TOKEN, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
  const j = await r.json(); if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; e.body = j; throw e; } return j;
};
// phone helper: send a call and wait for the result (same loop the phone shim uses)
async function phoneInvoke(action, args) {
  const s = await api("POST", "/phone/rpc", { action, args });
  if (s.pcOnline === false) return { ok: false, error: "pc offline" };
  for (let i = 0; i < 10; i++) { const x = await api("GET", "/phone/rpc/" + s.id); if (x.result) return x.result; }
  return { ok: false, error: "timeout" };
}

(async () => {
  const relay = spawn(process.execPath, [path.join(__dirname, "../relay/server.js")], { env: { ...process.env, PORT, TARA_TOKEN: TOKEN }, stdio: "inherit" });
  await new Promise(r => setTimeout(r, 600));
  let enabled = false, confirmAnswer = true; const confirms = [], seen = [];
  const handlers = {
    ping: () => ({ ok: true, tara: 3 }),
    readFile: a => { seen.push(["readFile", a]); return { ok: true, text: "hello " + a.path }; },
    searchFiles: a => { seen.push(["searchFiles", a]); return { ok: true, results: [] }; },
    writeFile: a => { seen.push(["writeFile", a]); return { ok: true, path: a.path }; },
    setPrefs: () => ({ ok: true }), emailSetup: () => ({ ok: true }),
    big: () => ({})
  };
  const pc = rpc.create({
    relayCall: (m, p, b, t) => api(m, p, b, t), relayOn: () => true, enabled: () => enabled, handlers,
    getRoots: async () => ({ read: ["D:/Data"], write: ["D:/Data/Out"] }),
    confirm: async (t, d) => { confirms.push([t, d]); return confirmAnswer; }
  });
  pc.start();
  await new Promise(r => setTimeout(r, 500));

  // 0) phone can't reach a PC that never polled -> handled by relay (pcOnline) ; here PC is polling so it is online
  let r = await phoneInvoke("ping", {});
  assert.strictEqual(r.phoneToolsOff, true, "off by default"); console.log("ok  off by default is refused");

  enabled = true;
  r = await phoneInvoke("ping", {}); assert.strictEqual(r.ok, true); console.log("ok  ping works when on");

  r = await phoneInvoke("readFile", { path: "D:/Data/a.txt", roots: ["*"] });
  assert.strictEqual(r.text, "hello D:/Data/a.txt");
  assert.deepStrictEqual(seen.pop()[1].roots, ["D:/Data"], "phone-sent roots must be replaced by the PC's roots");
  console.log("ok  read uses PC roots, phone-supplied roots ignored");

  for (const bad of ["setPrefs", "emailSetup", "relaySetup", "chatgptSignIn", "webAct", "nonsense"]) {
    r = await phoneInvoke(bad, {}); assert.strictEqual(r.ok, false); assert.ok(/not allowed/.test(r.error), bad);
  }
  console.log("ok  non-whitelisted actions refused");

  r = await phoneInvoke("writeFile", { path: "D:/Data/Out/x.txt", content: "hi" });
  assert.strictEqual(r.ok, true); assert.strictEqual(confirms.length, 1); assert.ok(/Write a file/.test(confirms[0][0]));
  assert.deepStrictEqual(seen.pop()[1].roots, ["D:/Data/Out"], "write uses write roots");
  console.log("ok  write asks on the PC first, uses write roots");

  confirmAnswer = false; seen.length = 0;
  r = await phoneInvoke("writeFile", { path: "D:/Data/Out/y.txt", content: "no" });
  assert.strictEqual(r.denied, true); assert.strictEqual(seen.length, 0, "handler must not run when denied");
  console.log("ok  denied write never runs");

  // no folders approved
  const pc2roots = rpc.create({ relayCall: (m, p, b, t) => api(m, p, b, t), relayOn: () => false, enabled: () => true, handlers, getRoots: async () => ({ read: [], write: [] }), confirm: async () => true });
  r = await pc2roots.run("readFile", { path: "C:/x" }); assert.ok(/No folders are approved/.test(r.error)); console.log("ok  empty roots -> clear message");

  // PC offline: stop polling and wait for relay's 90s window? just verify a never-polled relay answers pcOnline:false
  relay.kill(); await new Promise(r => setTimeout(r, 300));
  const relay2 = spawn(process.execPath, [path.join(__dirname, "../relay/server.js")], { env: { ...process.env, PORT, TARA_TOKEN: TOKEN }, stdio: "inherit" });
  await new Promise(r => setTimeout(r, 600));
  r = await phoneInvoke("ping", {}); assert.strictEqual(r.error, "pc offline"); console.log("ok  relay reports PC offline");
  relay2.kill(); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });

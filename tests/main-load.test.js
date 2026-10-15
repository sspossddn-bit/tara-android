"use strict";
// Loads desktop/main.js against a fake "electron" and exercises the new handlers (catches launch-time crashes).
const Module = require("module"), path = require("path"), fs = require("fs"), os = require("os"), assert = require("assert");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tara-test-"));
let invoke = null, ready = null;
const deep = (name) => new Proxy(function () {}, { get: (t, k) => k === "then" ? undefined : deep(name + "." + String(k)), apply: () => deep(name + "()"), construct: () => deep("new " + name) });
const app = new Proxy({}, { get(t, k) {
  if (k === "getPath") return () => tmp; if (k === "requestSingleInstanceLock") return () => true;
  if (k === "whenReady") return () => ({ then: cb => { ready = cb; return { catch() {} }; } });
  if (k === "getVersion") return () => "9.9.9"; if (k === "isPackaged") return false; if (k === "getAppPath") return tmp;
  return deep("app." + String(k)); } });
const electron = { app, ipcMain: { handle: (ch, fn) => { if (ch === "tara:invoke") invoke = fn; } }, safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showMessageBox: async () => ({ response: 0 }) }, BrowserWindow: Object.assign(function () { return deep("win"); }, { fromWebContents: () => null }),
  shell: deep("shell"), powerSaveBlocker: deep("psb"), Tray: function () { return deep("tray"); }, Menu: deep("Menu"), Notification: deep("N"), nativeImage: deep("img"), globalShortcut: deep("gs"), session: deep("session") };
const orig = Module._load;
Module._load = function (req, ...r) { return req === "electron" ? electron : orig.call(this, req, ...r); };
require("../desktop/main.js");
assert.ok(invoke, "tara:invoke handler registered");
(async () => {
  let r = await invoke({ sender: {} }, "getPrefs", {}); assert.strictEqual(r.phoneTools, false); console.log("ok  phoneTools defaults to OFF");
  r = await invoke({ sender: {} }, "setPrefs", { phoneTools: true }); assert.strictEqual(r.phoneTools, true);
  r = await invoke({ sender: {} }, "getPrefs", {}); assert.strictEqual(r.phoneTools, true); console.log("ok  phoneTools can be switched on and is stored");
  r = await invoke({ sender: {} }, "relayCmd", { kind: "sms", to: "+911234567890", text: "hi" }); assert.strictEqual(r.ok, false); assert.ok(/not set up/.test(r.error)); console.log("ok  relayCmd without relay -> clear error");
  r = await invoke({ sender: {} }, "researchFetch", { url: "http://localhost:1/x" }); assert.strictEqual(r.ok, false); console.log("ok  researchFetch refuses localhost:", r.error);
  r = await invoke({ sender: {} }, "ping", {}); assert.strictEqual(r.ok, true); console.log("ok  ping");
  process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });

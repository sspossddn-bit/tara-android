"use strict";
// Loads a TARA.html in jsdom with a fake bridge, checks it boots and that the expected tools exist.
// usage: node tests/html-load.test.js <file.html> [--mobile]
const fs = require("fs"), path = require("path"), assert = require("assert");
let JSDOM; try { JSDOM = require("jsdom").JSDOM; } catch { JSDOM = require("/tmp/jsd/node_modules/jsdom").JSDOM; }
const file = path.resolve(process.argv[2]), mobile = process.argv.includes("--mobile");
const html = fs.readFileSync(file, "utf8"), errors = [];
const calls = [];
const dom = new JSDOM(html, { url: "http://localhost/tara-full.html", runScripts: "dangerously", pretendToBeVisual: true, resources: "usable",
  beforeParse(w) {
    w.addEventListener("error", e => errors.push(String(e.error || e.message)));
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {} }));
    w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; if (!w.crypto || !w.crypto.getRandomValues) w.crypto = require("crypto").webcrypto; w.fetch = (...a) => Promise.reject(new Error("offline test")); w.speechSynthesis = undefined;
    w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
    if (!mobile) w.tara = { invoke: async (a, x) => { calls.push(a); return a === "ping" ? { ok: true, tara: 3 } : a === "relayStatus" ? { ok: true, configured: true, url: "x", state: "online" } : a === "getPrefs" ? { ok: true, keepRunning: true, phoneTools: true } : { ok: true } }, onRemoteJob() {}, onHotkey() {} };
    else { w.Android = { listen() {}, stopListening() {}, speak() {}, stopSpeaking() {}, setWake() {}, sendSms() {}, placeCall() {} };
           w.localStorage.setItem("url", "http://127.0.0.1:1"); w.localStorage.setItem("token", "x".repeat(24)); }
  } });
setTimeout(() => {
  const w = dom.window;
  assert.deepStrictEqual(errors, [], "page errors: " + errors.join(" | "));
  const names = Object.keys(w.eval("TOOLS"));
  const need = ["search_files", "read_file", "save_note", "add_contact", "find_contact", "phone_call", "phone_sms", "research_search", "create_word", "edit_excel"];
  for (const n of need) assert.ok(names.includes(n), "missing tool " + n);
  console.log("ok  boots without errors;", names.length, "tools incl. notes/contacts/phone/research/office");
  if (!mobile) { assert.ok(w.document.getElementById("setPhoneTools"), "phone tools checkbox"); assert.ok(w.document.getElementById("contacts"), "contacts box"); console.log("ok  settings has phone-tools switch + contacts box"); }
  process.exit(0);
}, 2500);

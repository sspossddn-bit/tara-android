# TARA: PC app + full TARA on your phone

```
Phone (full TARA screen)  <--->  Cloud relay (Render)  <--->  TARA on your PC
```
* `desktop/` TARA for Windows (v1.4: your v1.3 plus contacts, notes, research, phone call/text, phone tools)
* `relay/` tiny cloud relay (Node, no dependencies)
* `android/` phone app. **Full TARA** screen (chat, tasks, memory, notes, contacts, voice, "Hey TARA", calls/texts) plus the simple voice Remote screen
* `mobile/`, `scripts/build-mobile.js` build the phone's full screen from `desktop/TARA.html` (GitHub Actions does it for you)
* `tests/` `node tests/rpc.test.js`, `node tests/main-load.test.js`

## Setup
1. **Relay:** Render > New Web Service from this repo. Root Directory `relay`, Start `node server.js`, env `TARA_TOKEN` = long random secret.
2. **APK:** push to GitHub > Actions > *Build TARA APK* > download artifact `TARA-apk`, install on phone.
3. **PC:** replace the files in your TARA folder with `desktop/*` (all of them, including `tara-phone-rpc.js` and `tara-office.js`; if you have `resources\app.asar`, unpack it with `npx asar extract app.asar app` first and remove the asar). Quit TARA from the tray, reopen. Settings > Phone link: relay URL + token > Connect, then tick **Let my phone use TARA's PC tools**.
4. **Phone:** open the app > gear > relay URL + token > Save & test. Tap **Full TARA**.

## How the phone gets "full" TARA
* Runs the same TARA screen on the phone. Anything needing the PC (files, Excel/Word, Gmail, ChatGPT sign-in) is sent through the relay to your PC.
* PC off? Chat still works if you pick a free provider (Gemini/Groq) and paste its key in phone Settings.
* Safety (enforced on the PC): phone tools are OFF by default; only a fixed list of actions; folders are the ones approved on the PC; writing, creating documents, opening files, sending mail ask you **on the PC** each time (90 s, then deny). Anyone with relay URL + token can read approved folders, so use a long token. File contents pass through the relay in memory for ~10 min.
* APT / web portals work from the phone too: opening a portal asks you on the PC; the allowed sites/sections come from the PC's settings, and you still log in yourself in the TARA browser window on the PC.
* Calls/texts from the phone screen use a TARA approval card, then Android sends them. PC to phone calls/texts still go through the relay.

## Known limits (not tested on real devices when this was written)
* APK build, Electron run and phone layout were not run end-to-end; relay, PC module, main.js loading and page boot are tested.
* Phone and PC keep separate chats, notes, contacts, tasks (no sync yet).
* Free Render relay sleeps after 15 min; first request can take ~1 minute.

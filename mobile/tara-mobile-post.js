/* TARA mobile: native voice, native calls/texts, PC status, mirrored PC folders. Runs after the main TARA script. */
(function(){"use strict";
const A=window.Android,M=window.TARA_MOBILE;
const lang=()=>state.settings.mobileLang||"en-IN";
const sp=t=>/[\u0C00-\u0C7F]/.test(t)?"te-IN":/[\u0900-\u097F]/.test(t)?"hi-IN":"en-IN";
// ---- voice (Android speech recognizer / text-to-speech) ----
let pend=null;
function done(t){const p=pend;pend=null;voice.active=false;voice.mode="";voice.cancel=null;setVoiceUI("idle","Ready");if(p)p.res(t)}
window.listenOnce=function(o={}){
  if(!A){bubble("ai","- Voice works in the TARA phone app.");return Promise.resolve(null)}
  if(voice.active){voice.cancel&&voice.cancel();return Promise.resolve(null)}
  if(busy&&!o.test){toast("TARA is still working…");return Promise.resolve(null)}
  try{A.stopSpeaking()}catch{}
  voice.active=true;voice.mode="cmd";setVoiceUI("listening","Listening");
  return new Promise(res=>{pend={res,test:!!o.test};voice.cancel=()=>{try{A.stopListening()}catch{}done(null)};A.listen(lang())});
};
window.onSpeechState=s=>{if(s==="processing")setVoiceUI("busy","Transcribing")};
window.onSpeechResult=(t,fin)=>{if(!pend)return;if(!fin){if(!pend.test&&$("input"))$("input").value=t;return}
  const p=pend;done(t);if(!t||p.test)return;voice.next=true;$("input").value=t;send()};
window.onSpeechError=m=>{if(pend)done(null);toast(m)};
let after=null;
window.speak=function(text,noHook){
  if(remoteCtx)return;const cb=()=>{if(!noHook)voiceAfterReply()};
  if(!A||!state.settings.speak||!text){cb();return}
  const t=String(text).replace(/```[\s\S]*?```/g," code block. ").replace(/https?:\/\/\S+/g," link ").replace(/[*_`#>|]/g,"").slice(0,1500);
  after=cb;A.speak(t,sp(t));
};
window.onSpeakDone=()=>{const f=after;after=null;if(f)f()};
window.wakeLoop=async function(){if(!A)return;A.setWake(!!state.settings.wake,lang());setVoiceUI(state.settings.wake?"wake":"idle",state.settings.wake?"Waiting for “Hey TARA”":"Ready")};
window.onWakeState=(on,msg)=>{if(!on){state.settings.wake=false;save();const c=$("setWake");if(c)c.checked=false;if(msg)toast(msg);setVoiceUI("idle","Ready")}};
window.onWakeResult=t=>{if(busy||voice.active)return;
  const m=String(t).match(/^[\s,.!?]*(?:(?:hey|hi|hello|ok|okay)[\s,.!?]+)?(?:tara|tarah|thara|taara|తారా|तारा)(?:[\s,.!?:;-]+([\s\S]*))?$/i);if(!m)return;
  const rest=(m[1]||"").trim();if(rest){voice.next=true;$("input").value=rest;send()}else listenOnce({waitMs:8000})};
if($("setWake"))$("setWake").onchange=()=>{state.settings.wake=$("setWake").checked;save();wakeLoop()};
// voice language picker (added to the assistant settings)
const wk=$("setWake")&&$("setWake").closest(".chk");
if(wk){const d=document.createElement("label");d.className="chk";d.innerHTML='Voice language (phone) <select id="mobLang" class="field" style="width:auto;margin-left:8px"><option value="en-IN">English</option><option value="te-IN">Telugu</option><option value="hi-IN">Hindi</option></select>';
  wk.parentNode.insertBefore(d,wk);const s=d.querySelector("select");s.value=lang();s.onchange=()=>{state.settings.mobileLang=s.value;save()}}
// ---- calls and texts run on this phone (you approve on the TARA card first) ----
const wait=new Map();
window.onCmdResult=(id,ok,msg)=>{const f=wait.get(id);if(f){wait.delete(id);f({ok,msg})}};
async function cmd(kind,a){
  if(!A)return {error:"Calls and texts work in the TARA phone app."};
  const r=resolveNumber(a.to);if(r.error)return {error:r.error};
  const text=kind==="sms"?String(a.text||"").trim().slice(0,1000):"";
  if(kind==="sms"&&!text)return {error:"The message text is empty."};
  const g=await approve(kind==="call"?"Place this call?":"Send this text?","To: "+r.label+" ("+r.number+")",kind==="sms"?text:String(a.purpose||""));
  if(!g.ok)return {error:declineMsg(g)};
  const id="m"+Date.now();
  const res=await new Promise(f=>{wait.set(id,f);setTimeout(()=>{if(wait.delete(id))f({ok:false,msg:"The phone did not answer."})},60000);kind==="sms"?A.sendSms(id,r.number,text):A.placeCall(id,r.number)});
  return res.ok?"Done: "+res.msg+" ("+r.label+").":{error:"The phone did not do it: "+res.msg+". Do not claim it happened."};
}
TOOLS.phone_call.ok=()=>!!A;TOOLS.phone_call.run=a=>cmd("call",a);
TOOLS.phone_sms.ok=()=>!!A;TOOLS.phone_sms.run=a=>cmd("sms",a);
// ---- PC status + mirror the PC's approved folders ----
async function syncRoots(){if(!bridgeOK)return;const r=await window.tara.invoke("getRoots",{});if(!r||!r.ok)return;
  const rd=r.read||[],wr=r.write||[];state.settings.allAccess=rd[0]==="*";if(rd[0]!=="*")state.folders=rd.slice();state.settings.writeAll=wr[0]==="*";save();renderAll()}
async function syncApt(){if(!bridgeOK)return;const r=await window.tara.invoke("getScope",{});if(!r||!r.ok||!r.scope)return;
  const c=r.scope;if(c.hosts)state.settings.aptHosts=c.hosts;if(c.words)state.settings.aptWords=c.words;if(c.start)state.settings.aptUrl=c.start;save()}
function paint(){const b=$("bridgeState");if(b)b.textContent=M.pcOnline?(bridgeOK?"✓ Connected to TARA on your PC":"⚠ PC is online but phone tools are off: turn on “Let my phone use TARA's PC tools” in TARA Settings on the PC."):"PC offline: files, ChatGPT sign-in and Gmail need TARA open on your PC."}
M.onChange=async()=>{await checkBridge();await syncRoots();await syncApt();paint()};
setInterval(paint,3000);setTimeout(()=>M.onChange(),1500);
// ---- back to the simple remote screen ----
const back=document.createElement("button");back.textContent="Remote";back.title="Simple voice remote";back.onclick=()=>{try{A&&A.setWake(false,"en-IN")}catch{}location.href="index.html"};
const top=document.querySelector(".top");if(top)top.appendChild(back);
})();

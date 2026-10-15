/* TARA mobile bridge: makes window.tara work on the phone by sending PC-side tool calls through the cloud relay. */
(function(){"use strict";
const ls=k=>{try{return localStorage.getItem(k)||""}catch{return ""}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const M=window.TARA_MOBILE={pcOnline:false,onChange:null};
function setPc(on){if(M.pcOnline!==on){M.pcOnline=on;try{M.onChange&&M.onChange(on)}catch{}}}
async function relay(method,path,body,ms){
  const url=ls("url").replace(/\/+$/,""),token=ls("token");
  if(!url||!token)throw Object.assign(new Error("cfg"),{code:"cfg"});
  const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),ms||35000);
  try{const r=await fetch(url+path,{method,signal:ctl.signal,headers:{"x-tara-token":token,"content-type":"application/json"},body:body?JSON.stringify(body):undefined});
    const j=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(j.error||("HTTP "+r.status));e.status=r.status;throw e}return j}
  finally{clearTimeout(t)}
}
async function rpc(action,args){
  let s;
  try{s=await relay("POST","/phone/rpc",{action,args},30000)}
  catch(e){return {ok:false,error:e.code==="cfg"?"Set the relay URL and token first (Remote screen, gear icon).":e.status===401?"The relay rejected the token.":"Could not reach the relay ("+e.message+"). A free Render relay can take a minute to wake up."}}
  if(s.pcOnline===false){setPc(false);return {ok:false,error:"TARA on your PC is not online. Open TARA on the PC and connect Settings > Phone link."}}
  const end=Date.now()+125000;
  while(Date.now()<end){
    try{const x=await relay("GET","/phone/rpc/"+s.id,null,35000);if(x.result){setPc(!x.result.phoneToolsOff||true);return x.result}}
    catch(e){if(e.status===404)return {ok:false,error:"The relay lost the request (it may have restarted). Try again."};await sleep(1500)}
  }
  return {ok:false,error:"No answer from the PC in time."};
}
const no=m=>()=>({ok:false,error:m});
const LOCAL={
  openUrl:a=>{try{window.open(a.url,"_blank","noopener")}catch{}return {ok:true}},
  minimize:()=>({ok:true}),showWindow:()=>({ok:true}),notify:()=>({ok:true}),
  getPrefs:()=>({ok:true,keepRunning:false,autostart:false,hotkey:"",hotkeyOk:true,phoneTools:false}),setPrefs:()=>({ok:true}),
  relayStatus:()=>({ok:true,configured:false,url:"",state:"phone"}),
  relaySetup:no("Not used on the phone."),relayDisconnect:no("Not used on the phone."),relayJob:()=>({ok:true}),relayApproval:no("Not used on the phone."),relayCmd:no("Not used on the phone."),
  transcribe:no("native"),
  chatgptSignIn:no("Sign in to ChatGPT on the PC (TARA Settings > Continue with ChatGPT). The phone uses the PC's sign-in, or pick a free provider (Gemini/Groq) in Settings."),
  emailSetup:no("Connect e-mail on the PC."),emailDisconnect:no("Do this on the PC.")
};
window.tara={invoke:(a,x)=>LOCAL[a]?Promise.resolve(LOCAL[a](x||{})):rpc(a,x||{}),onRemoteJob(){},onHotkey(){}};
async function beat(){try{const r=await relay("GET","/phone/ping",null,15000);setPc(!!r.pcOnline)}catch{}}
setInterval(beat,20000);setTimeout(beat,800);
})();

"use strict";
const {app,BrowserWindow,ipcMain,shell,safeStorage,powerSaveBlocker,Tray,Menu,Notification,nativeImage,globalShortcut,session,dialog}=require("electron");
app.setAppUserModelId("TARA");
// Stay fast when TARA is idle, hidden or minimised (otherwise Chromium slows timers/network after ~5 min)
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
const fs=require("fs");
const http=require("http");
const crypto=require("crypto");
const https=require("https");
const path=require("path");
const files=require("./tara-files");

const SPECIAL={Downloads:"downloads",Desktop:"desktop",Documents:"documents"};

// ================= ChatGPT Plan / Sign in with ChatGPT =================
const CHATGPT_STORE=path.join(app.getPath("userData"),"chatgpt-plan.enc");
const CHATGPT_HOST=path.join(app.getPath("userData"),"chatgpt-host.json");
const CHATGPT_AUTH="https://auth.openai.com/api/accounts/authorize";
const CHATGPT_TOKEN="https://auth.openai.com/api/accounts/oauth/token";
const CHATGPT_RESOURCE="https://api.openai.com/v1";
const CHATGPT_SCOPE="openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CHATGPT_MODELS=CHATGPT_RESOURCE+"/models";
const CHATGPT_RESPONSES=CHATGPT_RESOURCE+"/responses";
function jsonSaveSecure(file,obj){
  const raw=Buffer.from(JSON.stringify(obj));
  if(!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable.");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,safeStorage.encryptString(raw.toString("utf8")));
}
function jsonReadSecure(file){
  if(!fs.existsSync(file)||!safeStorage.isEncryptionAvailable()) return null;
  try{return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));}catch{return null}
}
function hostId(){
  try{if(fs.existsSync(CHATGPT_HOST)){const j=JSON.parse(fs.readFileSync(CHATGPT_HOST,"utf8"));if(j.hostId)return j.hostId;}}
  catch{}
  const id="urn:uuid:"+crypto.randomUUID();
  fs.mkdirSync(path.dirname(CHATGPT_HOST),{recursive:true});fs.writeFileSync(CHATGPT_HOST,JSON.stringify({hostId:id}));return id;
}
function b64url(b){return Buffer.from(b).toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_")}
function randomString(n=48){return b64url(crypto.randomBytes(n))}
function pkceChallenge(verifier){return b64url(crypto.createHash("sha256").update(verifier).digest())}
function formPost(url,params){return new Promise((resolve,reject)=>{
  const u=new URL(url);const body=new URLSearchParams(params).toString();
  const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","content-length":Buffer.byteLength(body)}},res=>{let data="";res.on("data",c=>data+=c);res.on("end",()=>{let j;try{j=JSON.parse(data)}catch{j={raw:data}};if(res.statusCode>=200&&res.statusCode<300)resolve(j);else{const e=new Error(j.error_description||j.error||("OAuth HTTP "+res.statusCode));e.status=res.statusCode;e.body=j;reject(e)}})});req.on("error",reject);req.write(body);req.end();
})}
function apiJson(url,token,body,method="POST"){return new Promise((resolve,reject)=>{
  const u=new URL(url);const payload=body===undefined?null:JSON.stringify(body);const headers={authorization:"Bearer "+token,"content-type":"application/json"};if(payload)headers["content-length"]=Buffer.byteLength(payload);
  const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method,headers},res=>{let data="";res.on("data",c=>data+=c);res.on("end",()=>{let j;try{j=JSON.parse(data)}catch{j={raw:data}};if(res.statusCode>=200&&res.statusCode<300)resolve(j);else{let m=j.error?.message||j.message||(typeof j.error==="string"?j.error:"")||"";if(!m)m=JSON.stringify(j).slice(0,500);const e=new Error("HTTP "+res.statusCode+": "+m);e.status=res.statusCode;e.body=j;reject(e)}})});req.on("error",reject);if(payload)req.write(payload);req.end();
})}
async function chatgptSession(refresh=true){
  let s=jsonReadSecure(CHATGPT_STORE);if(!s)return null;
  if(refresh && s.refresh_token && s.expires_at && Date.now()>s.expires_at-60000){
    try{const t=await formPost(CHATGPT_TOKEN,{grant_type:"refresh_token",client_id:s.client_id,refresh_token:s.refresh_token,resource:CHATGPT_RESOURCE});
      s={...s,...t,expires_at:Date.now()+((t.expires_in||3600)*1000)};jsonSaveSecure(CHATGPT_STORE,s);
    }catch(e){if(e.status===400||e.status===401){try{fs.unlinkSync(CHATGPT_STORE)}catch{};return null}throw e}
  }
  return s;
}
let chatgptLoginBusy=false;
async function chatgptSignIn(){
  if(chatgptLoginBusy)return {ok:false,error:"Sign-in already in progress."};
  chatgptLoginBusy=true;
  let server,loginWin;
  try{
    const old=await chatgptSession(false);const clientId=old?.client_id||"dynamic_agent_client";
    const state= randomString(32), nonce=randomString(32), verifier=randomString(64), challenge=pkceChallenge(verifier);
    const host=hostId();
    server=http.createServer(async(req,res)=>{
      const u=new URL(req.url,"http://127.0.0.1");
      if(u.pathname!=="/auth/callback"){res.writeHead(404);return res.end("Not found");}
      try{
        if(u.searchParams.get("state")!==state)throw new Error("Invalid OAuth state.");
        const code=u.searchParams.get("code");const issuedClient=u.searchParams.get("client_id")||clientId;if(!code)throw new Error(u.searchParams.get("error_description")||u.searchParams.get("error")||"Authorization failed.");
        const t=await formPost(CHATGPT_TOKEN,{grant_type:"authorization_code",client_id:issuedClient,code,code_verifier:verifier,redirect_uri:redirectUri,resource:CHATGPT_RESOURCE});
        if(!t.access_token)throw new Error("OpenAI did not return an access token.");
        const payload=t.id_token?JSON.parse(Buffer.from(t.id_token.split(".")[1],"base64url").toString("utf8")):{};
        jsonSaveSecure(CHATGPT_STORE,{...t,client_id:issuedClient,expires_at:Date.now()+((t.expires_in||3600)*1000),email:payload.email||"",name:payload.name||"",id_token:t.id_token||""});
        res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end("<html><body style='font-family:Segoe UI;text-align:center;padding:60px;background:#07101d;color:white'><h2>✓ TARA connected</h2><p>You can close this window.</p><script>setTimeout(()=>window.close(),900)</script></body></html>");
        setTimeout(()=>{try{loginWin?.close()}catch{};try{server?.close()}catch{}},300);
      }catch(e){res.writeHead(400,{"content-type":"text/html; charset=utf-8"});res.end("<html><body style='font-family:Segoe UI;text-align:center;padding:50px'><h2>Connection failed</h2><p>"+String(e.message||e).replace(/[<>]/g,"")+"</p><p>You can close this window and try again.</p></body></html>");setTimeout(()=>{try{server?.close()}catch{}},3000)}
    });
    await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).on("error",reject));
    const port=server.address().port;const redirectUri=`http://127.0.0.1:${port}/auth/callback`;
    const qs=new URLSearchParams({client_id:clientId,response_type:"code",redirect_uri:redirectUri,scope:CHATGPT_SCOPE,resource:CHATGPT_RESOURCE,state,nonce,code_challenge_method:"S256",code_challenge:challenge,ext_agent_host_id:host});
    if(!old)qs.set("agent_name_hint","TARA AI");
    const authUrl=CHATGPT_AUTH+"?"+qs.toString();
    loginWin=new BrowserWindow({width:520,height:760,resizable:true,show:true,title:"Connect TARA with ChatGPT",backgroundColor:"#07101d",webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
    await loginWin.loadURL(authUrl);
    loginWin.on("closed",()=>{try{server?.close()}catch{}});
    return {ok:true,started:true};
  }catch(e){try{server?.close()}catch{};try{loginWin?.close()}catch{};return {ok:false,error:String(e.message||e)}}
  finally{chatgptLoginBusy=false}
}
async function chatgptStatus(){const s=await chatgptSession(false);return {ok:!!s,connected:!!s,email:s?.email||"",name:s?.name||"",expires_at:s?.expires_at||0}}
async function chatgptDisconnect(){try{fs.unlinkSync(CHATGPT_STORE)}catch{}return {ok:true}}
async function chatgptModels(){
  let s=await chatgptSession(true);if(!s)return {ok:false,error:"Not connected to ChatGPT."};
  try{return {ok:true,models:(await apiJson(CHATGPT_MODELS,s.access_token,undefined,"GET")).data||[]}}
  catch(e){if(e.status===401){s=await chatgptSession(true);if(!s)return {ok:false,error:"ChatGPT session expired. Connect again."};return {ok:true,models:(await apiJson(CHATGPT_MODELS,s.access_token,undefined,"GET")).data||[]}}throw e}
}
function apiSse(url,token,body){return new Promise((resolve,reject)=>{
  const u=new URL(url);const payload=JSON.stringify(body);
  const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json",accept:"text/event-stream","content-length":Buffer.byteLength(payload)}},res=>{
    if(res.statusCode<200||res.statusCode>=300){
      let d="";res.on("data",c=>d+=c);
      res.on("end",()=>{let j;try{j=JSON.parse(d)}catch{j={raw:d}};
        let m=j.error?.message||j.detail||j.message||(typeof j.error==="string"?j.error:"")||JSON.stringify(j).slice(0,500);
        const e=new Error("HTTP "+res.statusCode+": "+(typeof m==="string"?m:JSON.stringify(m)));e.status=res.statusCode;reject(e)});
      return;
    }
    let buf="",items=[],text="",final=null,err=null;
    res.setEncoding("utf8");
    res.on("data",chunk=>{
      buf+=chunk;let i;
      while((i=buf.indexOf("\n"))>=0){
        const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
        if(!line.startsWith("data:"))continue;
        const d=line.slice(5).trim();if(!d||d==="[DONE]")continue;
        let ev;try{ev=JSON.parse(d)}catch{continue}
        if(ev.type==="response.output_text.delta"&&typeof ev.delta==="string")text+=ev.delta;
        else if(ev.type==="response.output_item.done"&&ev.item)items.push(ev.item);
        else if(ev.type==="response.completed"||ev.type==="response.incomplete")final=ev.response||{};
        else if(ev.type==="response.failed")err=ev.response?.error?.message||"Response failed";
        else if(ev.type==="error")err=ev.message||ev.error?.message||JSON.stringify(ev).slice(0,300);
      }
    });
    res.on("end",()=>{
      if(err)return reject(new Error(err));
      const out=(final&&Array.isArray(final.output)&&final.output.length)?final.output:items;
      let t=text;
      if(!t)t=out.filter(x=>x.type==="message").map(x=>(x.content||[]).filter(c=>c.type==="output_text").map(c=>c.text).join("")).join("");
      resolve({...(final||{}),output:out,output_text:t});
    });
    res.on("error",reject);
  });
  req.on("error",reject);req.write(payload);req.end();
})}
async function chatgptResponse(a){
  let s=await chatgptSession(true);if(!s)return {ok:false,error:"Not connected to ChatGPT."};
  const body={model:a.model,input:a.input||[],instructions:a.instructions||"",store:false,stream:true};if(Array.isArray(a.tools)&&a.tools.length){body.tools=a.tools;body.parallel_tool_calls=true}
  if(a.effort&&a.effort!=="default")body.reasoning={effort:a.effort}; // "low" = much faster replies
  const go=async()=>{
    try{return await apiSse(CHATGPT_RESPONSES,s.access_token,body)}
    catch(e){
      // if the server rejects an optional speed setting, retry once without it
      if(e.status===400&&/reasoning|parallel_tool_calls/i.test(String(e.message))){delete body.reasoning;delete body.parallel_tool_calls;return await apiSse(CHATGPT_RESPONSES,s.access_token,body)}
      throw e;
    }
  };
  try{return {ok:true,response:await go()}}
  catch(e){if(e.status===401){s=await chatgptSession(true);if(!s)return {ok:false,error:"ChatGPT session expired. Connect again."};return {ok:true,response:await go()}}throw e}
}

// ================= Gmail (read-only, IMAP + app password) =================
const EMAIL_STORE=path.join(app.getPath("userData"),"email.enc");
let ImapFlow=null,simpleParser=null;
function mailLibs(){
  if(!ImapFlow){try{ImapFlow=require("imapflow").ImapFlow;simpleParser=require("mailparser").simpleParser}catch{return false}}
  return true;
}
async function withImap(fn,cred){
  const c=cred||jsonReadSecure(EMAIL_STORE);
  if(!c)throw new Error("Email is not connected. Open Settings → Email and connect Gmail with an app password.");
  if(!mailLibs())throw new Error("Email packages are missing. In the TARA folder run:  npm install   (then restart TARA)");
  const client=new ImapFlow({host:"imap.gmail.com",port:993,secure:true,auth:{user:c.email,pass:c.password},logger:false});
  client.on("error",()=>{});
  await client.connect();
  try{return await fn(client)}finally{try{await client.logout()}catch{}}
}
const boxName=m=>/^all/i.test(m||"")?"[Gmail]/All Mail":(/^sent/i.test(m||"")?"[Gmail]/Sent Mail":"INBOX");
const addr=a=>(a||[]).map(x=>(x.name?x.name+" ":"")+"<"+(x.address||"")+">").join(", ");
async function emailSetup(a){
  const email=String(a.email||"").trim(),password=String(a.password||"").replace(/\s+/g,"");
  if(!/^[^@\s]+@[^@\s]+$/.test(email)||!password)return {ok:false,error:"Enter the Gmail address and the 16-character app password."};
  try{await withImap(async()=>true,{email,password})}
  catch(e){return {ok:false,error:"Gmail rejected the login. Check: IMAP is enabled in Gmail settings, 2-Step Verification is on, and you used an APP PASSWORD (not your normal password). "+(e.responseText||e.message||"")}}
  jsonSaveSecure(EMAIL_STORE,{email,password});return {ok:true,email};
}
async function emailStatus(){const c=jsonReadSecure(EMAIL_STORE);return {ok:true,connected:!!c,email:c?.email||"",libs:mailLibs()}}
async function emailDisconnect(){try{fs.unlinkSync(EMAIL_STORE)}catch{}return {ok:true}}
async function emailSearch(a){
  return withImap(async client=>{
    const lock=await client.getMailboxLock(boxName(a.mailbox),{readOnly:true});
    try{
      const q=String(a.query||"").trim();
      let uids=await client.search(q?{gmraw:q}:{all:true},{uid:true});
      uids=(uids||[]).slice(-Math.min(+a.limit||15,40));
      const out=[];
      if(uids.length)for await(const m of client.fetch(uids,{uid:true,envelope:true,flags:true,internalDate:true},{uid:true})){
        out.push({uid:m.uid,from:addr(m.envelope.from),subject:m.envelope.subject||"(no subject)",date:new Date(m.internalDate).toISOString().slice(0,16).replace("T"," "),unread:!m.flags.has("\\Seen")});
      }
      out.sort((x,y)=>y.date.localeCompare(x.date));
      return {ok:true,count:out.length,mailbox:boxName(a.mailbox),emails:out};
    }finally{lock.release()}
  });
}
async function emailRead(a){
  return withImap(async client=>{
    const lock=await client.getMailboxLock(boxName(a.mailbox),{readOnly:true});
    try{
      const m=await client.fetchOne(String(a.uid),{source:true},{uid:true});
      if(!m||!m.source)return {ok:false,error:"Email not found."};
      const p=await simpleParser(m.source);
      return {ok:true,from:p.from?.text||"",to:p.to?.text||"",cc:p.cc?.text||"",subject:p.subject||"",date:p.date?p.date.toISOString():"",
        text:String(p.text||"").slice(0,20000),
        attachments:(p.attachments||[]).map(x=>({filename:x.filename||"attachment",size:x.size,type:x.contentType}))};
    }finally{lock.release()}
  });
}
async function emailSaveAttachments(a){
  return withImap(async client=>{
    const lock=await client.getMailboxLock(boxName(a.mailbox),{readOnly:true});
    try{
      const m=await client.fetchOne(String(a.uid),{source:true},{uid:true});
      if(!m||!m.source)return {ok:false,error:"Email not found."};
      const p=await simpleParser(m.source);
      const dir=path.join(app.getPath("downloads"),"TARA-mail");fs.mkdirSync(dir,{recursive:true});
      const saved=[],skipped=[];
      for(const x of p.attachments||[]){
        const name=String(x.filename||"attachment").replace(/[\\/:*?"<>|]/g,"_");
        if(a.filename&&!name.toLowerCase().includes(String(a.filename).toLowerCase()))continue;
        if(BLOCKED.test(name)){skipped.push(name+" (program/script blocked)");continue}
        let dest=path.join(dir,name);if(fs.existsSync(dest))dest=path.join(dir,Date.now()+"_"+name);
        fs.writeFileSync(dest,x.content);saved.push(dest);
      }
      return {ok:true,saved,skipped};
    }finally{lock.release()}
  });
}

// ================= Research (free web search + page reading) =================
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const decEnt=s=>String(s).replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&nbsp;/g," ").replace(/&#(\d+);/g,(m,n)=>String.fromCharCode(+n));
const stripTags=s=>decEnt(String(s).replace(/<[^>]+>/g,"")).replace(/\s+/g," ").trim();
async function researchSearch(a){
  const q=String(a.query||"").trim().slice(0,300);if(!q)return {ok:false,error:"Empty search query."};
  let r;
  try{r=await fetch("https://html.duckduckgo.com/html/",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","user-agent":UA},body:new URLSearchParams({q}),signal:AbortSignal.timeout(20000)})}
  catch(e){return {ok:false,error:"Search failed (no internet?): "+String(e.message||e)}}
  if(!r.ok)return {ok:false,error:"Search failed: HTTP "+r.status};
  const html=await r.text();
  const re=/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,ms=[];let m;
  while((m=re.exec(html)))ms.push({i:m.index,end:re.lastIndex,href:m[1],title:stripTags(m[2])});
  const out=[];
  for(let k=0;k<ms.length&&out.length<(Math.min(+a.limit||8,10));k++){
    let u=decEnt(ms[k].href);
    try{const x=new URL(u.startsWith("//")?"https:"+u:u,"https://duckduckgo.com");if(x.searchParams.get("uddg"))u=x.searchParams.get("uddg");else u=x.href}catch{continue}
    if(!/^https?:\/\//i.test(u)||/duckduckgo\.com\/y\.js/.test(u))continue;
    const seg=html.slice(ms[k].end,k+1<ms.length?ms[k+1].i:ms[k].end+4000);
    const sn=seg.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({title:ms[k].title,url:u,snippet:sn?stripTags(sn[1]).slice(0,300):""});
  }
  if(!out.length)return {ok:false,error:"No results came back (the search service may be rate-limiting). Try again in a moment or rephrase."};
  return {ok:true,query:q,results:out};
}
async function privateHost(host){
  const h=String(host||"").toLowerCase().replace(/^\[|\]$/g,"");
  if(!h||h==="localhost"||h.endsWith(".local")||h.endsWith(".internal"))return true;
  let addrs=[];try{addrs=await require("dns").promises.lookup(h,{all:true})}catch{return true}
  return addrs.some(({address:x})=>/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(x)||/^(::1?$|fc|fd|fe80)/i.test(x));
}
async function researchFetch(a){
  let u=String(a.url||"").trim();
  const off=Math.max(0,+a.offset||0),max=Math.min(+a.maxChars||14000,30000);
  let r=null;
  for(let hop=0;hop<5;hop++){
    let x;try{x=new URL(u)}catch{return {ok:false,error:"Invalid URL."}}
    if(!/^https?:$/.test(x.protocol))return {ok:false,error:"Only http(s) pages can be read."};
    if(await privateHost(x.hostname))return {ok:false,error:"That address is on this PC or a private network, so TARA won't fetch it."};
    try{r=await fetch(u,{redirect:"manual",headers:{"user-agent":UA,accept:"text/html,text/plain,application/json;q=0.9,*/*;q=0.5"},signal:AbortSignal.timeout(25000)})}
    catch(e){return {ok:false,error:"Could not load the page: "+String(e.message||e)}}
    if(r.status>=300&&r.status<400&&r.headers.get("location")){u=new URL(r.headers.get("location"),u).href;r=null;continue}
    break;
  }
  if(!r)return {ok:false,error:"Too many redirects."};
  if(!r.ok)return {ok:false,error:"The page returned HTTP "+r.status+"."};
  const ct=String(r.headers.get("content-type")||"").toLowerCase();
  if(!/text\/|json|xml/.test(ct))return {ok:false,error:"Not a readable text page ("+(ct||"unknown type")+")."};
  let raw=(await r.text()).slice(0,3000000);
  const title=stripTags((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||"");
  let text=raw;
  if(/html/.test(ct)){
    text=raw.replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi," ")
      .replace(/<!--[\s\S]*?-->/g," ").replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi,"\n")
      .replace(/<[^>]+>/g," ");
    text=decEnt(text).replace(/[ \t\f\v]+/g," ").replace(/\n\s*\n+/g,"\n").trim();
  }
  return {ok:true,url:u,title,totalChars:text.length,from:off,text:text.slice(off,off+max),more:off+max<text.length?"call again with offset="+(off+max):""};
}

// ================= Phone link (cloud relay) =================
// TARA only makes OUTBOUND requests to your relay; no ports are opened on this PC.
const RELAY_STORE=path.join(app.getPath("userData"),"relay.enc");
let relayCfg=jsonReadSecure(RELAY_STORE),relayLoopOn=false,relayState=relayCfg?"starting":"off",relayDone=null;
function relayCall(method,p,body,timeout=35000){return new Promise((resolve,reject)=>{
  const c=relayCfg;if(!c)return reject(new Error("Relay not set"));
  let u;try{u=new URL(c.url.replace(/\/+$/,"")+p)}catch{return reject(new Error("Bad relay URL"))}
  const lib=u.protocol==="http:"?http:https,payload=body?JSON.stringify(body):null;
  const headers={"x-tara-token":c.token};if(payload){headers["content-type"]="application/json";headers["content-length"]=Buffer.byteLength(payload)}
  const req=lib.request({hostname:u.hostname,port:u.port||undefined,path:u.pathname+u.search,method,headers,agent:false},res=>{
    let d="";res.on("data",x=>d+=x);
    res.on("end",()=>{if(res.statusCode<200||res.statusCode>=300)return reject(new Error("Relay HTTP "+res.statusCode));try{resolve(JSON.parse(d||"{}"))}catch{reject(new Error("Bad relay reply"))}});
  });
  req.setTimeout(timeout,()=>req.destroy(new Error("Relay timeout")));
  req.on("error",reject);if(payload)req.write(payload);req.end();
})}
const sleepMs=ms=>new Promise(r=>setTimeout(r,ms));
async function relayPost(p,body){ // the relay may be briefly unreachable: retry so a reply is never lost
  let last;for(let i=0;i<5;i++){try{return await relayCall("POST",p,body,20000)}catch(e){last=e;if(/HTTP 404/.test(String(e.message)))break;await sleepMs(1500*(i+1))}}
  throw last;
}
const handledJobs=[];
function handleRelayJob(job){return new Promise(resolve=>{
  if(handledJobs.includes(job.id))return resolve(); // duplicate delivery after a re-queue
  handledJobs.push(job.id);if(handledJobs.length>50)handledJobs.shift();
  const beat=setInterval(()=>{relayCall("POST","/pc/beat/"+job.id,null,15000).catch(()=>{})},15000);
  relayCall("POST","/pc/beat/"+job.id,null,15000).catch(()=>{});
  const win=(mainWin&&!mainWin.isDestroyed())?mainWin:null;
  if(!win){clearInterval(beat);relayPost("/pc/job/"+job.id,{status:"error",reply:"TARA's window is not open on the PC."}).catch(()=>{});return resolve()}
  const to=setTimeout(()=>{clearInterval(beat);relayDone=null;relayPost("/pc/job/"+job.id,{status:"error",reply:"Timed out on the PC."}).catch(()=>{});resolve()},15*60*1000);
  relayDone=()=>{clearTimeout(to);clearInterval(beat);relayDone=null;resolve()};
  win.webContents.send("tara:remote-job",job);
})}
let relayPsb=-1;
async function relayLoop(){
  if(relayLoopOn)return;relayLoopOn=true;
  try{phoneRpc.start()}catch{}   // phone tools (only answers if "Let my phone use TARA's PC tools" is on)
  try{if(relayPsb<0||!powerSaveBlocker.isStarted(relayPsb))relayPsb=powerSaveBlocker.start("prevent-app-suspension")}catch{}
  while(relayCfg){
    try{const r=await relayCall("GET","/pc/next",null,40000);relayState="online";if(r.job)await handleRelayJob(r.job)}
    catch(e){relayState="error: "+String(e.message||e);await sleepMs(1500)}
  }
  relayLoopOn=false;relayState="off";
  try{if(relayPsb>=0&&powerSaveBlocker.isStarted(relayPsb))powerSaveBlocker.stop(relayPsb)}catch{}relayPsb=-1;
}
async function relaySetup(a){
  const url=String(a.url||"").trim(),token=String(a.token||"").trim();
  if(!/^https?:\/\//i.test(url)||token.length<16)return {ok:false,error:"Enter the relay URL (https://…) and the secret token (16+ characters)."};
  const prev=relayCfg;relayCfg={url,token};
  try{await relayCall("GET","/pc/ping",null,60000)}
  catch(e){relayCfg=prev;return {ok:false,error:"Could not reach the relay: "+String(e.message||e)+" (a free Render relay can take ~1 minute to wake up — try again)."}}
  jsonSaveSecure(RELAY_STORE,relayCfg);relayLoop();return {ok:true};
}
// Ask the TARA phone app (through the relay) to place a call / send a text. The phone shows its own
// confirmation card and only acts after the user taps Yes there.
async function relayCmd(a){
  if(!relayCfg)return {ok:false,error:"The phone link (cloud relay) is not set up. Connect it in Settings → Phone link (cloud relay)."};
  let r;
  try{r=await relayCall("POST","/pc/cmd",{kind:a.kind,to:a.to,name:a.name,text:a.text},30000)}
  catch(e){return {ok:false,error:"Could not reach the relay: "+String(e.message||e)+" (a free Render relay can take ~1 minute to wake up)."}}
  if(r.phoneOnline===false)return {ok:false,error:"The TARA phone app isn't open or connected to the relay right now. Open it on the phone and try again."};
  if(!r.id)return {ok:false,error:"The relay did not accept the command."};
  const end=Date.now()+200000;
  while(Date.now()<end&&relayCfg){
    try{const x=await relayCall("GET","/pc/cmd/"+r.id,null,40000);if(x.result)return {ok:true,done:!!x.result.ok,msg:x.result.msg||""}}
    catch(e){if(/HTTP 404/.test(String(e.message)))return {ok:false,error:"The relay lost the command (it may have restarted). Try again."};await sleepMs(2000)}
  }
  return {ok:false,error:"No answer from the phone in time."};
}

async function relayStatus(){return {ok:true,configured:!!relayCfg,url:relayCfg?relayCfg.url:"",state:relayState}}
async function relayDisconnect(){try{fs.unlinkSync(RELAY_STORE)}catch{}relayCfg=null;return {ok:true}}
async function relayJob(a){
  if(!relayCfg||!a.id)return {ok:false};
  await relayPost("/pc/job/"+a.id,{status:a.status,reply:a.reply}).catch(()=>{});
  if(a.status==="done"||a.status==="error"){if(relayDone)relayDone()}
  return {ok:true};
}
async function relayApproval(a){
  if(!relayCfg||!a.id||!a.approval)return {ok:false,approved:false,feedback:"Phone link is not set up."};
  try{await relayPost("/pc/job/"+a.id,{approval:a.approval})}catch(e){return {ok:false,approved:false,feedback:"Could not reach the phone."}}
  const end=Date.now()+15*60*1000;
  while(Date.now()<end&&relayCfg){
    try{const r=await relayCall("GET","/pc/decision/"+a.id,null,40000);if(r.decision)return {ok:true,approved:!!r.decision.ok,feedback:r.decision.feedback||"",choice:r.decision.choice||""}}
    catch{await sleepMs(3000)}
  }
  return {ok:true,approved:false,feedback:"No answer from the phone (timed out)."};
}

// ================= TARA browser (read + operate web portals such as APT 2.0) =================
// A separate window with its own saved login. YOU log in (user id, password, captcha) yourself;
// TARA can then read the page and click/fill/select. It can never type into password fields.
let webWin=null,webDlHooked=false,webStart="";const webDownloads=[];
function getWebWin(){
  if(webWin&&!webWin.isDestroyed())return webWin;
  webWin=new BrowserWindow({width:1250,height:860,title:"TARA browser",backgroundColor:"#ffffff",
    webPreferences:{partition:"persist:tara-web",contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const wc=webWin.webContents;
  try{wc.session.setPermissionRequestHandler((w,p,cb)=>cb(false))}catch{}
  // look like normal Chrome (some portals refuse "Electron" browsers and show a blank page)
  try{const ua=wc.getUserAgent().replace(/\sElectron\/\S+/i,"").replace(/\sTARA\/\S+/i,"").replace(/\stara-?\S*\/\S+/i,"");wc.setUserAgent(ua);wc.session.setUserAgent(ua)}catch{}
  const cgb=()=>wc.navigationHistory?wc.navigationHistory.canGoBack():wc.canGoBack();
  const cgf=()=>wc.navigationHistory?wc.navigationHistory.canGoForward():wc.canGoForward();
  try{const {Menu}=require("electron");webWin.setMenu(Menu.buildFromTemplate([
    {label:"Back",click:()=>{if(cgb())wc.navigationHistory?wc.navigationHistory.goBack():wc.goBack()}},
    {label:"Forward",click:()=>{if(cgf())wc.navigationHistory?wc.navigationHistory.goForward():wc.goForward()}},
    {label:"Reload",accelerator:"F5",click:()=>wc.reload()},
    {label:"Start page",click:()=>{if(webStart)wc.loadURL(webStart).catch(()=>{})}},
    {label:"Close",click:()=>webWin&&webWin.close()}]))}catch{}
  wc.on("did-fail-load",(e,code,desc,url,isMain)=>{
    if(!isMain||code===-3||/^data:/i.test(url||""))return;
    const hint=code===-105?"The web address could not be found. Check that it is typed correctly.":
      [-102,-109,-118,-7,-21,-106,-130].includes(code)?"This PC cannot reach the site. Some government portals work only on the department network (DOP network / VPN) — check that you are connected to it, then press Reload.":
      (code<=-200&&code>-300)?"The site's security certificate was rejected. TARA does not bypass certificate warnings. Open the site once in Chrome to check it, or ask your network administrator.":
      "Press Reload to try again, or check your internet connection.";
    const esc=t=>String(t).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
    const html='<body style="font:16px system-ui,sans-serif;padding:40px;color:#222"><h2>TARA browser could not load this page</h2><p><b>'+esc(url)+'</b></p><p>Reason: '+esc(desc)+' (error '+code+')</p><p>'+esc(hint)+'</p><p style="color:#666">Use Reload or Back in the menu above, then tell TARA to try again.</p></body>';
    wc.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(html)).catch(()=>{});
  });
  wc.setWindowOpenHandler(({url})=>{if(/^https?:\/\//i.test(url))webWin.loadURL(url).catch(()=>{});return {action:"deny"}});
  if(!webDlHooked){
    webDlHooked=true;
    wc.session.on("will-download",(e,item)=>{
      const name=String(item.getFilename()||"download").replace(/[\\/:*?"<>|]/g,"_");
      if(BLOCKED.test(name)){item.cancel();webDownloads.push({name,status:"blocked (program/script)"});return}
      const dir=path.join(app.getPath("downloads"),"TARA-web");fs.mkdirSync(dir,{recursive:true});
      let dest=path.join(dir,name);if(fs.existsSync(dest))dest=path.join(dir,Date.now()+"_"+name);
      item.setSavePath(dest);const rec={name,path:dest,status:"downloading"};webDownloads.push(rec);if(webDownloads.length>30)webDownloads.shift();
      item.once("done",(ev,state)=>{rec.status=state==="completed"?"done":state});
    });
  }
  return webWin;
}
const WEB_READ_JS=`(()=>{
 const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"};
 document.querySelectorAll("[data-tara-id]").forEach(e=>e.removeAttribute("data-tara-id"));
 const sel='a[href],button,input,select,textarea,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=combobox],[role=checkbox],[role=radio],[role=switch],[aria-haspopup],mat-option,mat-select,[onclick],summary';
 let els=[...document.querySelectorAll(sel)].filter(vis);
 const have=new Set(els);
 for(const e of document.querySelectorAll('div,span,li,td,img,mat-card,[class*=card],[class*=tile],[class*=menu]')){
  if(have.has(e)||!vis(e)||els.length>260)continue;
  if(getComputedStyle(e).cursor!=='pointer')continue;
  const t=(e.innerText||e.getAttribute('aria-label')||e.title||'').trim();if(!t||t.length>90)continue;
  if(e.querySelector(sel))continue;
  if(e.parentElement&&have.has(e.parentElement))continue;
  els.push(e);have.add(e);
 }
 els=els.slice(0,200);
 let n=0;
 const items=els.map(e=>{n++;e.setAttribute("data-tara-id",String(n));
  const tag=e.tagName.toLowerCase(),type=(e.getAttribute("type")||"").toLowerCase();
  let label=(e.innerText||e.value||e.getAttribute("aria-label")||e.getAttribute("title")||e.getAttribute("placeholder")||e.getAttribute("name")||e.id||"").toString().replace(/\\s+/g," ").trim().slice(0,80);
  if(tag==="select")label=(e.getAttribute("aria-label")||e.name||e.id||"select")+" ["+[...e.options].slice(0,40).map(o=>o.text.trim()).join(" | ")+"]";
  const o={id:n,tag,type,label};
  if((tag==="input"||tag==="textarea")&&type!=="password"&&type!=="hidden")o.value=String(e.value||"").slice(0,80);
  if(type==="password")o.note="PASSWORD FIELD - the user must type this";
  if(tag==="a")o.href=(e.href||"").slice(0,120);
  if(e.disabled)o.disabled=true;
  return o});
 return {title:document.title,url:location.href,text:(document.body?document.body.innerText:"").replace(/\\n{3,}/g,"\\n\\n").slice(0,7000),elements:items};
})()`;
function webActJs(a){return `((a)=>{
 const e=a.id?document.querySelector('[data-tara-id="'+a.id+'"]'):null;
 if(a.action==="scroll"){window.scrollBy(0,a.amount||600);return {ok:true}}
 if(!e)return {ok:false,error:"Element not found. Call web_read again to get fresh element numbers."};
 const t=(e.getAttribute("type")||"").toLowerCase();
 if(a.action==="click"){e.scrollIntoView({block:"center"});e.click();return {ok:true}}
 if(a.action==="type"){
  if(t==="password")return {ok:false,error:"Refused: passwords must be typed by the user, not TARA."};
  e.focus();const proto=e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,"value").set.call(e,a.text);
  e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return {ok:true}}
 if(a.action==="select"){
  const w=String(a.text||"").toLowerCase().trim();
  const o=[...e.options].find(o=>o.text.trim().toLowerCase()===w)||[...e.options].find(o=>o.text.toLowerCase().includes(w));
  if(!o)return {ok:false,error:"Option not found: "+a.text};
  e.value=o.value;e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return {ok:true,selected:o.text.trim()}}
 if(a.action==="focus"){e.focus();return {ok:true}}
 return {ok:false,error:"Unknown action"};
})(${JSON.stringify(a)})`}
const webAlive=()=>webWin&&!webWin.isDestroyed();

// ---- APT scope guard: on the portal hosts, TARA may only work inside the sections the user allowed ----
const SAFE_CTRL=/^\d+$|\b(next|prev|previous|first|last|view|details?|download|export|excel|pdf|csv|search|go|submit|save|close|back|ok|cancel|reset|clear|filter|refresh|show|apply|add|new|create|raise|reply|comment|attach|upload|status|history|generate|get|fetch|load|select|choose|date|print)\b/i;
const AUTH_PAGE=/log\s?in|sign\s?in|captcha|otp|session|authenticat/i;
function scopeCfg(a){const sc=(a&&a.scope)||{};const lst=v=>(Array.isArray(v)?v:String(v||"").split(/[,\n]/)).map(x=>String(x).trim().toLowerCase()).filter(Boolean);return {hosts:lst(sc.hosts),words:lst(sc.words),gates:lst(sc.gates),start:String(sc.start||"").trim()}}
function hostGoverned(url,sc){let h="";try{h=new URL(url).hostname.toLowerCase()}catch{return true}return sc.hosts.some(x=>h===x||h.endsWith("."+x))}
const hasWord=(t,sc)=>{t=String(t||"").toLowerCase();return sc.words.some(w=>t.includes(w))};
async function pageInfo(){return await webWin.webContents.executeJavaScript(`(()=>({title:document.title,url:location.href,heads:[...document.querySelectorAll("h1,h2,h3,.breadcrumb,[aria-current],.active,.selected")].slice(0,15).map(e=>e.innerText||"").join(" ")}))()`,true)}
let webSticky=false; // true once TARA has entered an allowed section via an allowed menu click
const SAFE_PAGER=/^(\d+|next|prev|previous|first|last|[›»‹«<>]+)$/i;
const SCOPE_MSG=sc=>"Blocked by TARA's APT safety scope: only these APT sections are allowed: "+(sc.words.join(", ")||"(none set)")+". Do not try to open anything else in APT.";
async function webOpen(a){
  const url=String(a.url||"").trim();
  if(!/^https?:\/\//i.test(url))return {ok:false,error:"Only http(s) addresses can be opened."};
  {const sc=scopeCfg(a);let pth="/";try{pth=new URL(url).pathname}catch{}
   const nz=x=>String(x||"").replace(/\/+$/,"").toLowerCase();
   if(hostGoverned(url,sc)&&!(sc.start&&nz(url).startsWith(nz(sc.start)))&&pth.length>1&&!hasWord(url,sc))return {ok:false,error:SCOPE_MSG(sc)+" Open the portal's home/login page and use its menu instead of a direct link."}}
  const w=getWebWin();w.show();w.focus();webStart=url;webSticky=false;
  try{await w.loadURL(url)}catch(e){if(!/ERR_ABORTED/.test(String(e&&e.message||e)))return {ok:false,error:"Could not load the page: "+String(e.message||e)}}
  return {ok:true,title:w.getTitle(),url:w.webContents.getURL()};
}
async function webRead(){
  if(!webAlive())return {ok:false,error:"The TARA browser is not open. Use web_open first."};
  try{return {ok:true,...(await webWin.webContents.executeJavaScript(WEB_READ_JS,true))}}
  catch(e){return {ok:false,error:"Could not read the page: "+String(e.message||e)}}
}
async function webAct(a){
  if(!webAlive())return {ok:false,error:"The TARA browser is not open. Use web_open first."};
  const wc=webWin.webContents;
  const sc=scopeCfg(a);let before=null,matchedNav=false,kwBefore=false,enteredNow=false;
  const where=()=>before?(" [page: "+String(before.title||"").slice(0,60)+" | "+String(before.heads||"").replace(/\s+/g," ").slice(0,100)+"]"):"";
  if(hostGoverned(wc.getURL(),sc)){
    before=await pageInfo().catch(()=>null);
    kwBefore=!!before&&hasWord(before.url+" "+before.title+" "+before.heads,sc);
    const inModule=kwBefore||webSticky;
    const authPage=!!before&&AUTH_PAGE.test(before.url+" "+before.title);
    if(a.action==="click"&&a.id){
      const el=await wc.executeJavaScript(`(()=>{const e=document.querySelector('[data-tara-id="${Number(a.id)||0}"]');if(!e)return null;return {tag:e.tagName.toLowerCase(),role:(e.getAttribute("role")||""),label:((e.innerText||e.value||e.getAttribute("aria-label")||e.title||"")+"").replace(/\\s+/g," ").trim().slice(0,120),href:(e.getAttribute("href")||"")}})()`,true).catch(()=>null);
      if(!el)return {ok:false,error:"Element not found. Call web_read again to get fresh element numbers."};
      const text=el.label+" "+el.href;
      const gate=sc.gates.includes(el.label.trim().toLowerCase());
      matchedNav=hasWord(text,sc)||gate;
      const isNav=el.tag==="a"||/menuitem|link|tab/.test(el.role);
      const sameDoc=!el.href||/^(#|javascript:)/i.test(el.href);
      if(isNav&&!matchedNav&&!(inModule&&(sameDoc||SAFE_PAGER.test(el.label))))return {ok:false,error:SCOPE_MSG(sc)+" (\""+el.label+"\" is not in an allowed section)"+where()};
      if(!isNav&&!matchedNav&&!authPage){
        const formCtl=/^(input|select|textarea|mat-option|mat-select)$/.test(el.tag)||/option|combobox|checkbox|radio|switch/.test(el.role);
        if(!inModule)return {ok:false,error:SCOPE_MSG(sc)+" (\""+el.label+"\"). Open the allowed section first: "+(sc.gates.length?"menu \""+sc.gates[0]+"\" then ":"")+"the Pickup Management / Track & Trace / Support Desk card."+where()};
        if(!formCtl&&!SAFE_CTRL.test(el.label)&&!SAFE_PAGER.test(el.label))return {ok:false,error:SCOPE_MSG(sc)+" (\""+el.label+"\" is not a recognised control inside the allowed section)"+where()};
      }
      if(hasWord(text,sc))enteredNow=true;
    }else if((a.action==="type"||a.action==="select")&&!inModule&&!authPage){
      return {ok:false,error:SCOPE_MSG(sc)+" You are not inside an allowed section."+where()};
    }
    if(a.action==="press"&&!inModule&&!authPage)return {ok:false,error:SCOPE_MSG(sc)+" You are not inside an allowed section."+where()};
  }
  if(a.action==="press"){
    const key=String(a.key||"Enter");if(!["Enter","Tab","Escape","ArrowDown","ArrowUp"].includes(key))return {ok:false,error:"Unsupported key"};
    if(a.id)await wc.executeJavaScript(webActJs({action:"focus",id:a.id}),true).catch(()=>{});
    wc.sendInputEvent({type:"keyDown",keyCode:key});if(key==="Enter")wc.sendInputEvent({type:"char",keyCode:"\r"});wc.sendInputEvent({type:"keyUp",keyCode:key});
  }else{
    const r=await wc.executeJavaScript(webActJs(a),true).catch(e=>({ok:false,error:String(e.message||e)}));
    if(!r||r.ok===false)return r||{ok:false,error:"Action failed"};
  }
  await sleepMs(a.action==="click"?2200:1200); // let the page react / navigate (single-page apps need a moment)
  if(webWin.isDestroyed())return {ok:true,title:"",url:""};
  if(enteredNow)webSticky=true;
  if(before&&kwBefore&&hostGoverned(wc.getURL(),sc)&&wc.getURL()!==before.url&&!matchedNav){
    const now=await pageInfo().catch(()=>null);
    if(now&&!hasWord(now.url+" "+now.title+" "+now.heads,sc)&&!AUTH_PAGE.test(now.url+" "+now.title)){
      try{if(wc.navigationHistory&&wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();else if(wc.canGoBack())wc.goBack()}catch{}
      await sleepMs(1200);
      return {ok:false,error:SCOPE_MSG(sc)+" The page left the allowed sections, so TARA went back."};
    }
  }
  return {ok:true,title:webWin.getTitle(),url:wc.getURL()};
}
async function webDownloadsList(){return {ok:true,files:webDownloads.slice(-15)}}
async function webClose(){if(webAlive())webWin.close();webWin=null;return {ok:true}}

// never launch programs through TARA
const BLOCKED=/\.(exe|bat|cmd|com|msi|ps1|psm1|vbs|vbe|js|jse|wsf|jar|scr|lnk|reg|hta|cpl|dll)$/i;

// ================= Office documents, e-mail sending, tray/notifications, voice =================
const office=require("./tara-office");
const DOCS_DIR=()=>path.join(app.getPath("downloads"),"TARA-docs");
async function htmlToPdf(html,dest){
  if(html.length>1500000)throw new Error("The document is too large to turn into a PDF in one go.");
  const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,javascript:false}});
  try{
    await w.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(html));
    const pdf=await w.webContents.printToPDF({pageSize:"A4",printBackground:true,preferCSSPageSize:true});
    fs.writeFileSync(dest,pdf);
  }finally{try{w.destroy()}catch{}}
}
async function makeDocument(a){
  const kind=String(a.kind||"").toLowerCase(),ext={word:".docx",excel:".xlsx",pdf:".pdf"}[kind];
  if(!ext)return {ok:false,error:"kind must be word, excel or pdf."};
  if(!a.spec||typeof a.spec!=="object")return {ok:false,error:"Missing document content."};
  fs.mkdirSync(DOCS_DIR(),{recursive:true});
  const dest=office.uniquePath(fs,DOCS_DIR(),office.safeName(a.filename,ext));
  if(kind==="word")fs.writeFileSync(dest,office.buildDocx(a.spec));
  else if(kind==="excel")fs.writeFileSync(dest,office.buildXlsx(a.spec));
  else await htmlToPdf(office.buildHtml(a.spec),dest);
  return {ok:true,path:dest};
}
async function editDocument(a){
  const kind=String(a.kind||"").toLowerCase(),src=String(a.path||"");
  if(!src||!files.allowed(src,a.roots))return {ok:false,error:"That file is outside the allowed area."};
  const ext=path.extname(src).toLowerCase();
  if(kind==="word"&&ext!==".docx")return {ok:false,error:"Only .docx files can be edited (old .doc files must be saved as .docx first)."};
  if(kind==="excel"&&ext!==".xlsx")return {ok:false,error:"Only .xlsx files can be edited (.xls/.xlsm must be saved as .xlsx first)."};
  if(kind!=="word"&&kind!=="excel")return {ok:false,error:"kind must be word or excel."};
  if(fs.statSync(src).size>30*1024*1024)return {ok:false,error:"That file is too large to edit (over 30 MB)."};
  const buf=fs.readFileSync(src);
  const r=kind==="word"?office.editDocx(buf,a.edits):office.editXlsx(buf,a.edits);
  if(!r.changes)return {ok:false,error:"Nothing was changed: the text to find was not in the document."};
  fs.mkdirSync(DOCS_DIR(),{recursive:true});
  const dest=office.uniquePath(fs,DOCS_DIR(),path.basename(src,ext)+" (TARA edited)"+ext);
  fs.writeFileSync(dest,r.buffer);
  return {ok:true,path:dest,changes:r.changes,original:src,note:"The original file was not touched."};
}
// ---- send e-mail (only ever called after the user approved the exact message on screen) ----
let mailSent=[];
async function emailSend(a){
  const c=jsonReadSecure(EMAIL_STORE);
  if(!c)return {ok:false,error:"Email is not connected. Open Settings → Email and connect Gmail with an app password."};
  const now=Date.now();mailSent=mailSent.filter(t=>now-t<3600000);
  if(mailSent.length>=20)return {ok:false,error:"Safety limit: TARA sends at most 20 e-mails per hour."};
  let mail;try{mail=office.composeMail(a,c.email)}catch(e){return {ok:false,error:e.message}}
  const att=[];let total=0;
  for(const p of (Array.isArray(a.attachments)?a.attachments:[]).slice(0,5)){
    if(!files.allowed(p,a.roots))return {ok:false,error:"Attachment is outside the allowed area: "+p};
    if(BLOCKED.test(p)||/\.(env|pem|key|pfx|kdbx)$/i.test(p))return {ok:false,error:"For safety TARA won't attach programs, scripts or key files: "+path.basename(p)};
    let st;try{st=fs.statSync(p)}catch{return {ok:false,error:"Attachment not found: "+p}}
    total+=st.size;if(total>20*1024*1024)return {ok:false,error:"Attachments are over 20 MB in total."};
    att.push({filename:path.basename(p),path:p});
  }
  if(att.length)mail.attachments=att;
  if(a.replyToUid){
    try{const mid=await withImap(async client=>{const lock=await client.getMailboxLock(boxName(a.mailbox),{readOnly:true});try{const m=await client.fetchOne(String(a.replyToUid),{envelope:true},{uid:true});return m&&m.envelope&&m.envelope.messageId||""}finally{lock.release()}});
      if(mid){mail.inReplyTo=mid;mail.references=mid}}catch{}
  }
  let nm;try{nm=require("nodemailer")}catch{return {ok:false,error:"The nodemailer package is missing. In the TARA folder run:  npm install   (then restart TARA)"}}
  const tr=nm.createTransport({host:"smtp.gmail.com",port:465,secure:true,auth:{user:c.email,pass:c.password}});
  try{const info=await tr.sendMail(mail);mailSent.push(now);return {ok:true,to:mail.to,cc:mail.cc||"",messageId:info.messageId}}
  catch(e){return {ok:false,error:"Gmail could not send the e-mail: "+String(e.response||e.message||e)+" (check that the app password is still valid in Settings → Email)"}}
}
// ---- preferences, tray, notifications, hotkey ----
const PREFS_FILE=path.join(app.getPath("userData"),"prefs.json");
function readPrefs(){let p={};try{p=JSON.parse(fs.readFileSync(PREFS_FILE,"utf8"))}catch{}return {keepRunning:p.keepRunning!==false,autostart:!!p.autostart,hotkey:String(p.hotkey||"Control+Alt+T"),phoneTools:!!p.phoneTools}}
let mainWin=null,tray=null,quitting=false,hotkeyOk=false;
const TRAY_ICON="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABwElEQVR42u2bLXLDMBCFw0rLglpsahhqqGN0fAVR00Cfw9RX8ClKDH0GMXc9I9RJbK20+onzNPNIMsnofVqtLWl1uaChJWsfn18VSZFakiZ1Vtp+tn1XnclwQ7qTJpIhrY4y9jfbb5tXM12TetLCMHykxf5nXfpoj4Kmn2ksKirsvB4SGP+vIXu+sMlrzSydw/g1UbhzpsU1lfkbaeZ28vtnZckDwtanW2zzivM445oWgLH1TcU0n9R4AAgVI+xNLuMeIIzYdLAJby7FPAPCLJIYj7J9auNMEGPU53xu844QdMgbXvHmHSFUPgCGEwEYfBY2L2PeEUIjkvhCOtj8uikShNHVfC09+q7GJUAcREHtAqAvwXwkCL0LgEUCQKjxEBB7O0veyS/1yIdGglcytJuQxY2+cBTc9wBMoQBimedC2AEw7QEwpY6+YBQY9quvtPlnLWEUVKwND0kARy0RAPUIQBsbgGtLAKBlLX1PCEA/AtC9EYAOADAFkATxGMSLEF6FsRjCchgbItgSw6YotsVxMIKjMRyO4ngcBRIokUGRFMrkUCiJUlkUS6NcHhcmcGUGl6ZwbQ4XJ3F1Fu192h/u6iVqq9NPtwAAAABJRU5ErkJggg==";
function showMain(){
  if(!mainWin||mainWin.isDestroyed()){createWindow();return}
  if(mainWin.isMinimized())mainWin.restore();
  mainWin.show();mainWin.focus();
}
function applyPrefs(){
  const p=readPrefs();
  try{app.setLoginItemSettings({openAtLogin:!!p.autostart,path:process.execPath,args:app.isPackaged?["--hidden"]:[app.getAppPath(),"--hidden"]})}catch{}
  try{globalShortcut.unregisterAll();hotkeyOk=!!p.hotkey&&globalShortcut.register(p.hotkey,()=>{showMain();if(mainWin&&!mainWin.isDestroyed())mainWin.webContents.send("tara:hotkey")})}catch{hotkeyOk=false}
  if(p.keepRunning&&!tray){
    try{tray=new Tray(nativeImage.createFromDataURL(TRAY_ICON));tray.setToolTip("TARA");
      tray.setContextMenu(Menu.buildFromTemplate([{label:"Open TARA",click:showMain},{label:"Talk to TARA ("+p.hotkey+")",click:()=>{showMain();if(mainWin&&!mainWin.isDestroyed())mainWin.webContents.send("tara:hotkey")}},{type:"separator"},{label:"Quit TARA",click:()=>{quitting=true;app.quit()}}]));
      tray.on("click",showMain);
    }catch{tray=null}
  }else if(!p.keepRunning&&tray){try{tray.destroy()}catch{}tray=null}
}
async function getPrefs(){return {ok:true,...readPrefs(),hotkeyOk}}
async function setPrefs(a){
  const p={...readPrefs()};
  if(a.keepRunning!==undefined)p.keepRunning=!!a.keepRunning;
  if(a.autostart!==undefined)p.autostart=!!a.autostart;
  if(a.phoneTools!==undefined)p.phoneTools=!!a.phoneTools;
  if(a.hotkey!==undefined&&/^[A-Za-z0-9+]{1,40}$/.test(String(a.hotkey)))p.hotkey=String(a.hotkey);
  fs.mkdirSync(path.dirname(PREFS_FILE),{recursive:true});fs.writeFileSync(PREFS_FILE,JSON.stringify(p));
  applyPrefs();return {ok:true,...readPrefs(),hotkeyOk};
}
async function notify(a){
  try{const n=new Notification({title:String(a.title||"TARA").slice(0,80),body:String(a.body||"").slice(0,300),silent:false});n.on("click",showMain);n.show();return {ok:true}}
  catch(e){return {ok:false,error:String(e.message||e)}}
}
async function showWindow(){showMain();return {ok:true}}
// ---- speech to text (Google Gemini; free API key from aistudio.google.com/apikey) ----
function postJson(url,headers,body,timeout=45000){return new Promise((resolve,reject)=>{
  const u=new URL(url),payload=JSON.stringify(body);
  const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:"POST",agent:false,headers:{...headers,"content-type":"application/json","content-length":Buffer.byteLength(payload)}},res=>{
    let d="";res.on("data",x=>d+=x);res.on("end",()=>{let j;try{j=JSON.parse(d)}catch{j={raw:d}}
      if(res.statusCode>=200&&res.statusCode<300)resolve(j);else{const e=new Error("HTTP "+res.statusCode+": "+(j.error&&j.error.message||String(d).slice(0,300)));e.status=res.statusCode;reject(e)}})});
  req.setTimeout(timeout,()=>req.destroy(new Error("Speech service timed out")));req.on("error",reject);req.write(payload);req.end();
})}
async function transcribe(a){
  const key=String(a.key||"").trim(),audio=String(a.audio||"");
  if(!key)return {ok:false,error:"no_key"};
  if(!audio||audio.length>14000000)return {ok:false,error:"No audio (or too long)."};
  const body={contents:[{parts:[{text:"Transcribe the speech in this audio exactly as spoken. The language may be English, Telugu or Hindi, often mixed with English office words (DC, SPM, DPR, APT, BYOD, SSPOs, G2). Write Telugu in Telugu script and Hindi in Devanagari. Output ONLY the transcript: no quotes, no labels, no commentary. If there is no clear human speech, output nothing."},{inline_data:{mime_type:"audio/wav",data:audio}}]}],generationConfig:{temperature:0}};
  let last;
  for(const m of ["gemini-flash-latest","gemini-2.5-flash","gemini-2.0-flash"]){
    try{
      const j=await postJson("https://generativelanguage.googleapis.com/v1beta/models/"+m+":generateContent",{"x-goog-api-key":key},body);
      const t=(((j.candidates||[])[0]||{}).content||{}).parts;
      return {ok:true,text:String((t||[]).map(p=>p.text||"").join("")).trim()};
    }catch(e){last=e;if(e.status===404||e.status===503)continue;break}
  }
  return {ok:false,error:(last&&last.status===400&&/API key/i.test(last.message))||(last&&last.status===403)?"bad_key":String(last&&last.message||last)};
}

const handlers={
  ping:()=>({ok:true,tara:3,version:app.getVersion()}),
  searchFiles:a=>files.search(a),
  readFile:a=>files.readFile(a),
  writeFile:async a=>{
    if(!a.path||!files.allowed(a.path,a.roots))return {ok:false,error:"Path is outside the approved folders."};
    if(BLOCKED.test(a.path))return {ok:false,error:"For safety TARA won't write programs or scripts that can run."};
    if(/\.(env|pem|key|pfx|kdbx)$/i.test(a.path))return {ok:false,error:"TARA won't write credential/key files."};
    const content=String(a.content??"");
    if(content.length>2000000)return {ok:false,error:"Content too large."};
    fs.mkdirSync(path.dirname(a.path),{recursive:true});
    if(a.append){fs.appendFileSync(a.path,content,"utf8");return {ok:true,path:a.path}}
    if(fs.existsSync(a.path)){try{fs.copyFileSync(a.path,a.path+".bak")}catch{}}
    fs.writeFileSync(a.path,content,"utf8");return {ok:true,path:a.path};
  },
  listDir:a=>files.listDir(a),
  openPath:async a=>{
    let target;
    if(a.special){
      const k=SPECIAL[a.special];if(!k)return {ok:false,error:"Unknown folder"};
      target=app.getPath(k);
    }else{
      if(!a.path||!files.allowed(a.path,a.roots))return {ok:false,error:"Path is outside the approved folders."};
      if(BLOCKED.test(a.path))return {ok:false,error:"For safety TARA won't launch programs or scripts."};
      target=a.path;
    }
    const err=await shell.openPath(target);
    return err?{ok:false,error:err}:{ok:true};
  },
  openUrl:async a=>{
    if(!/^https?:\/\//i.test(a.url||""))return {ok:false,error:"Only http(s) links can be opened."};
    await shell.openExternal(a.url);return {ok:true};
  },
  minimize:(a,win)=>{win&&win.minimize();return {ok:true}},
  emailSetup,emailStatus,emailDisconnect,emailSearch,emailRead,emailSaveAttachments,emailSend,
  makeDocument,editDocument,getPrefs,setPrefs,notify,showWindow,transcribe,
  relaySetup,relayStatus,relayDisconnect,relayJob,relayApproval,relayCmd,
  researchSearch,researchFetch,
  webOpen,webRead,webAct,webDownloads:webDownloadsList,webClose,
  chatgptSignIn,
  chatgptStatus,
  chatgptDisconnect,
  chatgptModels,
  chatgptResponse
};

// ---- phone tools: the TARA phone app can use this PC's tools through the relay (off unless enabled in Settings) ----
const phoneRpc=require("./tara-phone-rpc").create({
  relayCall:(m,p,b,t)=>relayCall(m,p,b,t),
  relayOn:()=>!!relayCfg,
  enabled:()=>!!readPrefs().phoneTools,
  handlers,
  // folders come from the PC's own TARA settings (what you approved there), never from the phone
  getRoots:async()=>{const w=mainWin;if(!w||w.isDestroyed())return null;
    const s=await w.webContents.executeJavaScript('JSON.stringify({read:effRoots(),write:(typeof writeRoots==="function"?writeRoots():effRoots())})');return JSON.parse(s)},
  getScope:async()=>{const w=mainWin;if(!w||w.isDestroyed())return null;return JSON.parse(await w.webContents.executeJavaScript("JSON.stringify(aptScope())"))},
  confirm:(title,detail)=>Promise.race([
    dialog.showMessageBox({type:"question",buttons:["Allow","Deny"],defaultId:1,cancelId:1,noLink:true,title:"TARA — request from your phone",message:String(title).slice(0,300),detail:String(detail||"").slice(0,1200)}).then(r=>r.response===0),
    new Promise(res=>setTimeout(()=>res(false),90000))])
});

ipcMain.handle("tara:invoke",async(e,action,args)=>{
  const h=handlers[action];
  if(!h)return {ok:false,error:"Unknown action: "+action};
  try{return await h(args||{},BrowserWindow.fromWebContents(e.sender))}
  catch(err){return {ok:false,error:String(err&&err.message||err)}}
});

function createWindow(){
  const hidden=process.argv.includes("--hidden")&&!mainWin&&readPrefs().keepRunning;
  const win=new BrowserWindow({
    width:1480,height:900,minWidth:900,minHeight:600,backgroundColor:"#070b14",show:!hidden,
    title:"TARA — Personal AI Assistant",icon:nativeImage.createFromDataURL(TRAY_ICON),
    webPreferences:{preload:path.join(__dirname,"preload.js"),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}
  });
  mainWin=win;
  win.loadFile(path.join(__dirname,"TARA.html"));
  win.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//i.test(url))shell.openExternal(url);return {action:"deny"}});
  // closing the window keeps TARA running in the tray (reminders, phone link, voice hotkey keep working)
  win.on("close",e=>{if(!quitting&&readPrefs().keepRunning){e.preventDefault();win.hide()}});
  win.on("closed",()=>{if(mainWin===win)mainWin=null});
}
if(!app.requestSingleInstanceLock()){app.quit()}
else{
  app.on("second-instance",()=>showMain());
  app.on("before-quit",()=>{quitting=true});
  app.on("will-quit",()=>{try{globalShortcut.unregisterAll()}catch{}});
  app.whenReady().then(()=>{
    try{session.defaultSession.setPermissionRequestHandler((wc,perm,cb)=>cb(!["geolocation","midi","midiSysex","hid","usb","serial","bluetooth"].includes(perm)))}catch{}
    createWindow();applyPrefs();if(relayCfg)relayLoop();
    app.on("activate",()=>showMain());
  });
  app.on("window-all-closed",()=>{if(process.platform!=="darwin"&&!readPrefs().keepRunning)app.quit()});
}

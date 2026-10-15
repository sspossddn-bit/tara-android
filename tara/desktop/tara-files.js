"use strict";
/* TARA file engine — search, read and list files. READ-ONLY (it never writes or deletes anything).
   Reads: txt/csv/md/json/xml/html/log, Excel (xlsx/xls/xlsm/xlsb), Word (.docx), PDF (text PDFs).
   Optional packages:  npm install xlsx mammoth pdf-parse
   Roots: a list of approved folders, or ["*"] for FULL PC ACCESS (all drives, read-only). */
const fs=require("fs"),path=require("path"),os=require("os");
let XLSX=null,mammoth=null,pdfParse=null;
try{XLSX=require("xlsx")}catch{}
try{mammoth=require("mammoth")}catch{}
try{pdfParse=require("pdf-parse/lib/pdf-parse.js")}catch{}

const TEXT_EXT=new Set([".txt",".csv",".tsv",".md",".json",".xml",".html",".htm",".log",".ini",".yaml",".yml",".sql",".js",".py"]);
const SHEET_EXT=new Set([".xlsx",".xlsm",".xlsb",".xls"]);
const SEARCHABLE=new Set([...TEXT_EXT,...SHEET_EXT,".docx",".pdf"]);
const MAX_DEPTH=12,win=process.platform==="win32";

/* ---- things TARA must never touch, even with full access ---- */
const SKIP_DIRS=new Set(["node_modules",".git","$recycle.bin","system volume information","appdata","__pycache__"]);
const SYSTEM_TOP=new Set(["windows","program files","program files (x86)","programdata","recovery","perflogs","msocache","boot","$windows.~bt","$windows.~ws","config.msi","intel","amd"]);
const SYSTEM_PATH=/^[a-z]:[\\/](windows|program files( \(x86\))?|programdata|\$recycle\.bin|system volume information)([\\/]|$)/i;
const SENSITIVE_DIR=/(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.azure|appdata)([\\/]|$)/i;
const SENSITIVE_FILE=/(^|[\\/])(id_rsa|id_ed25519|id_ecdsa|\.git-credentials|\.npmrc|\.netrc)[^\\/]*$|(^|[\\/])\.env[^\\/]*$|\.(kdbx|kdb|pem|key|pfx|p12|ppk|keystore|jks)$/i;
const isSensitive=p=>SENSITIVE_DIR.test(String(p))||SENSITIVE_FILE.test(String(p));

const lc=p=>win?String(p).toLowerCase():String(p);
function realish(p){try{return fs.realpathSync(p)}catch{return path.resolve(p)}}
function inside(p,root){
  if(!p||!root)return false;
  const rel=path.relative(lc(realish(root)),lc(realish(p)));
  return rel===""||(!rel.startsWith("..")&&!path.isAbsolute(rel));
}
function allowed(p,roots){
  if(!p)return false;
  const abs=path.resolve(String(p));
  if(isSensitive(abs)||SYSTEM_PATH.test(abs)&&(roots||[]).includes("*"))return false;
  if(isSensitive(realish(abs)))return false;
  roots=clean(roots);
  if(roots.includes("*"))return path.isAbsolute(abs);
  return roots.some(r=>inside(abs,r));
}
function clean(roots){return (roots||[]).map(r=>String(r||"").trim().replace(/^["']+|["']+$/g,"").trim()).filter(Boolean)}
function effectiveRoots(roots){
  roots=clean(roots);
  if(roots.includes("*")){
    const out=[os.homedir()];
    if(win)for(const l of "CDEFGHIJKLMNOPQRSTUVWXYZ"){const d=l+":\\";try{if(fs.existsSync(d))out.push(d)}catch{}}
    return out.filter(r=>fs.existsSync(r));
  }
  return roots.filter(r=>fs.existsSync(r));
}
function terms(q){return [...new Set((String(q||"").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu)||[]).filter(x=>x.length>1))]}

/* ---- file walking (with a short-lived index so repeated searches are fast) ---- */
function walk(roots,deadline,max){
  const files=[],rootSet=new Set(roots.map(r=>lc(path.resolve(r))));let partial=false;
  const stack=roots.slice().reverse().map(r=>[r,0,r]);
  while(stack.length){
    if(files.length>=max||Date.now()>deadline){partial=true;break}
    const [dir,depth,root]=stack.pop();let ents;
    try{ents=fs.readdirSync(dir,{withFileTypes:true})}catch{continue}
    const atDriveTop=win&&/^[a-z]:\\?$/i.test(dir);
    for(const e of ents){
      const p=path.join(dir,e.name),nm=e.name.toLowerCase();
      if(e.isDirectory()){
        if(depth>=MAX_DEPTH||nm.startsWith(".")||SKIP_DIRS.has(nm))continue;
        if(atDriveTop&&SYSTEM_TOP.has(nm))continue;
        const lp=lc(path.resolve(p));if(rootSet.has(lp)&&lp!==lc(path.resolve(root)))continue; // walked as its own root
        stack.push([p,depth+1,root]);
      }else if(e.isFile()){
        if(nm.startsWith("~$")||isSensitive(p))continue;
        let st;try{st=fs.statSync(p)}catch{continue}
        files.push({path:p,name:e.name,size:st.size,mtimeMs:st.mtimeMs,rel:path.relative(root,p)});
      }
    }
  }
  return {files,partial};
}
let idx=null;
function getIndex(scope,all){
  const key=scope.map(lc).join("|");
  if(idx&&idx.key===key&&Date.now()-idx.time<600000)return idx;
  const r=walk(scope,Date.now()+(all?25000:10000),all?600000:100000);
  return (idx={key,time:Date.now(),files:r.files,partial:r.partial});
}

async function extractText(f,max=400000){
  const ext=path.extname(f.name).toLowerCase();
  try{
    if(TEXT_EXT.has(ext)){if(f.size>8e6)return "";return fs.readFileSync(f.path,"utf8").slice(0,max)}
    if(SHEET_EXT.has(ext)&&XLSX){
      if(f.size>30e6)return "";
      const wb=XLSX.readFile(f.path,{cellDates:true});let out="";
      for(const n of wb.SheetNames){out+="## Sheet: "+n+"\n"+XLSX.utils.sheet_to_csv(wb.Sheets[n],{blankrows:false})+"\n";if(out.length>max)break}
      return out.slice(0,max);
    }
    if(ext===".docx"&&mammoth){return ((await mammoth.extractRawText({path:f.path})).value||"").slice(0,max)}
    if(ext===".pdf"&&pdfParse){if(f.size>30e6)return "";return ((await pdfParse(fs.readFileSync(f.path))).text||"").slice(0,max)}
  }catch{}
  return "";
}
function snippets(text,t){
  const hits=[],lines=text.split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const ll=lines[i].toLowerCase();let n=0;for(const x of t)if(ll.includes(x))n++;
    if(n)hits.push({n,i,l:lines[i].trim().slice(0,250)});
  }
  hits.sort((a,b)=>b.n-a.n||a.i-b.i);
  return hits.slice(0,25).sort((a,b)=>a.i-b.i).map(x=>x.l);
}
const brief=(f,snips,text)=>({path:f.path,name:f.name,size:f.size,modified:new Date(f.mtimeMs).toISOString(),snippets:snips,preview:(text||"").slice(0,1500)});

async function search(o){
  const all=(o.roots||[]).includes("*");
  const roots=effectiveRoots(o.roots);
  if(!roots.length)return {ok:false,error:"None of the approved folders exist on this PC (checked: "+(clean(o.roots).join(" | ")||"no folders set")+"). Fix the paths in the My PC tab, or turn on Full PC access in Settings."};
  let scope=roots;
  if(o.folder){
    const f=path.resolve(o.folder);
    if(!fs.existsSync(f))return {ok:false,error:"Folder not found: "+o.folder};
    if(!allowed(f,o.roots))return {ok:false,error:"That folder is outside the allowed area."};
    scope=[f];
  }
  const t=(o.terms&&o.terms.length?o.terms:terms(o.query)).map(x=>String(x).toLowerCase());
  const limit=Math.min(o.limit||8,15),index=getIndex(scope,all&&!o.folder),files=index.files,cache=new Map();
  const getText=async f=>{if(!cache.has(f.path))cache.set(f.path,await extractText(f));return cache.get(f.path)};
  const note=index.partial?" (very large drive: the file index may be incomplete — add a more specific folder to be sure)":"";

  if(!t.length){ // "latest files" with no keywords
    const top=files.slice().sort((a,b)=>b.mtimeMs-a.mtimeMs).slice(0,limit);
    return {ok:true,scanned:files.length,partial:index.partial,message:note||undefined,results:top.map(f=>brief(f,[],""))};
  }
  for(const f of files){ // 1) filename / folder-name matches
    const nl=f.name.toLowerCase(),dl=path.dirname(f.rel).toLowerCase();
    const nm=t.filter(x=>nl.includes(x)).length,dm=t.filter(x=>dl.includes(x)).length,all=t.filter(x=>nl.includes(x)||dl.includes(x)).length;
    f.score=nm*10+dm*3+(t.length>1&&all===t.length?40:0); // big bonus when EVERY keyword is found in the name/folder
  }
  const cands=files.filter(f=>f.score>0).sort((a,b)=>b.score-a.score||b.mtimeMs-a.mtimeMs).slice(0,15);
  if(cands.length<3){ // 2) content scan of recent documents if filenames didn't give enough
    const start=Date.now(),seen=new Set(cands.map(f=>f.path)),need=Math.max(1,Math.ceil(t.length/2));
    const pool=files.filter(f=>!seen.has(f.path)&&SEARCHABLE.has(path.extname(f.name).toLowerCase())&&f.size<20e6)
      .sort((a,b)=>b.mtimeMs-a.mtimeMs).slice(0,400);
    for(const f of pool){
      if(Date.now()-start>(o.budgetMs||5000))break;
      const txt=(await getText(f)).toLowerCase();if(!txt)continue;
      if(t.filter(x=>txt.includes(x)).length>=need){f.score=0;cands.push(f)}
    }
  }
  const results=[]; // 3) rank by content too, pull the matching lines
  for(const f of cands){
    const text=await getText(f),cs=t.filter(x=>text.toLowerCase().includes(x)).length;
    results.push({f,rank:f.score+cs*3,out:brief(f,text?snippets(text,t):[],text)});
  }
  results.sort((a,b)=>b.rank-a.rank||b.f.mtimeMs-a.f.mtimeMs); // relevance first; "latest" only breaks ties
  return {ok:true,scanned:files.length,partial:index.partial,
    message:results.length?(note||undefined):"No file names or contents matched ("+files.length+" files scanned)."+note,
    results:results.slice(0,limit).map(x=>x.out)};
}
async function readFile(o){
  if(!o.path||!allowed(o.path,o.roots))return {ok:false,error:"That path is outside the allowed area (or is a protected system/credential file)."};
  let st;try{st=fs.statSync(o.path)}catch{return {ok:false,error:"File not found."}}
  if(!st.isFile())return {ok:false,error:"Not a file."};
  const text=await extractText({path:o.path,name:path.basename(o.path),size:st.size},o.maxChars||400000);
  return text?{ok:true,content:text}:{ok:false,error:"No readable text (unsupported type, empty, or a scanned PDF/image)."};
}
async function listDir(o){
  if(!o.path||!allowed(o.path,o.roots))return {ok:false,error:"That path is outside the allowed area."};
  try{
    const entries=fs.readdirSync(o.path,{withFileTypes:true}).filter(e=>!isSensitive(path.join(o.path,e.name))).slice(0,300).map(e=>{
      let st=null;try{st=fs.statSync(path.join(o.path,e.name))}catch{}
      return {name:e.name,type:e.isDirectory()?"folder":"file",size:st?.size,modified:st?new Date(st.mtimeMs).toISOString():undefined};
    });
    return {ok:true,entries};
  }catch(e){return {ok:false,error:e.message}}
}
module.exports={search,readFile,listDir,inside,allowed,terms,isSensitive};

// Builds android/app/src/main/assets/tara-full.html = desktop/TARA.html + the phone bridge, voice and layout.
const fs=require("fs"),path=require("path"),root=path.join(__dirname,"..");
const rd=f=>fs.readFileSync(path.join(root,f),"utf8");
let h=rd("desktop/TARA.html");
const rep=(a,b)=>{if(!h.includes(a))throw new Error("anchor not found: "+a.slice(0,60));h=h.replace(a,()=>b)};
rep("<head>","<head>\n<script>"+rd("mobile/tara-mobile-pre.js")+"</script>");
if(!/name="viewport"/.test(h))rep("<head>",'<head>\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
rep("</head>","<style>"+rd("mobile/mobile.css")+"</style>\n</head>");
// the phone may use any provider (Gemini/Groq/...) so it still works when the PC is off
rep('if(!PROVIDERS[state.settings.provider]||state.settings.provider!=="chatgpt")state.settings.provider="chatgpt";','if(!PROVIDERS[state.settings.provider])state.settings.provider="chatgpt";');
const i=h.lastIndexOf("</body>");h=h.slice(0,i)+"<script>"+rd("mobile/tara-mobile-post.js")+"</script>\n"+h.slice(i);
const out=path.join(root,"android/app/src/main/assets/tara-full.html");fs.writeFileSync(out,h);console.log("wrote",out,h.length,"bytes");

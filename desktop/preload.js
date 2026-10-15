const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("tara",{
  invoke:(action,args)=>ipcRenderer.invoke("tara:invoke",action,args),
  onRemoteJob:cb=>ipcRenderer.on("tara:remote-job",(e,job)=>cb(job)),
  onHotkey:cb=>ipcRenderer.on("tara:hotkey",()=>cb())
});

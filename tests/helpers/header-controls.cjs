const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),os=require('node:os');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'glass-header-test-')));app.disableHardwareAcceleration();
const root=path.resolve(__dirname,'../..'),evidence=path.join(root,'docs/wire2-header-evidence');
const results=[],measurements=[];let win,server;
const check=(ok,message)=>{if(!ok)throw Error(message)};
app.whenReady().then(async()=>{
 try{
 fs.mkdirSync(evidence,{recursive:true});
 server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/resize'){win.setContentSize(Number(url.searchParams.get('w')),Number(url.searchParams.get('h')));setTimeout(()=>res.end('{}'),100);return;}
 const file=url.pathname==='/'?path.join(__dirname,'meeting-fixture.html'):path.resolve(root,'.'+url.pathname);
 if(!file.startsWith(root+path.sep)||(!url.pathname.startsWith('/src/ui/')&&url.pathname!=='/')){res.writeHead(404).end();return;}
 try{res.setHeader('Content-Type',file.endsWith('.html')?'text/html':'text/javascript');res.end(fs.readFileSync(file))}catch{res.writeHead(404).end()}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 win=new BrowserWindow({show:false,frame:false,width:445,height:47,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith(origin+'/')}));
 const run=async(name,fn)=>{try{await fn();results.push({name,error:null})}catch(e){results.push({name,error:String(e.message).slice(0,500)})}};
 for(const source of ['local','meeting'])for(const configured of [true,false]){
 await run(source+' configured='+configured+' keeps every header control inside native viewport',async()=>{
 win.setContentSize(353,47);await win.loadURL(origin+'/');
 await win.webContents.executeJavaScript('(async()=>{document.body.style.margin="0";document.body.style.overflow="hidden";document.querySelector("#content").remove();window.boot=undefined;window.settingsOpened=0;window.toggles=0;api.mainHeader.showSettingsWindow=()=>settingsOpened++;api.mainHeader.toggleSettingsPinned=()=>settingsOpened++;api.mainHeader.hideSettingsWindow=()=>{};api.mainHeader.sendToggleAllWindowsVisibility=()=>toggles++;api.headerController.resizeHeaderWindow=async({width,height})=>{await fetch("/resize?w="+width+"&h="+height)};api.listen.getCapabilities=async()=>({meeting:true,localListen:'+configured+',ask:true});current={...current,source:'+JSON.stringify(source)+'};await import("/src/ui/app/MainHeader.js");window.header=document.createElement("main-header");header.shortcuts={nextStep:"Ctrl+Enter",toggleVisibility:"Ctrl+\\\\"};document.querySelector("#header-container").append(header);await tick()})()');
 await new Promise(r=>setTimeout(r,180));await win.capturePage();
 const metrics=await win.webContents.executeJavaScript('(()=>{const r=header.shadowRoot;const rect=e=>{const b=e.getBoundingClientRect();return {x:b.x,right:b.right,width:b.width,height:b.height}};return {viewport:innerWidth,header:rect(r.querySelector(".header")),controls:[...r.querySelectorAll(".source-select,.listen-button,.header-actions,.settings-button")].map(rect)}})()');
 measurements.push({source,configured,...metrics});
 if(source==='meeting'&&configured){fs.writeFileSync(path.join(evidence,process.env.HEADER_STAGE==='before'?'before.png':'after.png'),(await win.capturePage()).toPNG())}
 check(metrics.controls.every(r=>r.x>=0&&r.right<=metrics.viewport+1&&r.height>0),'control clipped: '+JSON.stringify(metrics));
 await win.webContents.executeJavaScript('(async()=>{const r=header.shadowRoot;r.querySelector(".settings-button").dispatchEvent(new Event("mouseenter"));r.querySelector(".ask-action").click();r.querySelector(".visibility-action").click();await tick();check(settingsOpened===1,"normal Settings action");check(asks===1&&toggles===1,"Ask and Show/Hide actions remain functional")})()');
 });
 }
 await run('all shipped controls remain visible and functional in active and stopped Local/Meeting states',async()=>{
 for(const source of ['local','meeting'])for(const phase of ['active','stopped']){
  await win.webContents.executeJavaScript('(async()=>{emit({...current,source:'+JSON.stringify(source)+',phase:'+JSON.stringify(phase)+',version:current.version+1});await tick()})()');
  await new Promise(r=>setTimeout(r,100));await win.capturePage();
  await win.webContents.executeJavaScript('(async()=>{const controls=[...header.shadowRoot.querySelectorAll("button,.header-actions,select")];check(controls.every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.height>0}),"all controls fit each lifecycle state");settingsOpened=0;header.shadowRoot.querySelector(".settings-button").click();await tick();check(settingsOpened===1,"Settings works during active/stopped source")})()');
 }
 });
 await run('stopped header retains Done alongside restart in both sources',async()=>{
 await win.webContents.executeJavaScript('(async()=>{api.mainHeader.sendListenButtonClick=async action=>{commands.push(action);if(action==="Done")emit({...current,phase:"idle",version:current.version+1});return {success:true,state:current}};for(const source of ["local","meeting"]){emit({...current,source,phase:"stopped",version:current.version+1});await tick();const done=header.shadowRoot.querySelector(".done-button");check(done,"upstream Done control retained");done.click();await tick();check(commands.at(-1)==="Done","Done uses existing lifecycle action");check(!header.shadowRoot.querySelector(".done-button"),"Done disappears after authoritative idle");check(header.shadowRoot.querySelector(".listen-button"),"restart stays available")}})()');
 });
 await run('settings supports click and accessible naming in meeting-only mode',async()=>{
 await win.webContents.executeJavaScript('(async()=>{settingsOpened=0;const button=header.shadowRoot.querySelector(".settings-button");check(button.getAttribute("aria-label")==="Settings","Settings has accessible name");check(button.title.includes("pin Settings"),"pin tooltip visible");button.click();await tick();check(settingsOpened===1,"click pins Settings")})()');
 });
 await run('configured shortcuts and stopped additions trigger fresh measured header sizing',async()=>{
 await win.webContents.executeJavaScript('header.shortcuts={nextStep:"Ctrl+Shift+Enter",toggleVisibility:"Ctrl+Alt+Backspace"}');
 await new Promise(r=>setTimeout(r,200));await win.capturePage();
 const result=await win.webContents.executeJavaScript('({viewport:innerWidth,right:header.shadowRoot.querySelector(".settings-button").getBoundingClientRect().right})');
 check(result.right<=result.viewport+1,'updated shortcuts clipped: '+JSON.stringify(result));
 });
 await run('opening Setup cannot be resized back to the old MainHeader by a late viewport event',async()=>{
 await win.webContents.executeJavaScript('(async()=>{header.remove();await import("/src/ui/app/HeaderController.js");window.dispatchEvent(new Event("DOMContentLoaded"));await tick()})()');
 await new Promise(r=>setTimeout(r,250));
 await win.webContents.executeJavaScript('window.requestSetup()');
 await new Promise(r=>setTimeout(r,350));await win.capturePage();
 const metrics=await win.webContents.executeJavaScript('({viewport:innerHeight,height:document.querySelector("welcome-header")?.shadowRoot.querySelector(".container").getBoundingClientRect().height})');
 check(metrics.height>100&&metrics.height<=metrics.viewport+1,'Setup window clipped after transition: '+JSON.stringify(metrics));
 await win.webContents.executeJavaScript('document.querySelector("welcome-header").shadowRoot.querySelector(".meeting-back").click()');
 await new Promise(r=>setTimeout(r,250));await win.capturePage();
 await win.webContents.executeJavaScript('window.header=document.querySelector("main-header");check(header.shadowRoot.querySelector(".settings-button").getBoundingClientRect().right<=innerWidth+1,"return to Main keeps Settings visible")');
 });
 await run('normal Settings renderer remains browsable without providers in Meeting',async()=>{
 await win.webContents.executeJavaScript('header.remove();document.querySelector("#header-container").remove()');
 await new Promise(r=>setTimeout(r,200));win.setContentSize(240,400);
 await win.webContents.executeJavaScript('(async()=>{header.remove();window.settingsCalls=[];const data={getCurrentUser:()=>({mode:"local",isLoggedIn:false}),getModelSettings:()=>({success:true,data:{config:{},storedKeys:{},availableLlm:[],availableStt:[],selectedModels:{llm:null,stt:null}}}),getPresets:()=>[],getContentProtectionStatus:()=>true,getCurrentShortcuts:()=>({}),getAutoUpdate:()=>true,getOllamaStatus:()=>({success:true,installed:false,running:false,models:[]})};api.settingsView=new Proxy(data,{get:(target,name)=>target[name]||((...args)=>{settingsCalls.push(name);return Promise.resolve()})});await import("/src/ui/settings/SettingsView.js");window.settings=document.createElement("settings-view");document.body.append(settings);await tick();const root=settings.shadowRoot;for(const label of ["Edit Shortcuts","My Presets","Personalize / Meeting Notes","Automatic Updates","Move","Invisibility","Login","Quit"])check(root.textContent.includes(label),"normal Settings retains "+label);[...root.querySelectorAll("button")].find(b=>b.textContent.includes("Edit Shortcuts")).click();check(settingsCalls.includes("openShortcutSettingsWindow"),"normal shortcut editor action");check(!settingsCalls.some(c=>/validate|selectModel|saveKey|ensureOllama|install/i.test(c)),"browsing Settings never configures a provider")})()');
 await new Promise(r=>setTimeout(r,100));fs.writeFileSync(path.join(evidence,'settings-meeting-only.png'),(await win.capturePage()).toPNG());
 });
 }catch(e){results.push({name:'harness',error:String(e.message).slice(0,500)})}
 finally{fs.writeFileSync(path.join(evidence,(process.env.HEADER_STAGE==='before'?'before':'after')+'-measurements.json'),JSON.stringify(measurements,null,2));console.log('HEADER_TESTS:'+JSON.stringify(results));win?.destroy();server?.close();app.exit(0)}
});


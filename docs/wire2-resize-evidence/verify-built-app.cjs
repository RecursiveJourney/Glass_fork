// Isolated diagnostic: existing built renderer + source window geometry modules.
// No real services, repositories, capture, server feed, credentials or profile are loaded.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');
const req = createRequire(path.join(root, 'package.json'));
const electron = req('electron');
const { app, BrowserWindow, ipcMain } = electron;
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wire2-diagnosis-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let active;
const outputs = [];
const metrics = `(() => {
 const a=document.querySelector('pickle-glass-app'),v=a?.shadowRoot.querySelector('listen-view');
 const c=v?.shadowRoot.querySelector('.assistant-container'),stt=v?.shadowRoot.querySelector('stt-view');
 const p=stt?.shadowRoot.querySelector('.transcription-container'),s=v?.shadowRoot.querySelector('suggestions-view');
 return {viewport:innerHeight,dpr:devicePixelRatio,container:c?.getBoundingClientRect().height,lastHeight:v?._lastHeight,
   rows:p?.children.length,scrollTop:p?.scrollTop,scrollHeight:p?.scrollHeight,clientHeight:p?.clientHeight,
   suggestionsTop:s?.getBoundingClientRect().top,version:v?.listenState?.version};
})()`;
function harness(delay, unlockFirst = false) {
 const bridge = new EventEmitter(), cache = new Map(), trace = [], windows = [], errors = [];
 let armed = false, listen;
 const state = { source:'local',phase:'idle',lifecycleId:0,version:1,feed:null };
 function NativeWindow(options) {
   const w = new BrowserWindow({ ...options, show:false, alwaysOnTop:false, focusable:false,
     webPreferences: { nodeIntegration:false, contextIsolation:true, backgroundThrottling:false, preload:path.join(__dirname,'built-app-preload.cjs') } });
   windows.push(w);
   // Keep diagnostic windows hidden; exercise production visibility decisions logically.
   let visible = options.show !== false;
   w.show = () => { visible=true; };
   w.hide = () => { visible=false; };
   w.isVisible = () => visible;
   w.setAlwaysOnTop = () => {};
   const load = w.loadFile.bind(w);
   w.loadFile = (file, opts) => {
     if (opts?.query?.view === 'listen') {
       listen=w;
       w.webContents.on('console-message', (_, level, message, line, source) => {
         if (level>=2) errors.push({level,line,source:path.basename(source),message:message.slice(0,180)});
       });
       w.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({cancel:/^https?:/.test(details.url)}));
       w.ready=load(file,opts); return w.ready;
     }
     return Promise.resolve();
   };
   const set = w.setBounds.bind(w);
   w.setBounds = b => { if(w===listen && trace.length<160)trace.push({kind:'bounds',height:b.height});set(b); };
   return w;
 }
 function load(name) {
   if(cache.has(name))return cache.get(name);
   const filename=path.join(root,'src/window',name+'.js'),mod={exports:{}};
   const stubs={electron:{...electron,BrowserWindow:NativeWindow,app:{isPackaged:true}},
     '../bridge/internalBridge':bridge,'../features/shortcuts/shortcutsService':{initialize(){},registerShortcuts(){}},
     '../features/common/repositories/permission':{}};
   vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:mod,exports:mod.exports,__dirname:path.dirname(filename),
     require:id=>Object.hasOwn(stubs,id)?stubs[id]:id.startsWith('./')?load(id.slice(2)):req(id),
     process:{platform:'win32',env:{}},Date,console:{log(){},warn(){},error(){}},setTimeout,clearTimeout},{filename});
   cache.set(name,mod.exports);return mod.exports;
 }
 const api=load('windowManager');api.createWindows();api.handleHeaderStateChanged('main');
 return {api,state,trace,errors,windows,get listen(){return listen;},height(name,height){
   trace.push({kind:'request',height,min:listen.getMinimumSize(),max:listen.getMaximumSize(),resizable:listen.isResizable()});
   if(unlockFirst && height>450){listen.setResizable(true);trace.push({kind:'unlocked',min:listen.getMinimumSize(),max:listen.getMaximumSize()});}
   const completion=api.adjustWindowHeight(name,height);
   if(armed && height>450 && delay!==null){armed=false;setTimeout(()=>{
     trace.push({kind:'show',height:load('windowBounds').getWindowBounds(listen).height});
     bridge.emit('window:requestVisibility',{name:'listen',visible:true});
   },delay);}
   return completion;
 },arm(){armed=true;},send(){listen.webContents.send('diagnosis:state',state);},load};
}
app.whenReady().then(async()=>{
 ipcMain.handle('diagnosis:state',()=>active.state);
 ipcMain.handle('diagnosis:height',(_,x)=>active.height(x.name,x.height));
 try {
   for(const unlockFirst of [false]) {
     const delay=null;
     const h=active=harness(delay,unlockFirst);await h.listen.ready;await sleep(650);
     const baseline=await (await h.listen.webContents.capturePage(), await h.listen.webContents.executeJavaScript(metrics));
     h.arm();Object.assign(h.state,{source:'meeting',phase:'active',version:2,lifecycleId:1,
       feed:{connectionStatus:'connected',snapshot:{instanceId:'fixture',transcriptId:'fixture',sequence:1,revision:1,
         chunks:[],suggestions:[],suggestionHistoryLimit:20,generation:{state:'idle'},availability:'available',connectionState:'connected'}}});
     h.send();await sleep(650);
     const switched=await (await h.listen.webContents.capturePage(), await h.listen.webContents.executeJavaScript(metrics));
     const growth=[];
     for(let n=1;n<=8;n++){
       h.state.version++;h.state.feed.snapshot.chunks.push({chunk_id:String(n),text:'Synthetic test sentence.',speaker_name:'unassigned',start_time:n,end_time:n+1});
       h.send();await sleep(60);growth.push(await (await h.listen.webContents.capturePage(), await h.listen.webContents.executeJavaScript(metrics)));
     }
     await sleep(250);
     const beforeScroll=await (await h.listen.webContents.capturePage(), await h.listen.webContents.executeJavaScript(metrics));
     await h.listen.webContents.executeJavaScript(`document.querySelector('pickle-glass-app').shadowRoot.querySelector('listen-view').shadowRoot.querySelector('stt-view').shadowRoot.querySelector('.transcription-container').scrollTop=200`);
     const afterScroll=await (await h.listen.webContents.capturePage(), await h.listen.webContents.executeJavaScript(metrics));
     outputs.push({delay,unlockFirst,baseline,switched,growth,beforeScroll,afterScroll,native:h.listen.getBounds(),trace:h.trace,errors:h.errors});
     for(const w of h.windows)w.destroy();await sleep(350);
   }
   console.log('DIAGNOSIS:'+JSON.stringify(outputs));
 }catch(error){console.log('DIAGNOSIS_FAILURE:'+JSON.stringify({name:error.name,message:error.message.slice(0,250)}));process.exitCode=1;}
 finally{for(const w of BrowserWindow.getAllWindows())w.destroy();app.exit(process.exitCode||0);}
});

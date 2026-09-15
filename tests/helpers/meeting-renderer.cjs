const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'glass-meeting-test-')));
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, '../..');
const cases = [
 ['source selector stays readable when host text defaults to black',async()=>{
   document.body.style.color='black';
   for(const source of ['local','meeting'])for(const phase of ['idle','active']){
     emit({...current,source,phase,version:current.version+1});await tick();
     const select=header.shadowRoot.querySelector('.source-select');
     check(getComputedStyle(select).color==='rgb(255, 255, 255)','selector must use explicit white header text');
   }
 }],

 ['departing MainHeader cannot compete with a pending Setup resize',async()=>{
   document.querySelector('#header-container').replaceChildren();await import('/src/ui/app/HeaderController.js');
   window.dispatchEvent(new Event('DOMContentLoaded'));await tick();
   const main=document.querySelector('main-header'),requests=[];
   let resolve;api.headerController.resizeHeaderWindow=dimensions=>{requests.push(dimensions);return new Promise(r=>resolve=r)};
   window.requestSetup();await tick();
   main.resizeToContent();await tick();
   check(requests.length===1,'old header must not overwrite in-flight setup dimensions');
   resolve();await tick();
 }],

 ['added Setup controls must not hide the original Welcome options or permission title',async()=>{
   document.querySelector('#header-container').replaceChildren();await import('/src/ui/app/HeaderController.js');
   const sizes=[];api.headerController.resizeHeaderWindow=async dimensions=>sizes.push(dimensions);
   window.dispatchEvent(new Event('DOMContentLoaded'));await tick();
   window.requestSetup();await tick();
   const welcome=document.querySelector('welcome-header'),height=welcome.shadowRoot.querySelector('.container').getBoundingClientRect().height;
   check(sizes.at(-1).height>=Math.floor(height),'Welcome resize must include the added return button');
   const prototype=customElements.get('permission-setup').prototype;
   prototype.connectedCallback=function(){Object.getPrototypeOf(prototype).connectedCallback.call(this)};
   const permission=document.createElement('permission-setup');permission.backCallback=()=>{};
   document.querySelector('#content').append(permission);await tick();
   const back=permission.shadowRoot.querySelector('.meeting-back').getBoundingClientRect();
   const title=permission.shadowRoot.querySelector('.title').getBoundingClientRect();
   check(back.bottom<=title.top || back.right<=title.left,'Back must not overlap permission title');
 }],

 ['meeting-only users can reach every Welcome option and return without losing Quit',async()=>{
   document.querySelector('#header-container').replaceChildren();await import('/src/ui/app/HeaderController.js');
   window.dispatchEvent(new Event('DOMContentLoaded'));await tick();let logins=0;api.common.startFirebaseAuth=async()=>logins++;
   const main=document.querySelector('main-header');
   check(typeof window.requestSetup==='function','Settings IPC route exposes upstream Welcome choices');window.requestSetup();await tick();
   const welcome=document.querySelector('welcome-header');check(welcome,'normal Welcome screen reachable');
   await welcome.loginCallback();check(logins===1,'normal browser login action retained');
   check(welcome.shadowRoot.querySelector('.close-button'),'Quit retained');
   const back=welcome.shadowRoot.querySelector('.meeting-back');check(back,'return to Meeting is additive');back.click();await tick();
   check(document.querySelector('main-header'),'return to source selection');
 }],

 ['meeting preserves upstream pane navigation, elapsed label and copy feedback',async()=>{
   emit(active(snapshot({chunks:[row('a')],suggestions:[outcome('a')]})));await tick();
   const root=view.shadowRoot,toggle=root.querySelector('.toggle-button');
   check(toggle,'Show Transcript/Insights control remains available');
   toggle.click();await tick();check(root.querySelector('stt-view')&&root.querySelector('suggestions-view'),'navigation keeps both meeting panes');
   check(root.querySelector('.copy-icon')&&root.querySelector('.check-icon'),'normal Copy and completion icons retained');
   check(root.querySelector('.meeting-elapsed'),'elapsed status retained');
 }],
 ['permission setup retains Quit alongside the added Back control',async()=>{
   await import('/src/ui/app/PermissionHeader.js');const p=customElements.get('permission-setup').prototype;
   p.connectedCallback=function(){Object.getPrototypeOf(p).connectedCallback.call(this)};
   let quits=0,backs=0;api.common.quitApplication=()=>quits++;
   const permission=document.createElement('permission-setup');permission.backCallback=()=>backs++;
   document.querySelector('#content').append(permission);await tick();
   permission.shadowRoot.querySelector('.close-button').click();await tick();check(quits===1,'upstream Close still quits');
   const back=permission.shadowRoot.querySelector('.meeting-back');check(back,'added Back is separate');back.click();await tick();check(backs===1,'Back returns without quitting');
 }],

 ['pending authoritative hydration never mounts the local summary pipeline', async()=>{
   view.remove();let resolve;api.listen.getState=()=>new Promise(r=>resolve=r);
   const v=document.createElement('listen-view');document.querySelector('#content').append(v);await tick();
   check(!v.shadowRoot.querySelector('summary-view'),'do not mount local summary before source is known');
   resolve(active(snapshot({chunks:[row('ready')]})));await tick();
   check(v.shadowRoot.querySelector('suggestions-view'),'meeting snapshot hydrates directly');
 }],
 ['source selection remains a native interactive control', async()=>{
   emit({...active(snapshot()),phase:'stopped'});await tick();
   const select=header.shadowRoot.querySelector('select');
   check(getComputedStyle(select).webkitAppRegion==='no-drag','selector must override native draggable header');
 }],
 ['stopped session can restart from the header', async()=>{
   emit({...active(snapshot()),phase:'stopped'});await tick();
   await header._handleListenClick();await tick();check(commands.at(-1)==='Listen','stopped state must offer a fresh Start');
 }],
 ['failed local cleanup offers Stop retry before source switching or another Start', async()=>{
   emit({...current,source:'local',phase:'stopped',error:'local_cleanup_failed',version:current.version+1});await tick();
   await header._handleListenClick();await tick();check(commands.at(-1)==='Stop','cleanup failure offers Stop retry without provider setup');
 }],
 ['meeting height is intrinsic inside the app full-height host', async()=>{
   const content=document.querySelector('#content');content.style.height='100px';view.style.height='100%';
   emit(active(snapshot({chunks:[row('a')],suggestions:[outcome('a')]})));await tick();
   const height=view.shadowRoot.querySelector('.meeting-layout').getBoundingClientRect().height;
   check(height>450 && height<=700,'layout must measure its content rather than the previous window height');
 }],
 ['atomic meeting hydration renders transcript and suggestions together as literal text', async()=>{
   emit(active(snapshot({chunks:[row('a','<img src=x onerror=alert(1)>')],suggestions:[outcome('a','<script>bad()</script>')]})));await tick();
   const stt=view.shadowRoot.querySelector('stt-view'), suggestions=view.shadowRoot.querySelector('suggestions-view');
   check(stt && suggestions,'both panes are mounted');
   check(stt.shadowRoot.textContent.includes('Speaker a'),'speaker labels render');
   check(stt.shadowRoot.textContent.includes('<img src=x'),'transcript remains literal text');
   check(suggestions.shadowRoot.textContent.includes('<script>bad()</script>'),'suggestion remains literal text');
   check(!suggestions.shadowRoot.querySelector('script') && !stt.shadowRoot.querySelector('img'),'no payload creates HTML');
   check(!view.shadowRoot.querySelector('summary-view'),'local summary observer bypassed');
 }],
 ['correction reorder eviction and instance restart replace keyed rows', async()=>{
   emit(active(snapshot({chunks:[row('a'),row('b')],suggestions:[outcome('x')]})));await tick();
   const stt=view.shadowRoot.querySelector('stt-view'), first=stt.shadowRoot.querySelector('[data-row-key]');
   emit(active(snapshot({sequence:2,chunks:[row('b'),row('a','corrected')],suggestions:[outcome('x','corrected suggestion')]})));await tick();
   const rows=[...stt.shadowRoot.querySelectorAll('[data-row-key]')];check(rows.length===2 && rows[1]===first,'keyed nodes survive reorder');
   check(rows[1].textContent.includes('corrected'),'correction replaces text');
   check(view.shadowRoot.querySelector('suggestions-view').shadowRoot.querySelectorAll('[data-row-key]').length===1,'attempt upsert does not duplicate');
   emit(active(snapshot({instanceId:'feed-b',chunks:[],suggestions:[]})));await tick();
   check(stt.shadowRoot.querySelectorAll('[data-row-key]').length===0,'new instance evicts old transcript');
 }],
 ['obsolete hydration cannot overwrite a newer push or remounted lifecycle', async()=>{
   view.remove();let resolve;api.listen.getState=()=>new Promise(r=>resolve=r);
   const v=document.createElement('listen-view');document.querySelector('#content').append(v);await tick();
   emit(active(snapshot({chunks:[row('new')]})));await tick();resolve({source:'local',phase:'idle',lifecycleId:0,version:0,feed:null});await tick();
   check(v.shadowRoot.querySelector('suggestions-view'),'obsolete local hydration rejected');
   check(v.shadowRoot.querySelector('stt-view').shadowRoot.textContent.includes('Speaker new'),'new push retained');
   v.remove();const count=listeners.size;emit({...current,version:current.version+1});await tick();check(listeners.size===count,'detached observer removed');
 }],
 ['bounded layout retains scroll and skips equal dimension resize requests', async()=>{
   emit(active(snapshot({chunks:Array.from({length:60},(_,i)=>row(String(i),'Long transcript '.repeat(12))),suggestions:Array.from({length:20},(_,i)=>outcome(String(i),'Advice '.repeat(30)))})));await tick();
   const stt=view.shadowRoot.querySelector('stt-view'), pane=stt.shadowRoot.querySelector('.transcription-container');
   const suggestionPane=view.shadowRoot.querySelector('suggestions-view').shadowRoot.querySelector('.suggestions-container');
   check(pane.clientHeight>0 && pane.clientHeight<=320 && suggestionPane.clientHeight>0 && suggestionPane.clientHeight<=260,'both scroll regions bounded and visible');
   pane.scrollTop=180;const prior=pane.scrollTop;resizes.length=0;
   emit({...current,version:current.version+1,feed:{...current.feed,connectionStatus:'reconnecting'}});await tick();
   view.adjustWindowHeight();view.adjustWindowHeight();await tick();
   check(Math.abs(pane.scrollTop-prior)<2,'reading position retained');check(resizes.length===0,'unchanged dimensions never resize');
   check(view.shadowRoot.textContent.toLowerCase().includes('reconnect'),'outage status visible');
 }],
 ['corrections preserve the visible row anchor and bottom readers follow new rows', async()=>{
   const chunks=Array.from({length:25},(_,i)=>row(String(i),'Line '+i+' '.repeat(2)+'words '.repeat(15)));
   emit(active(snapshot({chunks})));await tick();
   const pane=view.shadowRoot.querySelector('stt-view').shadowRoot.querySelector('.transcription-container');
   pane.scrollTop=300;const top=pane.getBoundingClientRect().top;
   const anchor=[...pane.children].find(node=>node.getBoundingClientRect().bottom>top),offset=anchor.getBoundingClientRect().top-top;
   emit(active(snapshot({chunks:[{...chunks[0],text:'Expanded correction '.repeat(40)},...chunks.slice(1),row('new')]})));await tick();
   check(Math.abs(anchor.getBoundingClientRect().top-top-offset)<2,'correction above viewport preserves visual anchor');
   pane.scrollTop=pane.scrollHeight;
   emit(active(snapshot({chunks:[...chunks,row('latest','Latest words '.repeat(20))]})));await tick();
   check(pane.scrollHeight-pane.scrollTop-pane.clientHeight<2,'bottom reader follows additions');
 }],
 ['no-suggestion outcomes stay hidden and terminal stopped state retains the last view', async()=>{
   const suggestions=Array.from({length:22},(_,i)=>outcome(String(i)));
   suggestions[21]={...suggestions[21],noSuggestion:true,text:''};
   emit(active(snapshot({chunks:[row('keep')],suggestions})));await tick();
   const pane=view.shadowRoot.querySelector('suggestions-view');
   check(pane.shadowRoot.querySelectorAll('article').length===19,'only retained visible outcomes render');
   emit({...current,phase:'stopped',version:current.version+1,feed:{...current.feed,connectionStatus:'closed',snapshot:{...current.feed.snapshot,closed:true}}});await tick();
   check(view.shadowRoot.textContent.includes('Meeting ended'),'terminal state explicit');
   check(view.shadowRoot.querySelector('stt-view').shadowRoot.textContent.includes('Speaker keep'),'stopped transcript retained');
   check(pane.shadowRoot.querySelectorAll('article').length===19,'stopped suggestions retained');
 }],
 ['source selector is locked active and Ask remains enabled in meeting', async()=>{
   emit(active(snapshot()));await tick();
   const select=header.shadowRoot.querySelector('select');check(select && select.disabled,'source is locked while active');
   header.shadowRoot.querySelector('.ask-action').click();await tick();check(asks===1,'Ask invokes unchanged action');
   emit({...current,phase:'stopped',version:current.version+1});await tick();check(!select.disabled,'source unlocks after stop');
   select.value='local';select.dispatchEvent(new Event('change'));await tick();check(selections[0]==='local','explicit source selection');
 }],
 ['MainHeader follows authoritative phase without optimistic cycling', async()=>{
   emit(active(snapshot()));await tick();api.mainHeader.sendListenButtonClick=async()=>({success:false,state:{...current,phase:'active',version:current.version+1}});
   await header._handleListenClick();await tick();check(header.shadowRoot.querySelector('.listen-button').textContent.includes('Stop'),'failure cannot optimistically mark completed');
 }],
 ['meeting-only HeaderController bypasses provider and capture setup including forced reevaluation', async()=>{
   document.querySelector('#header-container').replaceChildren();
   await import('/src/ui/app/HeaderController.js');window.dispatchEvent(new Event('DOMContentLoaded'));await tick();
   check(document.querySelector('main-header'),'meeting-only header reachable without providers/permissions');
   await forceApi();await tick();check(document.querySelector('main-header'),'provider event does not eject meeting user');
 }],
 ['Local credential setup can be cancelled back to Meeting', async()=>{
   document.querySelector('#header-container').replaceChildren();await import('/src/ui/app/HeaderController.js');
   for(const name of ['apikey-header','permission-setup']){
     const prototype=customElements.get(name).prototype;
     prototype.connectedCallback=function(){Object.getPrototypeOf(prototype).connectedCallback.call(this)};
   }
   api.apiKeyHeader.removeAllListeners=()=>{};let quits=0;api.common.quitApplication=()=>quits++;
   api.headerController.checkPermissionsCompleted=async()=>false;
   window.dispatchEvent(new Event('DOMContentLoaded'));await tick();
   window.dispatchEvent(new CustomEvent('listen-setup-requested'));await tick();
   const keys=document.querySelector('apikey-header');check(keys,'explicit Local setup opens credentials');
   keys.shadowRoot.querySelector('.meeting-back').click();await tick();check(document.querySelector('main-header'),'added return preserves source selection');
   check(quits===0,'cancel setup does not quit the meeting-capable app');
 }],
 ['Local permission setup can be cancelled back to Meeting', async()=>{
   document.querySelector('#header-container').replaceChildren();await import('/src/ui/app/HeaderController.js');
   const prototype=customElements.get('permission-setup').prototype;
   prototype.connectedCallback=function(){Object.getPrototypeOf(prototype).connectedCallback.call(this)};
   let quits=0;api.common.quitApplication=()=>quits++;api.apiKeyHeader.areProvidersConfigured=async()=>true;
   api.headerController.checkPermissionsCompleted=async()=>false;
   window.dispatchEvent(new Event('DOMContentLoaded'));await tick();
   window.dispatchEvent(new CustomEvent('listen-setup-requested'));await tick();
   const permission=document.querySelector('permission-setup');check(permission,'explicit Local setup opens permissions');
   permission.shadowRoot.querySelector(".meeting-back").click();await tick();check(document.querySelector('main-header'),'permission Back returns to source selection');
   check(quits===0,'cancel setup does not quit the meeting-capable app');
 }],
];
let server, win;
app.whenReady().then(async()=>{
 const results=[];
 try {
  server=http.createServer((req,res)=>{
   const url=new URL(req.url,'http://localhost');
   const file=url.pathname==='/'?path.join(__dirname,'meeting-fixture.html'):path.resolve(root,'.'+url.pathname);
   if(!file.startsWith(root+path.sep)||(!url.pathname.startsWith('/src/ui/')&&url.pathname!=='/')){res.writeHead(404);res.end();return}
   try{res.setHeader('Content-Type',file.endsWith('.html')?'text/html':'text/javascript');res.end(fs.readFileSync(file))}catch{res.writeHead(404);res.end()}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  win=new BrowserWindow({show:false,width:650,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true}});
  const origin=`http://127.0.0.1:${server.address().port}`;
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith(origin+'/')}));
  for(const [name,fn] of cases){
   try{await win.loadURL(origin+'/');await win.webContents.executeJavaScript('boot()');await win.webContents.executeJavaScript(`(${fn.toString()})()`);results.push({name,error:null})}
   catch(error){results.push({name,error:String(error.message).slice(0,700)})}
  }
  if(process.env.MEETING_SCREENSHOT){await win.loadURL(origin+'/');await win.webContents.executeJavaScript("boot().then(async()=>{emit(active(snapshot({chunks:[row('A','Could we phase the rollout across two regions?'),row('B','Yes. Let us agree on the first milestone.')],suggestions:[outcome('one','Ask which region has the clearest success criteria for the first milestone.')]})));await tick()})");await new Promise(r=>setTimeout(r,100));fs.writeFileSync(process.env.MEETING_SCREENSHOT,(await win.capturePage()).toPNG())}
 }catch(error){results.push({name:'renderer harness',error:String(error.message).slice(0,700)})}
 finally{console.log('MEETING_TESTS:'+JSON.stringify(results));win?.destroy();server?.close();app.exit(0)}
});

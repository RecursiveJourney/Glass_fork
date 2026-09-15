const {app,BrowserWindow,ipcMain,screen}=require('electron');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const [directory,mode,coordinator]=process.argv.slice(2),root=path.resolve(__dirname,'../..');
app.setPath('userData',path.join(directory,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1.75');app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const {WindowSizeStore}=require('../../src/window/windowSizeStore');
const {attachWindowSizing}=require('../../src/window/windowSizing');
const bounds=require('../../src/window/windowBounds');
const SmoothMovementManager=require('../../src/window/smoothMovementManager');
const {animateResize}=require('../../src/window/windowResize');
const pool=new Map(),movement=new SmoothMovementManager(pool),measurements=[];
const check=(value,code)=>{if(!value)throw Error(code)};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
    const store=new WindowSizeStore(path.join(directory,'sizes.json'));
    const bridge=path.join(root,'src/bridge/windowBridge.js'),module={exports:{}};
    vm.runInThisContext('(function(require,module){'+fs.readFileSync(bridge,'utf8')+'\n})')((id)=>({electron:{ipcMain,shell:{},app:{getAppPath:()=>directory}},'../window/windowManager':{windowPool:pool},'../window/windowBounds':bounds})[id],module);module.exports.initialize();
    for(const [name,width,height,min] of [['listen',400,300,[400,180]],['ask',600,180,[400,160]],['settings',240,400,[240,240]]]){
        const options={show:false,frame:false,width,height,resizable:true,minWidth:min[0],minHeight:min[1],webPreferences:{preload:path.join(root,'src/preload.js'),contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}};
        const win=new BrowserWindow(options);pool.set(name,win);bounds.registerWindowSizeLimits(win,options);
        const policy=attachWindowSizing(win,{name,defaults:{width,height},min,store,workArea:b=>screen.getDisplayNearestPoint({x:b.x+b.width/2,y:b.y+b.height/2}).workArea,cancel:()=>movement.cancelWindowAnimation(win)});
        if(mode==='read'){
            check(policy.state().owner==='user','restore_owner_'+name);
            check(bounds.getWindowBounds(win).width===store.get(name).width,'restore_width_'+name);
            check(bounds.getWindowBounds(win).height===store.get(name).height,'restore_height_'+name);
            continue;
        }
        const viewFile={listen:'listen/ListenView',ask:'ask/AskView',settings:'settings/SettingsView'}[name];
        const file=path.join(directory,'src/ui',name+'.html');fs.mkdirSync(path.dirname(file),{recursive:true});
        fs.writeFileSync(file,`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#181c23;color:white} ${name}-view{display:block;width:100%;height:100%}</style><script type="module">
          window.marked={parse:s=>s,setOptions(){}};window.hljs={};window.DOMPurify={sanitize:s=>s};
          await import('${pathToFileURL(path.join(root,'src/ui',viewFile+'.js')).href}');
          const Class=customElements.get('${name}-view'),p=Class.prototype;p.connectedCallback=function(){Object.getPrototypeOf(p).connectedCallback.call(this)};
          const v=document.createElement('${name}-view');window.view=v;
          if('${name}'==='listen')v.listenState={source:'meeting',phase:'active',version:1,feed:{snapshot:{instanceId:'synthetic',chunks:Array.from({length:30},(_,i)=>({chunk_id:''+i,speaker_name:'Speaker',text:'Synthetic long transcript '.repeat(20)})),suggestions:[],generation:{state:'idle'}}}};
          if('${name}'==='ask'){v.currentResponse='[no suggestion]';v.isLoading=false;v.showTextInput=true;}
          if('${name}'==='settings')v.isLoading=false;
          document.body.append(v);window.ready=v.updateComplete;
        </script>`);
        await win.loadFile(file);await win.webContents.executeJavaScript('window.ready');await wait(80);
        const pending=animateResize(win,()=>({...bounds.getWindowBounds(win),height:650}),movement,()=>{},650);
        await wait(25);win.emit('will-resize',{},win.getBounds(),{edge:'bottom-right'});
        win.setBounds({...win.getBounds(),width:name==='settings'?420:620,height:500});win.emit('resized');
        check((await pending).applied===false,'cancel_animation_'+name);
        check(policy.state().owner==='user','user_owner_'+name);
        const preferred=store.get(name);check(preferred.width===win.getBounds().width,'save_native_width_'+name);
        for(let i=0;i<12;i++)bounds.setWindowBounds(win,{x:100+i,width:900,height:700});
        check(bounds.getWindowBounds(win).width===preferred.width,'no_dpi_growth_'+name);
        check((await animateResize(win,()=>({}),movement,()=>{},600)).reason==='user_owned','auto_blocked_'+name);
        await wait(80);
        const large=await win.webContents.executeJavaScript(`(()=>{const c=view.shadowRoot.querySelector('.assistant-container,.ask-container,.settings-container');return {viewport:[innerWidth,innerHeight],container:[c.clientWidth,c.clientHeight]}})()`);
        check(Math.abs(large.container[1]-large.viewport[1])<=2,'large_height_fill_'+name);
        check(large.container[0]>=large.viewport[0]-20,'large_width_fill_'+name);
        measurements.push({name,large});
        if(name==='ask')check(await win.webContents.executeJavaScript("view.shadowRoot.textContent.includes('No suggestion right now')"),'friendly_empty');
        // Synthetic native edge events exercise the production intent path; physical pointer checks are separate.
        win.emit('will-resize');win.setBounds({...win.getBounds(),width:min[0],height:min[1]});win.emit('resized');await wait(80);
        const metrics=await win.webContents.executeJavaScript(`(()=>{const r=view.shadowRoot,c=r.querySelector('.assistant-container,.ask-container,.settings-container');c.scrollTop=1000;const scrolled=c.scrollTop;c.scrollTop=0;return {dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],container:[c.clientWidth,c.clientHeight],scroll:c.scrollHeight,scrolled,owner:view.sizeOwner,reset:!!r.querySelector('window-size-controls')};})()`);
        check(metrics.scrolled>0,'minimum_scroll_'+name);
        check(metrics.dpr===1.75&&metrics.owner==='user','native_state_'+name);
        check(metrics.container[0]<=metrics.viewport[0]+2&&metrics.container[1]<=metrics.viewport[1]+2,'viewport_fit_'+name);
        measurements.push({name,...metrics});
        const evidence=path.resolve(root,'../docs/wire3-phase3-evidence');fs.mkdirSync(evidence,{recursive:true});
        fs.writeFileSync(path.join(evidence,`${name}-minimum-${coordinator}.png`),(await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript("view.shadowRoot.querySelector('window-size-controls').shadowRoot.querySelector('button').click()");await wait(80);
        check(policy.state().owner==='automatic','reset_ipc_'+name);
        check(new WindowSizeStore(path.join(directory,'sizes.json')).get(name).owner==='automatic','reset_persisted_'+name);
        if(name==='listen'){
            win.emit('will-resize');win.setBounds({...win.getBounds(),width:640,height:900});win.emit('resized');
            for(const mode of ['transcript','insights']){
                const local=await win.webContents.executeJavaScript(`(async()=>{view.listenState={source:'local',phase:'idle'};view.viewMode='${mode}';await view.updateComplete;await new Promise(r=>setTimeout(r,30));const host=view.shadowRoot.querySelector('${mode==='transcript'?'stt-view':'summary-view'}');await host.updateComplete;const pane=host.shadowRoot.querySelector('${mode==='transcript'?'.transcription-container':'.insights-container'}');pane.textContent='Synthetic local content '.repeat(4000);pane.scrollTop=100;return {host:host.clientHeight,pane:pane.getBoundingClientRect().height,client:pane.clientHeight,scrolled:pane.scrollTop};})()`);
                measurements.push({localMode:mode,...local});
                check(Math.abs(local.host-local.pane)<=2,'local_fill_'+mode);check(local.scrolled>0,'local_scroll_'+mode);
            }
        }
        win.emit('will-resize');win.setBounds({...win.getBounds(),width:640,height:480});win.emit('resized');
    }
    console.log('SIZING_NATIVE:'+JSON.stringify({mode,windows:pool.size,measurements}));
}).catch(error=>console.log('SIZING_NATIVE:'+JSON.stringify({error:/^[a-z_]+$/.test(error.message)?error.message:'native_fixture_failure',measurements}))).finally(()=>{for(const win of pool.values())if(!win.isDestroyed())win.destroy();app.exit(0)});

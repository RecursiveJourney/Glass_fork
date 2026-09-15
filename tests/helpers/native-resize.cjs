// Native Windows constraints, isolated from providers, capture, profiles and the live feed.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const electron=require('electron'),{app,BrowserWindow}=electron;
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'glass-native-resize-')));
app.commandLine.appendSwitch('force-device-scale-factor','1.75');
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const root=path.resolve(__dirname,'../..'),bridge=new EventEmitter(),cache=new Map(),windows=[];
function NativeWindow(options){
    const w=new BrowserWindow({...options,show:false,alwaysOnTop:false,focusable:false,
        webPreferences:{nodeIntegration:false,contextIsolation:true}});
    windows.push(w);let visible=options.show!==false;
    w.show=()=>{visible=true;};w.hide=()=>{visible=false;};w.isVisible=()=>visible;
    w.loadFile=()=>Promise.resolve();w.setAlwaysOnTop=()=>{};return w;
}
function load(name){
    if(cache.has(name))return cache.get(name);
    const file=path.join(root,'src/window',name+'.js'),mod={exports:{}};
    const stubs={electron:{...electron,BrowserWindow:NativeWindow,app:{isPackaged:true,getPath:name=>app.getPath(name)}},
        '../bridge/internalBridge':bridge,'../features/shortcuts/shortcutsService':{initialize(){},registerShortcuts(){}},
        '../features/common/repositories/permission':{}};
    vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:mod,exports:mod.exports,__dirname:path.dirname(file),
        require:id=>Object.hasOwn(stubs,id)?stubs[id]:id.startsWith('./')?load(id.slice(2)):require(id),
        process:{platform:'win32',env:{}},Date,setTimeout,clearTimeout,console:{log(){},warn(){},error(){}}},{filename:file});
    cache.set(name,mod.exports);return mod.exports;
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
    const result={};
    try{
        const api=load('windowManager');api.createWindows();api.handleHeaderStateChanged('main');
        const header=api.windowPool.get('header');
        await header.loadURL('data:text/html,<style>html,body{margin:0;overflow:hidden}</style><div style="width:462px;height:47px"></div>');
        result.headerInitial={bounds:header.getBounds(),min:header.getMinimumSize(),max:header.getMaximumSize()};
        const headerReply=await api.resizeHeaderWindow({width:462,height:47});
        result.headerGrown={bounds:header.getBounds(),min:header.getMinimumSize(),max:header.getMaximumSize(),ack:headerReply};
        await header.webContents.capturePage();
        result.headerViewport=await header.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
        await api.resizeHeaderWindow({width:520,height:47});
        await api.resizeHeaderWindow({width:462,height:47});
        result.headerRepeated={bounds:header.getBounds(),cached:load('windowBounds').getWindowBounds(header)};
        const w=api.windowPool.get('listen');
        api.adjustWindowHeight('listen',223);await wait(550);
        result.locked={height:w.getBounds().height,min:w.getMinimumSize(),max:w.getMaximumSize(),resizable:w.isResizable()};
        const response=api.adjustWindowHeight('listen',614);
        await wait(550);result.grown={height:w.getBounds().height,resizable:w.isResizable(),ack:await response};
        const cap=api.adjustWindowHeight('listen',1000);await wait(550);
        result.capped={height:w.getBounds().height,resizable:w.isResizable(),ack:await cap};
        await api.adjustWindowHeight('listen',614);
        w.show();bridge.emit('listen:source-changed',{source:'meeting'});
        api.showSettingsWindow();await wait(400);
        const settings=api.windowPool.get('settings');
        result.meetingSettings={settings:settings.getBounds(),listen:w.getBounds()};
        bridge.emit('window:requestVisibility',{name:'ask',visible:true});await wait(550);
        result.meetingSettingsWithAsk={settings:settings.getBounds(),listen:w.getBounds(),ask:api.windowPool.get('ask').getBounds()};
        console.log('NATIVE_RESIZE:'+JSON.stringify(result));
    }catch{console.log('NATIVE_RESIZE:'+JSON.stringify({failed:true}));}
    finally{for(const w of windows)if(!w.isDestroyed())w.destroy();app.exit(0);}
});

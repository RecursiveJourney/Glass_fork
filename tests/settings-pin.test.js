const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('pin IPC accepts only the actual local header main frame without payload',()=>{
 const handlers=new Map(),frame={},sender={mainFrame:frame,getURL:()=> 'file:///fixture/src/ui/app/header.html'};
 let calls=0;const manager={windowPool:new Map([['header',{webContents:sender,isDestroyed:()=>false}]]),toggleSettingsPinned:()=>calls++};
 const stubs={electron:{ipcMain:{handle(){},on:(n,fn)=>handlers.set(n,fn)},app:{getAppPath:()=>'/fixture'}},'../window/windowManager':manager,'../window/windowBounds':{}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bridge/windowBridge.js'),'utf8'),{module,require:id=>stubs[id],URL});module.exports.initialize();
 const handler=handlers.get('settings:toggle-pin');assert.equal(typeof handler,'function');
 handler({sender,senderFrame:frame});assert.equal(calls,1);
 handler({sender,senderFrame:{} });handler({sender,senderFrame:frame},{pinned:true});handler({sender:{},senderFrame:frame});
 sender.getURL=()=> 'https://example.test/';handler({sender,senderFrame:frame});assert.equal(calls,1);
});
test('header click toggles pin while enter/leave retain upstream hover commands and drag suppression',()=>{
 let Header,calls=[];const source=fs.readFileSync(path.join(__dirname,'../src/ui/app/MainHeader.js'),'utf8');
 vm.runInNewContext(source.replace(/^import .*;\r?\n/gm,'').replace('export class MainHeader','class MainHeader'),{LitElement:class{},html:String.raw,css:String.raw,customElements:{define(n,v){Header=v}},window:{api:{mainHeader:{toggleSettingsPinned:()=>calls.push('pin'),showSettingsWindow:()=>calls.push('show'),hideSettingsWindow:()=>calls.push('hide')}}},console:{log(){}}});
 const h=Object.create(Header.prototype);h.toggleSettingsPinned();h.showSettingsWindow();h.hideSettingsWindow();assert.deepEqual(calls,['pin','show','hide']);
 h.wasJustDragged=true;h.toggleSettingsPinned();assert.equal(calls.length,3);
 assert.match(source,/@click=\$\{[^\n]*this\.toggleSettingsPinned\(/);
 const preload=fs.readFileSync(path.join(__dirname,'../src/preload.js'),'utf8');assert.match(preload,/toggleSettingsPinned:.*send\('settings:toggle-pin'\)/);
});

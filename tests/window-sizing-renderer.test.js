const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('views expose Reset and switch off automatic measurement in user-owned mode',()=>{
    for(const [directory,name] of [['listen','ListenView'],['ask','AskView'],['settings','SettingsView']]){
        const source=fs.readFileSync(path.join(__dirname,'../src/ui',directory,name+'.js'),'utf8');
        assert.ok(source.includes('<window-size-controls>'),name+' reset entry');
        assert.ok(source.includes("import '../app/WindowSizeControls.js'"),name+' registered component');
        assert.ok(source.includes(':host([user-sized])'),name+' viewport layout');
    }
});
test('reconnected sizing controls ignore the previous mount read',async()=>{
    let Control;const pending=[];
    const source=fs.readFileSync(path.join(__dirname,'../src/ui/app/WindowSizeControls.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class WindowSizeControls','class WindowSizeControls');
    vm.runInNewContext(source,{LitElement:class{connectedCallback(){} disconnectedCallback(){}},html:String.raw,css:String.raw,customElements:{define(n,v){Control=v}},window:{api:{windowSizing:{onChanged:()=>()=>{},get:()=>new Promise(r=>pending.push(r))}}}});
    const control=new Control(),applied=[];control.apply=s=>applied.push(s.owner);
    control.connectedCallback();control.disconnectedCallback();control.connectedCallback();
    pending[0]({data:{owner:'automatic'}});await Promise.resolve();assert.deepEqual(applied,[]);
    pending[1]({data:{owner:'user'}});await Promise.resolve();assert.deepEqual(applied,['user']);
});
test('Ask renders exact sentinel as friendly text without changing raw response',()=>{
    let View;const source=fs.readFileSync(path.join(__dirname,'../src/ui/ask/AskView.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class AskView','class AskView');
    vm.runInNewContext(source,{LitElement:class{},html:String.raw,css:String.raw,customElements:{define(n,v){View=v;}},window:{},console,setTimeout,clearTimeout});
    const container={innerHTML:''};const view=Object.create(View.prototype);view.shadowRoot={getElementById:()=>container};view.resetStreamingParser=()=>{};
    view.currentResponse='[no suggestion]'; view.isLoading=false;view.renderContent();
    assert.ok(container.innerHTML.includes('No suggestion right now'));
    assert.equal(view.currentResponse,'[no suggestion]');
    view.isLoading=true;view.renderContent();assert.ok(container.innerHTML.includes('loading-dots'));
    view.isLoading=false;let rendered;view.renderStreamingMarkdown=()=>{rendered=view.currentResponse};view.adjustWindowHeightThrottled=()=>{};
    for(const response of ['Normal answer','[no suggestion] followed by text']){view.currentResponse=response;view.renderContent();assert.equal(rendered,response);}
});

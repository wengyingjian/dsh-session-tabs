import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {domFixture,TestContext} from './dom-fixture.mjs';
const source=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
const plain=x=>JSON.parse(JSON.stringify(x));
class Observable{
  constructor(value){this.value=value;this.listeners=new Set();}
  getSnapshot(){return this.value;}
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  emit(){[...this.listeners].forEach(fn=>fn());}
}
function load(extra={}){
  let registration;
  const window=extra.window||{};window.__ModuleLoader__={load(r){registration=r;}};
  const sandbox={window,console,setTimeout,clearTimeout,Map,Set,Promise,...extra};sandbox.window=window;
  vm.runInNewContext(source,sandbox,{filename:'client.js'});
  return {registration,plugin:registration.factory(id=>{assert.equal(id,'react');return {createElement(){},useState(){return [0,()=>{}];},useEffect(){}};}),sandbox,window};
}
function fixture(opts={}){
  const {plugin}=load();
  const list=new Observable({phase:opts.phase||'ready',ids:['a','b','c'],byId:{a:{id:'a',displayTitle:'A',blank:false,running:false,retainedBy:{mainView:1}},b:{id:'b',displayTitle:'B',blank:false,running:false,retainedBy:{}},c:{id:'c',displayTitle:'C',blank:false,running:false,retainedBy:{}}}});
  const status=new Observable(new Map()),workspaces=new Observable({items:[],archivedSessionIds:[]}),panel=new Observable({activePanelId:null});
  const calls=[],refs=[],values=new Map();if(opts.raw)values.set(plugin.storageKey,opts.raw);
  const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>{values.set(k,v);}};
  const services={sessions:{list,retain(id,options){
    calls.push(['retain',id,options.source]);
    const r={id,released:false,ready:opts.rejectReady?Promise.reject(new Error('open failed')):Promise.resolve(),release(){if(r.released)return;r.released=true;const row=list.value.byId[id];if(row){delete row.retainedBy[options.source];list.emit();}}};refs.push(r);
    list.value.byId[id].retainedBy[options.source]=1;list.emit();return r;
  }},uiSession:{sessionStatus:status},workspaces:{list:workspaces},layout:{panelInfo:panel},uiWorkspace:{
    openSession(id){if(opts.failOpen)throw new Error('navigation failure');calls.push(['open',id]);Object.values(list.value.byId).forEach(row=>delete row.retainedBy.mainView);list.value.byId[id].retainedBy.mainView=1;list.emit();},
    startSession(){calls.push(['new']);if(opts.noCreate)return;const id='new'+calls.length;list.value.byId[id]={id,displayTitle:'new',blank:true,retainedBy:{}};services.uiWorkspace.openSession(id);}
  }};
  // The service guard rejects undeclared injection, unlike a permissive plain ctx.
  const ctx=new Proxy({}, {get(_,key){assert.ok(plugin.inject.includes(key),'undeclared service '+String(key));return services[key];}});
  const controller=plugin.createController(ctx,{storage,lang:()=>opts.lang||'en'});
  return {plugin,ctx,services,controller,list,status,workspaces,panel,calls,refs,storage,values};
}
test('published module shape, lazy import, declared services and metadata',()=>{
  const r=load();assert.equal(r.registration.id,pkg.name);assert.equal(typeof r.plugin.apply,'function');assert.equal(r.plugin.default,undefined);assert.deepEqual(Object.keys(r.window),['__ModuleLoader__']);
  for(const file of [pkg.main,pkg.icon,pkg.dsh.bundle.patch,pkg.exports['./client']])assert.ok(readFileSync(new URL('../'+file,import.meta.url)).length);
  assert.equal(pkg.dsh.client.platform,'web');
});
test('parse rejects malformed, future and unsafe data; de-duplicates and bounds IDs',()=>{
  const {plugin}=load();assert.deepEqual(plain(plugin.parse('{')), {version:1,enabled:true,ids:[],active:null,pins:[]});
  assert.equal(plugin.parse('{"version":2,"ids":["x"]}').ids.length,0);
  const state=plugin.parse({version:1,ids:['a','a','',3,null,'\u0000',...Array.from({length:250},(_,i)=>'s'+i)],active:'a'});
  assert.equal(state.ids.length,200);assert.equal(state.ids[0],'a');assert.equal(state.active,'a');assert.deepEqual(plain(plugin.parse(plugin.serialize(state))),plain(state));
});
test('initial active reference has its own source; inactive restored IDs do not open history',()=>{
  const f=fixture({raw:'{"version":1,"ids":["a","b","c"],"active":"a"}'});
  assert.deepEqual(f.calls,[['retain','a','dsh-session-tabs']]);assert.equal(f.controller.snapshot().retained,1);assert.equal(f.list.value.byId.a.retainedBy.mainView,1);
  f.controller.dispose();
});
test('restore once after ready, prune removed IDs, and do not steal focus later',()=>{
  const f=fixture({phase:'pending',raw:'{"version":1,"ids":["a","b","gone"],"active":"b"}'});
  assert.equal(f.calls.some(c=>c[0]==='open'),false);f.list.value.phase='ready';f.list.emit();
  assert.equal(f.controller.snapshot().active,'b');assert.deepEqual(plain(f.controller.snapshot().ids),['a','b']);
  f.controller.open('a');f.list.emit();assert.equal(f.controller.snapshot().active,'a');f.controller.dispose();
});
test('native navigation and per-session input lifecycle survive switching',()=>{
  const f=fixture();f.controller.open('b');assert.equal(f.controller.snapshot().active,'b');
  assert.equal(f.refs.filter(r=>!r.released).length,2);assert.equal(f.list.value.byId.a.retainedBy.mainView,undefined);
  assert.equal(f.list.value.byId.a.retainedBy['dsh-session-tabs'],1);f.controller.dispose();
});
test('opening a tab navigates first and takes its keepalive ref only after the switch settles',()=>{
  const f=fixture();f.controller.open('b');
  const openAt=f.calls.findIndex(c=>c[0]==='open'&&c[1]==='b');
  const retainAt=f.calls.findIndex(c=>c[0]==='retain'&&c[1]==='b');
  assert.ok(openAt>=0&&retainAt>openAt,'retain must follow navigation, not sit on the click path');
  assert.equal(f.refs.find(r=>r.id==='b').released,false);f.controller.dispose();
});
test('closing a running tab never cancels and retains it until idle',()=>{
  const f=fixture();f.controller.open('b');f.list.value.byId.a.running=true;f.status.value.set('a',{running:true});f.status.emit();
  f.controller.close('a');assert.equal(f.controller.snapshot().ids.includes('a'),false);assert.equal(f.refs.find(r=>r.id==='a').released,false);
  assert.equal(f.calls.some(c=>['cancel','delete','archive'].includes(c[0])),false);
  f.list.value.byId.a.running=false;f.status.value.set('a',{running:false});f.status.emit();assert.equal(f.refs.find(r=>r.id==='a').released,true);f.controller.dispose();
});
test('pending interaction outranks running and closing preserves its ownership',()=>{
  const f=fixture();f.controller.open('b');f.status.value.set('a',{running:true,pendingInteraction:{key:'approval-a'}});f.status.emit();assert.equal(f.controller.status('a'),'pending');
  f.controller.close('a');assert.equal(f.refs.find(r=>r.id==='a').released,false);f.controller.dispose();
});
test('bulk close keeps running, pending, unread and manually pinned tabs',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  f.list.value.byId.a.running=true;f.status.value.set('a',{running:true});f.status.emit();
  f.status.value.set('b',{running:true,pendingInteraction:{key:'approval-b'}});f.status.emit();
  assert.equal(f.controller.closeOthers('c'),false,'every other tab is guarded');
  assert.deepEqual(plain(f.controller.snapshot().ids),['a','b','c']);assert.equal(f.controller.snapshot().active,'c');
  f.status.value.set('b',{running:false,completionUnread:true});f.status.emit();
  assert.equal(f.controller.closeOthers('c'),false,'unread completion is guarded too');
  f.controller.pin('a');
  assert.equal(f.controller.closeOthers('c'),false,'manual pin is guarded too');
  assert.equal(f.refs.find(r=>r.id==='a').released,false);assert.equal(f.refs.find(r=>r.id==='b').released,false);
  assert.equal(f.calls.some(c=>['cancel','delete','archive'].includes(c[0])),false);f.controller.dispose();
});
test('bulk close still removes the unguarded tabs and keeps the anchor current',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  assert.equal(f.controller.closeOthers('a'),true);
  assert.deepEqual(plain(f.controller.snapshot().ids),['a']);assert.equal(f.controller.snapshot().active,'a');
  f.controller.dispose();
});
test('close left and right stop at the edges and move the current tab only when it is closed',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  assert.equal(f.controller.closeLeft('a'),false);assert.equal(f.controller.closeRight('c'),false);
  assert.deepEqual(plain(f.controller.snapshot().ids),['a','b','c']);assert.equal(f.controller.snapshot().active,'c');
  assert.equal(f.controller.closeLeft('b'),true);
  assert.deepEqual(plain(f.controller.snapshot().ids),['b','c']);assert.equal(f.controller.snapshot().active,'c');
  assert.equal(f.controller.closeRight('b'),true);
  assert.deepEqual(plain(f.controller.snapshot().ids),['b']);assert.equal(f.controller.snapshot().active,'b');
  assert.equal(f.calls.some(c=>['cancel','delete','archive'].includes(c[0])),false);f.controller.dispose();
});
test('bulk close unwinds through the shared closed stack',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');f.controller.closeOthers('a');
  assert.deepEqual(plain(f.controller.snapshot().ids),['a']);
  f.controller.reopen();assert.deepEqual(plain(f.controller.snapshot().ids),['a','c']);
  f.controller.reopen();assert.deepEqual(plain(f.controller.snapshot().ids),['a','c','b']);f.controller.dispose();
});
test('close active selects a neighbour; final close creates a blank without readding the old tab',()=>{
  const f=fixture();f.controller.open('b');f.controller.close('b');assert.equal(f.controller.snapshot().active,'a');
  f.controller.close('a');assert.ok(f.controller.snapshot().active.startsWith('new'));assert.equal(f.controller.snapshot().ids.includes('a'),false);f.controller.dispose();
});
test('new command reopens a closed blank even when native startSession reuses it',()=>{
  const f=fixture();f.list.value.byId.a.blank=true;f.controller.close('a');assert.equal(f.controller.snapshot().ids.length,0);
  f.services.uiWorkspace.startSession=()=>{};f.controller.newSession();assert.deepEqual(plain(f.controller.snapshot().ids),['a']);f.controller.dispose();
});
test('reopen and reorder preserve identity and active selection',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');f.controller.reorder('c','a');assert.deepEqual(plain(f.controller.snapshot().ids),['c','a','b']);
  f.controller.move('c',1);assert.deepEqual(plain(f.controller.snapshot().ids),['a','c','b']);assert.equal(f.controller.move('a',-1),false);
  f.controller.close('a');f.controller.reopen();assert.ok(f.controller.snapshot().ids.includes('a'));f.controller.dispose();
});
test('archived session is not navigated; host deletion and archive prune tabs',()=>{
  const f=fixture({raw:'{"version":1,"ids":["a","b","c"],"active":"a"}'});f.workspaces.value.archivedSessionIds=['b'];f.workspaces.emit();
  assert.equal(f.controller.open('b'),false);assert.equal(f.calls.some(c=>c[0]==='open'&&c[1]==='b'),false);
  delete f.list.value.byId.c;f.list.emit();assert.equal(f.controller.snapshot().ids.includes('c'),false);f.controller.dispose();
});
test('cross-window storage updates never change native current session',()=>{
  const f=fixture();f.controller.external('{"version":1,"enabled":true,"ids":["b","a"],"active":"b"}');
  assert.equal(f.controller.snapshot().active,'a');assert.equal(f.calls.some(c=>c[0]==='open'),false);assert.deepEqual(plain(f.controller.snapshot().ids),['b','a']);f.controller.dispose();
});
test('native view preserves draft ownership, survives private storage errors, and restores',()=>{
  const f=fixture();f.storage.setItem=()=>{throw Error('quota');};f.controller.setEnabled(false);assert.equal(f.controller.snapshot().enabled,false);assert.equal(f.refs[0].released,false);
  f.controller.setEnabled(true);assert.equal(f.controller.snapshot().enabled,true);assert.ok(f.refs.some(r=>!r.released));f.controller.dispose();
});
test('ready or navigation failure degrades to a notice without stopping native UI',async()=>{
  const f=fixture({rejectReady:true,failOpen:true});await Promise.resolve();assert.equal(f.controller.snapshot().notice,'Session unavailable');
  assert.equal(f.controller.open('b'),false);assert.equal(f.controller.snapshot().notice,'Could not open session');f.controller.dispose();
});
test('status projection includes completion and reconnect baseline without duplicate retains',()=>{
  const f=fixture();f.controller.open('b');f.status.value.set('a',{running:false,completionUnread:true});f.status.emit();assert.equal(f.controller.status('a'),'done');
  const count=f.calls.filter(c=>c[0]==='retain').length;f.list.emit();f.list.emit();assert.equal(f.calls.filter(c=>c[0]==='retain').length,count);f.controller.dispose();
});
test('dispose releases each reference once and removes every observable subscription',()=>{
  const f=fixture();f.controller.open('b');f.controller.dispose();f.controller.dispose();assert.ok(f.refs.every(r=>r.released));
  for(const observable of [f.list,f.status,f.workspaces,f.panel])assert.equal(observable.listeners.size,0);
});
test('implementation forbids client cloning, sidebar replacement, global keys and unscoped CSS',()=>{
  assert.doesNotMatch(source,/createElement\(['"]iframe|<iframe|window\.open\(|sidebarRight\.|name:\s*['"](?:rightbar|sidebar|root|main)['"]/);
  assert.doesNotMatch(source,/(?:document|window)\.addEventListener\(['"]keydown/);assert.match(source,/e\.isComposing\|\|e\.keyCode===229/);
  const {plugin}=load();assert.doesNotMatch(plugin.CSS,/[A-Za-z0-9_]{6,}_(?:root|header|frame)/);assert.match(plugin.CSS,/-webkit-app-region:no-drag/);
});
function mounted(setup,opts){const f=fixture(opts);f.controller.dispose();const dom=domFixture();setup?.(dom);const {plugin,window}=load(dom.extra);const ctx=new TestContext(f.services,plugin.inject);plugin.apply(ctx);dom.flush();return {...f,dom,plugin,window,ctx};}
test('without the host menu service right-click keeps the native behaviour',()=>{
  const f=mounted(),host=f.dom.center.firstChild,cell=host.querySelector('[data-dsst-tab]');
  let prevented=false;
  f.dom.dispatch(cell.querySelector('[data-dsst-action="open"]'),'contextmenu',{clientX:10,clientY:10,preventDefault(){prevented=true;}});
  assert.equal(prevented,false,'no menu service must leave the native right-click alone');f.ctx.dispose();
});
test('right-clicking a tab opens the host menu scoped to that tab without switching',()=>{
  const raw='{"version":1,"ids":["a","b","c"],"active":"a"}';
  const f=mounted(dom=>{dom.window.localStorage={getItem:key=>key==='dsh-session-tabs.v1'?raw:null,setItem(){}};});
  const seen=[];f.services.contextMenus={register:input=>{seen.push({registered:input});return()=>seen.push({off:true});},open:(target,point)=>seen.push({open:target,point})};
  const host=f.dom.center.firstChild,cell=host.querySelector('[data-dsst-tab="a"]'),select=cell.querySelector('[data-dsst-action="open"]');
  let prevented=false;
  f.dom.dispatch(select,'contextmenu',{clientX:120,clientY:30,preventDefault(){prevented=true;}});
  assert.equal(prevented,true,'a handled right-click keeps the native menu closed');
  const registered=seen.find(x=>x.registered).registered,open=seen.find(x=>x.open);
  assert.equal(registered.target,'dsh-session-tabs.tab');
  assert.deepEqual(plain(open.open),{kind:'dsh-session-tabs.tab',value:{id:'a'}});assert.deepEqual(plain(open.point),{x:120,y:30});
  assert.equal(f.calls.some(c=>c[0]==='open'&&c[1]==='a'),false,'right-click must not switch tabs');
  assert.deepEqual(plain(registered.resolve({id:'a'}).map(a=>[a.id,a.disabled,a.label])),[
    ['pin',null,'置顶'],['close-others',false,'关闭其他'],['close-left',true,'关闭左侧'],['close-right',false,'关闭右侧']]);
  assert.deepEqual(plain(registered.resolve({id:'b'}).map(a=>a.disabled)),[null,false,false,false]);
  const actions=registered.resolve({id:'a'});
  let revealed=null;cell.scrollIntoView=()=>{revealed='a';};
  actions[0].run();
  assert.deepEqual(plain(f.window.__dshSessionTabs.snapshot().pins),['a']);
  assert.equal(revealed,'a','pinning reveals the tab now sitting at the strip head');
  assert.equal(registered.resolve({id:'a'})[0].label,'取消置顶');
  assert.equal(registered.resolve({id:'a'})[1].label,'关闭其他');
  registered.resolve({id:'a'})[1].run();
  assert.deepEqual(plain(f.window.__dshSessionTabs.snapshot().ids),['a']);
  assert.deepEqual(plain(f.window.__dshSessionTabs.snapshot().pins),['a'],'a pinned anchor cannot be bulk closed');
  f.window.__dshSessionTabs.dispose();
  assert.equal(seen.some(x=>x.off),true,'dispose must unregister the menu contribution');
});
test('actual apply mounts only the center and leaves both native sidebar nodes intact',()=>{
  const f=mounted();assert.equal(f.dom.center.firstChild.getAttribute('data-dsh-session-tabs'),'');assert.equal(f.dom.native.getAttribute('data-dsh-session-tabs-main'),'');
  assert.equal(f.dom.left.textContent,'native left');assert.equal(f.dom.right.textContent,'native right');assert.deepEqual(f.dom.left.attrs,{'data-slot':'sidebar'});assert.deepEqual(f.dom.right.attrs,{'data-slot':'rightbar'});
  assert.equal(f.ctx.registrations[0].meta.name,'sidebar.footer.action');assert.equal(f.dom.doc.querySelectorAll('[data-dsh-session-tabs]').length,1);f.ctx.dispose();
});
test('actual apply is idempotent and dispose removes DOM, styles, listeners, observers and refs',()=>{
  const f=mounted();f.plugin.apply(f.ctx);assert.equal(f.ctx.cleanups.length,1);f.ctx.dispose();f.dom.flush();
  assert.equal(f.dom.doc.querySelectorAll('[data-dsh-session-tabs]').length,0);assert.equal(f.dom.doc.querySelectorAll('[data-plugin="dsh-session-tabs"]').length,0);
  assert.equal(f.dom.center.hasAttribute('data-dsh-session-tabs-column'),false);assert.equal(f.dom.native.hasAttribute('data-dsh-session-tabs-main'),false);assert.equal(f.window.__dshSessionTabs,undefined);
  assert.equal(f.ctx.registrations.length,0);assert.ok(f.dom.observers.every(o=>o.stopped));assert.equal(f.dom.window.listeners.get('storage').size,0);assert.equal(f.dom.doc.listeners.get('pointerdown')?.size||0,0);assert.equal(f.list.listeners.size,0);
});
test('native mode and global panels restore original center sizing and hide only the strip',()=>{
  const f=mounted();f.window.__dshSessionTabs.enable(false);f.dom.flush();assert.equal(f.dom.center.firstChild.hidden,true);assert.equal(f.dom.native.hasAttribute('data-dsh-session-tabs-main'),false);
  f.window.__dshSessionTabs.enable(true);f.panel.value.activePanelId='settings';f.panel.emit();f.dom.flush();assert.equal(f.dom.center.firstChild.hidden,true);
  f.panel.value.activePanelId=null;f.panel.emit();f.dom.flush();assert.equal(f.dom.center.firstChild.hidden,false);f.ctx.dispose();
});
test('own mutations do not schedule an observer-render loop, and keyboard events are IME guarded',()=>{
  const f=mounted(),host=f.dom.center.firstChild,button=host.querySelector('[data-dsst-action="open"]');
  f.dom.observers[0].fn([{target:host}]);assert.equal(f.dom.timers.size,0);
  f.dom.observers[0].fn([{target:f.dom.native}]);assert.equal(f.dom.timers.size,0,'streaming chat mutations should not remount the strip');
  const before=f.calls.length;host.dispatch('keydown',{target:button,key:'ArrowRight',isComposing:true,preventDefault(){throw Error('IME must not be captured');}});assert.equal(f.calls.length,before);
  assert.equal(f.dom.doc.listeners.has('keydown'),false);f.ctx.dispose();
});
test('conversation remount re-marks the flex body synchronously, before the coalesced refresh',()=>{
  const f=mounted(),dom=f.dom,conv=dom.main.firstChild;
  const old=dom.native,fresh=dom.doc.createElement('div');
  conv.append(fresh);old.remove();
  dom.observers[0].fn([{type:'childList',target:conv,removedNodes:[old],addedNodes:[fresh]}]);
  assert.equal(fresh.hasAttribute('data-dsh-session-tabs-main'),true,'the new body must be marked in the same microtask');
  assert.equal(old.hasAttribute('data-dsh-session-tabs-main'),false);
  f.ctx.dispose();
});
test('replacing chat with a global panel does not create a hidden-attribute observer loop',()=>{
  const f=mounted(),dom=f.dom,host=dom.center.firstChild,old=dom.native;
  let hidden=host.hidden,writes=0;const mutations=[];
  // Like a browser, assigning HTMLElement.hidden queues an attribute mutation even if unchanged.
  Object.defineProperty(host,'hidden',{get:()=>hidden,set:value=>{hidden=!!value;writes++;mutations.push({type:'attributes',attributeName:'hidden',target:host});}});
  try{
    f.panel.value.activePanelId='plugins';f.panel.emit();
    const page=dom.doc.createElement('div');dom.main.replaceChildren(page);
    dom.observers[0].fn([{type:'childList',target:dom.main,removedNodes:[old],addedNodes:[page]}]);
    dom.flush();
    for(let round=0;round<20&&mutations.length;round++)dom.observers[0].fn(mutations.splice(0));
    assert.equal(mutations.length,0,'own hidden mutations must settle instead of starving the renderer');
    assert.ok(writes<=2,'hiding a global panel must not repeatedly mount a detached chat body');
    assert.equal(host.hidden,true);assert.equal(page.hasAttribute('data-dsh-session-tabs-main'),false);
    f.panel.value.activePanelId=null;dom.main.replaceChildren(old);f.panel.emit();dom.flush();
    assert.equal(host.hidden,false);assert.equal(old.hasAttribute('data-dsh-session-tabs-main'),true);
  }finally{f.ctx.dispose();}
});
function scrollScenario({height=2000,remembered=400}={}){
  const f=mounted(),dom=f.dom,host=dom.center.firstChild;
  const port=dom.doc.createElement('div');port.setAttribute('data-conversation-scroll','');port.scrollHeight=2000;port.clientHeight=500;
  let top=0;const writes=[];
  // Browsers clamp a restore while history is shorter than the viewport plus remembered offset.
  Object.defineProperty(port,'scrollTop',{get:()=>top,set:value=>{top=Math.max(0,Math.min(Number(value)||0,Math.max(0,port.scrollHeight-port.clientHeight)));writes.push({time:dom.time,top});}});
  const region=dom.doc.createElement('div');region.setAttribute('data-conversation-region','chat');region.setAttribute('data-conversation-session','a');
  const transcript=dom.doc.createElement('p'),composer=dom.doc.createElement('textarea'),seat=dom.doc.createElement('div'),widthControl=dom.doc.createElement('div');
  seat.setAttribute('data-composer-seat','');seat.setAttribute('data-conversation-region','composer');seat.append(composer);port.append(transcript,seat);region.append(port,widthControl);dom.native.append(region);
  const navigate=f.services.uiWorkspace.openSession;f.services.uiWorkspace.openSession=id=>{region.setAttribute('data-conversation-session',id);navigate(id);};
  port.scrollTop=remembered;
  const a=host.querySelector('[data-dsst-id="a"]'),plus=host.querySelector('[data-dsst-action="new"]');
  host.dispatch('click',{target:plus});port.scrollTop=0;port.scrollHeight=height;
  host.dispatch('click',{target:a});port.scrollTop=0;
  return {...f,host,port,region,transcript,composer,widthControl,writes,open:id=>host.dispatch('click',{target:host.querySelector('[data-dsst-id="'+id+'"]')})};
}
test('scroll restore waits through a temporarily stable short transcript, then restores after growth',()=>{
  const f=scrollScenario({height:600,remembered:600});try{
    f.dom.advance(100);assert.equal(f.port.scrollTop,100,'the first attempt must really clamp');
    f.dom.advance(120);assert.equal(f.port.scrollTop,100,'history can remain short through another attempt');
    f.port.scrollHeight=2000;f.dom.advance(240);
    assert.equal(f.port.scrollTop,600,'later transcript growth must still permit restoration');
    f.dom.flush();assert.equal(f.dom.timers.size,0);
  }finally{f.ctx.dispose();}
});
test('user wheel input takes priority before the first restore and after a clamped attempt',()=>{
  for(const beforeFirst of [true,false]){
    const f=scrollScenario({height:beforeFirst?2000:600});try{
      f.dom.advance(beforeFirst?50:100);f.dom.dispatch(f.transcript,'wheel',{deltaY:100});f.port.scrollTop=50;
      f.port.scrollHeight=2000;f.dom.advance(2500);
      assert.equal(f.port.scrollTop,50,beforeFirst?'first restore must yield to earlier input':'settling retries must not pull the user back');
      assert.equal(f.dom.timers.size,0);
    }finally{f.ctx.dispose();}
  }
});
test('touch, scrollbar dragging and scrolling keys cancel restoration without consuming input',()=>{
  for(const [type,props] of [['touchstart',{}],['pointerdown',{}],['keydown',{key:'PageUp'}],['keydown',{key:'ArrowUp'}],['keydown',{key:'Home'}],['keydown',{key:'End'}],['keydown',{key:' '}]]){
    const f=scrollScenario();try{
      f.dom.advance(50);let prevented=false;f.dom.dispatch(f.port,type,{...props,preventDefault(){prevented=true;}});f.port.scrollTop=120;f.dom.advance(2500);
      assert.equal(f.port.scrollTop,120,type+' '+(props.key||'')+' must cancel the queued restore');assert.equal(prevented,false,'native input must remain usable');
    }finally{f.ctx.dispose();}
  }
});
test('typing and pointer input in the composer do not cancel transcript restoration',()=>{
  const f=scrollScenario();try{
    f.dom.advance(50);
    for(const [type,props] of [['keydown',{key:'ArrowUp'}],['keydown',{key:' '}],['pointerdown',{}],['touchstart',{}]])f.dom.dispatch(f.composer,type,props);
    f.dom.advance(50);assert.equal(f.port.scrollTop,400);f.dom.flush();
  }finally{f.ctx.dispose();}
});
test('wheel input forwarded by the native width controls also cancels restoration',()=>{
  const f=scrollScenario();try{
    f.dom.advance(50);f.dom.dispatch(f.widthControl,'wheel',{deltaY:100});f.port.scrollTop=80;f.dom.advance(2500);
    assert.equal(f.port.scrollTop,80);
  }finally{f.ctx.dispose();}
});
test('non-scrolling keys and IME composition leave restoration queued',()=>{
  const f=scrollScenario();try{
    for(const props of [{key:'a'},{key:'ArrowUp',isComposing:true},{key:'PageDown',keyCode:229}])f.dom.dispatch(f.transcript,'keydown',props);
    f.dom.advance(100);assert.equal(f.port.scrollTop,400);
  }finally{f.ctx.dispose();}
});
test('a newly mounted transcript observes input before the first restore',()=>{
  const f=scrollScenario();try{
    const next=f.dom.doc.createElement('div');next.setAttribute('data-conversation-scroll','');next.scrollTop=0;next.scrollHeight=2000;next.clientHeight=500;
    f.port.remove();f.region.append(next);f.dom.observers[0].fn([{type:'childList',target:f.region,removedNodes:[f.port],addedNodes:[next]}]);
    f.dom.advance(50);f.dom.dispatch(next,'wheel',{deltaY:100});next.scrollTop=70;f.dom.advance(2500);
    assert.equal(next.scrollTop,70);for(const type of ['wheel','touchstart','pointerdown','keydown'])assert.equal(f.region.listeners.get(type)?.size||0,0);
  }finally{f.ctx.dispose();}
});
test('restoration never writes into a reused region showing another session',()=>{
  const f=scrollScenario();try{
    f.region.setAttribute('data-conversation-session','other');f.port.scrollTop=25;f.dom.advance(2500);
    assert.equal(f.port.scrollTop,25);
  }finally{f.ctx.dispose();}
});
test('an intervening scroll position change also stops restoration when no input event was observed',()=>{
  for(const beforeFirst of [true,false]){
    const f=scrollScenario({height:600});try{
      f.dom.advance(beforeFirst?50:100);f.port.scrollTop=60;f.port.scrollHeight=2000;f.dom.advance(2500);
      assert.equal(f.port.scrollTop,60,'a changed position must not be overwritten by a later attempt');
    }finally{f.ctx.dispose();}
  }
});
test('restoration stops after a bounded wait when history never grows',()=>{
  const f=scrollScenario({height:600});try{
    f.dom.advance(3000);assert.equal(f.port.scrollTop,100);assert.equal(f.dom.timers.size,0,'short content must not leave a permanent retry chain');
    const count=f.writes.length;f.port.scrollHeight=2000;f.dom.advance(10000);
    assert.equal(f.writes.length,count,'timed-out restoration must not resume itself');assert.equal(f.port.scrollTop,100);
  }finally{f.ctx.dispose();}
});
test('switching sessions, native view and disposal cancel outstanding restoration',()=>{
  for(const action of ['session','native','dispose']){
    const f=scrollScenario({height:600});try{
      f.dom.advance(100);
      if(action==='session')f.open(f.window.__dshSessionTabs.snapshot().ids.find(id=>id!=='a'));
      else if(action==='native')f.window.__dshSessionTabs.enable(false);
      else f.ctx.dispose();
      f.port.scrollTop=25;f.port.scrollHeight=2000;f.dom.advance(2500);
      assert.equal(f.port.scrollTop,25,action+' must cancel the pending conversation restore');assert.equal(f.dom.timers.size,0);
      if(action==='dispose')for(const node of [f.dom.doc,f.dom.main,f.region,f.port])for(const type of ['wheel','touchstart','pointerdown','keydown'])assert.equal(node.listeners.get(type)?.size||0,0,'scroll-intent listeners must be removed');
    }finally{f.ctx.dispose();}
  }
});
test('partial mount failure rolls back rather than blocking native UI',()=>{
  const f=fixture();f.controller.dispose();const dom=domFixture();dom.extra.window.getComputedStyle=()=>{throw Error('bad native structure');};
  const {plugin,window}=load(dom.extra);const ctx=new TestContext(f.services,plugin.inject);assert.doesNotThrow(()=>plugin.apply(ctx));dom.flush();
  assert.equal(window.__dshSessionTabs,undefined);assert.equal(dom.doc.querySelectorAll('[data-dsh-session-tabs]').length,0);assert.equal(f.list.listeners.size,0);assert.equal(ctx.warnings.length,1);
});
test('status, title and selection updates preserve tab nodes and focused controls',()=>{
  const f=mounted(),host=f.dom.center.firstChild,a=host.querySelector('[data-dsst-id="a"]'),plus=host.querySelector('[data-dsst-action="new"]');
  a.focus();f.status.value.set('a',{running:true});f.status.emit();f.dom.flush();
  assert.equal(host.querySelector('[data-dsst-id="a"]'),a);assert.equal(f.dom.doc.activeElement,a);
  f.list.value.byId.a.displayTitle='renamed';f.list.emit();f.dom.flush();assert.equal(a.textContent.includes('renamed'),true);
  host.dispatch('click',{target:plus});assert.equal(host.querySelector('[data-dsst-id="a"]'),a);
  assert.equal(host.querySelector('[data-dsst-action="new"]'),plus);assert.equal(host.querySelectorAll('[data-dsst-tab]').length,2);
  f.ctx.dispose();
});
test('removing options keeps native fallback and strip-local reopen, with IME guarding',()=>{
  const f=mounted(),host=f.dom.center.firstChild,plus=host.querySelector('[data-dsst-action="new"]');
  assert.equal(host.querySelector('[data-dsst-action="menu"]'),null);assert.equal(f.ctx.registrations[0].meta.id,'dsh-session-tabs:mode');
  host.dispatch('click',{target:plus});const id=f.window.__dshSessionTabs.snapshot().active;
  host.dispatch('click',{target:host.querySelectorAll('[data-dsst-action="close"]').find(b=>b.getAttribute('data-dsst-id')===id)});
  assert.equal(f.window.__dshSessionTabs.snapshot().ids.includes(id),false);
  host.dispatch('keydown',{target:plus,key:'T',metaKey:true,shiftKey:true,isComposing:true,preventDefault(){throw Error('IME must not be captured');}});
  assert.equal(f.window.__dshSessionTabs.snapshot().ids.includes(id),false);
  host.dispatch('keydown',{target:plus,key:'T',metaKey:true,shiftKey:true,preventDefault(){}});
  assert.equal(f.window.__dshSessionTabs.snapshot().active,id);assert.equal(f.dom.doc.listeners.has('keydown'),false);
  const list=host.querySelector('[role="tablist"]');f.ctx.dispose();assert.equal(list.listeners.get('scroll').size,0);
});
test('top panel controls relay native clicks, track native state and restore originals',()=>{
  let bottom,right,other,bottomClicks=0,rightClicks=0;
  const f=mounted(dom=>{
    bottom=dom.doc.createElement('button');bottom.setAttribute('data-dsh-bottom-toggle','');bottom.setAttribute('aria-label','展开底部面板');bottom.setAttribute('aria-pressed','false');bottom.append(dom.doc.createElement('svg'));
    bottom.addEventListener('click',()=>{bottomClicks++;bottom.setAttribute('aria-pressed','true');bottom.setAttribute('aria-label','收起底部面板');});
    right=dom.doc.createElement('button');right.setAttribute('data-sidebar-right-expand','');right.setAttribute('aria-label','打开右侧边栏');right.addEventListener('click',()=>rightClicks++);
    other=dom.doc.createElement('button');other.setAttribute('aria-label','其他操作');dom.native.append(bottom,right,other);
  });
  const host=f.dom.center.firstChild,b=host.querySelector('[data-dsst-action="bottom"]'),r=host.querySelector('[data-dsst-action="right"]');
  assert.equal(bottom.parentElement,f.dom.native);assert.equal(right.parentElement,f.dom.native);assert.equal(other.hasAttribute('data-dsh-session-tabs-native-hidden'),false);
  assert.equal(bottom.hasAttribute('data-dsh-session-tabs-native-hidden'),true);assert.notEqual(b.firstChild,bottom.firstChild);
  host.dispatch('click',{target:b});f.dom.flush();assert.equal(bottomClicks,1);assert.equal(b.getAttribute('aria-pressed'),'true');assert.equal(b.getAttribute('aria-label'),'收起底部面板');
  host.dispatch('click',{target:r});assert.equal(rightClicks,1);right.disabled=true;host.dispatch('click',{target:r});assert.equal(rightClicks,1);
  f.window.__dshSessionTabs.enable(false);assert.equal(bottom.hasAttribute('data-dsh-session-tabs-native-hidden'),false);assert.equal(right.hasAttribute('data-dsh-session-tabs-native-hidden'),false);
  f.window.__dshSessionTabs.enable(true);f.ctx.dispose();assert.equal(bottom.hasAttribute('data-dsh-session-tabs-native-hidden'),false);assert.equal(right.hasAttribute('data-dsh-session-tabs-native-hidden'),false);
});
test('expanded right sidebar keeps only its native edge toggle and restores the opener after collapse',()=>{
  let expand,collapse,domRef;
  const f=mounted(dom=>{
    domRef=dom;expand=dom.doc.createElement('button');expand.setAttribute('data-sidebar-right-expand','');expand.setAttribute('aria-label','打开右侧边栏');
    collapse=dom.doc.createElement('button');collapse.setAttribute('data-sidebar-right-toggle','');collapse.setAttribute('aria-label','收起右侧边栏');
    expand.addEventListener('click',()=>{expand.remove();dom.right.append(collapse);});
    collapse.addEventListener('click',()=>{collapse.remove();dom.native.append(expand);});dom.native.append(expand);
  });
  const host=f.dom.center.firstChild,proxy=host.querySelector('[data-dsst-action="right"]');
  assert.equal(proxy.hidden,false);host.dispatch('click',{target:proxy});f.dom.flush();
  assert.equal(proxy.hidden,true);assert.equal(collapse.parentElement,domRef.right);assert.equal(collapse.hasAttribute('data-dsh-session-tabs-native-hidden'),false);
  collapse.click();f.dom.observers[0].fn([{target:domRef.native,addedNodes:[expand]}]);f.dom.flush();assert.equal(proxy.hidden,false);
  f.window.__dshSessionTabs.enable(false);assert.equal(expand.hasAttribute('data-dsh-session-tabs-native-hidden'),false);
  f.ctx.dispose();assert.equal(collapse.hasAttribute('data-dsh-session-tabs-native-hidden'),false);
});
test('native panel attributes win over a stale opener and update without a tab render delay',()=>{
  let expand,panel;
  const f=mounted(dom=>{
    expand=dom.doc.createElement('button');expand.setAttribute('data-sidebar-right-expand','');expand.append(dom.doc.createElement('svg'));dom.native.append(expand);
    panel=dom.doc.createElement('div');panel.setAttribute('data-sidebar-right-panel','push');panel.setAttribute('data-sidebar-right-session','a');dom.right.append(panel);
  });
  const proxy=f.dom.center.firstChild.querySelector('[data-dsst-action="right"]');assert.equal(proxy.hidden,false);
  panel.setAttribute('data-sidebar-right-open','');f.dom.observers[0].fn([{type:'attributes',target:panel,attributeName:'data-sidebar-right-open'}]);
  assert.equal(proxy.hidden,true,'attribute handoff must sync immediately, before timers');
  assert.equal(expand.hasAttribute('data-dsh-session-tabs-native-hidden'),true,'stale native opener must not flash back');f.ctx.dispose();
});
test('collapse handoff reserves the right slot and disables only its placeholder until the native opener returns',()=>{
  let expand,panel,bottomClicks=0;
  const f=mounted(dom=>{
    const bottom=dom.doc.createElement('button');bottom.setAttribute('data-dsh-bottom-toggle','');bottom.addEventListener('click',()=>bottomClicks++);dom.native.append(bottom);
    expand=dom.doc.createElement('button');expand.setAttribute('data-sidebar-right-expand','');expand.append(dom.doc.createElement('svg'));dom.native.append(expand);
    panel=dom.doc.createElement('div');panel.setAttribute('data-sidebar-right-panel','push');panel.setAttribute('data-sidebar-right-session','a');dom.right.append(panel);
  });
  const host=f.dom.center.firstChild,proxy=host.querySelector('[data-dsst-action="right"]'),slot=proxy.parentElement;
  expand.remove();panel.setAttribute('data-sidebar-right-open','');f.dom.observers[0].fn([{type:'attributes',target:panel}]);assert.equal(proxy.hidden,true);
  panel.removeAttribute('data-sidebar-right-open');f.dom.observers[0].fn([{type:'attributes',target:panel}]);
  assert.equal(proxy.parentElement,slot);assert.equal(slot.hasAttribute('data-dsst-right-slot'),true);assert.equal(proxy.hidden,false);assert.equal(proxy.disabled,true);
  host.dispatch('click',{target:proxy});assert.equal(bottomClicks,0);assert.equal(host.querySelector('[data-dsst-action="bottom"]').disabled,false);
  f.dom.native.append(expand);f.dom.observers[0].fn([{type:'childList',target:f.dom.native,addedNodes:[expand]}]);
  assert.equal(proxy.disabled,false);assert.equal(proxy.hidden,false);f.ctx.dispose();
});
test('native panel sources ignore hidden retained session headers',()=>{
  let wrong=0,right=0;
  const f=mounted(dom=>{
    const old=dom.doc.createElement('div');old.setAttribute('hidden','');dom.native.append(old);
    for(const container of [old,dom.native]){
      const b=dom.doc.createElement('button');b.setAttribute('data-sidebar-right-expand','');b.addEventListener('click',()=>{if(container===old)wrong++;else right++;});container.append(b);
    }
  });
  const host=f.dom.center.firstChild;host.dispatch('click',{target:host.querySelector('[data-dsst-action="right"]')});assert.equal(right,1);assert.equal(wrong,0);f.ctx.dispose();
});

test('attention states pin to the left in pending, done, running order',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  f.status.value.set('a',{running:true});f.status.value.set('c',{pendingInteraction:{key:'q'}});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().order),['c','a','b']);
  f.status.value.set('b',{completionUnread:true});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().order),['c','b','a']);
  const rows=plain(f.controller.snapshot().rows);
  assert.deepEqual(rows.map(r=>[r.id,r.zone,r.pinned]),[['c','auto',false],['b','auto',false],['a','auto',false]]);
  assert.equal(f.controller.guarded('c'),true);assert.equal(f.controller.guarded('b'),true);assert.equal(f.controller.guarded('a'),true);
  f.controller.dispose();
});
test('manual pins lead the strip in pin order and return to their stored slot when unpinned',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  f.controller.pin('c');f.controller.pin('a');
  assert.deepEqual(plain(f.controller.snapshot().pins),['c','a']);
  assert.deepEqual(plain(f.controller.snapshot().order),['c','a','b']);
  assert.equal(f.controller.snapshot().rows[0].zone,'pin');
  f.controller.unpin('c');
  assert.deepEqual(plain(f.controller.snapshot().order),['a','b','c']);
  assert.equal(f.controller.togglePin('b'),true);assert.equal(f.controller.isPinned('b'),true);
  f.controller.togglePin('b');assert.equal(f.controller.isPinned('b'),false);
  f.controller.dispose();
});
test('closing a tab also drops its manual pin record',()=>{
  const f=fixture();f.controller.pin('a');f.controller.close('a');
  assert.deepEqual(plain(f.controller.snapshot().pins),[]);f.controller.dispose();
});
test('drag reordering stays inside its own zone',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  assert.equal(f.controller.moveTab('c','a',false),true);
  assert.deepEqual(plain(f.controller.snapshot().order),['c','a','b']);
  f.status.value.set('a',{running:true});f.status.emit();
  assert.equal(f.controller.moveTab('c','a',true),false,'the attention group is status driven');
  assert.equal(f.controller.moveTab('a','b',false),false);
  f.controller.pin('b');
  assert.equal(f.controller.moveTab('b','c',false),false,'pin and normal are different zones');
  f.controller.pin('c');
  assert.equal(f.controller.moveTab('c','b',false),true);
  assert.deepEqual(plain(f.controller.snapshot().pins),['c','b']);
  f.controller.dispose();
});
function pinnedFixture(pins){
  const raw=JSON.stringify({version:1,ids:['a','b','c'],active:'a',pins:pins||[]});
  return mounted(dom=>{dom.window.localStorage={getItem:key=>key==='dsh-session-tabs.v1'?raw:null,setItem(){}};});
}
test('manual pins and attention tabs lead one continuous scrolling strip',()=>{
  const f=pinnedFixture(['c']);
  const host=f.dom.center.firstChild,list=host.querySelector('.dsst-list');
  const ids=container=>[...container.querySelectorAll('[data-dsst-tab]')].map(cell=>cell.getAttribute('data-dsst-tab'));
  assert.deepEqual(ids(host),['c','a','b'],'one container holds pinned and normal tabs in visual order');
  assert.equal(host.querySelectorAll('[role="tablist"]').length,1,'the strip is a single tablist');
  assert.equal(host.querySelector('.dsst-pinned'),null,'no separate pinned scroll container');
  assert.equal(list.querySelector('[data-dsst-tab="c"]').getAttribute('data-pinned'),'true');
  assert.equal(list.querySelector('[data-dsst-tab="c"]').getAttribute('data-zone'),'pin');
  assert.ok(list.querySelector('[data-dsst-tab="a"]').querySelector('.dsst-pin'),'every tab carries the pin slot');
  f.status.value.set('b',{running:true});f.status.emit();f.dom.flush();
  assert.deepEqual(ids(host),['c','b','a'],'attention tabs still lead the same strip');
  assert.equal(list.querySelector('[data-dsst-tab="b"]').getAttribute('data-zone'),'auto');
  f.ctx.dispose();
});
test('status marks are plain circles without glyph text, and the close button reserves width',()=>{
  const f=mounted(),host=f.dom.center.firstChild,cell=host.querySelector('[data-dsst-tab]'),dot=cell.querySelector('.dsst-dot');
  assert.equal(dot.textContent,'');assert.equal(cell.getAttribute('data-status'),'idle');
  assert.match(f.plugin.CSS,/\.dsst-dot::before\{[^}]*border-radius:50%/);
  assert.match(f.plugin.CSS,/\.dsst-dot\[data-status=running\]::before\{animation:dsst-running-pulse/);
  assert.match(f.plugin.CSS,/@keyframes dsst-running-pulse\{0%,100%\{opacity:1\}50%\{opacity:\.3\}\}/);
  assert.match(f.plugin.CSS,/@media \(prefers-reduced-motion:reduce\)\{\.dsst-dot\[data-status=running\]::before\{animation:none\}\}/);
  assert.match(f.plugin.CSS,/\.dsst-dot\[data-status=pending\]\{color:var\(--dsw-alias-state-warn-primary/);
  assert.doesNotMatch(source,/running:'●'|pending:'!'|done:'✓'/);
  assert.match(f.plugin.CSS,/\.dsst-close\{[^}]*visibility:hidden/);
  assert.doesNotMatch(f.plugin.CSS,/data-active=false\] \.dsst-close\{display:none\}/);
  assert.match(f.plugin.CSS,/\.dsst-tab\[data-active=true\] \.dsst-close,\.dsst-tab:is\(:hover,:focus-within\) \.dsst-close\{visibility:visible\}/);
  assert.match(f.plugin.CSS,/\.dsst-list\{display:flex;flex:0 1 auto;min-width:0;gap:2px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none\}/);
  assert.doesNotMatch(f.plugin.CSS,/\.dsst-pinned/);
  assert.doesNotMatch(f.plugin.CSS,/max-width:50%/);
  assert.doesNotMatch(source,/'dsst-pinned'/);
  f.ctx.dispose();
});
test('a click never turns into a drag, a real drag reorders live, and the close button never drags',()=>{
  const f=pinnedFixture([]);
  const host=f.dom.center.firstChild,api=f.window.__dshSessionTabs;
  const cells=[...host.querySelectorAll('[data-dsst-tab]')];
  cells.forEach((cell,index)=>cell.getBoundingClientRect=()=>({left:index*40,width:40,right:index*40+40,top:0,bottom:30,height:30}));
  const b=host.querySelector('[data-dsst-tab="b"]'),c=host.querySelector('[data-dsst-tab="c"]'),bOpen=b.querySelector('[data-dsst-action="open"]');
  const openCalls=()=>f.calls.filter(call=>call[0]==='open').length;
  const before=openCalls();
  f.dom.dispatch(bOpen,'pointerdown',{button:0,clientX:50,clientY:10});
  f.dom.dispatch(bOpen,'pointermove',{clientX:58,clientY:11});
  f.dom.dispatch(bOpen,'pointerup',{target:bOpen});
  assert.deepEqual(plain(api.snapshot().order),['a','b','c'],'8px of pointer jitter is still a click');
  assert.equal(b.hasAttribute('data-dsst-dragging'),false);
  assert.equal(openCalls(),before+1,'the click opens the tab even without a native click event');
  f.dom.dispatch(bOpen,'pointerdown',{button:0,clientX:50,clientY:10});
  f.dom.dispatch(c,'pointermove',{clientX:112,clientY:10});
  assert.equal(b.getAttribute('data-dsst-dragging'),'');
  assert.deepEqual(plain(api.snapshot().order),['a','c','b'],'the strip reorders live while dragging');
  assert.equal(host.getAttribute('data-dragging'),'');
  f.dom.dispatch(c,'pointerup',{target:c});
  assert.equal(b.hasAttribute('data-dsst-dragging'),false);
  assert.equal(host.hasAttribute('data-dragging'),false);
  assert.equal(host.hasAttribute('data-dropping'),false);
  const opensBefore=f.calls.filter(call=>call[0]==='open').length;
  f.dom.dispatch(host.querySelector('[data-dsst-tab="a"] [data-dsst-action="open"]'),'click',{});
  assert.equal(f.calls.filter(call=>call[0]==='open').length,opensBefore,'the click that follows a drag is suppressed');
  const close=c.querySelector('[data-dsst-action="close"]');
  f.dom.dispatch(close,'pointerdown',{button:0,clientX:90,clientY:10});
  f.dom.dispatch(aCellOf(host,'b'),'pointermove',{clientX:20,clientY:10});
  f.dom.dispatch(close,'pointerup',{target:close});
  assert.deepEqual(plain(api.snapshot().order),['a','c','b'],'close presses never drag');
  f.ctx.dispose();
});
test('pointer jitter inside the pressed tab stays a click instead of starting a drag',()=>{
  const f=pinnedFixture([]);
  const host=f.dom.center.firstChild,api=f.window.__dshSessionTabs;
  const cells=[...host.querySelectorAll('[data-dsst-tab]')];
  cells.forEach((cell,index)=>cell.getBoundingClientRect=()=>({left:index*40,width:40,right:index*40+40,top:0,bottom:30,height:30}));
  const b=host.querySelector('[data-dsst-tab="b"]'),bOpen=b.querySelector('[data-dsst-action="open"]');
  const opens=()=>f.calls.filter(call=>call[0]==='open').length;
  const before=opens();
  f.dom.dispatch(bOpen,'pointerdown',{button:0,clientX:45,clientY:8});
  f.dom.dispatch(b,'pointermove',{clientX:70,clientY:14});
  assert.equal(b.hasAttribute('data-dsst-dragging'),false,'moving inside the same tab never lifts it');
  assert.deepEqual(plain(api.snapshot().order),['a','b','c']);
  f.dom.dispatch(b,'pointerup',{target:b});
  assert.equal(opens(),before+1,'releasing inside the tab switches to it');
  f.ctx.dispose();
});
test('a click still switches when is the capture element, not the tab, that receives the release',()=>{
  const f=pinnedFixture([]);
  const host=f.dom.center.firstChild,api=f.window.__dshSessionTabs;
  const cells=[...host.querySelectorAll('[data-dsst-tab]')];
  cells.forEach((cell,index)=>cell.getBoundingClientRect=()=>({left:index*40,width:40,right:index*40+40,top:0,bottom:30,height:30}));
  const b=host.querySelector('[data-dsst-tab="b"]');
  const opens=()=>f.calls.filter(call=>call[0]==='open').length;
  const before=opens();
  f.dom.dispatch(b.querySelector('[data-dsst-action="open"]'),'pointerdown',{button:0,clientX:50,clientY:10});
  f.dom.dispatch(b,'pointerup',{target:host,clientX:52,clientY:10});
  assert.equal(opens(),before+1,'the pressed tab opens even if the capture target gets the pointerup');
  assert.equal(api.snapshot().active,'b');
  f.ctx.dispose();
});
test('dragging across status groups is rejected instead of moving or switching',()=>{
  const f=pinnedFixture([]);
  const api=f.window.__dshSessionTabs,host=f.dom.center.firstChild;
  const cells=[...host.querySelectorAll('[data-dsst-tab]')];
  cells.forEach((cell,index)=>cell.getBoundingClientRect=()=>({left:index*40,width:40,right:index*40+40,top:0,bottom:30,height:30}));
  const b=host.querySelector('[data-dsst-tab="b"]'),c=host.querySelector('[data-dsst-tab="c"]');
  f.status.value.set('c',{running:true});f.status.emit();f.dom.flush();
  const opens=()=>f.calls.filter(call=>call[0]==='open').length;
  const before=opens();
  f.dom.dispatch(b.querySelector('[data-dsst-action="open"]'),'pointerdown',{button:0,clientX:50,clientY:10});
  f.dom.dispatch(c,'pointermove',{clientX:110,clientY:10});
  assert.equal(host.getAttribute('data-dropping'),'reject','a guarded group refuses the drop');
  assert.deepEqual(plain(api.snapshot().order),['c','a','b'],'no reorder across groups');
  f.dom.dispatch(c,'pointerup',{target:c});
  assert.equal(opens(),before,'a rejected drag must not switch sessions');
  assert.equal(host.hasAttribute('data-dropping'),false);
  f.ctx.dispose();
});
test('dragging the current tab hides its join for the duration only',()=>{
  const f=pinnedFixture([]);
  const host=f.dom.center.firstChild;
  const cells=[...host.querySelectorAll('[data-dsst-tab]')];
  cells.forEach((cell,index)=>cell.getBoundingClientRect=()=>({left:index*40,width:40,right:index*40+40,top:0,bottom:30,height:30}));
  const a=host.querySelector('[data-dsst-tab="a"]'),b=host.querySelector('[data-dsst-tab="b"]');
  f.dom.dispatch(a.querySelector('[data-dsst-action="open"]'),'pointerdown',{button:0,clientX:20,clientY:10});
  f.dom.dispatch(b,'pointermove',{clientX:90,clientY:10});
  assert.equal(host.getAttribute('data-dragging-active'),'');
  f.dom.dispatch(b,'pointerup',{target:b});
  assert.equal(host.hasAttribute('data-dragging-active'),false);
  f.ctx.dispose();
});
test('each tab carries its workspace name above the title',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  f.workspaces.value={items:[{workspaceId:'w1',title:'dsh-plugins',sessionIds:['a']},{workspaceId:'w2',path:'/Users/me/projects/beta',sessionIds:['b']}],archivedSessionIds:[]};
  f.workspaces.emit();
  const rows=plain(f.controller.snapshot().rows);
  assert.equal(rows.find(row=>row.id==='a').workspace,'dsh-plugins');
  assert.equal(rows.find(row=>row.id==='b').workspace,'beta','falls back to the path basename');
  assert.equal(rows.find(row=>row.id==='c').workspace,'');
  f.controller.dispose();
});
test('the strip renders the workspace line in its own smaller row',()=>{
  const f=pinnedFixture([]);
  const host=f.dom.center.firstChild;
  f.services.workspaces.list.value={items:[{workspaceId:'w1',title:'dsh-plugins',sessionIds:['a']}],archivedSessionIds:[]};
  f.services.workspaces.list.emit();f.dom.flush();
  const cell=host.querySelector('[data-dsst-tab="a"]');
  const labels=cell.querySelector('.dsst-labels');
  assert.equal(cell.querySelector('.dsst-workspace').textContent,'dsh-plugins');
  assert.equal(labels.querySelector('.dsst-title').textContent,'A');
  assert.equal(labels.firstChild.className,'dsst-meta','the workspace line comes first');
  assert.equal(labels.querySelector('.dsst-meta').firstChild.className,'dsst-workspace');
  assert.equal(host.querySelector('[data-dsst-tab="b"] .dsst-workspace').textContent,'');
  assert.match(f.plugin.CSS,/\.dsst-strip\{[^}]*height:46px/);
  assert.match(f.plugin.CSS,/\.dsst-workspace\{[^}]*font-size:10px/);
  f.ctx.dispose();
});
function notificationFixture(permission){
  const calls=[];
  class FakeNotification{constructor(title,opts){this.title=title;this.opts=opts;this.closed=false;calls.push(this);}close(){this.closed=true;}}
  FakeNotification.permission=permission||'granted';FakeNotification.requested=0;
  FakeNotification.requestPermission=()=>{FakeNotification.requested++;return Promise.resolve('granted');};
  const raw=JSON.stringify({version:1,ids:['a','b','c'],active:'a',pins:[]});
  const f=mounted(dom=>{dom.extra.Notification=FakeNotification;dom.window.localStorage={getItem:key=>key==='dsh-session-tabs.v1'?raw:null,setItem(){}};});
  return {f,calls,Notification:FakeNotification};
}
test('finished and attention-needing sessions raise an OS notification',()=>{
  const {f,calls}=notificationFixture();
  f.status.value.set('b',{running:true});f.status.emit();f.dom.flush();
  f.status.value.set('b',{running:false,completionUnread:true});f.status.emit();f.dom.flush();
  assert.equal(calls.length,1);assert.equal(calls[0].title,'会话已完成');assert.ok(calls[0].opts.body.includes('B'));
  assert.equal(calls[0].opts.tag,'dsh-session-tabs:b');
  f.status.value.set('c',{running:true,pendingInteraction:{key:'approval-c'}});f.status.emit();f.dom.flush();
  assert.equal(calls.length,2);assert.equal(calls[1].title,'等待你的处理');
  f.ctx.dispose();
});
test('notifications open the matching tab when clicked',()=>{
  const {f,calls}=notificationFixture();
  f.status.value.set('b',{running:true});f.status.emit();
  f.status.value.set('b',{running:false,completionUnread:true});f.status.emit();
  assert.equal(calls.length,1);
  calls[0].onclick();
  assert.equal(f.window.__dshSessionTabs.snapshot().active,'b');
  assert.equal(calls[0].closed,true);
  f.ctx.dispose();
});
test('no notification while the same session is focused, and none without permission',()=>{
  const {f,calls,Notification}=notificationFixture('default');
  f.dom.doc.visibilityState='visible';f.dom.doc.hasFocus=()=>true;
  f.status.value.set('a',{running:true});f.status.emit();
  f.status.value.set('a',{running:false,completionUnread:false,pendingInteraction:{key:'k'}});f.status.emit();
  assert.equal(Notification.requested>=1,true,'permission is requested once');
  assert.equal(calls.length,0,'no delivery before the permission is granted');
  Notification.permission='granted';
  f.status.value.set('b',{running:true});f.status.emit();
  f.status.value.set('b',{running:false,pendingInteraction:{key:'k2'}});f.status.emit();
  assert.equal(calls.length,1,'the active focused row stays silent, the background one notifies');
  f.dom.doc.hasFocus=()=>false;
  f.status.value.set('a',{running:false});f.status.emit();
  f.status.value.set('a',{running:false,pendingInteraction:{key:'k3'}});f.status.emit();
  assert.equal(calls.length,2,'losing focus makes the active row notify again');
  f.ctx.dispose();
});
test('unrelated status changes stay quiet',()=>{
  const {f,calls}=notificationFixture();
  f.status.value.set('b',{running:true});f.status.emit();
  f.status.value.set('b',{running:false});f.status.emit();
  assert.equal(calls.length,0);
  f.ctx.dispose();
});
function aCellOf(host,id){return host.querySelector('[data-dsst-tab="'+id+'"]');}

test('each tab carries the compact relative time the workspace list shows for its session',()=>{
  const f=fixture({lang:'zh'});
  const label=ms=>{f.list.value.byId.a.updatedAt=Date.now()-ms;f.list.emit();return plain(f.controller.snapshot().rows).find(row=>row.id==='a').time;};
  assert.equal(label(30*1000),'刚刚');
  assert.equal(label(5*60*1000),'5分钟');
  assert.equal(label(3*60*60*1000),'3小时');
  assert.equal(label(2*24*60*60*1000),'2天');
  assert.equal(label(40*24*60*60*1000),'1个月');
  assert.equal(label(400*24*60*60*1000),'1年');
  assert.equal(label(0),'刚刚','a future timestamp never reads as negative');
  delete f.list.value.byId.a.updatedAt;f.list.emit();
  assert.equal(f.controller.snapshot().rows.find(row=>row.id==='a').time,'','no durable activity, no time');
  f.controller.dispose();
});
test('blank sessions show no time and the english dictionary stays compact',()=>{
  const zh=fixture({lang:'zh'});zh.list.value.byId.a.blank=true;zh.list.value.byId.a.updatedAt=Date.now()-5*60*1000;zh.list.emit();
  assert.equal(zh.controller.snapshot().rows.find(row=>row.id==='a').time,'','a session that never started has no time');
  zh.controller.dispose();
  const en=fixture({lang:'en'});
  const enLabel=ms=>{en.list.value.byId.a.updatedAt=Date.now()-ms;en.list.emit();return en.controller.snapshot().rows.find(row=>row.id==='a').time;};
  assert.equal(enLabel(30*1000),'now');
  assert.equal(enLabel(5*60*1000),'5min');
  assert.equal(enLabel(2*24*60*60*1000),'2d');
  assert.equal(enLabel(400*24*60*60*1000),'1y');
  en.controller.dispose();
});

test('the time renders at the right of the workspace line without widening the tab',()=>{
  const raw='{"version":1,"ids":["a","b","c"],"active":"a","pins":[]}';
  const f=mounted(dom=>{dom.window.localStorage={getItem:key=>key==='dsh-session-tabs.v1'?raw:null,setItem(){}};});
  f.services.workspaces.list.value={items:[{workspaceId:'w1',title:'dsh-plugins',sessionIds:['a']}],archivedSessionIds:[]};
  f.services.workspaces.list.emit();
  f.services.sessions.list.value.byId.a.updatedAt=Date.now()-5*60*1000;
  f.services.sessions.list.value.byId.b.updatedAt=Date.now()-3*60*60*1000;
  f.services.sessions.list.emit();f.dom.flush();
  const host=f.dom.center.firstChild,a=aCellOf(host,'a'),b=aCellOf(host,'b'),c=aCellOf(host,'c');
  const meta=a.querySelector('.dsst-meta');
  assert.equal(a.querySelector('.dsst-labels').firstChild,meta,'the time sits on the label row, above the title');
  assert.equal(meta.firstChild.className,'dsst-workspace','the workspace name stays leftmost');
  assert.equal(meta.querySelector('.dsst-time').textContent,'5分钟');
  assert.equal(a.querySelector('[data-dsst-action="open"]').getAttribute('aria-label'),'A — 空闲 · 5分钟','the time also reaches the accessible name');
  assert.equal(b.querySelector('.dsst-time').textContent,'3小时');
  assert.equal(b.querySelector('.dsst-meta').hidden,false,'a time without a workspace still shows the row');
  assert.equal(b.querySelector('.dsst-workspace').textContent,'');
  assert.equal(c.querySelector('.dsst-meta').hidden,true,'no workspace and no time leaves the row out entirely');
  assert.match(f.plugin.CSS,/\.dsst-tab\{[^}]*max-width:168px/,'the tab width cap does not grow for the time');
  assert.match(f.plugin.CSS,/\.dsst-labels\{[^}]*max-width:108px/,'the label block keeps its width cap');
  assert.match(f.plugin.CSS,/\.dsst-workspace\{[^}]*min-width:0[^}]*text-overflow:ellipsis/,'a long workspace name ends with an ellipsis');
  assert.match(f.plugin.CSS,/\.dsst-time\{[^}]*flex:0 0 auto[^}]*\}[\s\S]*\.dsst-time:empty\{display:none\}/,'the time keeps its width while the workspace shrinks');
  f.ctx.dispose();
});

test('a tab that loses its status dot moves to the head of the normal zone',async ()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  assert.deepEqual(plain(f.controller.snapshot().ids),['a','b','c']);
  f.status.value.set('c',{running:true,pendingInteraction:{key:'approve-c'}});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().order),['c','a','b'],'a pending tab leads the strip');
  f.status.value.set('c',{running:false});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().ids),['c','a','b'],'answering rewrites the stored order');
  assert.deepEqual(plain(f.controller.snapshot().order),['c','a','b']);
  assert.equal(f.controller.snapshot().rows.find(row=>row.id==='c').zone,'normal');
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.deepEqual(plain(JSON.parse(f.values.get('dsh-session-tabs.v1')).ids),['c','a','b'],'the settled order survives a reload');
  f.controller.dispose();
});
test('a tab keeps its slot until every status dot is gone',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  f.status.value.set('c',{running:true,pendingInteraction:{key:'k-c'}});f.status.emit();
  f.status.value.set('c',{running:true});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().ids),['a','b','c'],'yellow to blue is not settling');
  f.status.value.set('c',{running:false,completionUnread:true});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().ids),['a','b','c'],'unread completion still holds the dot');
  f.status.value.set('c',{running:false,completionUnread:false});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().ids),['c','a','b'],'losing the dot settles the tab');
  f.controller.dispose();
});
test('a settled tab lands first in the normal zone, behind tabs still waiting',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  f.status.value.set('b',{running:true,pendingInteraction:{key:'k-b'}});f.status.value.set('c',{running:true});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().order),['b','c','a'],'running and pending lead the strip');
  f.status.value.set('c',{running:false});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().order),['b','c','a'],'the waiting tab keeps its place to the left');
  f.controller.dispose();
});
test('a manually pinned tab keeps its stored slot when its dot clears',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  f.controller.pin('c');
  assert.deepEqual(plain(f.controller.snapshot().order),['c','a','b']);
  f.status.value.set('c',{running:true,pendingInteraction:{key:'k-c'}});f.status.emit();
  f.status.value.set('c',{running:false});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().ids),['a','b','c'],'a pinned tab never joins the normal order');
  f.controller.unpin('c');
  assert.deepEqual(plain(f.controller.snapshot().order),['a','b','c'],'unpinning still returns it to its stored slot');
  f.controller.dispose();
});
test('tabs whose dots clear in one update keep the order the user saw',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  f.status.value.set('a',{running:false,completionUnread:true});
  f.status.value.set('b',{running:true,pendingInteraction:{key:'k-b'}});
  f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().order),['b','a','c'],'needs-answer leads completed-unread');
  f.status.value.set('a',{running:false,completionUnread:false});
  f.status.value.set('b',{running:false});
  f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().ids),['b','a','c'],'both keep the order they were showing');
  f.controller.dispose();
});
test('tabs settling in the same update keep their visual order at the head',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  f.status.value.set('a',{running:true});f.status.value.set('c',{running:true});f.status.emit();
  f.status.value.set('a',{running:false});f.status.value.set('c',{running:false});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().ids),['a','c','b']);
  f.controller.dispose();
});

test('a manual drag after settling is not undone by later updates',()=>{
  const f=fixture();f.controller.open('b');f.controller.open('c');
  f.status.value.set('c',{running:true});f.status.emit();
  f.status.value.set('c',{running:false});f.status.emit();
  assert.deepEqual(plain(f.controller.snapshot().ids),['c','a','b'],'the settled tab reached the head');
  assert.equal(f.controller.moveTab('b','c',false),true,'the normal zone stays drag-sortable');
  assert.deepEqual(plain(f.controller.snapshot().ids),['b','c','a']);
  f.workspaces.emit();
  assert.deepEqual(plain(f.controller.snapshot().ids),['b','c','a'],'an idle tab is never moved twice');
  f.controller.dispose();
});

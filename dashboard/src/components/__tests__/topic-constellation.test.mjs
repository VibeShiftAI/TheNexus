import test from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {TopicConstellation} from '../bridge/topic-constellation.tsx';

test('canvas hit testing follows display scaling; reduced motion and offscreen state stop work animation',async()=>{
 const original={ro:globalThis.ResizeObserver,io:globalThis.IntersectionObserver,media:window.matchMedia,ctx:window.HTMLCanvasElement.prototype.getContext,raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame};
 const width=Object.getOwnPropertyDescriptor(window.HTMLElement.prototype,'clientWidth'),height=Object.getOwnPropertyDescriptor(window.HTMLElement.prototype,'clientHeight');
 let visibility, reduced=true, frames=0, cancelled=0; const centers=[];
 const context=new Proxy({translate:(x,y)=>centers.push([x,y]),measureText:t=>({width:t.length*5}),createRadialGradient:()=>({addColorStop(){}})},{get:(target,key)=>key in target?target[key]:()=>{},set:(target,key,value)=>(target[key]=value,true)});
 globalThis.ResizeObserver=class{observe(){} disconnect(){}};
 globalThis.IntersectionObserver=class{constructor(cb){visibility=cb;}observe(){}disconnect(){}};
 window.matchMedia=()=>({matches:reduced});
 globalThis.requestAnimationFrame=()=>++frames; globalThis.cancelAnimationFrame=()=>cancelled++;
 window.HTMLCanvasElement.prototype.getContext=()=>context;
 Object.defineProperty(window.HTMLElement.prototype,'clientWidth',{configurable:true,get:()=>320});
 Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{configurable:true,get:()=>240});
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 const data={nodes:[{id:1,title:'Memory',size:30,top_entities:['Graph']},{id:2,title:'Reasoning',size:20,top_entities:['Planning']}],links:[{source:1,target:2,weight:5}]};let selected;
 const props={data,maxNodes:2,labelCount:0,onSelect:t=>selected=t};
 try {
  await act(async()=>root.render(createElement(TopicConstellation,props)));
  assert.equal(frames,0,'reduced motion renders a static illuminated frame');
  const canvas=container.querySelector('canvas');canvas.getBoundingClientRect=()=>({left:20,top:40,width:640,height:480});
  const [x,y]=centers[0];
  await act(async()=>canvas.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:20+x*2,clientY:40+y*2})));
  assert.equal(selected.id,1,'click lands on the drawn community at 200% display scale');
  reduced=false;await act(async()=>root.render(createElement(TopicConstellation,{...props,accesses:[]})));
  assert.ok(frames>0);const before=frames;
  await act(async()=>visibility([{isIntersecting:false}]));
  assert.equal(frames,before);assert.ok(cancelled>0);
 } finally {
  await act(async()=>root.unmount());container.remove();
  globalThis.ResizeObserver=original.ro;globalThis.IntersectionObserver=original.io;window.matchMedia=original.media;window.HTMLCanvasElement.prototype.getContext=original.ctx;globalThis.requestAnimationFrame=original.raf;globalThis.cancelAnimationFrame=original.caf;
  if(width)Object.defineProperty(window.HTMLElement.prototype,'clientWidth',width);else delete window.HTMLElement.prototype.clientWidth;
  if(height)Object.defineProperty(window.HTMLElement.prototype,'clientHeight',height);else delete window.HTMLElement.prototype.clientHeight;
 }
});

test('access changes only the touched crystal brightness; geometry stays fixed and idle bridge dots move',async()=>{
 const originals={ro:globalThis.ResizeObserver,io:globalThis.IntersectionObserver,media:window.matchMedia,ctx:window.HTMLCanvasElement.prototype.getContext,raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame};
 const width=Object.getOwnPropertyDescriptor(window.HTMLElement.prototype,'clientWidth'),height=Object.getOwnPropertyDescriptor(window.HTMLElement.prototype,'clientHeight');
 let reduced=true,nextFrame, nodes=[],currentNode=null,particles=[],globalFills=0;
 const context=new Proxy({
   clearRect(){nodes=[];particles=[];globalFills=0;},
   translate(x,y){currentNode={center:[x,y],geometry:[],fills:[]};nodes.push(currentNode);},
   restore(){currentNode=null;},
   ellipse(...args){currentNode?.geometry.push(['ellipse',...args]);},
   arc(...args){if(currentNode)currentNode.geometry.push(['arc',...args]);else if(args[2]<5)particles.push(args);},
   fill(){currentNode?.fills.push(context.fillStyle);},
   fillRect(){if(!currentNode)globalFills++;},
   measureText:t=>({width:t.length*5}),
   createRadialGradient:(...args)=>({args,stops:[],addColorStop(...stop){this.stops.push(stop);}})
 },{get:(target,key)=>key in target?target[key]:()=>{},set:(target,key,value)=>(target[key]=value,true)});
 globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.IntersectionObserver=class{observe(){}disconnect(){}};
 window.matchMedia=()=>({matches:reduced});window.HTMLCanvasElement.prototype.getContext=()=>context;
 globalThis.requestAnimationFrame=cb=>(nextFrame=cb,1);globalThis.cancelAnimationFrame=()=>{};
 Object.defineProperty(window.HTMLElement.prototype,'clientWidth',{configurable:true,get:()=>320});Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{configurable:true,get:()=>240});
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 const data={computed_at:'2026-09-08T10:00:00Z',nodes:[{id:1,title:'Memory',size:30,top_entities:['Graph']},{id:2,title:'Reasoning',size:20,top_entities:['Planning']}],links:[{source:1,target:2,weight:5}]};
 const props={data,maxNodes:2,labelCount:0};
 try {
   await act(async()=>root.render(createElement(TopicConstellation,props)));
   const idle=JSON.parse(JSON.stringify(nodes)),canvas=container.querySelector('canvas'),dimensions=[canvas.width,canvas.height];
   const accesses=[{topicId:1,at:new Date().toISOString(),communityUpdatedAt:'2026-09-06T00:00:00Z',mapIdentity:JSON.stringify(['Memory',30,['Graph']]),entityCount:1,entities:['Graph']}];
   await act(async()=>root.render(createElement(TopicConstellation,{...props,accesses})));
   assert.notDeepEqual(JSON.parse(JSON.stringify(nodes[0].fills)),idle[0].fills,'the accessed crystal brightens');
   assert.deepEqual(JSON.parse(JSON.stringify(nodes[1])),idle[1],'unrelated crystal remains exactly unchanged');
   assert.deepEqual(nodes.map(n=>[n.center,n.geometry]),idle.map(n=>[n.center,n.geometry]),'no orbit rotation, growth, or layout shift');
   assert.deepEqual([canvas.width,canvas.height],dimensions);
   assert.equal(globalFills,0,'no full-canvas wash or expanding rings');
   reduced=false;
   await act(async()=>root.render(createElement(TopicConstellation,{...props,accesses:[]})));
   assert.ok(nextFrame,'ambient photons animate while there is no access');
   assert.ok(particles.length,'bridge dots are visible in the quiet graph');
   const before=structuredClone(particles);nextFrame(performance.now()+1000);
   assert.notDeepEqual(particles,before,'dots travel between nodes');
 } finally {
   await act(async()=>root.unmount());container.remove();
   globalThis.ResizeObserver=originals.ro;globalThis.IntersectionObserver=originals.io;window.matchMedia=originals.media;window.HTMLCanvasElement.prototype.getContext=originals.ctx;globalThis.requestAnimationFrame=originals.raf;globalThis.cancelAnimationFrame=originals.caf;
   if(width)Object.defineProperty(window.HTMLElement.prototype,'clientWidth',width);else delete window.HTMLElement.prototype.clientWidth;
   if(height)Object.defineProperty(window.HTMLElement.prototype,'clientHeight',height);else delete window.HTMLElement.prototype.clientHeight;
 }
});

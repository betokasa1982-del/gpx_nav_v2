// Smoke test: run the app's JS with a mock DOM/Leaflet, simulate a GPS run
const fs=require('fs');
let code=fs.readFileSync('/home/claude/main.js','utf8');

// ── Mock DOM ──
const elems={};
function mkEl(id){
  return elems[id]??(elems[id]={id,style:{},classList:{
      _s:new Set(),add(...c){c.forEach(x=>this._s.add(x))},remove(...c){c.forEach(x=>this._s.delete(x))},
      toggle(c,f){f===undefined?(this._s.has(c)?this._s.delete(c):this._s.add(c)):(f?this._s.add(c):this._s.delete(c));},
      contains(c){return this._s.has(c)}},
    textContent:'',innerHTML:'',value:'80',className:'',appendChild(){},insertBefore(){},
    addEventListener(){},querySelector(){return null},remove(){},scrollIntoView(){},click(){},
    setAttribute(){},getContext(){return{drawImage(){}}},files:[]});
}
// give the sliders proper values
const sliderVals={'rng-radius':'80','rng-auto':'1','rng-autostop':'1','rng-follow':'1','rng-zoom':'17','rng-recvel':'5','rng-recdur':'5'};
global.document={
  getElementById:id=>{const isNew=!elems[id];const e=mkEl(id);if(isNew&&sliderVals[id])e.value=sliderVals[id];return e},
  createElement:t=>mkEl('_dyn_'+Math.random()),
  addEventListener(){},
  visibilityState:'visible'
};
global.__speech={spoken:[],cancels:0,speaking:false,pending:false,
  cancel(){this.cancels++},speak(u){this.spoken.push(u.text)},resume(){}};
global.window={addEventListener(){},getComputedStyle:()=>({transform:'matrix(1,0,0,1,0,0)'}),speechSynthesis:global.__speech};
Object.defineProperty(globalThis,'navigator',{value:{geolocation:{watchPosition:(ok)=>{global.__gpsCb=ok;return 1},clearWatch(){}},serviceWorker:{register:()=>({catch(){}})}},configurable:true});
global.alert=m=>console.log('[alert]',m);
global.prompt=(q,d)=>global.__promptReply!==undefined?global.__promptReply:d;
global.confirm=()=>true;
global.localStorage={_d:{},getItem(k){return this._d[k]??null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]},
  key(i){return Object.keys(this._d)[i]??null},get length(){return Object.keys(this._d).length}};
global.DOMParser=class{parseFromString(){return{querySelectorAll:()=>[]}}};
global.SpeechSynthesisUtterance=class{constructor(t){this.text=t}};
global.URL={createObjectURL:()=>'blob:x',revokeObjectURL(){}};
global.Blob=class{};
global.Image=class{};
global.requestAnimationFrame=f=>f();
global.DOMMatrix=class{constructor(){this.m41=0;this.m42=0}};

// ── Mock Leaflet ──
const mkLayer=()=>({addTo(){return this},setLatLngs(){return this},addLatLng(){return this},bringToFront(){},getBounds:()=>({isValid:()=>true}),setIcon(){},setLatLng(){return this},bindTooltip(){return this},bindPopup(){return this},openPopup(){}});
global.L={
  map:()=>({getContainer:()=>(global.__mapC??(global.__mapC={style:{},classList:{_s:new Set(),toggle(c,f){f?this._s.add(c):this._s.delete(c)},add(){},remove(){},contains(c){return this._s.has(c)}},querySelector:()=>null,addEventListener(){}})),on(){},invalidateSize(){},setView(){},fitBounds(){},setZoom(){},getZoom:()=>17,removeLayer(){},getSize:()=>({x:800,y:600})}),
  tileLayer:()=>mkLayer(), polyline:()=>mkLayer(), marker:()=>mkLayer(),
  circle:()=>mkLayer(), divIcon:()=>({}), control:{zoom:()=>({addTo(){}})}
};
global.setTimeout=(f,t)=>{ if(t<=1000) f(); return 0; }; // run short timers inline, skip long
global.clearTimeout=()=>{};
global.setInterval=()=>123; global.clearInterval=()=>{};
global.Date.prototype.toLocaleDateString=function(){return '10/06/2026'};
global.Date.prototype.toLocaleTimeString=function(){return '12:00'};


code=code.replace(/'use strict';/,'');
const tests = require('fs').readFileSync('/home/claude/tests_body.js','utf8');
eval(code + '\n;' + tests);

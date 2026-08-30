import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
const html=fs.readFileSync(new URL('index.html',root),'utf8');
const worker=fs.readFileSync(new URL('worker.js',root),'utf8');
function environment(){
  const store=new Map(),elements=new Map();
  const element=()=>({textContent:'',innerHTML:'',value:'',style:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},querySelector(){return null},querySelectorAll(){return []},getAttribute(){return ''}});
  const document={hidden:false,addEventListener(){},querySelector(){return null},querySelectorAll(){return []},getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement:element};
  const c={console,Date,Math,URL,URLSearchParams,TextEncoder,Headers,Request,Response,AbortController,crypto:webcrypto,performance:{now:()=>Date.now()},document,navigator:{},location:{href:'http://localhost/',origin:'http://localhost',search:'',pathname:'/'},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},setTimeout(){return 1},clearTimeout(){},setInterval(){return 1},clearInterval(){},addEventListener(){},fetch:async()=>{throw Error('Unexpected network in unit test')},WebSocket:{OPEN:1,CONNECTING:0,CLOSED:3}};
  c.window=c;return vm.createContext(c);
}
function app(source=html){const c=environment();for(const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){if(!/src=|application\//.test(match[1]))vm.runInContext(match[2].replace(/acknowledgeOpportunity\(\);\s*run\(\);\s*$/,'').replace(/\brun\(\);\s*$/,''),c);}return c;}
function edge(){const c=environment();vm.runInContext(worker.replace('export default {','const handler = {'),c);return c;}
function run(c,code){return vm.runInContext(code,c);}
function fixture(){return {name:'HEMI',buy:8,s:{buy:8},spread:.1,vRatio:1.2,m:{price:100,lastOpen:99,closedPrice:100,rsi:50,rsi6:52,rsi12:50,hist:2,prevHist:1,kdjK:55,kdjD:50},h:{lastOpen:99},flow:{status:'REAL',m15:{net:10},m30:{net:20},h1:{net:40},distribution:false},p:{marketEntry:100,conditionalEntry:99,stop:98,marketRR:1,conditionalRR:2,hasResistance:true,mainTarget:103,zoneLow:98.8,zoneHigh:99,dist:1,near:false,bounce:false,recovery:{base:true,state:'DÖNÜŞ ADAYI',advanceFromDipPct:2,multiDayAdvancePct:3}}};}
test('source syntax and V5.1 active labels',()=>{
  app();edge();new vm.Script(fs.readFileSync(new URL('OneSignalSDKWorker.js',root),'utf8'));new vm.Script(fs.readFileSync(new URL('sw.js',root),'utf8'));
  assert.match(html,/V5\.1 DENETİMLİ KARAR MOTORU/);assert.match(worker,/5\.1-QUOTE/);
});
test('market/conditional, bounce, R/R, late-entry and hard-gate parity',()=>{
  const a=app(),w=edge();
  const cases=[['CONDITIONAL',()=>{}],['CONFIRMED',x=>{x.p.bounce=true;x.p.marketRR=1.30}],['CONDITIONAL',x=>{x.p.marketRR=1.29;x.p.bounce=true}],['BROKEN',x=>{x.p.marketRR=1.29;x.p.conditionalRR=1.29}],['BROKEN',x=>x.p.recovery.confirmedSupportBreak=true],['BROKEN',x=>x.spread=.36],['FLOW_RISK',x=>{x.flow.m15.net=-100;x.flow.m30.net=-120;x.flow.h1.net=-180}],['PULLBACK',x=>x.p.recovery.advanceFromDipPct=22],['LIMIT_WAIT',x=>x.p.near=true]];
  for(const [expected,change] of cases){const x=fixture();change(x);a.x=x;w.x=x;assert.equal(run(a,'entryState(x).key'),expected);const mapped={CONFIRMED:'BUY',BROKEN:'REJECT',FLOW_RISK:'REJECT'};assert.equal(run(w,'candidateState(x)'),mapped[expected]||expected);}
  for(const rr of [1.3,2,3]){const x=fixture();x.p.marketRR=rr;x.p.bounce=true;w.x=x;assert.equal(run(w,'candidateState(x)'),'BUY');}
});
test('single coin is subscribed; no/partial/crossed quotes stay stale; genuine book unlocks',()=>{
  const a=app();a.x=fixture();run(a,"currentManualCoin='HEMI'; latestAnalysis.HEMI=x");
  assert.ok(run(a,"activeCoinNames().includes('HEMI')"));assert.equal(run(a,"entryState(x,'HEMI').key"),'STALE');
  run(a,"updateLiveDom('HEMI',{price:100});applyPositionQuote('HEMI',100,NaN)");assert.equal(run(a,"quoteIsFresh('HEMI')"),false);
  run(a,"applyPositionQuote('HEMI',101,100)");assert.equal(run(a,"quoteIsFresh('HEMI')"),false);
  run(a,"applyPositionQuote('HEMI',99.9,100,'BINANCE_TR_REST_DEPTH')");assert.equal(run(a,"entryState(x,'HEMI').key"),'CONDITIONAL');
  run(a,"liveQuotes.HEMI.recvPerf-=7000;liveQuotes.HEMI.at-=7000;updateLiveDom('HEMI',{price:101})");assert.equal(run(a,"entryState(x,'HEMI').key"),'STALE');
  run(a,"applyPositionQuote('HEMI',100,100.1)");assert.equal(run(a,"quoteIsFresh('HEMI')"),true);
});
test('REST and Worker fallback: real timestamp and source; stale Worker quote refused',async()=>{
  const a=app();a.fetch=async url=>new Response(JSON.stringify({bidPrice:'0.546',askPrice:'0.547',at:Date.now()}));
  const book=await run(a,"liveBook('HEMI')");assert.equal(book.ask,.547);assert.equal(run(a,"liveQuotes.HEMI.source"),'BINANCE_TR_REST_DEPTH');
  a.fetch=async url=>{if(!url.includes('/quote?'))throw Error('REST unavailable');return new Response(JSON.stringify({bidPrice:'.546',askPrice:'.547',at:Date.now()}));};
  await run(a,"liveBook('HEMI')");assert.equal(run(a,"liveQuotes.HEMI.source"),'BINANCE_TR_WORKER_WS');
  a.fetch=async url=>{if(!url.includes('/quote?'))throw Error('REST unavailable');return new Response(JSON.stringify({bidPrice:'.546',askPrice:'.547',at:Date.now()-20000}));};
  await assert.rejects(run(a,"liveBook('HEMI')"),/bayat/);
});
test('Worker quote route rejects invalid symbols, disables cache and reports real receipt time',async()=>{
  const w=edge();run(w,"fetchBinanceTrBookTicker=async()=>({bidPrice:'0.546',askPrice:'0.547',source:'BINANCE_TR_WS'})");
  w.req=new Request('https://worker/quote?coin=HEMI');const response=await run(w,'handler.fetch(req,{}, {})');assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');const book=await response.json();assert.equal(book.askPrice,'0.547');assert.ok(Date.now()-book.at<1000);
  w.req=new Request('https://worker/quote?coin=../../bad');assert.equal((await run(w,'handler.fetch(req,{}, {})')).status,400);
});
test('baseline technical calculations unchanged (80 chronological synthetic histories)',()=>{
  const old=execFileSync('git',['-c',`safe.directory=${decodeURIComponent(root.pathname).replace(/^\//,'').replace(/\/$/,'')}`,'show','HEAD:index.html'],{cwd:root,encoding:'utf8'}),before=app(old),after=app();
  const candles=Array.from({length:220},(_,i)=>{const close=100+Math.sin(i/5)*3+i*.01;return [Date.UTC(2026,7,27)+i*900000,close-.1,close+.4,close-.5,close,100+i%20,Date.UTC(2026,7,27)+(i+1)*900000-1,10000,100,60,6000,0]});
  for(let n=140;n<220;n++){for(const c of [before,after]){c.rows=candles.slice(0,n);run(c,'m=calc(rows);h=calc(rows);p=tradePlan(rows,rows,m,h);flow=buildFlowContext(rows,{status:"VERİ YOK"},m);result=enrichRecoveryPlan(p,rows,rows,rows,rows.slice(-8),m,h,flow,.1)');}assert.equal(JSON.stringify(before.result),JSON.stringify(after.result));}
});
test('release scope: Finder/RR/bounce/hard-gate implementations unchanged',()=>{
  const git=['-c',`safe.directory=${decodeURIComponent(root.pathname).replace(/^\//,'').replace(/\/$/,'')}`,'show'];
  const before=app(execFileSync('git',[...git,'HEAD:index.html'],{cwd:root,encoding:'utf8'})),after=app();
  const normalize=fn=>String(fn).replace(/\s+/g,'');
  for(const name of ['findDaily3','score','tradePlan','enrichRecoveryPlan','finderRiskFlags','resistancePotential'])assert.equal(normalize(after[name]),normalize(before[name]),name);
  const oldWorker=environment();vm.runInContext(execFileSync('git',[...git,'HEAD:worker.js'],{cwd:root,encoding:'utf8'}).replace('export default {','const handler = {'),oldWorker);
  const currentWorker=edge();
  for(const name of ['candidateState','hardGateReason','score','tradePlan','enrichRecoveryPlan','finderRiskFlags','resistancePotential','scanMarket'])assert.equal(normalize(currentWorker[name]),normalize(oldWorker[name]),name);
});

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

test('baseline indicators, market score and bounce formula are preserved',()=>{
 const args=['-c',`safe.directory=${decodeURIComponent(root.pathname).replace(/^\//,'').replace(/\/$/,'')}`,'show'];
 const before=app(execFileSync('git',[...args,'HEAD:index.html'],{cwd:root,encoding:'utf8'})),after=app();
 const normalize=fn=>String(fn).replace(/\s+/g,'');
 for(const name of ['calc','score','finderRiskFlags','resistancePotential'])assert.equal(normalize(after[name]),normalize(before[name]),name);
 assert.equal(normalize(String(after.tradePlan).match(/const volOk=[\s\S]*?const bounce=.*?;/)[0]),normalize(String(before.tradePlan).match(/const volOk=[\s\S]*?const bounce=.*?;/)[0]));
 const rows=Array.from({length:220},(_,i)=>candle(Date.UTC(2026,7,27)+i*900000,100+Math.sin(i/5)*3+i*.01));
 for(let n=140;n<220;n++){
  for(const c of [before,after]){c.rows=rows.slice(0,n);run(c,'m=calc(rows);h=calc(rows)');}
  assert.equal(JSON.stringify(before.m),JSON.stringify(after.m));
  const p={marketEntry:100,mainTarget:103,marketRR:1.5,conditionalRR:20,dist:1,bounce:false};
  before.p=p;after.p=p;assert.equal(JSON.stringify(run(before,'score(m,h,p)')),JSON.stringify(run(after,'score(m,h,p)')));
 }
});

function candle(open,close=100,step=900000,low=close-.5,high=close+.5){
 return [open,close-.1,high,low,close,100,open+step-1,10000,100,60,6000,0];
}
test('shared historical helper is identical; no future higher-timeframe candle enters levels',()=>{
 const a=app(),w=edge();assert.equal(String(a.recoveryHistory),String(w.recoveryHistory));
 const rows=Array.from({length:120},(_,i)=>candle(i*900000,100+Math.sin(i/5)));
 const future=[candle(121*900000,999,900000,1,9999)];
 for(const c of [a,w]){
  const prefix=c.recoveryHistory(rows,rows,rows,rows,100);
  const padded=c.recoveryHistory(rows,[...rows,...future],[...rows,...future],[...rows,...future],100);
  assert.equal(JSON.stringify(prefix),JSON.stringify(padded));
  assert.equal(prefix.context.year.complete,false);
 }
});
test('midnight and rising dynamic support cannot erase the pre-move floor',()=>{
 const a=app(),w=edge(),open=Date.UTC(2026,7,29,20,45);
 const daily=Array.from({length:8},(_,i)=>candle(open-(9-i)*86400000,105,86400000,100,110));
 const before=[candle(open,120,900000,100,121)];
 const after=[...before,candle(open+900000,120,900000,119,121)];
 for(const c of [a,w]){
  assert.equal(c.recoveryHistory(before,[],[],daily,120).dipReference,100);
  assert.equal(c.recoveryHistory(after,[],[],daily,120).dipReference,100);
  const risingLows=[105,104,100,104,105,106,102,106,107,108,104,108,109].map((low,i)=>candle(open+i*900000,low+1,900000,low,low+2));
  assert.equal(c.recoveryHistory(risingLows,[],[],daily,120).dipReference,100,'higher lows retain the original confirmed floor');
  const x=fixture();x.p.support=119;x.p.recovery.advanceFromDipPct=20;c.x=x;
  assert.equal(run(c,"finderRiskFlags(x).advancedLate"),true);
 }
});
test('main D1 requires a confirmed higher-timeframe resistance, never an arbitrary second micro high',()=>{
 const a=app(),w=edge();
 const micro=[100,100,101,100,100,100,102,100,100].map((v,i)=>candle(i*900000,99,900000,98,v));
 const hour=[100,100,110,100,100].map((v,i)=>candle(i*900000,99,900000,98,v));
 for(const c of [a,w]){
  let p=c.recoveryHistory(micro,hour,[],[],100);assert.equal(p.interimTarget,101);assert.equal(p.mainTarget,110);
  p=c.recoveryHistory(micro,[],[],[],100);assert.equal(p.interimTarget,101);assert.equal(p.mainTarget,101);
 }
});
test('invalid spreads, distribution, invalid conditional stop and stale plans cannot unlock entry',()=>{
 const a=app(),w=edge();
 for(const change of [x=>x.spread=NaN,x=>x.spread=-.1,x=>x.flow.distribution=true,x=>{x.p.conditionalEntry=97;x.p.marketRR=1;}]){
  const x=fixture();change(x);a.x=x;w.x=x;assert.equal(run(a,'entryState(x).hard'),true);assert.equal(run(w,'candidateState(x)'),'REJECT');
 }
 a.x=fixture();a.x.revalidating=true;assert.equal(run(a,'entryState(x).key'),'RECHECK');
 a.x=fixture();a.x.p.near=true;a.x.analyzedAt=Date.now()-17*60e3;assert.equal(run(a,'entryState(x).key'),'RECHECK');
 for(const c of [a,w]){
  const x=fixture();x.p.near=true;x.p.bounce=false;c.x=x;
  assert.equal(run(c,c===a?'entryState(x).key':'candidateState(x)'),'LIMIT_WAIT');
  x.p.bounce=true;x.p.marketRR=1.3;
  assert.equal(run(c,c===a?'entryState(x).key':'candidateState(x)'),c===a?'CONFIRMED':'BUY');
  x.p.recovery.confirmedSupportBreak=true;
  assert.equal(run(c,c===a?'entryState(x).key':'candidateState(x)'),c===a?'BROKEN':'REJECT');
 }
});
test('a dynamic-only support cannot fabricate a below-market conditional plan',()=>{
 for(const c of [app(),edge()]){
  const rows=Array.from({length:80},(_,i)=>candle(i*900000,100+i*.01));
  const m=c.calc(rows),h=c.calc(rows),flow=c.buildFlowContext(rows,{status:'VERİ YOK'},m);
  const p=c.tradePlan(rows,rows,m,h);assert.equal(p.supportSource,'DYNAMIC');
  p.zoneHigh=m.price-1;p.stop=m.price-2;
  c.enrichRecoveryPlan(p,rows,rows,rows,rows,m,h,flow,.1);
  assert.equal(p.conditionalEntry,p.marketEntry);
 }
});
test('year request and short-listing history: no fabricated full-year coverage',async()=>{
 const a=app(),w=edge();
 const rows=Array.from({length:8},(_,i)=>candle(Date.UTC(2026,0,i+1),100,86400000));
 let requested='';a.fetch=async url=>{if(String(url).includes('/klines?'))requested=String(url);return new Response(JSON.stringify(rows));};
 assert.equal((await a.klines('NIL','1d')).length,8);assert.match(requested,/limit=366/);
 w.rows=rows;run(w,"fetchJsonAny=async urls=>{requested=urls[0];return rows}");
 assert.equal((await w.klines('NIL','1d')).length,8);assert.match(run(w,'requested'),/limit=366/);
 assert.equal(a.recoveryHistory([candle(Date.UTC(2026,1,1))],[],[],rows,100).context.year.complete,false);
});
test('Finder retains below-3% early/conditional candidates; does not force three or admit hard failures',async()=>{
 const a=app();a.setTimeout=callback=>{queueMicrotask(callback);return 1};
 const candidates=['AAA','BBB','CCC','BAD'].map((name,i)=>{
  const x=fixture();x.name=name;x.qv=100000-i;x.m.ema9=100;x.m.ema21=99;x.m.macd=2;x.m.signal=1;x.m.vol=120;x.m.vma5=100;x.h.ema9=100;x.h.ema21=99;
  x.p.interimTarget=100.5;x.p.mainTarget=101;x.rpot={upside1:.66,expectedEdge:.2,profitScore:0,reach:7};return x;
 });
 candidates[1].p.conditionalEntry=100;candidates[1].p.marketRR=1.3;
 candidates[2].p.near=true;
 candidates[3].spread=1;
 a.candidates=candidates;
 run(a,"purgeGhostPairs=async()=>{};all24hTickers=async()=>candidates.map(x=>({symbol:x.name+'TRY',quoteVolume:x.qv}));allBookTickers=async()=>candidates.map(x=>({symbol:x.name+'TRY',bidPrice:99.9,askPrice:100}));candidateMetrics=async n=>candidates.find(x=>x.name===n)");
 let winners=await a.findDaily3();assert.equal(winners.length,3);assert.ok(winners.every(x=>x.name!=='BAD'));assert.ok(winners.every(x=>x.scanState.key!=='CONFIRMED'));
 a.candidates=[candidates[0]];winners=await a.findDaily3();assert.equal(winners.length,1);assert.equal(winners[0].name,'AAA');
 assert.match(a.document.getElementById('candidateGrid').innerHTML,/KÂR ALANI DÜŞÜK/);
});
test('notification control shows progress, bounded checks; registration is not delivery evidence',async()=>{
 const a=app();a.location.origin='https://fatihhanfan-orhan.github.io';
 let opened=false;a.document.getElementById('autoStatus').closest=()=>({set open(v){opened=v}});
 let release;a.fetchWithTimeout=()=>new Promise(resolve=>{release=resolve});
 const pending=a.enableNotifications();assert.equal(a.document.getElementById('notifyBtn').disabled,true);assert.match(a.document.getElementById('notifyBtn').textContent,/kontrol/);assert.equal(opened,true);
 release(new Response('',{status:404}));await pending;
 assert.equal(a.document.getElementById('notifyBtn').disabled,false);assert.match(a.document.getElementById('autoStatus').textContent,/404/);
 assert.match(String(a.enableNotifications),/15000/);
});

const replayData=JSON.parse(fs.readFileSync(new URL('tests/fixtures/recovery-replay.json',root),'utf8'));
test('NIL / MANTRA / TST historical candle replay: prefix-only parity and safety (spread assumption, not execution proof)',()=>{
 const a=app(),w=edge();
 for(const scenario of replayData.cases){
  const start=Date.parse(scenario.date+'T00:00:00+03:00'),end=start+86400000,first={};let checked=0,lateSignals=0;
  for(const bar of scenario.frames['15m']){
   const asOf=bar[6];if(asOf<start||asOf>=end)continue;
   const frames=Object.fromEntries(Object.entries(scenario.frames).map(([key,rows])=>[key,rows.filter(r=>r[6]<=asOf).slice(-(key==='1d'?365:220))]));
   if(frames['15m'].length<51||frames['1h'].length<51)continue;
   const outputs=[];
   for(const c of [a,w]){
    c.frames=frames;
    run(c,'m=calc(frames["15m"]);h=calc(frames["1h"]);flow=buildFlowContext(frames["15m"],{status:"VERİ YOK"},m);p=enrichRecoveryPlan(tradePlan(frames["15m"],frames["1h"],m,h),frames["15m"],frames["1h"],frames["4h"],frames["1d"],m,h,flow,.1);x={m,h,p,flow,spread:.1,s:score(m,h,p),buy:score(m,h,p).buy};');
    const state=run(c,c===a?'entryState(x).key':'candidateState(x)');
    if(state==='CONFIRMED'||state==='BUY'){assert.ok(c.p.bounce);assert.ok(c.p.marketRR>=1.3);}
    if(state==='CONDITIONAL'){assert.ok(c.p.conditionalEntry<c.p.marketEntry);assert.ok(c.p.conditionalRR>=1.3);assert.equal(c.p.supportSource,'HORIZONTAL');}
    outputs.push({state,plan:c.p});
   }
   const map={CONFIRMED:'BUY',BROKEN:'REJECT',FLOW_RISK:'REJECT'};
   if(checked===0){const panel=a.planUI(a.p,a.m,a.h);assert.match(panel,/1 yıllık geçmiş eksik|1yıl/);assert.match(panel,/PİYASA GİRİŞ R\/R/);assert.match(panel,/KOŞULLU LİMİT R\/R/);}
   assert.equal(map[outputs[0].state]||outputs[0].state,outputs[1].state,scenario.coin+' '+asOf);
   assert.equal(JSON.stringify(outputs[0].plan),JSON.stringify(outputs[1].plan),scenario.coin+' plan');
   const state=outputs[0].state;if(!first[state])first[state]={at:new Date(asOf).toISOString(),price:bar[4],marketRR:a.p.marketRR,conditionalRR:a.p.conditionalRR};
   if(a.m.rsi6>=82||a.m.rsi12>=72)assert.ok(!['CONFIRMED','CONDITIONAL','EARLY','LIMIT_WAIT'].includes(state),'overheated '+scenario.coin);
   if(scenario.coin==='NIL'&&bar[4]>=2.7&&['CONFIRMED','CONDITIONAL','EARLY'].includes(state))lateSignals++;
   checked++;
  }
  assert.equal(checked,96,scenario.coin+' full day');
  assert.equal(lateSignals,0,'NIL late-entry protection');
  if(scenario.coin==='NIL')assert.ok(first.CONDITIONAL.price<=2.285,'NIL early region retained');
  if(scenario.coin==='TST')assert.ok(first.CONDITIONAL.price<=.774,'TST early region retained');
  console.log('CANDLE REPLAY (assumed spread 0.1%, no historical book):',scenario.coin,JSON.stringify(first));
 }
});

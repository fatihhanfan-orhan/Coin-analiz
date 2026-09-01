import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {CriticalAlarm,ALARM_RECIPIENTS} from '../critical-alarm.mjs';

function harness(){
  const records=new Map();let wake=null,now=1_000_000;
  const storage={get:async k=>structuredClone(records.get(k)),put:async(k,v)=>records.set(k,structuredClone(v)),setAlarm:async n=>{wake=n;},deleteAlarm:async()=>{wake=null;},transaction:async fn=>fn(storage)};
  const env={CRITICAL_ALARM_ENABLED:'true'},plan={kind:'CONDITIONAL',entry:99,stop:98,target:101,rr:2};
  let current=plan,checks=0;
  const alarm=new CriticalAlarm({storage},env,async()=>{checks++;return current;});
  alarm.now=()=>now;
  const sent=[];
  alarm.send=async(state,p)=>{sent.push({state:structuredClone(state),plan:structuredClone(p)});return Response.json({id:'notification-'+sent.length});};
  return {alarm,storage,env,sent,setPlan:p=>current=p,advance:ms=>{now+=ms;},get checks(){return checks;},get wake(){return wake;}};
}
function request(path,body){return new Request('https://alarm'+path,{method:'POST',body:JSON.stringify(body)});}

test('immediate + 30 second repeats, six sends maximum, no backlog after 3 minutes',async()=>{
  const h=harness();await h.alarm.fetch(request('/start',{coin:'HEMI'}));assert.equal(h.sent.length,1);
  for(let i=1;i<6;i++){h.advance(30000);await h.alarm.alarm();assert.equal(h.sent.length,i+1);}
  h.advance(30000);await h.alarm.alarm();assert.equal(h.sent.length,6);assert.equal(h.wake,null);
  assert.equal((await h.storage.get('state')).stopped,'EXPIRED');assert.equal(h.checks,6);
  await h.alarm.fetch(request('/start',{coin:'HEMI'}));assert.equal(h.sent.length,6);
});
test('same coin dedup persists across instance restart; only conditional -> BUY rearms',async()=>{
  const h=harness();await h.alarm.fetch(request('/start',{coin:'HEMI'}));
  await Promise.all([h.alarm.fetch(request('/start',{coin:'HEMI'})),h.alarm.fetch(request('/start',{coin:'HEMI'}))]);
  assert.equal(h.sent.length,1);
  const again=new CriticalAlarm({storage:h.storage},h.env,async()=>({kind:'CONDITIONAL'}));
  again.now=h.alarm.now;
  again.send=async()=>{throw Error('must not send');};
  assert.equal((await (await again.fetch(request('/start',{coin:'HEMI'}))).json()).started,false);
  h.setPlan({kind:'BUY',entry:100,stop:98,target:104,rr:2});
  await h.alarm.fetch(request('/start',{coin:'HEMI'}));assert.equal(h.sent.length,2);
});
test('tap on either phone stops the shared alarm; wrong/old tokens cannot stop it',async()=>{
  const h=harness();
  await h.alarm.fetch(request('/start',{coin:'HEMI'}));const s=await h.storage.get('state');
  assert.equal((await h.alarm.fetch(request('/ack',{...s,token:'wrong'}))).status,403);
  assert.equal((await h.alarm.fetch(request('/ack',s))).status,200);
  h.advance(30000);await h.alarm.alarm();assert.equal(h.sent.length,1);assert.equal(h.wake,null);
});
test('invalid, unavailable or downgraded opportunity stops repeats',async()=>{
  const h=harness();
  await h.alarm.fetch(request('/start',{coin:'HEMI'}));h.setPlan(null);
  h.advance(30000);await h.alarm.alarm();assert.equal(h.sent.length,1);assert.match((await h.storage.get('state')).stopped,/INVALID/);
});
test('tap while revalidation is pending wins, and delayed wakeup never catches up',async()=>{
  const h=harness();
  await h.alarm.fetch(request('/start',{coin:'HEMI'}));const s=await h.storage.get('state');
  let resume;h.alarm.validate=()=>new Promise(r=>{resume=r;});
  h.advance(30000);const pending=h.alarm.alarm();
  while(!resume)await Promise.resolve();
  await h.alarm.fetch(request('/ack',s));resume({kind:'CONDITIONAL'});await pending;assert.equal(h.sent.length,1);
  const late=harness();await late.alarm.fetch(request('/start',{coin:'AVAX'}));
  late.advance(240000);await late.alarm.alarm();assert.equal(late.sent.length,1);
});
test('uncertain provider responses reuse idempotency keys; no secret or broad audience',async()=>{
  const h=harness();const keys=[];
  h.alarm.send=async s=>{keys.push(s.pending);if(keys.length===1)throw Error('timeout');return Response.json({id:'same-message'});};
  await h.alarm.fetch(request('/start',{coin:'HEMI'}));h.advance(30000);await h.alarm.alarm();assert.equal(keys[0],keys[1]);
  assert.equal(ALARM_RECIPIENTS.length,2);assert.ok(!ALARM_RECIPIENTS.includes('12640147-f79d-42c5-a046-66aefecc46fb'));
  let payload;const original=globalThis.fetch;
  globalThis.fetch=async(_,opts)=>{payload=JSON.parse(opts.body);return Response.json({id:'test'});};
  try{
    h.alarm.env={ONESIGNAL_API_KEY:'test-only-placeholder',ONESIGNAL_APP_ID:'app',CRITICAL_ALARM_API:'https://coin-analiz-push-test.fatihhanfan.workers.dev'};
    await CriticalAlarm.prototype.send.call(h.alarm,await h.storage.get('state'),{kind:'CONDITIONAL',entry:99,stop:98,target:101,rr:2});
    assert.deepEqual(payload.include_subscription_ids,[...ALARM_RECIPIENTS]);assert.equal(payload.included_segments,undefined);assert.equal(payload.ttl,0);assert.equal(payload.priority,10);
    assert.match(payload.contents.en,/Piyasa AL değil/);assert.ok(!JSON.stringify(payload).includes('test-only-placeholder'));
  }finally{globalThis.fetch=original;}
});
test('SW preserves OneSignal clicks, enhances only critical notifications, blocks opened/expired plans',async()=>{
  const listeners={},shown=[],records=new Map(),jobs=[],requests=[];
  const cache={match:async k=>records.get(k),put:async(k,v)=>records.set(k,v)};
  const ctx=vm.createContext({Date,URL,Set,Response,AbortSignal,caches:{open:async()=>cache},fetch:async(url)=>{requests.push(url);return Response.json({active:true});},self:{registration:{scope:'https://fatihhanfan-orhan.github.io/Coin-analiz/',showNotification:async(t,o)=>shown.push(o)},addEventListener:(name,fn)=>{listeners[name]=fn;}}});
  vm.runInContext(fs.readFileSync(new URL('../critical-alarm-sw.js',import.meta.url),'utf8'),ctx);
  const a={id:webcrypto.randomUUID(),token:webcrypto.randomUUID()+webcrypto.randomUUID(),coin:'HEMI',expiresAt:Date.now()+180000,api:'https://coin-analiz-push-test.fatihhanfan.workers.dev'};
  const options={data:{notificationId:'onesignal-message',additionalData:{criticalAlarm:a}}};
  await ctx.self.registration.showNotification('test',options);assert.equal(shown[0].renotify,true);assert.equal(shown[0].silent,false);assert.equal(shown[0].vibrate.length,5);
  listeners.notificationclick({notification:{data:options.data,close(){}},stopImmediatePropagation(){throw Error('SDK blocked');},waitUntil:p=>jobs.push(p)});await Promise.all(jobs);
  await ctx.self.registration.showNotification('test',options);assert.equal(shown.length,1);assert.ok(requests.some(u=>u.endsWith('/alarm-ack')));
  await ctx.self.registration.showNotification('ordinary',{body:'unchanged'});assert.equal(shown.length,2);assert.equal(shown[1].vibrate,undefined);
  const expired={data:{additionalData:{criticalAlarm:{...a,id:webcrypto.randomUUID(),expiresAt:Date.now()-1}}}};
  await ctx.self.registration.showNotification('expired',expired);assert.equal(shown.length,2);
});

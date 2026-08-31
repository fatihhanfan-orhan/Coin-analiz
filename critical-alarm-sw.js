// Keep OneSignal responsible for push parsing, display and click analytics.
// Only critical Coin Analiz notifications are checked/enhanced here.
const criticalEndpoints = new Set([
  'https://coin-analiz.fatihhanfan.workers.dev',
  'https://coin-analiz-push-test.fatihhanfan.workers.dev'
]);
function criticalMetadata(data) {
  const a=data?.additionalData?.criticalAlarm;
  return a && criticalEndpoints.has(a.api) && /^[A-Z0-9]{2,20}$/.test(a.coin||'') &&
    /^[a-f0-9-]{36}$/.test(a.id||'') && String(a.token||'').length===72 && Number.isFinite(a.expiresAt) ? a : null;
}
function criticalOpenedKey(a){return new URL('./__critical_opened_'+a.id,self.registration.scope).href;}
const nativeCriticalDisplay=self.registration.showNotification.bind(self.registration);
self.registration.showNotification=async function(title,options={}){
  const a=criticalMetadata(options.data);
  if(!a)return nativeCriticalDisplay(title,options);
  if(Date.now()>=a.expiresAt)return;
  const cache=await caches.open('coin-critical-opened-v1');
  if(await cache.match(criticalOpenedKey(a)))return;
  try{
    const response=await fetch(a.api+'/alarm-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(a),signal:AbortSignal.timeout(4000),cache:'no-store'});
    if(!response.ok||!(await response.json()).active||Date.now()>=a.expiresAt||await cache.match(criticalOpenedKey(a)))return;
  }catch{return;}
  return nativeCriticalDisplay(title,{...options,tag:'v51-critical-'+a.coin,renotify:true,silent:false,vibrate:[250,150,250,150,400]});
};
self.addEventListener('notificationclick',event=>{
  const a=criticalMetadata(event.notification?.data);
  if(!a)return;
  // Do not stop propagation: OneSignal must also process this real click.
  event.waitUntil((async()=>{
    const cache=await caches.open('coin-critical-opened-v1');
    await cache.put(criticalOpenedKey(a),new Response(String(a.expiresAt)));
    event.notification.close();
    try{await fetch(a.api+'/alarm-ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(a),signal:AbortSignal.timeout(4000)});}catch{}
  })());
});

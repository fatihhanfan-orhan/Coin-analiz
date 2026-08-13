const CACHE='coin-analiz-v500-15-denetimli';
const CORE=['./','./index.html','./manifest.webmanifest','./ikon-192.png','./ikon-512.png'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  // Binance/OneSignal/Worker yanıtlarını önbelleğe alma; eski piyasa verisi kritik kararda kullanılmamalı.
  if(url.origin!==self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then(resp=>{
        if(resp.ok && (event.request.mode==='navigate' || CORE.some(x=>url.pathname.endsWith(x.replace('./','/'))))){
          const copy=resp.clone();
          caches.open(CACHE).then(c=>c.put(event.request,copy)).catch(()=>{});
        }
        return resp;
      })
      .catch(()=>caches.match(event.request).then(r=>r||(event.request.mode==='navigate'?caches.match('./index.html'):Promise.reject(new Error('Ağ bağlantısı yok')))))
  );
});

self.addEventListener('message',event=>{
  if(event.data?.type==='SETTINGS'){
    event.waitUntil(
      caches.open(CACHE).then(c=>c.put(
        './__coin_settings__',
        new Response(JSON.stringify({coins:event.data.coins||[],savedAt:Date.now()}),
        {headers:{'Content-Type':'application/json'}})
      ))
    );
  }
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const base=new URL('./',self.registration.scope);
    const requested=new URL(event.notification.data?.coinAnalizUrl||event.notification.data?.url||base.href,base);
    const url=requested.origin===base.origin&&requested.pathname.startsWith(base.pathname)?requested.href:base.href;
    const list=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of list){
      if('navigate' in client)await client.navigate(url);
      if('focus' in client)return client.focus();
    }
    return clients.openWindow(url);
  })());
});

self.addEventListener('periodicsync',event=>{
  if(event.tag==='coin-quarter-hour'){
    event.waitUntil(
      self.registration.showNotification('Coin Analiz V5.0',{
        body:'Yeni 15 dakikalık kontrol zamanı. Güncel analiz için Coin Analiz’i açın.',
        icon:'./ikon-192.png',
        badge:'./ikon-192.png',
        tag:'coin-periodic-v500-15',
        data:{coinAnalizUrl:new URL('./',self.registration.scope).href}
      })
    );
  }
});

const CACHE='coin-analiz-v462';
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
  event.respondWith(
    fetch(event.request)
      .then(resp=>{
        const copy=resp.clone();
        caches.open(CACHE).then(c=>c.put(event.request,copy)).catch(()=>{});
        return resp;
      })
      .catch(()=>caches.match(event.request).then(r=>r||caches.match('./index.html')))
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
  const url=event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
      for(const client of list){
        if('focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('periodicsync',event=>{
  if(event.tag==='coin-quarter-hour'){
    event.waitUntil(
      self.registration.showNotification('Coin Analiz V4.6',{
        body:'Yeni 15 dakikalık kontrol zamanı. Güncel analiz için Coin Analiz’i açın.',
        icon:'./ikon-192.png',
        badge:'./ikon-192.png',
        tag:'coin-periodic-v462',
        data:{url:'./'}
      })
    );
  }
});

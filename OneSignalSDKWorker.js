importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

self.addEventListener('message', event => {
  if (event.data?.type === 'SETTINGS') {
    event.waitUntil(
      caches.open('coin-analiz-push-v463').then(cache =>
        cache.put(
          './__coin_settings__',
          new Response(
            JSON.stringify({
              coins: event.data.coins || [],
              savedAt: Date.now()
            }),
            {headers:{'Content-Type':'application/json'}}
          )
        )
      )
    );
  }
});

self.addEventListener('periodicsync', event => {
  if (event.tag !== 'coin-quarter-hour') return;

  event.waitUntil(
    self.registration.showNotification('Coin Analiz V4.6', {
      body:'⏱️ Yeni 15 dakikalık kontrol zamanı. Güncel giriş fırsatlarını kontrol et.',
      icon:'./ikon-192.png',
      badge:'./ikon-192.png',
      tag:'coin-periodic-v463',
      renotify:true,
      data:{
        url:'https://fatihhanfan-orhan.github.io/Coin-analiz/'
      }
    })
  );
});
importScripts('./critical-alarm-sw.js');
self.addEventListener('notificationclick', event => {
  if(event.notification?.data?.notificationId)return; // OneSignal owns remote click navigation/analytics.
  event.stopImmediatePropagation();
  event.notification.close();
  event.waitUntil((async () => {
    const safeBase = new URL('./', self.registration.scope);
    const target = event.notification?.data?.coinAnalizUrl || event.notification?.data?.url || safeBase.href;
    const requested = new URL(target, safeBase);
    const destination = requested.origin === safeBase.origin && requested.pathname.startsWith(safeBase.pathname)
      ? requested.href
      : safeBase.href;
    const windows = await clients.matchAll({ type:'window', includeUncontrolled:true });
    for (const client of windows) {
      if ('navigate' in client) await client.navigate(destination);
      if ('focus' in client) return client.focus();
    }
    return clients.openWindow(destination);
  })());
});

importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

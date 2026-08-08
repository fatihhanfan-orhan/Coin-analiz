const CACHE='coin-analiz-v4-2-dynamic-420';
const CONFIG_CACHE='coin-analiz-config-v370';
const SHELL=['/','/index.html','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE&&k!==CONFIG_CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  const req=event.request;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin) return;
  if(req.mode==='navigate'){
    event.respondWith((async()=>{
      try{
        const net=await fetch('/index.html',{cache:'no-store'});
        const c=await caches.open(CACHE); await c.put('/index.html',net.clone());
        return net;
      }catch(e){ return (await caches.match('/index.html')) || (await caches.match('/')); }
    })());
    return;
  }
  event.respondWith((async()=>{
    try{
      const net=await fetch(req,{cache:'no-store'});
      const c=await caches.open(CACHE); await c.put(req,net.clone());
      return net;
    }catch(e){ return (await caches.match(req)) || Response.error(); }
  })());
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const list=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of list){
      if(new URL(c.url).origin===self.location.origin){ await c.focus(); return; }
    }
    await clients.openWindow('/');
  })());
});

self.addEventListener('message',event=>{
  if(event.data?.type==='SETTINGS'&&Array.isArray(event.data.coins)){
    event.waitUntil(saveJson('settings',{coins:event.data.coins.slice(0,3)}));
  }
});

self.addEventListener('periodicsync',event=>{
  if(event.tag==='coin-quarter-hour') event.waitUntil(backgroundCheck());
});

async function saveJson(key,obj){const c=await caches.open(CONFIG_CACHE);await c.put(new Request(new URL(`/__${key}__`,self.location.origin)),new Response(JSON.stringify(obj),{headers:{'content-type':'application/json'}}));}
async function loadJson(key,def={}){try{const c=await caches.open(CONFIG_CACHE),r=await c.match(new Request(new URL(`/__${key}__`,self.location.origin)));return r?await r.json():def}catch{return def}}
function ema(a,p){const k=2/(p+1);let o=[a[0]];for(let i=1;i<a.length;i++)o.push(a[i]*k+o[i-1]*(1-k));return o}
function sma(a,p){return a.map((_,i)=>i<p-1?NaN:a.slice(i-p+1,i+1).reduce((x,y)=>x+y,0)/p)}
function rsi(a,p=14){let g=0,l=0;for(let i=1;i<=p;i++){let d=a[i]-a[i-1];d>=0?g+=d:l-=d}let ag=g/p,al=l/p,o=Array(p).fill(NaN);o.push(al===0?100:100-100/(1+ag/al));for(let i=p+1;i<a.length;i++){let d=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;o.push(al===0?100:100-100/(1+ag/al))}return o}
function stdev(a){let m=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0)/a.length)}
function calc(k){const c=k.map(x=>+x[4]),v=k.map(x=>+x[5]),i=c.length-1,E9=ema(c,9),E21=ema(c,21),R=rsi(c),M12=ema(c,12),M26=ema(c,26),macd=M12.map((x,j)=>x-M26[j]),sig=ema(macd,9),hist=macd.map((x,j)=>x-sig[j]),ma5=sma(v,5),ma10=sma(v,10),mid=sma(c,20),sd=stdev(c.slice(-20));return{price:c[i],vol:v[i],vma5:ma5[i],vma10:ma10[i],ema9:E9[i],ema21:E21[i],rsi:R[i],macd:macd[i],signal:sig[i],hist:hist[i],prevHist:hist[i-1],bollMid:mid[i],bollUp:mid[i]+2*sd}}
function score(m,h){let buy=0,sell=0;const add=(good,w=1,neutral=false)=>{if(good)buy+=w;else if(!neutral)sell+=w};add(m.vol>m.vma5,2);add(m.vma5>m.vma10,1);add(m.price>m.ema9,1);add(m.ema9>m.ema21,2);add(h.ema9>h.ema21,1.5);add(m.rsi>=50&&m.rsi<=68,1,m.rsi>68&&m.rsi<75);add(m.macd>m.signal,1.5);add(m.hist>m.prevHist,1);add(m.price>m.bollMid&&m.price<m.bollUp,1,m.price<=m.bollMid);return Math.round(Math.min(10,buy/12*10)*10)/10}
function decision(v){return v>=7.5?'AL':v>=5?'BEKLE':'ALMA/SAT'}
function closed(rows,ms){const now=Date.now();return rows.filter(x=>{const open=+x[0],close=Number.isFinite(+x[6])?+x[6]:open+ms-1;return close<now-1500})}
async function klines(name,interval){const clean=name.toUpperCase().replace(/[^A-Z0-9]/g,''),ms=interval==='15m'?900000:3600000;const urls=[`https://api.binance.me/api/v1/klines?symbol=${clean}TRY&interval=${interval}&limit=220`,`https://cloudme-tr.2meta.app/api/v1/klines?symbol=${clean}_TRY&interval=${interval}&limit=220`,`https://cloudme-tr.2meta.app/api/v1/klines?symbol=${clean}TRY&interval=${interval}&limit=220`];for(const url of urls){try{const r=await fetch(url,{cache:'no-store'});if(!r.ok)continue;const j=await r.json(),raw=Array.isArray(j)?j:j.data,d=Array.isArray(raw)?closed(raw,ms):[];if(d.length>50)return d}catch{}}throw new Error('veri yok')}
async function backgroundCheck(){
  const cfg=await loadJson('settings',{coins:['BANK','HEI','TLM']});
  const state=await loadJson('state',{}); let max15=0,max1h=0; const lines=[];
  for(const name of cfg.coins||[]){try{const [a,b]=await Promise.all([klines(name,'15m'),klines(name,'1h')]);max15=Math.max(max15,+a[a.length-1][0]);max1h=Math.max(max1h,+b[b.length-1][0]);const v=score(calc(a),calc(b));lines.push(`${name} ${decision(v)} ${v}/10`)}catch{lines.push(`${name} veri yok`)}}
  const new15=max15&&max15!==state.last15, new1h=max1h&&max1h!==state.last1h;
  if(new15){await self.registration.showNotification(new1h?'🕐 1 Saat + 15 dk Teyidi':'⏱️ 15 Dakika Kapanışı',{body:lines.join(' • '),icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:new1h?'coin-bg-1h':'coin-bg-15m',renotify:true,vibrate:[120,70,120],data:{url:'/'}})}
  await saveJson('state',{last15:max15||state.last15||0,last1h:max1h||state.last1h||0});
}

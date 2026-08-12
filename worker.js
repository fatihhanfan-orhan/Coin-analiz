// Coin Analiz V5.0 FINAL Worker — 15dk + 1saat gerçek arka plan push
const BINANCE_API_BASES = [
  'https://data-api.binance.vision/api/v3',
  'https://api-gcp.binance.com/api/v3',
  'https://api1.binance.com/api/v3',
  'https://api2.binance.com/api/v3',
  'https://api3.binance.com/api/v3',
  'https://api4.binance.com/api/v3'
];

const BINANCE_24H_URLS = BINANCE_API_BASES.map(base => `${base}/ticker/24hr`);
const BINANCE_BOOK_URLS = BINANCE_API_BASES.map(base => `${base}/ticker/bookTicker`);

const TOP_N = 32;
const TRACK_COUNT = 3;
const STATE_KEY = 'coin-analiz-state-v2';
const ALERT_MEMORY_KEY = 'coin-analiz-alert-memory-v1';
const POSITION_COOLDOWN_MS = 90 * 60 * 1000;
const EXCLUDED_BASES = new Set(['BTC','ETH','USDT','USDC','FDUSD','DAI','TRY','EUR']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === '/' || url.pathname === '/health') {
        const state = await loadState(env);
        return json({
          ok: true,
          service: 'Coin Analiz Worker V5.0 — 7/24 Bildirim',
          version: '5.0-WORKER-PROFIT-4H',
          kvConfigured: Boolean(env.COIN_KV),
          oneSignalAppIdConfigured: Boolean(env.ONESIGNAL_APP_ID),
          oneSignalApiKeyConfigured: Boolean(env.ONESIGNAL_API_KEY),
          tracked: (state.tracked || []).map(x => x.name),
          marketTop3: (state.marketTop3 || []).map(x => x.name),
          lastHourlyAt: state.lastHourlyAt || null,
          last4hScanAt: state.last4hScanAt || null,
          updatedAt: state.updatedAt || null,
          recommendedCron: '*/15 * * * *'
        });
      }

      if (url.pathname === '/tracked') {
        return json(await loadState(env));
      }

      if (url.pathname === '/scan') {
        const result = await backgroundCycle(env, { notify: false, forceFullScan: true, source: 'manual-scan' });
        return json(result);
      }

      if (url.pathname === '/test-notification') {
        await sendOneSignal(env, [{
          type:'TEST', name:'COIN',
          title:'✅ Coin Analiz Worker Test',
          body:'Cloudflare Worker → OneSignal arka plan bildirimi çalışıyor.'
        }]);
        return json({ok:true, sent:true});
      }

      // Web sayfasındaki 3 coini Worker takip listesine aktarır.
      if (url.pathname === '/set-tracked' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const names = normalizeNames(body.coins || body.names || []);
        if (!names.length) return json({ ok:false, error:'Coin listesi boş.' }, 400);

        const analyzed = [];
        for (const name of names.slice(0, TRACK_COUNT)) {
          try { analyzed.push(await analyzeCandidate(name, null, new Map())); }
          catch (e) { analyzed.push({ name, error: String(e?.message || e) }); }
        }
        const good = analyzed.filter(x => !x.error);
        if (!good.length) return json({ ok:false, error:'Takip için geçerli veri alınamadı.', details:analyzed }, 422);

        const previous = await loadState(env);
        const next = {
          ...previous,
          tracked: sortByProfit(good).slice(0, TRACK_COUNT),
          trackedSource: 'web-selection',
          source: 'web-selection',
          updatedAt: new Date().toISOString()
        };
        await saveState(env, next);
        return json({ ok:true, tracked: next.tracked, updatedAt: next.updatedAt });
      }

      return json({ ok:false, error:'Not found' }, 404);
    } catch (e) {
      return json({ ok:false, error:String(e?.message || e) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    const t = new Date(Number(controller.scheduledTime || Date.now()));
    const minute = t.getUTCMinutes();
    const hour = t.getUTCHours();
    const turkeyHour = (hour + 3) % 24;
    // Önerilen Cron: */15 * * * *
    // Her tetikte takip edilen coinlerde uygun pozisyon kontrolü.
    // Saat başında saatlik özet; 4 saatte bir tam 32 coin taraması.
    const hourly = minute === 0;
    const fourHourly = hourly && (turkeyHour % 4 === 0);
    ctx.waitUntil(backgroundCycle(env, {
      notify: true,
      source: 'cron',
      cron: controller.cron,
      hourly,
      fourHourly,
      scheduledAt: t.toISOString()
    }));
  }
};

async function backgroundCycle(env, opts = {}) {
  const previous = await loadState(env);
  const shouldFullScan = Boolean(opts.forceFullScan || opts.fourHourly || !(previous.tracked || []).length);

  let market = null;
  let marketTop3 = previous.marketTop3 || [];
  if (shouldFullScan) {
    market = await scanMarket();
    const eligible = market.metrics.filter(x => x.rpot?.eligible).sort(compareProfitFirst);
    const backups = market.metrics.filter(x => x.rpot && !x.rpot.eligible).sort(compareProfitFirst);
    marketTop3 = eligible.slice(0, TRACK_COUNT);
    for (const x of backups) {
      if (marketTop3.length >= TRACK_COUNT) break;
      if (!marketTop3.some(y => y.name === x.name)) marketTop3.push(x);
    }
  }

  // Takip listesindeki coinleri her cron tetiklenmesinde (önerilen 15 dk) yeniden analiz et.
  const currentTracked = [];
  for (const old of (previous.tracked || []).slice(0, TRACK_COUNT)) {
    const name = cleanBase(old?.name || old?.symbol || '');
    if (!name) continue;
    try { currentTracked.push(await analyzeCandidate(name, null, market?.bookMap || new Map())); }
    catch {}
  }

  let tracked;
  if (currentTracked.length) {
    // Web sayfasının seçtiği coinleri değiştirme; sadece kâr potansiyeline göre sırala.
    tracked = sortByProfit(currentTracked).slice(0, TRACK_COUNT);
  } else {
    tracked = sortByProfit(marketTop3).slice(0, TRACK_COUNT);
  }

  const positionAlerts = opts.notify ? await buildPositionAlerts(env, previous.tracked || [], tracked) : [];
  if (positionAlerts.length) await sendOneSignal(env, positionAlerts);

  if (opts.notify && tracked.length) { await sendQuarterHourSummary(env, tracked); }

  if (opts.hourly && opts.notify && tracked.length) {
    await sendHourlySummary(env, tracked);
  }

  if (opts.fourHourly && opts.notify && marketTop3.length) {
    await sendFourHourScan(env, marketTop3, market?.scanned || 0);
  }

  const state = {
    ...previous,
    tracked,
    marketTop3,
    source: opts.source || previous.source || 'cron',
    lastAlerts: positionAlerts,
    lastHourlyAt: opts.hourly ? (opts.scheduledAt || new Date().toISOString()) : (previous.lastHourlyAt || null),
    last4hScanAt: opts.fourHourly ? (opts.scheduledAt || new Date().toISOString()) : (previous.last4hScanAt || null),
    updatedAt: new Date().toISOString()
  };
  await saveState(env, state);

  return {
    ok: true,
    mode: shouldFullScan ? 'full-scan' : 'tracked-check',
    scanned: market?.scanned || 0,
    valid: market ? market.metrics.filter(x => x.rpot?.eligible).length : null,
    tracked,
    marketTop3,
    alerts: positionAlerts,
    hourly: Boolean(opts.hourly),
    fourHourly: Boolean(opts.fourHourly),
    updatedAt: state.updatedAt
  };
}

function sortByProfit(list) {
  return [...(list || [])].sort(compareProfitFirst);
}

function compareProfitFirst(a,b) {
  // Bizim önceliğimiz: elde edilebilir Hedef-1 yüzde kârı.
  // Eşitlikte giriş kalitesi/fırsat puanı ve AL puanı devreye girer.
  return (Number(b?.rpot?.upside1||0)-Number(a?.rpot?.upside1||0)) ||
         (Number(b?.candidate||0)-Number(a?.candidate||0)) ||
         (Number(b?.buy||0)-Number(a?.buy||0));
}

function chooseTracked(current, marketTop3) {
  if (!current.length) return marketTop3.slice(0, TRACK_COUNT).sort(compareCandidate);

  const list = [...current];
  for (const c of marketTop3) {
    if (list.some(x => x.name === c.name)) continue;
    list.sort(compareCandidate);
    const weakest = list[list.length - 1];
    if (list.length < TRACK_COUNT || Number(c.candidate || 0) >= Number(weakest?.candidate || 0) + 8) {
      if (list.length >= TRACK_COUNT) list.pop();
      list.push(c);
    }
  }
  return list.sort(compareCandidate).slice(0, TRACK_COUNT);
}

async function buildPositionAlerts(env, prevList, nowList) {
  const prev = new Map(prevList.map(x => [cleanBase(x.name), x]));
  const candidates = [];
  const leader = sortByProfit(nowList)[0];
  const prevLeader = sortByProfit(prevList)[0];

  for (const x of nowList) {
    const p = prev.get(x.name);
    const d = Number(x.p?.dist ?? 99);
    const buy = Number(x.buy || 0);
    const upside = Number(x.rpot?.upside1 || 0);
    const price = Number(x.m?.price || 0);
    const t1 = Number(x.p?.t1 || 0);
    const targetRemaining = (price>0 && t1>0) ? ((t1-price)/price*100) : 99;
    const buyReady = Boolean(x.p?.bounce) && buy >= 7.0;
    const nearSupport = d >= -0.20 && d <= 0.80;
    const targetNear = targetRemaining >= 0 && targetRemaining <= 1.0;
    const targetHit = price>0 && t1>0 && price >= t1;

    const prevD = Number(p?.p?.dist ?? 99);
    const prevBuy = Number(p?.buy || 0);
    const prevBuyReady = Boolean(p?.p?.bounce) && prevBuy >= 7.0;
    const prevNear = prevD >= -0.20 && prevD <= 0.80;
    const prevPrice = Number(p?.m?.price || 0);
    const prevT1 = Number(p?.p?.t1 || 0);
    const prevRemain = (prevPrice>0 && prevT1>0) ? ((prevT1-prevPrice)/prevPrice*100) : 99;

    if (!p) {
      candidates.push({type:'TRACK_NEW',name:x.name,title:`🆕 Takip: ${x.name}/TRY`,body:`Kâr potansiyeli +${fmt2(upside)}% • AL ${fmt1(buy)}/10 • desteğe ${fmtPct(d)}`});
      continue;
    }
    if (buyReady && !prevBuyReady) {
      candidates.push({type:'BUY_READY',name:x.name,title:`🎯 ${x.name}/TRY — TEYİTLİ GİRİŞ`,body:`AL ${fmt1(buy)}/10 • kâr potansiyeli +${fmt2(upside)}% • desteğe ${fmtPct(d)} • R/K 1:${fmt2(x.p?.rr)}`});
    }
    if (nearSupport && !prevNear) {
      candidates.push({type:'SUPPORT_NEAR',name:x.name,title:`🔔 ${x.name}/TRY alım bölgesinde`,body:`Desteğe ${fmtPct(d)} • AL ${fmt1(buy)}/10 • kâr potansiyeli +${fmt2(upside)}% • teyit ${x.p?.bounce?'VAR':'BEKLENİYOR'}`});
    }
    if (buy >= prevBuy + 1.5 && buy >= 6.5) {
      candidates.push({type:'BUY_SCORE_UP',name:x.name,title:`📈 ${x.name}/TRY AL puanı güçlendi`,body:`AL ${fmt1(prevBuy)} → ${fmt1(buy)}/10 • kâr potansiyeli +${fmt2(upside)}%`});
    }
    if (targetNear && prevRemain > 1.0) {
      candidates.push({type:'TARGET_NEAR',name:x.name,title:`💰 ${x.name}/TRY hedefe yaklaştı`,body:`Hedef-1'e yaklaşık ${fmt2(Math.max(0,targetRemaining))}% kaldı • mevcut kâr alanını koru/çıkışı değerlendir.`});
    }
    if (targetHit && prevPrice < prevT1) {
      candidates.push({type:'TARGET_HIT',name:x.name,title:`✅ ${x.name}/TRY Hedef-1'e ulaştı`,body:`Hedef-1 ${fmtPrice(t1)} • fiyat ${fmtPrice(price)} • kârı korumayı değerlendir.`});
    }
    if (d < -0.80 && prevD >= -0.80) {
      candidates.push({type:'SUPPORT_LOST',name:x.name,title:`⚠️ ${x.name}/TRY destek altına sarktı`,body:`Desteğe mesafe ${fmtPct(d)} • AL ${fmt1(buy)}/10`});
    }
  }

  if (leader && prevLeader && leader.name !== prevLeader.name && Number(leader.rpot?.upside1||0) >= 3) {
    candidates.push({
      type:'PROFIT_LEADER',name:leader.name,
      title:`🏆 En yüksek kâr fırsatı: ${leader.name}/TRY`,
      body:`Takip listesinin lideri değişti • Hedef-1 kâr potansiyeli +${fmt2(leader.rpot?.upside1)}% • AL ${fmt1(leader.buy)}/10`
    });
  }

  const deduped = dedupeAlerts(candidates);
  const allowed = [];
  for (const a of deduped) {
    if (await allowAlert(env, a.type, a.name)) allowed.push(a);
  }
  return allowed.slice(0, 4);
}

async function allowAlert(env, type, name) {
  if (!env.COIN_KV) return true;
  const key = `${ALERT_MEMORY_KEY}:${type}:${name}`;
  const now = Date.now();
  const last = Number(await env.COIN_KV.get(key) || 0);
  if (last && now-last < POSITION_COOLDOWN_MS) return false;
  await env.COIN_KV.put(key, String(now), { expirationTtl: 6*60*60 });
  return true;
}

async function sendQuarterHourSummary(env, tracked) {
  const ranked=sortByProfit(tracked).slice(0,3);
  if(!ranked.length)return;
  const body=ranked.map((x,i)=>`${i+1}) ${x.name} • AL ${fmt1(x.buy)}/10 • destek ${fmtPct(x.p?.dist)} • H1 +${fmt2(x.rpot?.upside1)}%`).join(' | ');
  await sendOneSignal(env,[{type:'QUARTER_HOUR',name:ranked[0].name,title:'⏱️ Coin Analiz — 15 Dakika Kapanışı',body}]);
}

async function sendHourlySummary(env, tracked) {
  const ranked = sortByProfit(tracked);
  const leader = ranked[0];
  const body = ranked.map((x,i)=>`${i===0?'🏆 ':''}${x.name}: +${fmt2(x.rpot?.upside1)}% • AL ${fmt1(x.buy)}/10 • ${String(x.p?.status||'')}`).join(' | ');
  await sendOneSignal(env,[{
    type:'HOURLY', name:leader?.name||'COIN',
    title:'🕐 Coin Analiz — Saatlik Takip',
    body
  }]);
}

async function sendFourHourScan(env, top3, scanned) {
  const ranked = sortByProfit(top3).slice(0,3);
  const leader = ranked[0];
  const body = ranked.map((x,i)=>`${i+1}) ${x.name} +${fmt2(x.rpot?.upside1)}% • AL ${fmt1(x.buy)}/10 • destek ${fmtPct(x.p?.dist)}`).join(' | ');
  await sendOneSignal(env,[{
    type:'FOUR_HOUR_SCAN', name:leader?.name||'COIN',
    title:'🔎 4 Saatlik Yeni Coin Taraması',
    body:`${scanned || TOP_N} coin tarandı • ${body}`
  }]);
}

async function scanMarket() {
  const [tickers, books] = await Promise.all([all24hTickers(), allBookTickers()]);
  const bookMap = new Map(books.map(x => [String(x.symbol || x.s || ''), x]));

  let tryTicks = tickers.filter(t => {
    const sym = String(t.symbol || t.s || '');
    const base = baseFromSymbol(sym);
    return /_?TRY$/.test(sym) && base && !EXCLUDED_BASES.has(base) && num(t,'quoteVolume','q','volumeQuote','quoteAssetVolume') > 0;
  });

  tryTicks.sort((a,b) => num(b,'quoteVolume','q','volumeQuote','quoteAssetVolume') - num(a,'quoteVolume','q','volumeQuote','quoteAssetVolume'));
  const top = tryTicks.slice(0, TOP_N);
  if (!top.length) throw new Error('TRY piyasa listesi alınamadı.');

  const metrics = [];
  // API yükünü kontrollü tutmak için üçlü gruplar.
  for (let i=0; i<top.length; i+=3) {
    const batch = top.slice(i, i+3);
    const got = await Promise.all(batch.map(async t => {
      const name = baseFromSymbol(String(t.symbol || t.s || ''));
      try { return await analyzeCandidate(name, t, bookMap); }
      catch { return null; }
    }));
    metrics.push(...got.filter(Boolean));
  }

  if (metrics.length < 3) throw new Error('Yeterli TRY coin verisi alınamadı.');
  assignCandidateScores(metrics);
  return { scanned: top.length, metrics, bookMap };
}

async function analyzeCandidate(name, t24, bookMap = new Map()) {
  const [a,b] = await Promise.all([klines(name,'15m'), klines(name,'1h')]);
  const m = calc(a), h = calc(b);

  let ticker = t24;
  if (!ticker) {
    ticker = await ticker24(name).catch(() => ({}));
  }

  const qv = num(ticker,'quoteVolume','q','volumeQuote','quoteAssetVolume');
  const ch = num(ticker,'priceChangePercent','P') || ((num(ticker,'lastPrice','c')/(num(ticker,'openPrice','o')||1)-1)*100);
  const bk = bookMap.get(name+'TRY') || bookMap.get(name+'_TRY') || {};
  const bid = num(bk,'bidPrice','b') || num(ticker,'bidPrice','b');
  const ask = num(bk,'askPrice','a') || num(ticker,'askPrice','a');
  const mid = (bid+ask)/2;
  const spread = (bid&&ask&&mid) ? ((ask-bid)/mid*100) : 99;
  const vRatio = m.vma5 ? m.vol/m.vma5 : 0;
  const impulse = m.vma10 ? m.vma5/m.vma10 : 0;
  const vola = volatility15(a);
  const trend = (m.ema9>m.ema21?1:0)+(h.ema9>h.ema21?1:0)+(m.macd>m.signal?1:0)+(m.hist>m.prevHist?1:0);
  const p = tradePlan(a,b,m,h);
  const out = { name,qv,ch,spread,vRatio,impulse,vola,trend,buy:score(m,h,p).buy,m,h,p };
  out.rpot = resistancePotential(out);
  return out;
}

function assignCandidateScores(metrics) {
  const logs = metrics.map(x => Math.log10(Math.max(1,x.qv)));
  const lmin = Math.min(...logs), lmax = Math.max(...logs);

  for (const x of metrics) {
    const d=Number(x.p?.dist??99), absd=Math.abs(d), inZone=!!x.p?.near, bounce=!!x.p?.bounce;
    let proximity=0;
    if(bounce)proximity=38;
    else if(inZone)proximity=33;
    else if(d>=0&&d<=0.75)proximity=30;
    else if(d>0&&d<=1.5)proximity=25;
    else if(d>1.5&&d<=2.5)proximity=18;
    else if(d>2.5&&d<=4)proximity=9;
    else if(d<0&&absd<=1)proximity=13;

    const reversal=(bounce?10:0)+(x.m.hist>x.m.prevHist?4:0)+(x.m.macd>x.m.signal?3:0)+(x.m.price>x.m.ema9?3:0);
    const volume=norm(Math.min(x.vRatio,2.5),.75,1.8)*12;
    const trend=((x.m.ema9>x.m.ema21?1:0)+(x.h.ema9>x.h.ema21?1:0))*4;
    const rsiPts=(x.m.rsi>=42&&x.m.rsi<=66)?7:(x.m.rsi>=35&&x.m.rsi<72?4:0);
    const liquid=(1-norm(Math.min(x.spread,.8),.05,.5))*8;
    const qvol=norm(Math.log10(Math.max(1,x.qv)),lmin,lmax)*2;
    const profitPts=(x.rpot?.profitScore||0)*3.0;
    const supportPts=Math.min(30,(proximity+reversal)*1.5);
    const reachPts=(x.rpot?.reach||0)*2.0;
    const momentumPts=Math.min(15,volume+trend+rsiPts);
    const liquidPts=Math.min(5,liquid+qvol);
    const chasePenalty=d>3?Math.min(30,(d-3)*5):0;
    const belowPenalty=d<-1.5?10:0;
    const overheat=x.m.rsi>72?8:0;
    x.candidate=Math.max(0,Math.min(100,profitPts+reachPts+supportPts+momentumPts+liquidPts-chasePenalty-belowPenalty-overheat));
  }
}

function compareCandidate(a,b) {
  return (Number(b?.candidate||0)-Number(a?.candidate||0)) || (Number(b?.rpot?.upside1||0)-Number(a?.rpot?.upside1||0));
}

function resistancePotential(x){
  const p=x.p||{}, m=x.m||{}, h=x.h||{};
  const entry=p.near?Number(m.price||0):Math.max(Number(p.zoneHigh||0),Number(m.price||0));
  const t1=Number(p.t1||0), t2=Number(p.t2||0);
  const upside1=(entry>0&&t1>entry)?((t1-entry)/entry*100):0;
  const upside2=(entry>0&&t2>entry)?((t2-entry)/entry*100):0;
  const rr=Number(p.rr||0);
  const v=Math.max(0,Math.min(2.5,Number(x.vRatio||0)));
  const trend=(m.ema9>m.ema21?1:0)+(h.ema9>h.ema21?1:0)+(m.macd>m.signal?1:0)+(m.hist>m.prevHist?1:0);
  const rsiV=Number(m.rsi||50);
  const signedDist=Number(p.dist??99), dist=Math.abs(signedDist);

  let profitScore=0;
  if(upside1<3)profitScore=0; else if(upside1<4)profitScore=4; else if(upside1<5)profitScore=5.5;
  else if(upside1<7)profitScore=7.5; else if(upside1<10)profitScore=9; else if(upside1<15)profitScore=10; else profitScore=9.5;

  let reach=0; reach+=(trend/4)*4; reach+=(Math.min(v,1.8)/1.8)*2.5;
  if(rsiV>=45&&rsiV<=67)reach+=1.5; else if(rsiV>=38&&rsiV<45)reach+=.8; else if(rsiV>72)reach-=1;
  if(p.bounce)reach+=2; reach=Math.max(0,Math.min(10,reach));

  let support=Math.max(0,10-dist*2.2); if(p.bounce)support=Math.min(10,support+2);
  const momentum=Math.max(0,Math.min(10,(Math.min(v,2)/2)*5+(trend/4)*5));
  const sp=Number(x.spread??99), liquidity=sp<=.10?10:sp<=.18?8:sp<=.30?5:sp<=.50?2:0;
  const potScore=profitScore*.35+reach*.25+support*.20+momentum*.15+liquidity*.05;

  const eligible=!!p.hasResistance && upside1>=3 && signedDist>=0 && signedDist<=3 && rr>=1.30 && sp<=0.35 && !String(p.status||'').includes('DESTEK ALTI');
  return{score:Math.round(potScore*10)/10,upside1,upside2,rr,t1,t2,profitScore,reach,dist,signedDist,eligible};
}

function tradePlan(k15,k1h,m,h){
  const price=m.price, A=atr(k15,14)||price*.006;
  const lows15=swingLevels(k15,'low',2,100), lows1=swingLevels(k1h,'low',2,100);
  const highs15=swingLevels(k15,'high',2,100), highs1=swingLevels(k1h,'high',2,100);
  const s15=clusteredLevel(lows15,price,'below'), s1=clusteredLevel(lows1,price,'below',.7);
  const supports=[s15,s1,m.bollDn,m.ema21,h.ema21].filter(Number.isFinite).filter(x=>x<=price*1.015);
  let support=supports.length?supports.sort((a,b)=>Math.abs(price-a)-Math.abs(price-b))[0]:price-A;
  const pad=Math.max(A*.22,support*.0015);
  const zoneLow=Math.max(0,support-pad), zoneHigh=support+pad;
  const dist=(price-zoneHigh)/price*100;
  const near=price>=zoneLow-A*.15 && price<=zoneHigh+A*.35;

  const volOk=Number.isFinite(m.vma5) && m.vma5>0 && m.vol>=m.vma5;
  const rsiOk=m.rsi>=42 && m.rsi<=68;
  const emaOk=m.ema9>=m.ema21 && m.price>=m.ema9;
  const macdOk=m.macd>=m.signal && m.hist>m.prevHist;
  const hourlyOk=h.ema9>=h.ema21 || h.hist>h.prevHist;
  const bounce=near && volOk && rsiOk && (emaOk||macdOk) && hourlyOk;

  const stop=Math.max(0,zoneLow-Math.max(A*.65,support*.0035));
  const resist=[...highs15,...highs1,m.bollUp].filter(Number.isFinite).filter(x=>x>Math.max(price,zoneHigh)*1.002).sort((a,b)=>a-b);
  const hasResistance=resist.length>0;
  const t1=hasResistance?resist[0]:Math.max(price,zoneHigh)+2*(Math.max(price,zoneHigh)-stop);
  const t2=resist.find(x=>x>t1*1.006)||Math.max(t1*1.012,Math.max(price,zoneHigh)+3*(Math.max(price,zoneHigh)-stop));
  const entry=near?price:(zoneLow+zoneHigh)/2;
  const risk=Math.max(entry-stop,entry*.001), rr=(t1-entry)/risk;
  const status=bounce?'TEYİTLİ GİRİŞ':(near?'DESTEKTE — TEYİT BEKLE':dist>0?'DESTEĞE GERİ ÇEKİLME BEKLE':'DESTEK ALTI — GİRİŞ YAPMA');
  return{support,zoneLow,zoneHigh,dist,near,bounce,volOk,rsiOk,emaOk,macdOk,hourlyOk,stop,t1,t2,rr,hasResistance,status};
}

function score(m,h,p){
  let buy=0,sell=0;
  const add=(good,w=1,neutral=false)=>{if(good)buy+=w;else if(!neutral)sell+=w};
  const d=Number(p?.dist??99), ad=Math.abs(d);
  let entryPts=0;
  if(p?.bounce)entryPts=4.0; else if(p?.near)entryPts=3.5; else if(d>=0&&d<=0.50)entryPts=3.1; else if(d>0.50&&d<=1.0)entryPts=2.6; else if(d>1.0&&d<=1.75)entryPts=1.8; else if(d>1.75&&d<=2.5)entryPts=1.0; else if(d<0&&ad<=0.75)entryPts=.7;
  buy+=entryPts; if(entryPts<1.0)sell+=1.0;
  add(p?.bounce,1.0,p?.near);
  add(m.vol>m.vma5,1.0);add(m.vma5>m.vma10,.5);add(m.price>m.ema9,.5);add(m.ema9>m.ema21,.75);add(h.ema9>h.ema21,.75);
  add(m.rsi>=45&&m.rsi<=66,.5,m.rsi>66&&m.rsi<72);add(m.macd>m.signal,.5);add(m.hist>m.prevHist,.5);
  const max=10;let b=Math.round(Math.min(10,buy/max*10)*10)/10;
  if(p && !p.near && d>1.75)b=Math.min(b,6.9);
  if(p && !p.near && d>2.5)b=Math.min(b,5.9);
  if(p && p.status.includes('DESTEK ALTI'))b=Math.min(b,4.9);
  if(p && !p.bounce)b=Math.min(b,7.4);
  if(p && !p.hasResistance)b=Math.min(b,6.9);
  return{buy:b,sell:Math.round(Math.min(10,sell/max*10)*10)/10};
}

function calc(k){
  const c=k.map(x=>+x[4]),v=k.map(x=>+x[5]),i=c.length-1;
  const E9=emaSeries(c,9),E21=emaSeries(c,21),E50=emaSeries(c,50),R=rsiSeries(c),M12=emaSeries(c,12),M26=emaSeries(c,26);
  const macd=M12.map((x,j)=>x-M26[j]),sig=emaSeries(macd,9),hist=macd.map((x,j)=>x-sig[j]);
  const ma5=sma(v,5),ma10=sma(v,10),mid=sma(c,20),sd=stdev(c.slice(-20));
  return{price:c[i],vol:v[i],vma5:ma5[i],vma10:ma10[i],ema9:E9[i],ema21:E21[i],ema50:E50[i],rsi:R[i],macd:macd[i],signal:sig[i],hist:hist[i],prevHist:hist[i-1],bollMid:mid[i],bollUp:mid[i]+2*sd,bollDn:mid[i]-2*sd,change:(c[i]/c[i-1]-1)*100};
}

function closedKlines(rows,interval){
  const ms=interval==='15m'?15*60*1000:60*60*1000, now=Date.now();
  return rows.filter(x=>{const open=+x[0], close=Number.isFinite(+x[6])?+x[6]:open+ms-1;return close<now-1500});
}

async function klines(name,interval){
  const clean=cleanBase(name);
  const urls=BINANCE_API_BASES.map(base => `${base}/klines?symbol=${clean}TRY&interval=${interval}&limit=220`);
  const j=await fetchJsonAny(urls);
  const raw=Array.isArray(j)?j:j?.data;
  const d=Array.isArray(raw)?closedKlines(raw,interval):[];
  if(d.length<=50)throw new Error(`${clean}/TRY ${interval} kapanmış mum verisi yetersiz.`);
  return d;
}

async function ticker24(name){
  const clean=cleanBase(name);
  return fetchJsonAny(BINANCE_API_BASES.map(base => `${base}/ticker/24hr?symbol=${clean}TRY`));
}

async function all24hTickers(){return unwrapArray(await fetchJsonAny(BINANCE_24H_URLS));}
async function allBookTickers(){try{return unwrapArray(await fetchJsonAny(BINANCE_BOOK_URLS));}catch{return [];}}

async function fetchJsonAny(urls){
  const errors=[];
  for(const u of urls){
    try{
      const r=await fetchWithTimeout(u,{headers:{accept:'application/json'}},10000);
      if(!r.ok){errors.push(`HTTP ${r.status}`);continue;}
      return await r.json();
    }catch(e){errors.push(e?.name==='AbortError'?'zaman aşımı':String(e?.message||e));}
  }
  throw new Error([...new Set(errors)].join(' | '));
}

async function fetchWithTimeout(url,options={},timeoutMs=10000){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{return await fetch(url,{...options,signal:ctrl.signal});}
  finally{clearTimeout(timer);}
}

async function loadState(env){
  if(!env.COIN_KV)return {tracked:[]};
  try{return JSON.parse(await env.COIN_KV.get(STATE_KEY)||'{"tracked":[]}');}
  catch{return {tracked:[]};}
}

async function saveState(env,state){
  if(!env.COIN_KV)throw new Error('COIN_KV bağlantısı bulunamadı.');
  await env.COIN_KV.put(STATE_KEY,JSON.stringify(state));
}

async function sendOneSignal(env,alerts){
  if(!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_API_KEY)return;
  const title=alerts.length===1?alerts[0].title:'Coin Analiz — Takip Uyarısı';
  const body=alerts.length===1?alerts[0].body:alerts.map(a=>`${a.name}/TRY: ${a.body}`).join('\n');

  const r=await fetch('https://api.onesignal.com/notifications',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Key ${env.ONESIGNAL_API_KEY}`},
    body:JSON.stringify({
      app_id:env.ONESIGNAL_APP_ID,
      target_channel:'push',
      included_segments:['Subscribed Users'],
      headings:{en:title},
      contents:{en:body},
      url:env.APP_URL||'https://fatihhanfan-orhan.github.io/Coin-analiz/'
    })
  });
  if(!r.ok)throw new Error(`OneSignal ${r.status}: ${await r.text()}`);
}

function cors(response){
  const h=new Headers(response.headers);
  h.set('Access-Control-Allow-Origin','*');
  h.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers','Content-Type');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});
}
function json(data,status=200){return cors(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8'}}));}

function normalizeNames(arr){return [...new Set((Array.isArray(arr)?arr:[]).map(cleanBase).filter(Boolean))].filter(x=>!EXCLUDED_BASES.has(x));}
function cleanBase(v){return String(v||'').toUpperCase().replace(/\/TRY$/,'').replace(/_?TRY$/,'').replace(/[^A-Z0-9]/g,'');}
function baseFromSymbol(sym){return String(sym||'').replace(/_?TRY$/,'');}
function unwrapArray(j){if(Array.isArray(j))return j;if(Array.isArray(j?.data))return j.data;if(Array.isArray(j?.data?.list))return j.data.list;return [];}
function num(o,...ks){for(const k of ks){const v=+o?.[k];if(Number.isFinite(v))return v;}return 0;}
function norm(v,min,max){if(max<=min)return .5;return Math.max(0,Math.min(1,(v-min)/(max-min)));}
function volatility15(k){const a=k.slice(-16);if(a.length<5)return 0;return a.slice(1).reduce((sum,x)=>sum+((+x[2]-+x[3])/(+x[4]||1))*100,0)/(a.length-1);}
function atr(k,p=14){const tr=[];for(let i=1;i<k.length;i++){const hi=+k[i][2],lo=+k[i][3],pc=+k[i-1][4];tr.push(Math.max(hi-lo,Math.abs(hi-pc),Math.abs(lo-pc)));}return tr.slice(-p).reduce((a,b)=>a+b,0)/Math.max(1,Math.min(p,tr.length));}
function swingLevels(k,type='low',look=3,limit=90){const a=k.slice(-limit),out=[];for(let i=look;i<a.length-look;i++){const v=+(type==='low'?a[i][3]:a[i][2]);let ok=true;for(let j=i-look;j<=i+look;j++){if(j===i)continue;const q=+(type==='low'?a[j][3]:a[j][2]);if(type==='low'?(q<v):(q>v)){ok=false;break;}}if(ok)out.push(v);}return out;}
function clusteredLevel(vals,price,side,tolPct=.45){const eligible=vals.filter(v=>side==='below'?v<=price:v>=price);if(!eligible.length)return NaN;let best=null;for(const v of eligible){const tol=v*tolPct/100,touches=vals.filter(x=>Math.abs(x-v)<=tol).length,dist=Math.abs(price-v)/price*100,quality=touches*3-Math.min(dist,12)*.18;if(!best||quality>best.quality)best={v,touches,quality,dist};}return best?.v;}
function sma(a,p){const o=Array(a.length).fill(NaN);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];if(i>=p-1)o[i]=s/p;}return o;}
function emaSeries(a,p){const o=Array(a.length).fill(NaN),k=2/(p+1);let s=a.slice(0,p).reduce((x,y)=>x+y,0)/p;o[p-1]=s;for(let i=p;i<a.length;i++){s=a[i]*k+s*(1-k);o[i]=s;}return o;}
function rsiSeries(a,p=14){let g=0,l=0;for(let i=1;i<=p;i++){let d=a[i]-a[i-1];d>=0?g+=d:l-=d;}let ag=g/p,al=l/p,o=Array(p).fill(NaN);o.push(al===0?100:100-100/(1+ag/al));for(let i=p+1;i<a.length;i++){let d=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;o.push(al===0?100:100-100/(1+ag/al));}return o;}
function stdev(a){let m=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0)/a.length);}
function dedupeAlerts(a){const seen=new Set();return a.filter(x=>{const k=x.type+':'+x.name;if(seen.has(k))return false;seen.add(k);return true;});}
function fmt0(v){return Number(v||0).toFixed(0);}
function fmt1(v){return Number(v||0).toFixed(1);}
function fmt2(v){return Number(v||0).toFixed(2);}
function fmtPct(v){const n=Number(v||0);return `${n>=0?'+':''}${n.toFixed(2)}%`;}

function fmtPrice(v){const n=Number(v||0);if(!Number.isFinite(n))return '-';if(n>=100)return n.toFixed(2);if(n>=1)return n.toFixed(4);return n.toFixed(6);}

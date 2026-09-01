import { CriticalAlarm } from './critical-alarm.mjs';
// Coin Analiz V5.1 Worker — hızlı pozisyon alarmı + 15dk/1saat arka plan push
// Analiz, giriş ve çıkış kararlarının tamamı aynı borsanın (Binance TR) TRY piyasasını kullanır.
const BINANCE_24H_URLS = [
  'https://api.binance.me/api/v3/ticker/24hr',
  'https://cloudme-tr.2meta.app/api/v1/ticker/24hr'
];
const BINANCE_BOOK_URLS = [
  'https://api.binance.me/api/v3/ticker/bookTicker',
  'https://cloudme-tr.2meta.app/api/v1/ticker/bookTicker'
];

// Cloudflare'ın tek invocation dış istek sınırında pozisyon kontrolü ve OneSignal için pay bırak.
const TOP_N = 16;
const TRACK_COUNT = 3;
const STATE_KEY = 'coin-analiz-state-v2';
const POSITION_STATE_KEY = 'coin-analiz-positions-v1';
const ALERT_MEMORY_KEY = 'coin-analiz-alert-memory-v1';
const CRITICAL_PUSH_TYPES = new Set(['BUY_READY','CONDITIONAL_READY','TARGET_NEAR','TARGET_HIT','POSITION_STOP','POSITION_GIVEBACK_3','POSITION_GIVEBACK_2','POSITION_TARGET','POSITION_TARGET_NEAR']);
const APP_ORIGIN = 'https://fatihhanfan-orhan.github.io';
const EXCLUDED_BASES = new Set(['BTC','ETH','USDT','USDC','FDUSD','DAI','TRY','EUR']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    try {
      if (['/alarm-ack','/alarm-status'].includes(url.pathname) && request.method==='POST') {
        if (!env.OPPORTUNITY_ALARMS) return json({ok:false},503);
        const body=await request.json().catch(()=>({}));
        if(!/^[A-Z0-9]{2,20}$/.test(body.coin||'') || String(body.token||'').length!==72) return json({ok:false},400);
        const stub=env.OPPORTUNITY_ALARMS.get(env.OPPORTUNITY_ALARMS.idFromName(body.coin));
        const response=await stub.fetch('https://alarm/'+(url.pathname==='/alarm-ack'?'ack':'status'),{method:'POST',body:JSON.stringify(body)});
        const result=cors(response);result.headers.set('Cache-Control','no-store');return result;
      }
      if(url.pathname==='/alarm-evaluate' && request.method==='POST') {
        if(!isTrustedAppRequest(request,env)&&!isAdminRequest(request,env))return json({ok:false},403);
        const body=await request.json().catch(()=>({}));
        return json({ok:true,results:await evaluateCriticalCandidates(env,normalizeNames(body.coins||[]).slice(0,3))});
      }
      if (url.pathname === '/' || url.pathname === '/health') {
        const state = await loadState(env);
        return json({
          ok: true,
          service: 'Coin Analiz Worker V5.1 — 7/24 Bildirim',
          version: '5.1-QUOTE',
          kvConfigured: Boolean(env.COIN_KV),
          oneSignalAppIdConfigured: Boolean(env.ONESIGNAL_APP_ID),
          oneSignalApiKeyConfigured: Boolean(env.ONESIGNAL_API_KEY),
          trackedCount: (state.tracked || []).length,
          marketTop3Count: (state.marketTop3 || []).length,
          activePositionCount: (state.positions || []).length,
          lastHourlyAt: state.lastHourlyAt || null,
          lastHourlyNotificationAt: state.lastHourlyNotificationAt || null,
          last4hScanAt: state.last4hScanAt || null,
          last4hNotificationAt: state.last4hNotificationAt || null,
          last4hScanned: state.last4hScanned || null,
          lastQuarterNotificationAt: state.lastQuarterNotificationAt || null,
          lastQuarterAnalysisAt: state.lastQuarterAnalysisAt || null,
          lastPositionCheckAt: state.lastPositionCheckAt || null,
          lastFastPositionCheckAt: state.lastFastPositionCheckAt || null,
          lastFastPositionSuccessAt: state.lastFastPositionSuccessAt || null,
          lastCriticalNotificationAt: state.lastCriticalNotificationAt || null,
          lastAnalysisErrors: state.lastAnalysisErrors || [],
          lastNotificationErrors: state.lastNotificationErrors || [],
          lastSummaryStatus: state.lastSummaryStatus || null,
          trackedSyncedAt: state.trackedSyncedAt || null,
          updatedAt: state.updatedAt || null,
          dataSource: 'Binance TR TRY — tarayıcı REST + Worker WebSocket BID',
          recommendedCrons: ['* * * * *']
        });
      }

      if (url.pathname === '/quote' && request.method === 'GET') {
        const name=String(url.searchParams.get('coin')||'');
        if(!/^[A-Z0-9]{2,20}$/.test(name)||EXCLUDED_BASES.has(name))return json({ok:false,error:'Geçersiz coin'},400);
        const book=await fetchBinanceTrBookTicker(name,3500);
        const response=json({...book,at:Date.now()});
        response.headers.set('Cache-Control','no-store');
        return response;
      }

      if (url.pathname === '/tracked') {
        const state = await loadState(env);
        return json({
          ok:true,
          tracked:(state.tracked || []).map(x => ({name:x.name,buy:x.buy,status:x.p?.status||null})),
          marketTop3:(state.marketTop3 || []).map(x => ({name:x.name,candidate:x.candidate||0})),
          activePositionCount:(state.positions || []).length,
          updatedAt:state.updatedAt||null
        });
      }

      if (url.pathname === '/scan') {
        if (!isAdminRequest(request, env)) return json({ok:false,error:'Yetkisiz yönetim isteği.'}, 403);
        const result = await backgroundCycle(env, { notify: false, forceFullScan: true, source: 'manual-scan' });
        return json(result);
      }

      if (url.pathname === '/test-notification') {
        if (!isAdminRequest(request, env)) return json({ok:false,error:'Yetkisiz yönetim isteği.'}, 403);
        await sendOneSignal(env, [{
          type:'TEST', name:'COIN',
          title:'✅ Coin Analiz Worker Test',
          body:'Cloudflare Worker → OneSignal arka plan bildirimi çalışıyor.'
        }]);
        return json({ok:true, sent:true});
      }

      // Web sayfasındaki 3 coini Worker takip listesine aktarır.
      if (url.pathname === '/set-tracked' && request.method === 'POST') {
        if (!isTrustedAppRequest(request, env)) return json({ok:false,error:'İstek kaynağı doğrulanamadı.'}, 403);
        const body = await request.json().catch(() => ({}));
        const requested = normalizeNames(body.coins || body.names || []);
        const [pairTickers,pairBooks]=await Promise.all([all24hTickers(),allBookTickers()]);
        const validPairs=validTryPairs(pairTickers,pairBooks),names=requested.filter(n=>validPairs.has(n));
        if (!names.length) return json({ ok:false, error:'Coin listesi boş.' }, 400);

        const synced = normalizeSyncedAnalyses(body.analyses || [], names);
        const analyzed = [...synced];
        if (!synced.length) {
          for (const name of names.slice(0, TRACK_COUNT)) {
            try { analyzed.push(await analyzeCandidate(name, null, new Map())); }
            catch (e) { analyzed.push({ name, error: String(e?.message || e) }); }
          }
        }
        const good = analyzed.filter(x => !('error' in x) && !hardGateReason(x) && !['WATCH','PULLBACK'].includes(candidateState(x)));
        if (!good.length) return json({ ok:false, error:'Takip için geçerli veri alınamadı.', details:analyzed }, 422);

        const previous = await loadState(env);
        const syncedAt = new Date().toISOString();
        const tracked = sortByProfit(good).slice(0, TRACK_COUNT);
        const criticalAlerts = await buildPositionAlerts(env, previous.tracked || [], tracked);
        const next = {
          ...previous,
          tracked,
          trackedSource: synced.length ? 'web-analysis' : 'web-selection',
          trackedSyncedAt: syncedAt,
          source: synced.length ? 'web-analysis' : 'web-selection',
          updatedAt: syncedAt
        };
        if (criticalAlerts.length) {
          await sendOneSignal(env, criticalAlerts);
          for (const alert of criticalAlerts) await markAlertSent(env, alert);
          next.lastAlerts = criticalAlerts;
          next.lastCriticalNotificationAt = syncedAt;
        }
        await saveState(env, next);
        return json({ ok:true, tracked: next.tracked, updatedAt: next.updatedAt });
      }

      // Kullanıcının açık pozisyonlarını uygulama arka plandayken dakikada bir izler.
      if (url.pathname === '/set-positions' && request.method === 'POST') {
        if (!isTrustedAppRequest(request, env)) return json({ok:false,error:'İstek kaynağı doğrulanamadı.'}, 403);
        const body = await request.json().catch(() => ({}));
        const raw = Array.isArray(body.positions) ? body.positions : [];
        const previous = await loadState(env);
        const oldMap = new Map((previous.positions || []).map(x => [cleanBase(x.name), x]));
        const positions = [];
        for (const item of raw) {
          if (positions.length >= TRACK_COUNT) break;
          const name = cleanBase(item?.name), entry = Number(item?.entry);
          if (!name || EXCLUDED_BASES.has(name) || !Number.isFinite(entry) || entry <= 0 || positions.some(x => x.name === name)) continue;
          const old = oldMap.get(name) || {};
          positions.push({
            ...old,
            name,
            entry,
            createdAt: Number(item?.createdAt) || Number(old.createdAt) || Date.now(),
            highWater: Math.max(entry, Number(item?.highWater) || 0, Number(old.highWater) || 0),
            protectedStop: maxPositive(old.protectedStop, item?.protectedStop),
            stop: maxPositive(old.stop, item?.stop, item?.protectedStop),
            target: positiveOr(item?.target, old.target),
            target2: positiveOr(item?.target2, old.target2),
            feePct: clampNumber(item?.feePct, 0, 5, Number(old.feePct)||0),
            updatedAt: new Date().toISOString()
          });
        }
        const next = { ...previous, positions, positionSource:'web-positions', updatedAt:new Date().toISOString() };
        await savePositionsState(env, next);
        return json({ ok:true, positions:positions.map(x => ({name:x.name,entry:x.entry,highWater:x.highWater})), updatedAt:next.updatedAt });
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
    const cron = String(controller.cron || '');
    if (cron !== '* * * * *') return;

    // Tek dakikalık zamanlayıcı: her çalışmada önce Binance TR WebSocket BID ile pozisyon riski kontrol edilir.
    // Cloudflare çıkışındaki Binance REST WAF engeline karşı ağır analiz tarayıcıda yapılır ve Worker'a senkronlanır.
    const quarterHourly = minute % 15 === 0;
    const fourHourly = minute === 1 && turkeyHour % 4 === 3;
    ctx.waitUntil(runFastPositionCycle(env, t.toISOString(), {
      quarterHourly,
      hourly: quarterHourly && minute === 0,
      fourHourly
    }));
    if(env.CRITICAL_ALARM_ENABLED==='true' && env.OPPORTUNITY_ALARMS)ctx.waitUntil((async()=>{
      const state=await loadState(env);
      await evaluateCriticalCandidates(env,normalizeNames([...(state.marketTop3||[]),...(state.tracked||[])].map(x=>x.name)).slice(0,3));
    })());
  }
};


async function evaluateCriticalCandidates(env,names) {
  if(env.CRITICAL_ALARM_ENABLED!=='true'||!env.OPPORTUNITY_ALARMS)return [];
  return Promise.all(names.map(async coin=>{
    const stub=env.OPPORTUNITY_ALARMS.get(env.OPPORTUNITY_ALARMS.idFromName(coin));
    try{return await (await stub.fetch('https://alarm/start',{method:'POST',body:JSON.stringify({coin})})).json();}
    catch{return {ok:false,coin,reason:'REVALIDATION_UNAVAILABLE'};}
  }));
}

function criticalOpportunity(x,now=Date.now()) {
  const f=x?.freshness,p=x?.p||{},flow=x?.flow||{};
  if(!f||!Number.isFinite(f.quoteAt)||now-f.quoteAt>15000||f.quoteAt>now||!Array.isArray(f.closes)||
    ![900000,3600000,14400000,86400000].every((step,i)=>Number.isFinite(f.closes[i])&&f.closes[i]<=now&&now-f.closes[i]<=step+90000))return null;
  if(flow.status!=='REAL'||!Number.isFinite(Number(x.qv))||!(x.qv>0)||hardGateReason(x))return null;
  const kind=candidateState(x);
  // Notification strength only: does not change Finder scores or entry gates.
  if(kind!=='BUY' && !(kind==='CONDITIONAL'&&p.supportSource==='HORIZONTAL'&&
    p.conditionalRR>=2&&x.vRatio>=1&&flow.m15?.net>0&&flow.h1?.net>=0))return null;
  const entry=Number(kind==='BUY'?p.marketEntry:p.conditionalEntry),stop=Number(p.stop),target=Number(p.mainTarget),rr=(target-entry)/(entry-stop);
  if(![entry,stop,target,rr].every(Number.isFinite)||!(stop>0&&entry>stop&&target>entry&&rr>=1.30))return null;
  return {kind,entry,stop,target,rr};
}
async function validateCriticalCoin(coin) {
  if(EXCLUDED_BASES.has(coin))return null;
  const [tickers,books]=await Promise.all([all24hTickers(),allBookTickers()]);
  if(!validTryPairs(tickers,books).has(coin))return null;
  const ticker=tickers.find(t=>baseFromSymbol(String(t.symbol||t.s||''))===coin);
  const x=await analyzeCandidate(coin,ticker,new Map(books.map(b=>[String(b.symbol||b.s||''),b])),true);
  return criticalOpportunity(x);
}
export class OpportunityAlarm extends CriticalAlarm {
  constructor(ctx,env){super(ctx,env,validateCriticalCoin);}
}

async function backgroundCycle(env, opts = {}) {
  const previous = await loadState(env);
  const shouldFullScan = Boolean(opts.forceFullScan || opts.fourHourly || !(previous.tracked || []).length);

  let market = null;
  let marketTop3 = previous.marketTop3 || [];
  let tickerMap = new Map();
  let bookMap = new Map();
  let validPairs = new Set();
  if (shouldFullScan) {
    market = await scanMarket();
    tickerMap = market.tickerMap || new Map();
    bookMap = market.bookMap || new Map();
    validPairs = market.validPairs || new Set();
    marketTop3 = market.metrics.filter(x=>{return !hardGateReason(x)&&!['WATCH','PULLBACK'].includes(candidateState(x));}).sort(compareCandidateState).slice(0,TRACK_COUNT);
  } else {
    const [tickers, books] = await Promise.all([
      all24hTickers().catch(() => []),
      allBookTickers().catch(() => [])
    ]);
    tickerMap = new Map(tickers.map(x => [String(x.symbol || x.s || ''), x]));
    bookMap = new Map(books.map(x => [String(x.symbol || x.s || ''), x]));
    validPairs = validTryPairs(tickers,books);
  }

  // Takip listesindeki coinleri her cron tetiklenmesinde (önerilen 15 dk) yeniden analiz et.
  const analysisByName = new Map((market?.metrics || []).map(x => [x.name, x]));
  const currentTracked = [];
  const analysisErrors = [];
  for (const old of (previous.tracked || []).slice(0, TRACK_COUNT)) {
    const name = cleanBase(old?.name || old?.symbol || '');
    if (!name||!validPairs.has(name)) continue;
    try {
      const cached = analysisByName.get(name);
      if (shouldFullScan && !cached) continue;
      const ticker = tickerMap.get(name+'TRY') || tickerMap.get(name+'_TRY') || null;
      const analyzed = cached || await analyzeCandidate(name, ticker, bookMap);
      analysisByName.set(name, analyzed);
      if(!hardGateReason(analyzed))currentTracked.push(analyzed);
    }
    catch (e) { analysisErrors.push(`${name}: ${String(e?.message || e)}`); }
  }

  let tracked;
  if (currentTracked.length) {
    // Web sayfasının seçtiği coinleri değiştirme; sadece kâr potansiyeline göre sırala.
    tracked = sortByProfit(currentTracked).slice(0, TRACK_COUNT);
    for (const candidate of (shouldFullScan ? marketTop3 : [])) {
      if (tracked.length >= TRACK_COUNT) break;
      if (!tracked.some(x => x.name === candidate.name)) tracked.push(candidate);
    }
  } else {
    tracked = shouldFullScan ? sortByProfit(marketTop3).slice(0, TRACK_COUNT) : [];
  }
  if (!shouldFullScan && analysisErrors.length) tracked = currentTracked.filter(x=>!hardGateReason(x)).slice(0,TRACK_COUNT);

  const analysisReady = analysisErrors.length === 0 && tracked.length > 0;
  const marketAlerts = opts.collectAlerts && opts.quarterHourly && analysisReady ? await buildPositionAlerts(env, previous.tracked || [], tracked) : [];
  const positionMonitor = await monitorActivePositions(
    env,
    previous.positions || [],
    Boolean(opts.collectAlerts),
    analysisByName,
    tickerMap,
    bookMap
  );
  const positionAlerts = [...positionMonitor.alerts, ...marketAlerts].slice(0, 6);

  // Kullanıcı analiz sürerken pozisyon ekleyip silebilir. Yalnız hâlâ mevcut kayıtları güncelle.
  const latestBeforeSave = await loadState(env);
  const mergedPositions = mergeCheckedPositions(latestBeforeSave.positions || [], positionMonitor.positions);
  const state = {
    ...latestBeforeSave,
    tracked,
    marketTop3,
    positions: mergedPositions,
    source: opts.source || previous.source || 'cron',
    lastAlerts: positionAlerts,
    pendingAlerts: opts.collectAlerts ? positionAlerts : (previous.pendingAlerts || []),
    lastQuarterAnalysisAt: opts.quarterHourly && analysisReady ? (opts.scheduledAt || new Date().toISOString()) : (previous.lastQuarterAnalysisAt || null),
    lastHourlyAt: opts.hourly && analysisReady ? (opts.scheduledAt || new Date().toISOString()) : (previous.lastHourlyAt || null),
    last4hScanAt: opts.fourHourly && analysisReady ? (opts.scheduledAt || new Date().toISOString()) : (previous.last4hScanAt || null),
    last4hScanned: opts.fourHourly ? (market?.scanned || 0) : (previous.last4hScanned || null),
    lastPositionCheckAt: mergedPositions.length ? (opts.scheduledAt || new Date().toISOString()) : (previous.lastPositionCheckAt || null),
    lastAnalysisErrors:analysisErrors,
    lastNotificationErrors: [],
    updatedAt: new Date().toISOString()
  };

  const notificationErrors = analysisErrors.map(x=>`analysis: ${x}`);
  const notifySafely = async (label, fn) => {
    try { await fn(); return true; }
    catch (e) { notificationErrors.push(`${label}: ${String(e?.message || e)}`); return false; }
  };
  if (positionAlerts.length) {
    const sent = await notifySafely('position-alerts', () => sendOneSignal(env, positionAlerts));
    if (sent) {
      state.pendingAlerts = [];
      for (const alert of positionAlerts) await markAlertSent(env, alert);
      const criticalAlerts = positionAlerts.filter(x => String(x?.type || '').startsWith('POSITION_'));
      if (criticalAlerts.length) {
        state.lastCriticalNotificationAt = new Date().toISOString();
      }
    }
  }
  if (opts.quarterHourly && opts.notify && analysisReady) {
    const sent = await notifySafely('quarter-hour', () => sendQuarterHourSummary(env, tracked));
    if (sent) {
      state.lastQuarterNotificationAt = new Date().toISOString();
    }
  }
  if (opts.hourly && opts.notify && analysisReady) {
    const sent = await notifySafely('hourly', () => sendHourlySummary(env, tracked));
    if (sent) {
      state.lastHourlyNotificationAt = new Date().toISOString();
    }
  }
  if (opts.fourHourly && opts.notify && analysisReady && marketTop3.length) {
    const sent = await notifySafely('four-hour', () => sendFourHourScan(env, marketTop3, market?.scanned || 0));
    if (sent) {
      state.last4hNotificationAt = new Date().toISOString();
    }
  }
  state.lastNotificationErrors = notificationErrors;
  state.updatedAt = new Date().toISOString();
  // Workers KV aynı anahtara saniyede birden fazla yazmayı desteklemez; her görev tek yazıyla biter.
  await Promise.all([saveState(env, state), savePositionsState(env, state)]);

  return {
    ok: true,
    mode: shouldFullScan ? 'full-scan' : 'tracked-check',
    scanned: market?.scanned || 0,
    analyzed: market?.metrics?.length || 0,
    valid: market ? market.metrics.filter(x => x.rpot?.eligible).length : null,
    tracked,
    marketTop3,
    alerts: positionAlerts,
    activePositions: mergedPositions,
    quarterHourly: Boolean(opts.quarterHourly),
    hourly: Boolean(opts.hourly),
    fourHourly: Boolean(opts.fourHourly),
    notificationErrors,
    analysisErrors,
    updatedAt: state.updatedAt
  };
}

function sortByProfit(list) {
  return [...(list || [])].sort(compareProfitFirst);
}

function compareProfitFirst(a,b) {
  // Brüt hedef uzaklığı tek başına yeterli değildir; ulaşılabilirlik ve giriş kalitesi önce gelir.
  return (Number(Boolean(b?.rpot?.eligible))-Number(Boolean(a?.rpot?.eligible))) ||
         (Number(b?.rpot?.expectedEdge||0)-Number(a?.rpot?.expectedEdge||0)) ||
         (Number(b?.candidate||0)-Number(a?.candidate||0)) ||
         (Number(b?.rpot?.upside1||0)-Number(a?.rpot?.upside1||0)) ||
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
    const decision = candidateState(x);
    const upside = finderEntryQuality(x, decision === 'BUY' ? 'MARKET' : 'CONDITIONAL').profit;
    const price = Number(x.m?.price || 0);
    const t1 = Number(x.p?.mainTarget || x.p?.t2 || x.p?.t1 || 0);
    const targetRemaining = (price>0 && t1>0) ? ((t1-price)/price*100) : 99;
    const buyReady = decision === 'BUY';
    const conditionalReady = decision === 'CONDITIONAL';
    const nearSupport = d >= -0.20 && d <= 0.80;
    const targetNear = targetRemaining >= 0 && targetRemaining <= 1.0;
    const targetHit = price>0 && t1>0 && price >= t1;

    const prevD = Number(p?.p?.dist ?? 99);
    const prevBuy = Number(p?.buy || 0);
    const previousDecision = p ? candidateState(p) : 'REJECT';
    const prevBuyReady = previousDecision === 'BUY';
    const prevConditionalReady = previousDecision === 'CONDITIONAL';
    const prevNear = prevD >= -0.20 && prevD <= 0.80;
    const prevPrice = Number(p?.m?.price || 0);
    const prevT1 = Number(p?.p?.mainTarget || p?.p?.t2 || p?.p?.t1 || 0);
    const prevRemain = (prevPrice>0 && prevT1>0) ? ((prevT1-prevPrice)/prevPrice*100) : 99;

    if (!p && !buyReady && !conditionalReady) {
      candidates.push({type:'TRACK_NEW',name:x.name,title:`🆕 Takip: ${x.name}/TRY`,body:'Takip kaydı oluşturuldu. Alım sinyali değildir; giriş koşulları sağlanmadı.'});
      continue;
    }
    if (buyReady && !prevBuyReady) {
      candidates.push({type:'BUY_READY',name:x.name,title:`🎯 ${x.name}/TRY — TEYİTLİ PİYASA GİRİŞİ`,body:`AL ${fmt1(buy)}/10 • desteğe ${fmtPct(d)} • piyasa R/K 1:${fmt2(x.p?.marketRR)}`});
    }
    if (conditionalReady && !prevConditionalReady) {
      candidates.push({type:'CONDITIONAL_READY',name:x.name,title:`🟡 ${x.name}/TRY — KOŞULLU GİRİŞ HAZIR`,body:`Şimdi piyasa girişi değil • limit ${fmtPrice(x.p?.conditionalEntry)} • stop ${fmtPrice(x.p?.stop)} • koşullu R/K 1:${fmt2(x.p?.conditionalRR)}`});
    }
    if (buyReady && nearSupport && !prevNear) {
      candidates.push({type:'SUPPORT_NEAR',name:x.name,title:`🔔 ${x.name}/TRY alım bölgesinde`,body:`Desteğe ${fmtPct(d)} • AL ${fmt1(buy)}/10 • kâr potansiyeli +${fmt2(upside)}% • teyit ${x.p?.bounce?'VAR':'BEKLENİYOR'}`});
    }
    if (buyReady && buy >= prevBuy + 1.5 && buy >= 6.5) {
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

  if (leader && prevLeader && leader.name !== prevLeader.name && candidateState(leader) === 'BUY') {
    candidates.push({
      type:'PROFIT_LEADER',name:leader.name,
      title:`🏆 En yüksek kâr fırsatı: ${leader.name}/TRY`,
      body:`Takip listesinin lideri değişti • Piyasa girişinden Ana D1 kâr alanı +${fmt2(finderEntryQuality(leader,'MARKET').profit)}% • AL ${fmt1(leader.buy)}/10`
    });
  }

  const nowByName = new Map(nowList.map(x => [cleanBase(x.name), x]));
  const deduped = dedupeAlerts(candidates).map(alert => ({
    ...alert,
    eventId:criticalEventId(alert, nowByName.get(cleanBase(alert.name)))
  }));
  const allowed = [];
  for (const a of deduped) {
    if (await alertAllowed(env, a)) allowed.push(a);
  }
  return allowed.slice(0, 4);
}

async function monitorActivePositions(env, savedPositions, notify, analysisByName = new Map(), tickerMap = new Map(), bookMap = new Map()) {
  const positions = [], alerts = [];
  for (const saved of (savedPositions || []).slice(0, TRACK_COUNT)) {
    const name = cleanBase(saved?.name), entry = Number(saved?.entry);
    if (!name || !Number.isFinite(entry) || entry <= 0) continue;
    try {
      const ticker = tickerMap.get(name+'TRY') || tickerMap.get(name+'_TRY') || null;
      const data = analysisByName.get(name) || await analyzeCandidate(name, ticker, bookMap);
      const book = bookMap.get(name+'TRY') || bookMap.get(name+'_TRY') || {};
      const price = num(book,'bidPrice','b');
      const technicalStop = Number(data?.p?.stop);
      const protectedStop = maxPositive(saved.protectedStop, saved.stop);
      const stop = maxPositive(technicalStop, protectedStop);
      const target = Number(data?.p?.t1);
      if (!Number.isFinite(price) || price <= 0) throw new Error('canlı Binance TR BID alınamadı');
      const highWater = Math.max(entry, Number(saved.highWater) || 0, price);
      const feePct = clampNumber(saved.feePct,0,5,0);
      const pnl = (price / entry - 1) * 100 - feePct;
      const pullback = highWater > 0 ? Math.max(0, (highWater - price) / highWater * 100) : 0;
      const remaining = target > 0 ? (target - price) / price * 100 : NaN;
      const current = {
        ...saved, feePct,
        name, entry, highWater, lastPrice:price, lastPnl:pnl, lastPullback:pullback,
        technicalStop:Number.isFinite(technicalStop)?technicalStop:null,
        protectedStop:Number.isFinite(protectedStop)?protectedStop:null,
        stop:Number.isFinite(stop)?stop:null,
        target:Number.isFinite(target)?target:null,
        target2:Number.isFinite(Number(data?.p?.t2))?Number(data.p.t2):null,
        checkedAt:new Date().toISOString()
      };
      delete current.lastError;
      positions.push(current);
      if (!notify) continue;

      const alert = buildPositionRiskAlert({name, positionId:saved.createdAt||entry, price, stop, target, entry, highWater, pnl, pullback, remaining});
      if (alert && await alertAllowed(env, alert)) alerts.push(alert);
    } catch (e) {
      positions.push({ ...saved, name, entry, lastError:String(e?.message || e), checkedAt:new Date().toISOString() });
    }
  }
  return { positions, alerts };
}

function buildPositionRiskAlert({name, positionId, price, stop, target, entry, highWater, pnl, pullback, remaining}) {
  const make=(type,title,body)=>({type,name,title,body,eventId:`${type}:${name}:${positionId||entry}`});
  if (stop > 0 && price <= stop) {
    return make('POSITION_STOP',`🔴 ${name}/TRY — STOP / RİSK`,`Fiyat ${fmtPrice(price)} • stop ${fmtPrice(stop)} • K/Z ${fmtPct(pnl)}. Uygulamayı açıp pozisyonu kontrol et.`);
  }
  if (pnl > 0 && pullback >= 3) {
    return make('POSITION_GIVEBACK_3',`🔴 ${name}/TRY — KÂR GERİ VERME %${fmt2(pullback)}`,`Zirve ${fmtPrice(highWater)} • fiyat ${fmtPrice(price)} • K/Z ${fmtPct(pnl)}. Çıkış/koruma kararını kontrol et.`);
  }
  if (pnl >= 3 && pullback >= 2) {
    return make('POSITION_GIVEBACK_2',`🟠 ${name}/TRY — KÂRI KORU`,`Zirveden geri çekilme %${fmt2(pullback)} • K/Z ${fmtPct(pnl)}. Akıllı Satış V2 kararını kontrol et.`);
  }
  if (Number.isFinite(remaining) && remaining <= 0) {
    return make('POSITION_TARGET',`🎯 ${name}/TRY — TAHMİNİ DİRENÇ GELDİ`,`Fiyat ${fmtPrice(price)} • tahmini direnç ${fmtPrice(target)} • K/Z ${fmtPct(pnl)}.`);
  }
  if (Number.isFinite(remaining) && remaining <= 0.8) {
    return make('POSITION_TARGET_NEAR',`🟡 ${name}/TRY — DİRENCE ÇOK YAKIN`,`Tahmini dirence %${fmt2(Math.max(0,remaining))} kaldı • K/Z ${fmtPct(pnl)}.`);
  }
  return null;
}

async function fetchBinanceTrBookMap(names, timeoutMs = 10000) {
  const cleanNames = normalizeNames(names).slice(0, TRACK_COUNT);
  if (!cleanNames.length) return {bookMap:new Map(), errors:[]};

  // Yerel birim testlerinde scheduler yoktur; mevcut REST taklidiyle aynı mantık doğrulanır.
  if (!globalThis.scheduler?.wait) {
    const books = await allBookTickers();
    return {bookMap:new Map(books.map(x => [String(x.symbol || x.s || ''), x])), errors:[]};
  }

  const settled = await Promise.allSettled(cleanNames.map(name => fetchBinanceTrBookTicker(name, timeoutMs)));
  const bookMap = new Map(), errors = [];
  settled.forEach((result, index) => {
    const name = cleanNames[index];
    if (result.status === 'fulfilled') bookMap.set(name+'TRY', result.value);
    else errors.push(`${name}: ${String(result.reason?.message || result.reason)}`);
  });
  if (!bookMap.size) throw new Error(errors.join(' | ') || 'Binance TR WebSocket BID alınamadı');
  return {bookMap, errors};
}

async function fetchBinanceTrBookTicker(name, timeoutMs = 10000) {
  const clean = cleanBase(name);
  const url = `https://stream-cloud.binance.tr/ws/${clean.toLowerCase()}try@depth5@100ms`;
  const response = await fetch(url, {headers:{Upgrade:'websocket'}});
  const socket = response.webSocket;
  if (!socket) throw new Error(`WebSocket bağlantısı reddedildi (HTTP ${response.status})`);
  socket.accept();
  try {
    const message = new Promise((resolve, reject) => {
      socket.addEventListener('message', event => {
        try {
          const parsed = JSON.parse(String(event.data));
          const row = parsed?.data || parsed;
          const bid = Number(row?.bids?.[0]?.[0] || row?.b?.[0]?.[0] || row?.bidPrice),
                ask = Number(row?.asks?.[0]?.[0] || row?.a?.[0]?.[0] || row?.askPrice);
          if (!(bid > 0) || !(ask >= bid)) throw new Error('BID/ASK alanı eksik veya geçersiz');
          resolve({symbol:clean+'TRY', bidPrice:String(bid), askPrice:String(ask), b:String(bid), a:String(ask), source:'BINANCE_TR_WS'});
        } catch (error) { reject(error); }
      }, {once:true});
      socket.addEventListener('error', () => reject(new Error('WebSocket veri hatası')), {once:true});
    });
    return await Promise.race([
      message,
      globalThis.scheduler.wait(timeoutMs).then(() => { throw new Error('WebSocket zaman aşımı'); })
    ]);
  } finally {
    try { socket.close(1000, 'done'); } catch {}
  }
}

async function applyScheduledSummaries(env, state, scheduleMeta = {}) {
  const errors = [];
  if (scheduleMeta.quarterHourly) {
    const syncedAt = Date.parse(state.trackedSyncedAt || '');
    const fresh = Number.isFinite(syncedAt) && Date.now() - syncedAt <= 20*60*1000;
    if (fresh && (state.tracked || []).length) {
      try {
        await sendQuarterHourSummary(env, state.tracked);
        state.lastQuarterNotificationAt = scheduleMeta.scheduledAt || new Date().toISOString();
        if (scheduleMeta.hourly) {
          await sendHourlySummary(env, state.tracked);
          state.lastHourlyAt = scheduleMeta.scheduledAt || new Date().toISOString();
          state.lastHourlyNotificationAt = scheduleMeta.scheduledAt || new Date().toISOString();
        }
        state.lastSummaryStatus = 'Taze tarayıcı analiziyle kapanış özeti gönderildi.';
      } catch (error) {
        errors.push(`synced-summary: ${String(error?.message || error)}`);
      }
    } else {
      state.lastSummaryStatus = 'Kapanış özeti atlandı: 20 dakikadan yeni tarayıcı analizi yok.';
    }
  }
  if (scheduleMeta.fourHourly) {
    try {
      await sendOneSignal(env, [{
        type:'FOUR_HOUR_REMINDER', name:'COIN',
        title:'🔎 Coin Analiz — 4 Saatlik Tarama Zamanı',
        body:'En uygun TRY coinlerini taze Binance TR verisiyle taramak için uygulamayı aç. Açılışta tarama otomatik başlar.'
      }]);
      state.last4hNotificationAt = scheduleMeta.scheduledAt || new Date().toISOString();
      state.lastSummaryStatus = '4 saatlik taze tarama açılış bildirimi gönderildi.';
    } catch (error) {
      errors.push(`four-hour-reminder: ${String(error?.message || error)}`);
    }
  }
  return errors;
}

async function runFastPositionCycle(env, scheduledAt, scheduleMeta = {}) {
  const previous = await loadState(env);
  const savedPositions = (previous.positions || []).slice(0, TRACK_COUNT);
  if (!savedPositions.length) {
    const idle = {...previous,lastFastPositionCheckAt:scheduledAt || new Date().toISOString(),updatedAt:new Date().toISOString()};
    const summaryErrors = await applyScheduledSummaries(env, idle, {...scheduleMeta,scheduledAt});
    idle.lastNotificationErrors = summaryErrors;
    await saveState(env, idle);
    return {ok:true, checked:0, alerts:0};
  }

  let bookMap, quoteErrors = [];
  try {
    const quoteResult = await fetchBinanceTrBookMap(savedPositions.map(x => x?.name));
    bookMap = quoteResult.bookMap;
    quoteErrors = quoteResult.errors;
  } catch (e) {
    const failed = {
      ...previous,
      lastFastPositionCheckAt:scheduledAt || new Date().toISOString(),
      lastFastPositionSuccessAt:previous.lastFastPositionSuccessAt || null,
      lastNotificationErrors:[`fast-position-data: ${String(e?.message || e)}`],
      updatedAt:new Date().toISOString()
    };
    await saveState(env, failed);
    return {ok:false,checked:0,alerts:0,error:String(e?.message || e)};
  }
  const checked = [];
  const alerts = [];

  for (const saved of savedPositions) {
    const name = cleanBase(saved?.name), entry = Number(saved?.entry);
    if (!name || !Number.isFinite(entry) || entry <= 0) continue;
    try {
      const book = bookMap.get(name+'TRY') || bookMap.get(name+'_TRY') || {};
      const price = num(book,'bidPrice','b');
      if (!Number.isFinite(price) || price <= 0) throw new Error('canlı BID alınamadı');

      let stop = maxPositive(saved.stop, saved.protectedStop), target = Number(saved.target);
      if (!(stop > 0) || !(target > 0)) {
        throw new Error('stop/hedef planı eksik; taze analiz için uygulamayı aç');
      }

      const highWater = Math.max(entry, Number(saved.highWater) || 0, price);
      const feePct = clampNumber(saved.feePct,0,5,0);
      const pnl = (price / entry - 1) * 100 - feePct;
      const pullback = highWater > 0 ? Math.max(0, (highWater - price) / highWater * 100) : 0;
      const remaining = target > 0 ? (target - price) / price * 100 : NaN;
      const current = {
        ...saved, feePct,
        name, entry, highWater, lastPrice:price, lastPnl:pnl, lastPullback:pullback,
        protectedStop:Number.isFinite(Number(saved.protectedStop))?Number(saved.protectedStop):null,
        stop:Number.isFinite(stop)?stop:null,
        target:Number.isFinite(target)?target:null,
        checkedAt:new Date().toISOString(), fastCheckedAt:scheduledAt || new Date().toISOString()
      };
      delete current.lastError;
      checked.push(current);

      const alert = buildPositionRiskAlert({name, positionId:saved.createdAt||entry, price, stop, target, entry, highWater, pnl, pullback, remaining});
      if (alert && await alertAllowed(env, alert)) alerts.push(alert);
    } catch (e) {
      checked.push({ ...saved, name, entry, lastError:String(e?.message || e), fastCheckedAt:scheduledAt || new Date().toISOString() });
    }
  }

  // Kullanıcı bu sırada pozisyon eklemiş/silmiş olabilir; yalnız hâlâ mevcut kayıtları güncelle.
  const latest = await loadState(env);
  const checkedMap = new Map(checked.map(x => [cleanBase(x.name), x]));
  const positions = (latest.positions || []).slice(0, TRACK_COUNT).map(pos => {
    const fresh = checkedMap.get(cleanBase(pos.name));
    if (!fresh) return pos;
    const entry = Number(pos.entry) || Number(fresh.entry);
    return {
      ...pos,
      ...fresh,
      entry,
      createdAt:Number(pos.createdAt) || Number(fresh.createdAt) || Date.now(),
      highWater:Math.max(entry, Number(pos.highWater)||0, Number(fresh.highWater)||0)
    };
  });
  const state = {
    ...latest,
    positions,
    lastPositionCheckAt:scheduledAt || new Date().toISOString(),
    lastFastPositionCheckAt:scheduledAt || new Date().toISOString(),
    lastFastPositionSuccessAt:scheduledAt || new Date().toISOString(),
    lastFastPositionAlerts:alerts,
    lastAnalysisErrors:[],
    updatedAt:new Date().toISOString()
  };

  const notificationErrors = quoteErrors.map(x => `fast-position-data: ${x}`);
  if (alerts.length) {
    try {
      await sendOneSignal(env, alerts);
      for (const alert of alerts) await markAlertSent(env, alert);
      state.lastCriticalNotificationAt = new Date().toISOString();
    } catch (e) {
      notificationErrors.push(`fast-position-alerts: ${String(e?.message || e)}`);
    }
  }
  notificationErrors.push(...await applyScheduledSummaries(env, state, {...scheduleMeta,scheduledAt}));
  state.lastNotificationErrors = notificationErrors;
  state.updatedAt = new Date().toISOString();
  await Promise.all([saveState(env, state), savePositionsState(env, state)]);
  return {ok:true, checked:positions.length, alerts:alerts.length};
}

function criticalEventId(alert, analysis) {
  const eventAt=Number(analysis?.eventAt)||Number(analysis?.freshness?.closes?.[0])||Math.floor(Date.now()/900000)*900000;
  return `${alert.type}:${cleanBase(alert.name)}:${eventAt}`;
}

async function alertAllowed(env, alertOrType, legacyName) {
  const alert=typeof alertOrType==='object'?alertOrType:{type:alertOrType,name:legacyName};
  if (!env.COIN_KV) return true;
  const key = `${ALERT_MEMORY_KEY}:${alert.eventId||`${alert.type}:${alert.name}`}`;
  const last = Number(await env.COIN_KV.get(key) || 0);
  return !(last && Date.now()-last < alertCooldownMs(alert.type));
}

function alertCooldownMs(type) {
  const t = String(type || '');
  if (t === 'POSITION_STOP') return 5 * 60 * 1000;
  if (t === 'POSITION_GIVEBACK_3') return 10 * 60 * 1000;
  if (t === 'POSITION_GIVEBACK_2' || t === 'POSITION_TARGET') return 15 * 60 * 1000;
  if (t === 'POSITION_TARGET_NEAR') return 20 * 60 * 1000;
  return 90 * 60 * 1000;
}

async function markAlertSent(env, alertOrType, legacyName) {
  const alert=typeof alertOrType==='object'?alertOrType:{type:alertOrType,name:legacyName};
  if (!env.COIN_KV) return;
  const key = `${ALERT_MEMORY_KEY}:${alert.eventId||`${alert.type}:${alert.name}`}`;
  await env.COIN_KV.put(key, String(Date.now()), { expirationTtl: 24*60*60 });
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

async function sendStoredQuarterSummary(env, scheduledAt, opts = {}) {
  const state = await loadState(env);
  const notificationErrors = [];
  const notifySafely = async (label, fn) => {
    try { await fn(); return true; }
    catch (e) { notificationErrors.push(`${label}: ${String(e?.message || e)}`); return false; }
  };
  const analysisMs = Date.parse(state.lastQuarterAnalysisAt || '');
  const quarterSentMs = Date.parse(state.lastQuarterNotificationAt || '');
  const hourlyAt = Date.parse(state.lastHourlyAt || '');
  const hourlySentMs = Date.parse(state.lastHourlyNotificationAt || '');
  const scheduledMs = Date.parse(scheduledAt || '') || Date.now();
  const alerts = Array.isArray(state.pendingAlerts) ? state.pendingAlerts.slice(0, 6) : [];
  const quarterDue = Number.isFinite(analysisMs) && (!Number.isFinite(quarterSentMs) || quarterSentMs < analysisMs);
  const hourlyDue = Number.isFinite(hourlyAt) && (!Number.isFinite(hourlySentMs) || hourlySentMs < hourlyAt) && Math.abs(scheduledMs-hourlyAt) <= 5*60*1000;
  if (opts.fallbackOnly && !alerts.length && !quarterDue && !hourlyDue) return {ok:true, skipped:true};

  let pendingAlerts = alerts;
  let lastQuarterNotificationAt = state.lastQuarterNotificationAt || null;
  let lastHourlyNotificationAt = state.lastHourlyNotificationAt || null;
  if (alerts.length) {
    const sent = await notifySafely('position-alerts', () => sendOneSignal(env, alerts));
    if (sent) {
      pendingAlerts = [];
      for (const alert of alerts.filter(x => String(x?.type || '').startsWith('POSITION_'))) {
        await markAlertSent(env, alert);
      }
    }
  }
  if (quarterDue && (state.tracked || []).length) {
    const sent = await notifySafely('quarter-hour', () => sendQuarterHourSummary(env, state.tracked));
    if (sent) lastQuarterNotificationAt = scheduledAt || new Date().toISOString();
  }
  if (hourlyDue && (state.tracked || []).length) {
    const sent = await notifySafely('hourly', () => sendHourlySummary(env, state.tracked));
    if (sent) lastHourlyNotificationAt = scheduledAt || new Date().toISOString();
  }
  const latest = await loadState(env);
  const next = {
    ...latest,
    pendingAlerts,
    lastQuarterNotificationAt,
    lastHourlyNotificationAt,
    lastNotificationErrors:notificationErrors,
    updatedAt:new Date().toISOString()
  };
  await saveState(env, next);
  return {ok:!notificationErrors.length, skipped:false, errors:notificationErrors};
}

async function sendStoredFourHourSummary(env, scheduledAt) {
  const state = await loadState(env);
  try {
    await sendFourHourScan(env, state.marketTop3 || [], state.last4hScanned || TOP_N);
    state.last4hNotificationAt = scheduledAt || new Date().toISOString();
    state.lastNotificationErrors = [];
    state.updatedAt = new Date().toISOString();
    await saveState(env, state);
  } catch (e) {
    state.lastNotificationErrors = [`four-hour-summary: ${String(e?.message || e)}`];
    state.updatedAt = new Date().toISOString();
    await saveState(env, state);
  }
}

async function scanMarket() {
  const [tickers, books] = await Promise.all([all24hTickers(), allBookTickers()]);
  const bookMap = new Map(books.map(x => [String(x.symbol || x.s || ''), x]));
  const validPairs = validTryPairs(tickers,books);

  let tryTicks = tickers.filter(t => {
    const sym = String(t.symbol || t.s || '');
    const base = baseFromSymbol(sym);
    return validPairs.has(base) && !EXCLUDED_BASES.has(base);
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

  if (metrics.length === 0) throw new Error('Yeterli TRY coin verisi alınamadı.');
  assignCandidateScores(metrics);
  const tickerMap = new Map(tickers.map(x => [String(x.symbol || x.s || ''), x]));
  return { scanned: top.length, metrics, tickerMap, bookMap, validPairs };
}

function validTryPairs(tickers,books){
  const live=new Set((books||[]).filter(x=>num(x,'bidPrice','b')>0&&num(x,'askPrice','a')>0).map(x=>String(x.symbol||x.s||'')));
  return new Set((tickers||[]).filter(t=>{const sym=String(t.symbol||t.s||''),base=baseFromSymbol(sym);return /_?TRY$/.test(sym)&&base&&num(t,'quoteVolume','q','volumeQuote','quoteAssetVolume')>0&&(live.has(sym)||live.has(base+'TRY')||live.has(base+'_TRY'));}).map(t=>baseFromSymbol(String(t.symbol||t.s||''))));
}

function hardGateReason(x){
  const p=x?.p||{},f=x?.flow||{},marketEntry=Number(p.marketEntry||x?.m?.price),conditionalEntry=Number(p.conditionalEntry),stop=Number(p.stop),marketRR=Number(p.marketRR),conditionalRR=Number(p.conditionalRR),spread=Number(x?.spread),out=f.status==='REAL'&&f.m15?.net<0&&f.m30?.net<0&&f.h1?.net<0&&Math.abs(f.m15.net)*2>Math.abs(f.m30.net);
  if(!p.hasResistance)return 'HEDEF_YOK';if(!(spread>=0&&spread<=.35))return 'SPREAD_LIKIDITE';if(!(stop>0&&stop<marketEntry))return 'STOP_YOK';if(p.recovery?.confirmedSupportBreak)return 'DESTEK_KIRILDI';if(out||f.distribution)return 'PARA_CIKISI';if(!(marketRR>=1.30)&&!(conditionalEntry>stop&&conditionalEntry<marketEntry&&Number(p.mainTarget||p.t2||p.t1)>conditionalEntry&&conditionalRR>=1.30))return 'RR';return finderEntryQuality(x).reason;
}
// Finder quality uses the chosen entry, never conditional R/R as market advantage.
function finderEntryQuality(x,kind='AUTO'){
 const p=x?.p||{},rec=p.recovery||{},history=rec.history||{},risk=finderRiskFlags(x),target=Number(p.mainTarget),market=Number(p.marketEntry),limit=Number(p.conditionalEntry),stop=Number(p.stop);
 const area=entry=>entry>0&&target>entry?(target-entry)/entry*100:NaN;
 const marketProfit=area(market),conditionalProfit=area(limit);
 const marketEligible=marketProfit>=5-1e-9&&Number(p.marketRR)>=1.30&&stop>0&&stop<market;
 const conditionalEligible=p.supportSource==='HORIZONTAL'&&limit>stop&&limit<market&&conditionalProfit>=5-1e-9&&Number(p.conditionalRR)>=1.30;
 const periods=['week','month','quarter','year'].map(k=>history[k]).filter(v=>(v?.complete||Number(v?.bars)>=7)&&Number(v.low)>0);
 const historicDistance=periods.length?Math.max(...periods.map(v=>Math.max(0,(market/Number(v.low)-1)*100))):Infinity;
 const historicalScore=periods.length?periods.reduce((sum,v)=>sum+Math.max(0,1-Math.max(0,(market/Number(v.low)-1)*100)/12),0)/periods.length*30:0;
 const selectedKind=kind==='AUTO'?(marketEligible&&p.bounce&&Number(x.s?.buy??x.buy)>=7?'MARKET':conditionalEligible?'CONDITIONAL':'MARKET'):kind;
 const profit=selectedKind==='MARKET'?marketProfit:selectedKind==='CONDITIONAL'?conditionalProfit:NaN;
 const eligible=kind==='MARKET'?marketEligible:kind==='CONDITIONAL'?conditionalEligible:marketEligible||conditionalEligible;
 const reason=risk.pullback?'GEÇ GİRİŞ / PULLBACK BEKLE':!history.week?.complete?'TARİHSEL VERİ EKSİK':historicDistance>=12?'TARİHSEL DİPTEN UZAK':!eligible?'KÂR ALANI %5 / R/R ŞARTI SAĞLANMADI':'';
 return{selectedKind,rr:Number(selectedKind==='MARKET'?p.marketRR:p.conditionalRR),reason,marketEligible,conditionalEligible,marketProfit,conditionalProfit,profit,historicalScore,historicDistance,band:profit>=12?'ÇOK GÜÇLÜ':profit>=8?'GÜÇLÜ':profit>=5-1e-9?'NORMAL':'ELENDİ'};
}
function compareFinderQuality(a,b){
 const qa=finderEntryQuality(a),qb=finderEntryQuality(b);
 return qb.historicalScore-qa.historicalScore||qa.historicDistance-qb.historicDistance||Number(a.p?.recovery?.advanceFromDipPct||0)-Number(b.p?.recovery?.advanceFromDipPct||0)||Math.abs(Number(a.p?.dist)||0)-Math.abs(Number(b.p?.dist)||0)||qb.profit-qa.profit||qb.rr-qa.rr||Number(b.candidate||0)-Number(a.candidate||0);
}
function finderRiskFlags(x){const p=x?.p||{},m=x?.m||{},h=x?.h||{},rec=p.recovery||{},f=x?.flow||{},drops=rec.drops||{},severeDrop=Number(drops.d3)<=-8||Number(drops.d5)<=-12||Number(drops.d7)<=-18,weakRecovery=severeDrop&&f.status==='REAL'&&Number(f.h1?.net)<0&&rec.state!=='TOPARLANMA TEYİDİ',fast15=Number(m.lastOpen)>0&&((Number(m.price)/Number(m.lastOpen)-1)*100)>=2.5,fast1h=Number(h.lastOpen)>0&&((Number(m.price)/Number(h.lastOpen)-1)*100)>=4,overheat=Number(m.rsi6)>=82||Number(m.rsi12)>=72||Number(m.rsi)>75,momentumHot=Number(m.rsi6)>=70||Number(m.rsi12)>=65||Number(m.rsi)>=68,entryGap=Number(p.marketEntry)>0&&Number(p.conditionalEntry)>0?(Number(p.marketEntry)/Number(p.conditionalEntry)-1)*100:0,anchorAdvance=Number(rec.advanceFromDipPct),multiDayAdvance=Number(rec.multiDayAdvancePct),recentAdvance=Number(rec.recentAdvancePct),advancedLate=recentAdvance>=12||multiDayAdvance>=18||anchorAdvance>=12||(anchorAdvance>=8&&(fast15||fast1h||momentumHot||entryGap>2.5))||(multiDayAdvance>=18&&(fast15||fast1h||momentumHot||entryGap>2.5)),chased=overheat||fast15||entryGap>2.5||advancedLate;return{severeDrop,weakRecovery,fast15,fast1h,overheat,momentumHot,entryGap,anchorAdvance,multiDayAdvance,recentAdvance,advancedLate,chased,pullback:weakRecovery||chased};}
function candidateState(x){if(hardGateReason(x))return ['TARİHSEL DİPTEN UZAK','GEÇ GİRİŞ / PULLBACK BEKLE'].includes(hardGateReason(x))&&finderRiskFlags(x).pullback?'PULLBACK':'REJECT';const p=x.p||{},m=x.m||{},rec=p.recovery||{},hold=!rec.confirmedSupportBreak&&!rec.fourHourFalling&&(rec.higherLow||rec.base||rec.reclaim||Number(p.dist)<0),momentum=[m.hist>m.prevHist,m.kdjK>m.kdjD,m.price>m.lastOpen,m.rsi6>=m.rsi12].filter(Boolean).length,flow=x.flow||{},flowOk=flow.status!=='REAL'||flow.m15?.net>0||!flow.distribution;if(finderRiskFlags(x).pullback)return 'PULLBACK';if(finderEntryQuality(x).marketEligible&&p.bounce&&hold&&flowOk&&Number(p.marketRR)>=1.30&&Number(x.buy)>=7)return 'BUY';if(finderEntryQuality(x).marketEligible&&p.near&&Number(p.conditionalEntry)>=Number(p.zoneLow)&&Number(p.conditionalEntry)<=Number(p.zoneHigh)&&!p.bounce&&hold&&flowOk)return 'LIMIT_WAIT';if(finderEntryQuality(x).conditionalEligible&&Number(p.conditionalEntry)>Number(p.stop)&&Number(p.conditionalEntry)<Number(p.marketEntry)&&Number(p.conditionalRR)>=1.30&&hold&&flowOk&&momentum>=2)return 'CONDITIONAL';if(finderEntryQuality(x).marketEligible&&(p.near||Number(p.dist)<=2)&&hold&&flowOk&&momentum>=2)return 'EARLY';return 'WATCH';}
function compareCandidateState(a,b){return compareFinderQuality(a,b);}

function klineNetFlow(rows,count){const a=(rows||[]).slice(-count),quote=a.reduce((s,x)=>s+(+x[7]||0),0),buy=a.reduce((s,x)=>s+(+x[10]||0),0);return{status:quote>0?'REAL':'VERİ YOK',net:quote>0?buy-(quote-buy):NaN,quote};}
function flowPercentile(a,p){if(!a.length)return NaN;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor((s.length-1)*p))];}
function aggregateOrderFlow(rows,now=Date.now()){const trades=(Array.isArray(rows)?rows:[]).map(x=>({time:+(x.T??x.time),quote:(+x.p||0)*(+x.q||0),side:x.m?'SELL':'BUY'})).filter(x=>x.time>0&&x.quote>0),sizes=trades.map(x=>x.quote),mediumCut=flowPercentile(sizes,.75),largeCut=flowPercentile(sizes,.95),start=now-60*60e3;if(!trades.length||!Number.isFinite(mediumCut)||Math.min(...trades.map(x=>x.time))>start)return{status:'VERİ YOK',large:NaN,medium:NaN,small:NaN};const out={status:'REAL',large:0,medium:0,small:0,thresholds:{medium:mediumCut,large:largeCut}};for(const t of trades.filter(x=>x.time>=start)){const k=t.quote>=largeCut?'large':t.quote>=mediumCut?'medium':'small';out[k]+=(t.side==='BUY'?1:-1)*t.quote;}return out;}
async function fetchOrderFlow(name){try{const clean=cleanBase(name),j=await fetchJsonAny([`https://api.binance.me/api/v3/aggTrades?symbol=${clean}TRY&limit=1000`,`https://cloudme-tr.2meta.app/api/v1/aggTrades?symbol=${clean}TRY&limit=1000`]);return aggregateOrderFlow(unwrapArray(j));}catch{return{status:'VERİ YOK',large:NaN,medium:NaN,small:NaN};}}
function buildFlowContext(k15,orders,m){const m15=klineNetFlow(k15,1),m30=klineNetFlow(k15,2),h1=klineNetFlow(k15,4),distribution=Number(m?.price)>Number(m?.closedPrice)&&m15.status==='REAL'&&m15.net<0;return{status:[m15,m30,h1].every(x=>x.status==='REAL')?'REAL':'VERİ YOK',m15,m30,h1,orders,distribution};}
function recoveryProfit(price,target){return price>0&&target>price?(target/price-1)*100:NaN;}
function uniqueLevels(values){return [...new Set(values.filter(Number.isFinite).filter(x=>x>0).map(x=>+x.toPrecision(12)))].sort((a,b)=>a-b);}
// Only completed candles available at this 15-minute close may define history/targets.
function recoveryHistory(k15,k1h,k4h,k1d,price){
 const asOf=Number(k15?.at(-1)?.[6]);
 const closed=rows=>[...new Map((rows||[]).filter(r=>Number.isFinite(Number(r[6]))&&Number(r[6])<=asOf&&Number(r[3])>0&&Number(r[2])>=Number(r[3])).map(r=>[Number(r[0]),r])).values()].sort((a,b)=>a[0]-b[0]);
 const intraday=closed(k15),hourly=closed(k1h),fourHourly=closed(k4h),daily=closed(k1d);
 const context={};
 for(const [name,days] of [['day',1],['week',7],['month',30],['quarter',90],['year',365]]){
  const rows=days===1?intraday.filter(r=>Number(r[0])>asOf-86400000):daily.slice(-days);
  const lows=rows.map(r=>Number(r[3])).filter(x=>x>0),highs=rows.map(r=>Number(r[2])).filter(x=>x>0);
  const low=lows.length?Math.min(...lows):NaN,high=highs.length?Math.max(...highs):NaN;
  context[name]={low,high,bars:rows.length,complete:(days===1?rows.length>=96:rows.length>=days)&&rows.every((r,i)=>i===0||Number(r[0])-Number(rows[i-1][0])===(days===1?900000:86400000)),distancePct:low>0?(price/low-1)*100:NaN};
 }
 // Keep the current reversal's confirmed low across midnight and higher lows.
 // Older 3/5/7-day floors remain separate context, not a forced intraday entry anchor.
 const floors=[3,5,7].map(days=>Math.min(...daily.slice(-days).map(r=>Number(r[3])).filter(x=>x>0))).filter(Number.isFinite);
 const multiDayReference=floors.length?Math.min(...floors):NaN;
 const recentLows=intraday.map(r=>Number(r[3])).filter(x=>x>0);
 const pivots=swingLevels(intraday,'low',2,220);
 let dipReference=NaN,previousPivot=NaN;
 for(const low of pivots){dipReference=Number.isFinite(dipReference)?Math.min(dipReference,low):low;}
 if(!Number.isFinite(dipReference))dipReference=recentLows.length?Math.min(...recentLows):NaN;
 const micro=swingLevels(intraday,'high',2,120);
 // Confirmed higher-timeframe swings, not an arbitrary second micro resistance.
 const strong=uniqueLevels([...swingLevels(hourly,'high',2,160),...swingLevels(fourHourly,'high',2,120),...swingLevels(daily,'high',2,365)]);
 const resistances=uniqueLevels([...micro,...strong]).filter(x=>x>price*1.002);
 const interimTarget=resistances[0]??NaN;
 const mainTarget=strong.find(x=>x>interimTarget*1.002)??interimTarget;
 const nextTarget=strong.find(x=>x>mainTarget*1.006)??NaN;
 return{asOf,intraday,hourly,fourHourly,daily,context,dipReference,multiDayReference,resistances,interimTarget,mainTarget,nextTarget};
}
function enrichRecoveryPlan(p,k15,k1h,k4h,k1d,m,h,flow,spread){
 const price=Number(m.price),history=recoveryHistory(k15,k1h,k4h,k1d,price);
 k15=history.intraday;k1h=history.hourly;k4h=history.fourHourly;k1d=history.daily;
 const daily=k1d.slice(-8),dailyHighs=daily.map(x=>+x[2]),res=history.resistances;
 const {interimTarget,mainTarget,nextTarget}=history;
 p.resistances=res;p.interimTarget=interimTarget;p.mainTarget=mainTarget;p.t1=interimTarget;p.t2=mainTarget;p.t3=nextTarget;p.hasResistance=Number.isFinite(interimTarget);p.marketEntry=price;p.conditionalEntry=price>p.zoneHigh&&p.supportSource==='HORIZONTAL'?p.zoneHigh:price;p.earlyEntry=p.conditionalEntry;p.marketRR=p.hasResistance&&price>p.stop&&mainTarget>price?(mainTarget-price)/(price-p.stop):NaN;p.conditionalRR=p.hasResistance&&p.conditionalEntry>p.stop&&mainTarget>p.conditionalEntry?(mainTarget-p.conditionalEntry)/(p.conditionalEntry-p.stop):NaN;p.rr=p.conditionalRR;
  const drops={},drawdowns={},changeReferenceAt={};
  for(const days of [3,5,7]){
   const cutoff=history.asOf-days*86400000,prior=[...k15,...k1h,...k1d].filter(r=>Number(r[6])<=cutoff).sort((a,b)=>a[6]-b[6]).at(-1);
   drops['d'+days]=prior&&Number(prior[4])>0?(price/Number(prior[4])-1)*100:NaN;changeReferenceAt['d'+days]=prior?.[6]??null;
   const w=k1d.slice(-days),peak=Math.max(...w.map(x=>+x[2]).filter(Number.isFinite));drawdowns['d'+days]=peak>0?(price/peak-1)*100:NaN;
  }
  const recentRows=[...k15,...k1h,...k1d].filter(r=>Number(r[6])>history.asOf-3*86400000),recentFloor=Math.min(...recentRows.map(r=>Number(r[3])).filter(v=>v>0)),recentAdvancePct=recentFloor>0?(price/recentFloor-1)*100:NaN;
  const priorPeak=Math.max(...dailyHighs.filter(Number.isFinite)),maxRecoveryPct=recoveryProfit(price,priorPeak),lows15=swingLevels(k15,'low',2,80),higherLow=lows15.length>=2&&lows15.at(-1)>lows15.at(-2)*1.001,dipReference=history.dipReference,advanceFromDipPct=dipReference>0?(price/dipReference-1)*100:NaN,multiDayReference=history.multiDayReference,multiDayAdvancePct=multiDayReference>0?(price/multiDayReference-1)*100:NaN;
  const closes15=(k15||[]).slice(-2).map(x=>+x[4]),closes4h=(k4h||[]).slice(-3).map(x=>+x[4]),lows4h=(k4h||[]).slice(-3).map(x=>+x[3]),fourHourHold=closes4h.length>=2&&closes4h.at(-1)>=closes4h.at(-2),fourHourFalling=closes4h.length===3&&closes4h[2]<closes4h[1]&&closes4h[1]<closes4h[0]&&lows4h[2]<=lows4h[1];
  const lastDailyLow=+daily.at(-1)?.[3],previousDailyLows=daily.slice(0,-1).map(x=>+x[3]).filter(Number.isFinite),newLow=previousDailyLows.length&&lastDailyLow<=Math.min(...previousDailyLows),recent15=(k15||[]).slice(-4),range15=recent15.length?Math.max(...recent15.map(x=>+x[2]))-Math.min(...recent15.map(x=>+x[3])):Infinity,base=range15<=Math.max(Number(p.atr)||0,price*.012),reclaim=Number(m.price)>=Number(p.support)&&Number(m.lastLow)<Number(p.support),volume=Number(m.vol)>=Number(m.vma5),money=flow?.m15?.status==='REAL'&&flow.m15.net>0&&!flow.distribution,rsi=Number(m.rsi6)>=Number(m.rsi12)&&Number(m.rsi)>=35,kdj=Number(m.kdjK)>Number(m.kdjD),ema=Number(m.ema9)>=Number(m.ema21),macd=Number(m.hist)>Number(m.prevHist),boll=Number(m.price)>=Number(m.bollDn),spreadOk=Number(spread)<=.35,sellingPressure=flow?.status==='REAL'&&flow.m15?.net<0&&flow.m30?.net<0&&(flow.h1?.net<0||flow.orders?.large<0),confirmedSupportBreak=closes15.length===2&&closes15.every(x=>x<p.zoneLow)&&sellingPressure;
  const confirmations=[higherLow,base,reclaim,fourHourHold,volume,money,rsi,kdj,ema,macd,boll,spreadOk].filter(Boolean).length,stabilized=!confirmedSupportBreak&&!fourHourFalling&&(higherLow||base||reclaim),state=confirmedSupportBreak?'DESTEK KIRILDI — AL YOK':newLow?'YENİ DİP — İZLE':fourHourFalling?'DÜŞÜŞ SÜRÜYOR — AL YOK':stabilized&&confirmations>=7?'TOPARLANMA TEYİDİ':stabilized?'YATAY / İZLE':'DESTEK GERİ KAZANIMI / İZLE';
  p.recovery={history:history.context,asOf:history.asOf,drops,drawdowns,changeReferenceAt,recentAdvancePct,higherLow,base,reclaim,fourHourHold,fourHourFalling,newLow,sellingPressure,confirmedSupportBreak,confirmations,state,dipReference,advanceFromDipPct,multiDayReference,multiDayAdvancePct,nearTarget:p.interimTarget,mainTarget:p.mainTarget,maxRecoveryLevel:priorPeak,maxRecoveryPct,guaranteed:false};return p;
}

async function analyzeCandidate(name, t24, bookMap = new Map(), freshAlarmQuote = false) {
  const [a,b,k4h,daily,orders] = await Promise.all([klines(name,'15m'), klines(name,'1h'), klines(name,'4h'), klines(name,'1d'), fetchOrderFlow(name)]);
  const m = calc(a), h = calc(b);
  m.closedPrice = m.price;

  let ticker = t24;
  if (!ticker) {
    ticker = await ticker24(name).catch(() => ({}));
  }
  const bk = freshAlarmQuote ? await fetchBinanceTrBookTicker(name,3500) : bookMap.get(name+'TRY') || bookMap.get(name+'_TRY') || {};
  const quoteAt = Date.now();
  const bid = num(bk,'bidPrice','b') || num(ticker,'bidPrice','b');
  const ask = num(bk,'askPrice','a') || num(ticker,'askPrice','a');
  const currentPrice = ask || num(ticker,'lastPrice','c','price');
  if (currentPrice > 0) {
    m.price = currentPrice;
    m.change = (currentPrice / m.closedPrice - 1) * 100;
  }

  const qv = num(ticker,'quoteVolume','q','volumeQuote','quoteAssetVolume');
  const ch = num(ticker,'priceChangePercent','P') || ((num(ticker,'lastPrice','c')/(num(ticker,'openPrice','o')||1)-1)*100);
  const mid = (bid+ask)/2;
  const spread = (bid&&ask&&mid) ? ((ask-bid)/mid*100) : 99;
  const vRatio = m.vma5 ? m.vol/m.vma5 : 0;
  const impulse = m.vma10 ? m.vma5/m.vma10 : 0;
  const vola = volatility15(a);
  const trend = (m.ema9>m.ema21?1:0)+(h.ema9>h.ema21?1:0)+(m.macd>m.signal?1:0)+(m.hist>m.prevHist?1:0);
  const flow=buildFlowContext(a,orders,m),p = enrichRecoveryPlan(tradePlan(a,b,m,h),a,b,k4h,daily,m,h,flow,spread);
  const fastMode=vRatio>=1.8&&Math.abs((m.price/m.closedPrice-1)*100)>=Math.max(.8,vola*.7),out = { name,qv,marketCap:NaN,marketCapStatus:'VERİ YOK',ch,spread,vRatio,impulse,vola,fastMode,trend,buy:score(m,h,p).buy,m,h,p,flow };
  out.freshness={quoteAt,closes:[a,b,k4h,daily].map(rows=>Number(rows.at(-1)?.[6]))};
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
    const supportPts=Math.min(10,(proximity+reversal)*.5);
    const reachPts=(x.rpot?.reach||0)*2.0;
    const momentumPts=Math.min(15,volume+trend+rsiPts);
    const liquidPts=Math.min(5,liquid+qvol);
    const chasePenalty=d>3?Math.min(30,(d-3)*5):0;
    const belowPenalty=d<-1.5?10:0;
    const overheat=x.m.rsi>72?8:0;
    const recovery=x.p?.recovery||{},risk=finderRiskFlags(x),recoveryBonus=recovery.state==='TOPARLANMA TEYİDİ'?Math.min(4,Number(recovery.confirmations||0)*.45):0,dipNearBonus=risk.severeDrop&&Math.abs(d)<=1.5&&(recovery.higherLow||recovery.base||recovery.reclaim)?8:0,recoveryPenalty=recovery.newLow?20:0,weakFlowPenalty=risk.weakRecovery?12:0,weakVolumePenalty=x.vRatio<.8?10:0,fastRisePenalty=risk.chased?18:0,theoreticalBonus=Math.min(2,Math.max(0,Number(recovery.maxRecoveryPct||0))*.03);
    x.candidate=Math.max(0,Math.min(100,finderEntryQuality(x).historicalScore+profitPts+reachPts+supportPts+momentumPts+liquidPts+recoveryBonus+dipNearBonus+theoreticalBonus-chasePenalty-belowPenalty-overheat-recoveryPenalty-weakFlowPenalty-weakVolumePenalty-fastRisePenalty-(finderEntryQuality(x).historicDistance>=12?30:0)));
    if(x.vRatio<.8&&!bounce)x.candidate=Math.min(x.candidate,74);
  }
}

function compareCandidate(a,b) {
  return (Number(b?.rpot?.expectedEdge||0)-Number(a?.rpot?.expectedEdge||0)) || (Number(b?.candidate||0)-Number(a?.candidate||0)) || (Number(b?.rpot?.upside1||0)-Number(a?.rpot?.upside1||0));
}

function resistancePotential(x){
  const p=x.p||{}, m=x.m||{}, h=x.h||{};
  const marketEntry=Number(p.marketEntry||m.price||0),entry=Number(p.conditionalEntry||marketEntry),t1=Number(p.interimTarget||p.t1||0),t2=Number(p.mainTarget||p.t2||t1),upside1=(entry>0&&t2>entry)?((t2-entry)/entry*100):0,upside2=(marketEntry>0&&t2>marketEntry)?((t2-marketEntry)/marketEntry*100):0,rr=Number(p.conditionalRR||0);
  const v=Math.max(0,Math.min(2.5,Number(x.vRatio||0)));
  const trend=(m.ema9>m.ema21?1:0)+(h.ema9>h.ema21?1:0)+(m.macd>m.signal?1:0)+(m.hist>m.prevHist?1:0);
  const rsiV=Number(m.rsi||50);
  const signedDist=Number(p.dist??99), dist=Math.abs(signedDist);

  const chosenQuality=finderEntryQuality(x),rankProfit=chosenQuality.profit;
  const profitScore=rankProfit>=12?10:rankProfit>=8?7.5:rankProfit>=5-1e-9?5:0;

  let reach=0; reach+=(trend/4)*4; reach+=(Math.min(v,1.8)/1.8)*2.5;
  if(rsiV>=45&&rsiV<=67)reach+=1.5; else if(rsiV>=38&&rsiV<45)reach+=.8; else if(rsiV>72)reach-=1;
  if(p.bounce)reach+=2; reach=Math.max(0,Math.min(10,reach));

  let support=Math.max(0,10-dist*2.2); if(p.bounce)support=Math.min(10,support+2);
  const momentum=Math.max(0,Math.min(10,(Math.min(v,2)/2)*5+(trend/4)*5));
  const sp=Number(x.spread??99), liquidity=sp<=.10?10:sp<=.18?8:sp<=.30?5:sp<=.50?2:0;
  const potScore=profitScore*.35+reach*.25+support*.20+momentum*.15+liquidity*.05;
  const executionConfidence=Math.max(0,Math.min(1,(reach*.55+support*.25+liquidity*.20)/10));
  const expectedEdge=Math.max(0,upside1*executionConfidence-Math.max(0,sp));

  const eligible=!chosenQuality.reason && !!p.hasResistance && !p.recovery?.confirmedSupportBreak && signedDist<=3.5 && chosenQuality.rr>=1.30 && sp<=0.35;
  return{score:Math.round(potScore*10)/10,upside1,upside2,rr,marketRR:Number(p.marketRR),conditionalRR:Number(p.conditionalRR),t1,t2,profitScore,reach,support,momentum,liquidity,expectedEdge:Math.round(expectedEdge*100)/100,dist,signedDist,eligible};
}

function tradePlan(k15,k1h,m,h){
  const price=m.price, A=atr(k15,14)||price*.006;
  const levelPrice=Number(m.closedPrice)||price;
  const lows15=swingLevels(k15,'low',2,100), lows1=swingLevels(k1h,'low',2,100);
  const highs15=swingLevels(k15,'high',2,100), highs1=swingLevels(k1h,'high',2,100);
  const s15=clusteredLevel(lows15,price,'below'), s1=clusteredLevel(lows1,price,'below',.7);
  const horizontalSupports=[...lows15,...lows1].filter(Number.isFinite).filter(x=>x<=price);
 const supports=horizontalSupports.length?horizontalSupports:[m.bollDn,m.ema21,h.ema21].filter(Number.isFinite).filter(x=>x<=price*1.015);
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
  const horizontalHighs=[...highs15,...highs1].filter(Number.isFinite).sort((a,b)=>a-b);
  const crossedResistance=horizontalHighs.filter(x=>x<=levelPrice*1.002).sort((a,b)=>b-a)[0]||NaN;
  // Direnç ancak kapanmış mum onu geçtiğinde ileri taşınır; anlık iğne hedefi kaçırmaz.
  const resist=[...horizontalHighs,m.bollUp].filter(Number.isFinite).filter(x=>x>Math.max(levelPrice,zoneHigh)*1.002).sort((a,b)=>a-b);
  const hasResistance=resist.length>0;
  const t1=hasResistance?resist[0]:NaN;
  const t2=hasResistance?(resist.find(x=>x>t1*1.006)||NaN):NaN;
  const entry=near?price:(zoneLow+zoneHigh)/2;
  const risk=Math.max(entry-stop,entry*.001), rr=Number.isFinite(t1)?(t1-entry)/risk:NaN;
  const status=bounce?'TEYİTLİ GİRİŞ':(near?'BEKLE — DESTEK TEYİDİ BEKLENİYOR':dist>3.5?'GEÇ KALINDI':dist>0?'BEKLE — DESTEĞE GERİ ÇEKİLME':'ALMA — DESTEK KAPANIŞLA GEÇERSİZ');
  return{support,supportSource:horizontalSupports.length?'HORIZONTAL':'DYNAMIC',zoneLow,zoneHigh,dist,near,bounce,volOk,rsiOk,emaOk,macdOk,hourlyOk,stop,t1,t2,crossedResistance,entry,rr,hasResistance,status,atr:A};
}

function score(m,h,p){
  const d=Number(p?.dist??99), ad=Math.abs(d);
  // Tarayıcı ve Worker aynı 10 puanlık giriş modelini kullanır.
  let entryPts=0;
  if(p?.bounce)entryPts=3.0; else if(p?.near)entryPts=2.7; else if(d>=0&&d<=0.50)entryPts=2.4; else if(d<=1.0&&d>0)entryPts=2.0; else if(d<=1.75&&d>1.0)entryPts=1.3; else if(d<=2.5&&d>1.75)entryPts=.7; else if(d<0&&ad<=.75)entryPts=.4;
  const entry=Number(p?.marketEntry||m.price), target=Number(p?.mainTarget||p?.t2||p?.t1);
  const upside=(Number.isFinite(target)&&Number.isFinite(entry)&&entry>0)?((target-entry)/entry*100):0;
  const profitPts=upside>=10?2:upside>=7?1.8:upside>=5?1.5:upside>=3?1.1:upside>0?Math.max(0,upside/3):0;
  const rr=Number(p?.marketRR||0), rrPts=rr>=3?1:rr>=2?.85:rr>=1.5?.65:rr>=1.3?.45:0;
  const volPts=(m.vol>m.vma5?.65:.2)+(m.vma5>m.vma10?.35:0);
  const trendPts=(m.ema9>m.ema21?.55:0)+(h.ema9>h.ema21?.65:0)+(m.price>m.ema9?.30:0);
  const momentumPts=(m.rsi>=45&&m.rsi<=66?.45:m.rsi>72?0:.20)+(m.macd>m.signal?.55:0)+(m.hist>m.prevHist?.50:0);
  let b=Math.round(Math.max(0,Math.min(10,entryPts+profitPts+rrPts+volPts+trendPts+momentumPts))*10)/10;
  let sell=0;if(m.rsi>72)sell+=2;if(m.macd<m.signal)sell+=1.5;if(m.hist<m.prevHist)sell+=1;if(m.price<m.ema9)sell+=1;if(h.ema9<h.ema21)sell+=1;if(d<-.75)sell+=2;if(upside<=.5)sell+=1.5;
  if(p && !p.near && d>1.75)b=Math.min(b,6.9);
  if(p && !p.near && d>2.5)b=Math.min(b,5.9);
  if(p && p.status.includes('DESTEK ALTI'))b=Math.min(b,4.9);
  if(p && !p.bounce)b=Math.min(b,7.4);
  if(p && !p.hasResistance)b=Math.min(b,6.9);
  if(upside<3)b=Math.min(b,6.8);
  return{buy:b,sell:Math.round(Math.min(10,sell)*10)/10,upside:Math.round(upside*100)/100,profitPts:Math.round(profitPts*10)/10};
}

function calc(k){
  const c=k.map(x=>+x[4]),v=k.map(x=>+x[5]),i=c.length-1;
  const E9=emaSeries(c,9),E21=emaSeries(c,21),E50=emaSeries(c,50),R=rsiSeries(c),R6=rsiSeries(c,6),R12=rsiSeries(c,12),R24=rsiSeries(c,24),KDJ=kdj(k,9),M12=emaSeries(c,12),M26=emaSeries(c,26);
  const macd=M12.map((x,j)=>x-M26[j]),sig=emaSeries(macd,9),hist=macd.map((x,j)=>x-sig[j]);
  const ma5=sma(v,5),ma10=sma(v,10),mid=sma(c,20),sd=stdev(c.slice(-20));
  return{price:c[i],closedPrice:c[i],lastOpen:+k[i][1],lastHigh:+k[i][2],lastLow:+k[i][3],vol:v[i],vma5:ma5[i],vma10:ma10[i],ema9:E9[i],ema21:E21[i],ema50:E50[i],rsi:R[i],rsi6:R6[i],rsi12:R12[i],rsi24:R24[i],kdjK:KDJ.k,kdjD:KDJ.d,kdjJ:KDJ.j,macd:macd[i],signal:sig[i],hist:hist[i],prevHist:hist[i-1],bollMid:mid[i],bollUp:mid[i]+2*sd,bollDn:mid[i]-2*sd,change:(c[i]/c[i-1]-1)*100};
}

function closedKlines(rows,interval){
  const ms=interval==='15m'?15*60*1000:interval==='1h'?60*60*1000:interval==='4h'?4*60*60*1000:24*60*60*1000, now=Date.now();
  return rows.filter(x=>{const open=+x[0], close=Number.isFinite(+x[6])?+x[6]:open+ms-1;return close<now-1500});
}

async function klines(name,interval){
  const clean=cleanBase(name);
  const urls=[
    `https://api.binance.me/api/v1/klines?symbol=${clean}TRY&interval=${interval}&limit=${interval==='1d'?366:220}`,
    `https://cloudme-tr.2meta.app/api/v1/klines?symbol=${clean}_TRY&interval=${interval}&limit=${interval==='1d'?366:220}`,
    `https://cloudme-tr.2meta.app/api/v1/klines?symbol=${clean}TRY&interval=${interval}&limit=${interval==='1d'?366:220}`
  ];
  const j=await fetchJsonAny(urls);
  const raw=Array.isArray(j)?j:j?.data;
  const d=Array.isArray(raw)?closedKlines(raw,interval):[];
  if(d.length<(interval==='1d'?8:51))throw new Error(`${clean}/TRY ${interval} kapanmış mum verisi yetersiz.`);
  return d;
}

async function ticker24(name){
  const clean=cleanBase(name);
  return fetchJsonAny([
    `https://api.binance.me/api/v3/ticker/24hr?symbol=${clean}TRY`,
    `https://cloudme-tr.2meta.app/api/v1/ticker/24hr?symbol=${clean}_TRY`,
    `https://cloudme-tr.2meta.app/api/v1/ticker/24hr?symbol=${clean}TRY`
  ]);
}

async function all24hTickers(){const rows=unwrapArray(await fetchJsonAny(BINANCE_24H_URLS));if(!rows.length)throw new Error('Binance TR TRY piyasa listesi alınamadı.');return rows;}
async function allBookTickers(){
  const rows=unwrapArray(await fetchJsonAny(BINANCE_BOOK_URLS));
  if(!rows.length)throw new Error('Binance TR emir defteri listesi alınamadı.');
  return rows;
}

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
  if(!env.COIN_KV)return {tracked:[],positions:[]};
  try{
    const [stateRaw,positionRaw]=await Promise.all([env.COIN_KV.get(STATE_KEY),env.COIN_KV.get(POSITION_STATE_KEY)]);
    const state=JSON.parse(stateRaw||'{"tracked":[]}');
    const positionState=positionRaw?JSON.parse(positionRaw):null;
    return {...state,positions:Array.isArray(positionState?.positions)?positionState.positions:(Array.isArray(state.positions)?state.positions:[])};
  }
  catch{return {tracked:[],positions:[]};}
}

async function saveState(env,state){
  if(!env.COIN_KV)throw new Error('COIN_KV bağlantısı bulunamadı.');
  const {positions,...analysisState}=state||{};
  await kvPutWithRetry(env.COIN_KV,STATE_KEY,JSON.stringify(analysisState));
}

async function savePositionsState(env,state){
  if(!env.COIN_KV)throw new Error('COIN_KV bağlantısı bulunamadı.');
  await kvPutWithRetry(env.COIN_KV,POSITION_STATE_KEY,JSON.stringify({
    positions:Array.isArray(state?.positions)?state.positions.slice(0,TRACK_COUNT):[],
    positionSource:state?.positionSource||null,
    updatedAt:state?.updatedAt||new Date().toISOString()
  }));
}

async function kvPutWithRetry(kv,key,value){
  try{await kv.put(key,value);}
  catch(e){
    if(!/429|rate/i.test(String(e?.message||e)))throw e;
    await new Promise(resolve=>setTimeout(resolve,1100));
    await kv.put(key,value);
  }
}

async function sendOneSignal(env,alerts){
  if(!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_API_KEY)throw new Error('OneSignal yapılandırması eksik.');
  const title=alerts.length===1?alerts[0].title:'Coin Analiz — Takip Uyarısı';
  const body=alerts.length===1?alerts[0].body:alerts.map(a=>`${a.name}/TRY: ${a.body}`).join('\n');
  const critical=alerts.some(a=>CRITICAL_PUSH_TYPES.has(String(a?.type||'')));
  const appUrl = new URL(env.APP_URL||'https://fatihhanfan-orhan.github.io/Coin-analiz/');
  if(alerts.length===1 && alerts[0].name){
    appUrl.searchParams.set('coin',cleanBase(alerts[0].name));
    if(String(alerts[0].type||'').startsWith('POSITION_')){
      appUrl.searchParams.set('position','1');
      appUrl.hash='position-'+cleanBase(alerts[0].name);
    }
  }


  const r=await fetch('https://api.onesignal.com/notifications',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Key ${env.ONESIGNAL_API_KEY}`},
    body:JSON.stringify({
      app_id:env.ONESIGNAL_APP_ID,
      target_channel:'push',
      included_segments:['Subscribed Users'],
      headings:{en:title},
      contents:{en:body},
      priority:critical?10:5,
      ttl:critical?60:900,
      url:appUrl.href
    })
  });
  if(!r.ok)throw new Error(`OneSignal ${r.status}: ${await r.text()}`);
  const result=await r.json().catch(()=>({}));
  if(!result?.id)throw new Error(`OneSignal bildirim oluşturmadı: ${JSON.stringify(result)}`);
}

function cors(response){
  const h=new Headers(response.headers);
  h.set('Access-Control-Allow-Origin',APP_ORIGIN);
  h.set('Vary','Origin');
  h.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers','Content-Type');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});
}
function json(data,status=200){return cors(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8'}}));}

function normalizeNames(arr){return [...new Set((Array.isArray(arr)?arr:[]).map(cleanBase).filter(Boolean))].filter(x=>!EXCLUDED_BASES.has(x));}
function normalizeSyncedAnalyses(rows, allowedNames = []) {
  const allowed = new Set(normalizeNames(allowedNames));
  const result = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (result.length >= TRACK_COUNT) break;
    const name = cleanBase(row?.name);
    if (!name || (allowed.size && !allowed.has(name)) || result.some(x => x.name === name)) continue;
    const p = row?.p || {}, rpot = row?.rpot || {};
    const buy = clampNumber(row?.buy, 0, 10, NaN);
    const stop = Number(p.stop), t1 = Number(p.t1), t2 = Number(p.t2), t3=Number(p.t3);
    if (!Number.isFinite(buy) || !(stop > 0) || !(t1 > 0)) continue;
    result.push({
      name,
      state:String(row?.state||''),
      eventAt:clampNumber(row?.eventAt,0,Date.now(),Math.floor(Date.now()/900000)*900000),
      buy,
      candidate:clampNumber(row?.candidate,0,100,0),
      spread:clampNumber(row?.spread,0,100,99),
      ch:clampNumber(row?.ch,-1000,1000,0),
      p:{
        status:String(p.status || '').slice(0,120),
        dist:clampNumber(p.dist,-1000,1000,99),
        near:Boolean(p.near), bounce:Boolean(p.bounce), hasResistance:Boolean(p.hasResistance),
        stop, t1, t2:Number.isFinite(t2)&&t2>0?t2:t1,t3:Number.isFinite(t3)&&t3>0?t3:null,
        interimTarget:Number(p.interimTarget)||t1,mainTarget:Number(p.mainTarget)||t2||t1,
        marketEntry:Number(p.marketEntry)||0,conditionalEntry:Number(p.conditionalEntry)||0,
        marketRR:clampNumber(p.marketRR,0,100,0),conditionalRR:clampNumber(p.conditionalRR,0,100,0),
        recovery:p.recovery?{state:String(p.recovery.state||''),confirmations:Number(p.recovery.confirmations)||0,newLow:Boolean(p.recovery.newLow),dipReference:clampNumber(p.recovery.dipReference,0,1e12,0),advanceFromDipPct:clampNumber(p.recovery.advanceFromDipPct,-1000,1000,0),multiDayReference:clampNumber(p.recovery.multiDayReference,0,1e12,0),multiDayAdvancePct:clampNumber(p.recovery.multiDayAdvancePct,-1000,1000,0),maxRecoveryPct:clampNumber(p.recovery.maxRecoveryPct,-1000,1000,0),guaranteed:false}:null,
        rr:clampNumber(p.rr,0,100,0)
      },
      rpot:{
        eligible:Boolean(rpot.eligible),
        upside1:clampNumber(rpot.upside1,-1000,1000,0),
        expectedEdge:clampNumber(rpot.expectedEdge,-1000,1000,0),
        realizable:clampNumber(rpot.realizable,-1000,1000,0),
        score:clampNumber(rpot.score,0,10,0),
        rr:clampNumber(rpot.rr,0,100,0)
      }
    });
  }
  return result;
}
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
function emaSeries(a,p){const o=Array(a.length).fill(NaN),k=2/(p+1),seed=[];let s=NaN,ready=false;for(let i=0;i<a.length;i++){const x=Number(a[i]);if(!Number.isFinite(x))continue;if(!ready){seed.push(x);if(seed.length===p){s=seed.reduce((u,v)=>u+v,0)/p;o[i]=s;ready=true;}}else{s=x*k+s*(1-k);o[i]=s;}}return o;}
function rsiSeries(a,p=14){let g=0,l=0;for(let i=1;i<=p;i++){let d=a[i]-a[i-1];d>=0?g+=d:l-=d;}let ag=g/p,al=l/p,o=Array(p).fill(NaN);o.push(al===0?100:100-100/(1+ag/al));for(let i=p+1;i<a.length;i++){let d=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;o.push(al===0?100:100-100/(1+ag/al));}return o;}
function kdj(k,p=9){let K=50,D=50,J=50;for(let i=p-1;i<k.length;i++){const w=k.slice(i-p+1,i+1),hi=Math.max(...w.map(x=>+x[2])),lo=Math.min(...w.map(x=>+x[3])),cl=+k[i][4],rsv=hi===lo?50:(cl-lo)/(hi-lo)*100;K=(2*K+rsv)/3;D=(2*D+K)/3;J=3*K-2*D;}return{k:K,d:D,j:J};}
function stdev(a){let m=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0)/a.length);}
function dedupeAlerts(a){const seen=new Set();return a.filter(x=>{const k=x.type+':'+x.name;if(seen.has(k))return false;seen.add(k);return true;});}
function fmt0(v){return Number(v||0).toFixed(0);}
function fmt1(v){return Number(v||0).toFixed(1);}
function fmt2(v){return Number(v||0).toFixed(2);}
function fmtPct(v){const n=Number(v||0);return `${n>=0?'+':''}${n.toFixed(2)}%`;}

function fmtPrice(v){const n=Number(v||0);if(!Number.isFinite(n))return '-';if(n>=100)return n.toFixed(2);if(n>=1)return n.toFixed(4);return n.toFixed(6);}

function maxPositive(...values){const nums=values.map(Number).filter(x=>Number.isFinite(x)&&x>0);return nums.length?Math.max(...nums):NaN;}
function positiveOr(value,fallback){const n=Number(value);return Number.isFinite(n)&&n>0?n:(Number(fallback)>0?Number(fallback):null);}
function clampNumber(value,min,max,fallback=0){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}
function mergeCheckedPositions(latest,checked){
  const checkedMap=new Map((checked||[]).map(x=>[cleanBase(x.name),x]));
  return (latest||[]).slice(0,TRACK_COUNT).map(pos=>{
    const fresh=checkedMap.get(cleanBase(pos.name));
    if(!fresh)return pos;
    const entry=Number(pos.entry)||Number(fresh.entry);
    return {...pos,...fresh,entry,createdAt:Number(pos.createdAt)||Number(fresh.createdAt)||Date.now(),highWater:Math.max(entry,Number(pos.highWater)||0,Number(fresh.highWater)||0),protectedStop:maxPositive(pos.protectedStop,fresh.protectedStop)};
  });
}
function isTrustedAppRequest(request,env){
  const allowed=new URL(env.APP_URL||`${APP_ORIGIN}/Coin-analiz/`).origin;
  return String(request.headers.get('Origin')||'')===allowed;
}
function isAdminRequest(request,env){
  const secret=String(env.COIN_ADMIN_TOKEN||'');
  const auth=String(request.headers.get('Authorization')||'');
  return Boolean(secret)&&auth===`Bearer ${secret}`;
}

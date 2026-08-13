// Coin Analiz V5.0 FINAL Worker — hızlı pozisyon alarmı + 15dk/1saat arka plan push
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
const APP_ORIGIN = 'https://fatihhanfan-orhan.github.io';
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
          version: '5.0-WORKER-15-DENETIMLI',
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
        const names = normalizeNames(body.coins || body.names || []);
        if (!names.length) return json({ ok:false, error:'Coin listesi boş.' }, 400);

        const synced = normalizeSyncedAnalyses(body.analyses || [], names);
        const analyzed = [...synced];
        if (!synced.length) {
          for (const name of names.slice(0, TRACK_COUNT)) {
            try { analyzed.push(await analyzeCandidate(name, null, new Map())); }
            catch (e) { analyzed.push({ name, error: String(e?.message || e) }); }
          }
        }
        const good = analyzed.filter(x => !('error' in x));
        if (!good.length) return json({ ok:false, error:'Takip için geçerli veri alınamadı.', details:analyzed }, 422);

        const previous = await loadState(env);
        const syncedAt = new Date().toISOString();
        const next = {
          ...previous,
          tracked: sortByProfit(good).slice(0, TRACK_COUNT),
          trackedSource: synced.length ? 'web-analysis' : 'web-selection',
          trackedSyncedAt: syncedAt,
          source: synced.length ? 'web-analysis' : 'web-selection',
          updatedAt: syncedAt
        };
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
  }
};

async function backgroundCycle(env, opts = {}) {
  const previous = await loadState(env);
  const shouldFullScan = Boolean(opts.forceFullScan || opts.fourHourly || !(previous.tracked || []).length);

  let market = null;
  let marketTop3 = previous.marketTop3 || [];
  let tickerMap = new Map();
  let bookMap = new Map();
  if (shouldFullScan) {
    market = await scanMarket();
    tickerMap = market.tickerMap || new Map();
    bookMap = market.bookMap || new Map();
    const eligible = market.metrics.filter(x => x.rpot?.eligible).sort(compareProfitFirst);
    const backups = market.metrics.filter(x => x.rpot && !x.rpot.eligible).sort(compareProfitFirst);
    marketTop3 = eligible.slice(0, TRACK_COUNT);
    for (const x of backups) {
      if (marketTop3.length >= TRACK_COUNT) break;
      if (!marketTop3.some(y => y.name === x.name)) marketTop3.push(x);
    }
  } else {
    const [tickers, books] = await Promise.all([
      all24hTickers().catch(() => []),
      allBookTickers().catch(() => [])
    ]);
    tickerMap = new Map(tickers.map(x => [String(x.symbol || x.s || ''), x]));
    bookMap = new Map(books.map(x => [String(x.symbol || x.s || ''), x]));
  }

  // Takip listesindeki coinleri her cron tetiklenmesinde (önerilen 15 dk) yeniden analiz et.
  const analysisByName = new Map((market?.metrics || []).map(x => [x.name, x]));
  const currentTracked = [];
  const analysisErrors = [];
  for (const old of (previous.tracked || []).slice(0, TRACK_COUNT)) {
    const name = cleanBase(old?.name || old?.symbol || '');
    if (!name) continue;
    try {
      const cached = analysisByName.get(name);
      if (shouldFullScan && !cached) continue;
      const ticker = tickerMap.get(name+'TRY') || tickerMap.get(name+'_TRY') || null;
      const analyzed = cached || await analyzeCandidate(name, ticker, bookMap);
      currentTracked.push(analyzed);
      analysisByName.set(name, analyzed);
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
    tracked = shouldFullScan ? sortByProfit(marketTop3).slice(0, TRACK_COUNT) : (previous.tracked || []).slice(0,TRACK_COUNT);
  }
  if (!shouldFullScan && analysisErrors.length) tracked = (previous.tracked || []).slice(0,TRACK_COUNT);

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
      for (const alert of positionAlerts) await markAlertSent(env, alert.type, alert.name);
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
    if (await alertAllowed(env, a.type, a.name)) allowed.push(a);
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

      const alert = buildPositionRiskAlert({name, price, stop, target, entry, highWater, pnl, pullback, remaining});
      if (alert && await alertAllowed(env, alert.type, name)) alerts.push(alert);
    } catch (e) {
      positions.push({ ...saved, name, entry, lastError:String(e?.message || e), checkedAt:new Date().toISOString() });
    }
  }
  return { positions, alerts };
}

function buildPositionRiskAlert({name, price, stop, target, entry, highWater, pnl, pullback, remaining}) {
  if (stop > 0 && price <= stop) {
    return {type:'POSITION_STOP',name,title:`🔴 ${name}/TRY — STOP / RİSK`,body:`Fiyat ${fmtPrice(price)} • stop ${fmtPrice(stop)} • K/Z ${fmtPct(pnl)}. Uygulamayı açıp pozisyonu kontrol et.`};
  }
  if (pnl > 0 && pullback >= 3) {
    return {type:'POSITION_GIVEBACK_3',name,title:`🔴 ${name}/TRY — KÂR GERİ VERME %${fmt2(pullback)}`,body:`Zirve ${fmtPrice(highWater)} • fiyat ${fmtPrice(price)} • K/Z ${fmtPct(pnl)}. Çıkış/koruma kararını kontrol et.`};
  }
  if (pnl >= 3 && pullback >= 2) {
    return {type:'POSITION_GIVEBACK_2',name,title:`🟠 ${name}/TRY — KÂRI KORU`,body:`Zirveden geri çekilme %${fmt2(pullback)} • K/Z ${fmtPct(pnl)}. Akıllı Satış V2 kararını kontrol et.`};
  }
  if (Number.isFinite(remaining) && remaining <= 0) {
    return {type:'POSITION_TARGET',name,title:`🎯 ${name}/TRY — TAHMİNİ DİRENÇ GELDİ`,body:`Fiyat ${fmtPrice(price)} • tahmini direnç ${fmtPrice(target)} • K/Z ${fmtPct(pnl)}.`};
  }
  if (Number.isFinite(remaining) && remaining <= 0.8) {
    return {type:'POSITION_TARGET_NEAR',name,title:`🟡 ${name}/TRY — DİRENCE ÇOK YAKIN`,body:`Tahmini dirence %${fmt2(Math.max(0,remaining))} kaldı • K/Z ${fmtPct(pnl)}.`};
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
          if (!(bid > 0) || !(ask > 0)) throw new Error('BID/ASK alanı eksik');
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

      const alert = buildPositionRiskAlert({name, price, stop, target, entry, highWater, pnl, pullback, remaining});
      if (alert && await alertAllowed(env, alert.type, name)) alerts.push(alert);
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
      for (const alert of alerts) await markAlertSent(env, alert.type, alert.name);
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

async function alertAllowed(env, type, name) {
  if (!env.COIN_KV) return true;
  const key = `${ALERT_MEMORY_KEY}:${type}:${name}`;
  const last = Number(await env.COIN_KV.get(key) || 0);
  return !(last && Date.now()-last < alertCooldownMs(type));
}

function alertCooldownMs(type) {
  const t = String(type || '');
  if (t === 'POSITION_STOP') return 5 * 60 * 1000;
  if (t === 'POSITION_GIVEBACK_3') return 10 * 60 * 1000;
  if (t === 'POSITION_GIVEBACK_2' || t === 'POSITION_TARGET') return 15 * 60 * 1000;
  if (t === 'POSITION_TARGET_NEAR') return 20 * 60 * 1000;
  return 90 * 60 * 1000;
}

async function markAlertSent(env, type, name) {
  if (!env.COIN_KV) return;
  const key = `${ALERT_MEMORY_KEY}:${type}:${name}`;
  await env.COIN_KV.put(key, String(Date.now()), { expirationTtl: 6*60*60 });
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
        await markAlertSent(env, alert.type, alert.name);
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
  const tickerMap = new Map(tickers.map(x => [String(x.symbol || x.s || ''), x]));
  return { scanned: top.length, metrics, tickerMap, bookMap };
}

async function analyzeCandidate(name, t24, bookMap = new Map()) {
  const [a,b] = await Promise.all([klines(name,'15m'), klines(name,'1h')]);
  const m = calc(a), h = calc(b);
  m.closedPrice = m.price;

  let ticker = t24;
  if (!ticker) {
    ticker = await ticker24(name).catch(() => ({}));
  }
  const bk = bookMap.get(name+'TRY') || bookMap.get(name+'_TRY') || {};
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
  const executionConfidence=Math.max(0,Math.min(1,(reach*.55+support*.25+liquidity*.20)/10));
  const expectedEdge=Math.max(0,upside1*executionConfidence-Math.max(0,sp));

  const eligible=!!p.hasResistance && upside1>=3 && signedDist>=0 && signedDist<=3 && rr>=1.30 && sp<=0.35 && !String(p.status||'').includes('DESTEK ALTI');
  return{score:Math.round(potScore*10)/10,upside1,upside2,rr,t1,t2,profitScore,reach,support,momentum,liquidity,expectedEdge:Math.round(expectedEdge*100)/100,dist,signedDist,eligible};
}

function tradePlan(k15,k1h,m,h){
  const price=m.price, A=atr(k15,14)||price*.006;
  const levelPrice=Number(m.closedPrice)||price;
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
  const horizontalHighs=[...highs15,...highs1].filter(Number.isFinite).sort((a,b)=>a-b);
  const crossedResistance=horizontalHighs.filter(x=>x<=levelPrice*1.002).sort((a,b)=>b-a)[0]||NaN;
  // Direnç ancak kapanmış mum onu geçtiğinde ileri taşınır; anlık iğne hedefi kaçırmaz.
  const resist=[...horizontalHighs,m.bollUp].filter(Number.isFinite).filter(x=>x>Math.max(levelPrice,zoneHigh)*1.002).sort((a,b)=>a-b);
  const hasResistance=resist.length>0;
  const t1=hasResistance?resist[0]:Math.max(price,zoneHigh)+2*(Math.max(price,zoneHigh)-stop);
  const t2=resist.find(x=>x>t1*1.006)||Math.max(t1*1.012,Math.max(price,zoneHigh)+3*(Math.max(price,zoneHigh)-stop));
  const entry=near?price:(zoneLow+zoneHigh)/2;
  const risk=Math.max(entry-stop,entry*.001), rr=(t1-entry)/risk;
  const status=bounce?'TEYİTLİ GİRİŞ':(near?'DESTEKTE — TEYİT BEKLE':dist>0?'DESTEĞE GERİ ÇEKİLME BEKLE':'DESTEK ALTI — GİRİŞ YAPMA');
  return{support,zoneLow,zoneHigh,dist,near,bounce,volOk,rsiOk,emaOk,macdOk,hourlyOk,stop,t1,t2,crossedResistance,entry,rr,hasResistance,status,atr:A};
}

function score(m,h,p){
  const d=Number(p?.dist??99), ad=Math.abs(d);
  // Tarayıcı ve Worker aynı 10 puanlık giriş modelini kullanır.
  let entryPts=0;
  if(p?.bounce)entryPts=3.0; else if(p?.near)entryPts=2.7; else if(d>=0&&d<=0.50)entryPts=2.4; else if(d<=1.0&&d>0)entryPts=2.0; else if(d<=1.75&&d>1.0)entryPts=1.3; else if(d<=2.5&&d>1.75)entryPts=.7; else if(d<0&&ad<=.75)entryPts=.4;
  const entry=Number(p?.entry||p?.support||m.price), target=Number(p?.t1);
  const upside=(Number.isFinite(target)&&Number.isFinite(entry)&&entry>0)?((target-entry)/entry*100):0;
  const profitPts=upside>=10?2:upside>=7?1.8:upside>=5?1.5:upside>=3?1.1:upside>0?Math.max(0,upside/3):0;
  const rr=Number(p?.rr||0), rrPts=rr>=3?1:rr>=2?.85:rr>=1.5?.65:rr>=1.3?.45:0;
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
  const ms=interval==='15m'?15*60*1000:60*60*1000, now=Date.now();
  return rows.filter(x=>{const open=+x[0], close=Number.isFinite(+x[6])?+x[6]:open+ms-1;return close<now-1500});
}

async function klines(name,interval){
  const clean=cleanBase(name);
  const urls=[
    `https://api.binance.me/api/v1/klines?symbol=${clean}TRY&interval=${interval}&limit=220`,
    `https://cloudme-tr.2meta.app/api/v1/klines?symbol=${clean}_TRY&interval=${interval}&limit=220`,
    `https://cloudme-tr.2meta.app/api/v1/klines?symbol=${clean}TRY&interval=${interval}&limit=220`
  ];
  const j=await fetchJsonAny(urls);
  const raw=Array.isArray(j)?j:j?.data;
  const d=Array.isArray(raw)?closedKlines(raw,interval):[];
  if(d.length<=50)throw new Error(`${clean}/TRY ${interval} kapanmış mum verisi yetersiz.`);
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
  const critical=alerts.some(a=>String(a?.type||'').startsWith('POSITION_'));
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
    const stop = Number(p.stop), t1 = Number(p.t1), t2 = Number(p.t2);
    if (!Number.isFinite(buy) || !(stop > 0) || !(t1 > 0)) continue;
    result.push({
      name,
      buy,
      candidate:clampNumber(row?.candidate,0,100,0),
      spread:clampNumber(row?.spread,0,100,99),
      ch:clampNumber(row?.ch,-1000,1000,0),
      p:{
        status:String(p.status || '').slice(0,120),
        dist:clampNumber(p.dist,-1000,1000,99),
        near:Boolean(p.near), bounce:Boolean(p.bounce), hasResistance:Boolean(p.hasResistance),
        stop, t1, t2:Number.isFinite(t2)&&t2>0?t2:t1,
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

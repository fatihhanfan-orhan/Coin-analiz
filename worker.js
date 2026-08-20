// Coin Analiz V5.1 FINAL Worker — 15dk + 1saat gerçek arka plan push
const BINANCE_24H_URLS = [
  'https://api.binance.me/api/v3/ticker/24hr',
  'https://cloudme-tr.2meta.app/api/v1/ticker/24hr'
];

const BINANCE_BOOK_URLS = [
  'https://api.binance.me/api/v3/ticker/bookTicker',
  'https://cloudme-tr.2meta.app/api/v1/ticker/bookTicker'
];

const TOP_N = 32;
const TRACK_COUNT = 3;
const STATE_KEY = 'coin-analiz-state-v2';
const ALERT_MEMORY_KEY = 'coin-analiz-alert-memory-v1';
const POSITION_COOLDOWN_MS = 90 * 60 * 1000;
const MIN_AUTO_UPSIDE_PCT = 3;
const MIN_AUTO_RR = 1.30;
const MAX_SAFE_SPREAD_PCT = .35;
const MIN_QUOTE_LIQUIDITY_TRY = 1000000;
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
          service: 'Coin Analiz Worker V4.6 — 7/24 Bildirim',
          version: '4.6-WORKER-PROFIT-4H',
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
        if (!names.length) {
          const previous = await loadState(env);
          const next = {
            ...previous,
            tracked: [],
            trackedSource: 'web-selection',
            source: 'web-selection',
            updatedAt: new Date().toISOString()
          };
          await saveState(env, next);
          return json({ ok:true, tracked: [], updatedAt: next.updatedAt });
        }

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
    // Önerilen Cron: */15 * * * *
    // Her tetikte takip edilen coinlerde uygun pozisyon kontrolü.
    // Saat başında saatlik özet; 4 saatte bir tam 32 coin taraması.
    const hourly = minute === 0;
    const fourHourly = hourly && (hour % 4 === 0);
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
    marketTop3 = eligible.slice(0, TRACK_COUNT);
  }

  // Takip listesindeki coinleri her cron tetiklenmesinde (önerilen 15 dk) yeniden analiz et.
  const currentTracked = [];
  for (const old of (previous.tracked || []).slice(0, TRACK_COUNT)) {
    const name = cleanBase(old?.name || old?.symbol || '');
    if (!name) continue;
    try { currentTracked.push(stabilizeWorkerDecision(await analyzeCandidate(name, null, market?.bookMap || new Map()),old)); }
    catch {}
  }

  let tracked;
  if (currentTracked.length) {
    // Web sayfasının seçtiği coinleri değiştirme; sadece kâr potansiyeline göre sırala.
    tracked = sortByProfit(currentTracked).slice(0, TRACK_COUNT);
  } else {
    // Otomatik bulunan fırsatlar takip listesine kendiliğinden eklenmez.
    tracked = [];
  }

  const positionAlerts = opts.notify ? await buildPositionAlerts(env, previous.tracked || [], tracked) : [];
  if (positionAlerts.length) await sendOneSignal(env, positionAlerts);

  // 15 dk analiz devam eder; aynı yaşam döngüsü durumu için periyodik özet push gönderilmez.

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

function stabilizeWorkerDecision(current,previous){
  const next=current?.decision||'BEKLE',old=previous?.decision,fatal=next==='FIRSAT BOZULDU'||next==='GEÇ KALINDI';
  if(!old||fatal||old===next)return{...current,decision:next,decisionPending:null,decisionPendingCount:0};
  const samePending=previous?.decisionPending===next,count=samePending?Number(previous?.decisionPendingCount||0)+1:1;
  if(count>=2)return{...current,decision:next,decisionPending:null,decisionPendingCount:0};
  return{...current,decision:old,rawDecision:next,decisionPending:next,decisionPendingCount:count};
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
  for (const x of nowList) {
    const old=prev.get(x.name),state=old?(x.decision||'TAKİPTE'):'TAKİPTE',oldState=old?.decision||null,allowed=new Set(['TAKİPTE','HAZIRLAN','ERKEN GİRİŞ','TEYİTLİ GİRİŞ','FIRSAT BOZULDU']);
    if(!allowed.has(state)||oldState===state)continue;
    candidates.push({type:`ENTRY_STATE_${state}`,name:x.name,title:`Coin Analiz • ${state}`,body:`${x.name}/TRY • AL ${fmt1(x.buy)}/10 • gerçek D1 alanı +${fmt2(x.rpot?.upside1)}% • desteğe ${fmtPct(x.p?.dist)}`});
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
  const [tickers, books, wind] = await Promise.all([all24hTickers(), allBookTickers(), marketWind()]);
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
      try { return await analyzeCandidate(name, t, bookMap, wind); }
      catch { return null; }
    }));
    metrics.push(...got.filter(Boolean));
  }

  if (metrics.length < 3) throw new Error('Yeterli TRY coin verisi alınamadı.');
  assignCandidateScores(metrics);
  return { scanned: top.length, metrics, bookMap };
}

async function analyzeCandidate(name, t24, bookMap = new Map(), windInput) {
  const [a,b] = await Promise.all([klines(name,'15m'), klines(name,'1h')]);
  const m = attachFlowContext(calc(a),a), h = calc(b);

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
  const closedPrice = m.price;
  m.price = num(ticker,'lastPrice','c') || mid || closedPrice;
  m.change = closedPrice>0 ? (m.price/closedPrice-1)*100 : 0;
  const vRatio = m.vma5 ? m.vol/m.vma5 : 0;
  const impulse = m.vma10 ? m.vma5/m.vma10 : 0;
  const vola = volatility15(a);
  const trend = (m.ema9>m.ema21?1:0)+(h.ema9>h.ema21?1:0)+(m.macd>m.signal?1:0)+(m.hist>m.prevHist?1:0);
  const p = tradePlan(a,b,m,h);
  const wind=windInput||await marketWind(),risk=buildRiskContext(m,p,wind),adjusted=contextAdjustedScore(score(m,h,p),m,risk);
  const out = { name,qv,ch,spread,vRatio,impulse,vola,trend,buy:adjusted.buy,m,h,p,risk,contextAdjustment:adjusted.contextAdjustment };
  out.rpot = resistancePotential(out);
  const tickerSymbol=String(ticker?.symbol||ticker?.s||'').replace('_','');
  out.gate = hardGate({dataFresh:true,activeTry:tickerSymbol===name+'TRY',spread,qv,p,upside:out.rpot.upside1,...risk});
  out.decision = rawDecision(p,out.gate,out.rpot.upside1);
  out.quality = qualityClass(out.buy,p,out.gate);
  out.rpot.eligible = out.gate.passed && p.hasResistance && p.dist>=0 && p.dist<=3;
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

  const eligible=!!p.hasResistance && upside1>=MIN_AUTO_UPSIDE_PCT && signedDist>=0 && signedDist<=3 && rr>=MIN_AUTO_RR && sp<=MAX_SAFE_SPREAD_PCT && !p.closeBreak;
  return{score:Math.round(potScore*10)/10,upside1,upside2,rr,t1,t2,profitScore,reach,dist,signedDist,eligible};
}

function hardGate(input={}){
  const p=input.p||{},reasons=[],checks={},unknowns=[];
  const add=(key,pass,reason)=>{checks[key]={pass:Boolean(pass),reason};if(!pass)reasons.push(reason);};
  add('fresh',input.dataFresh===true,'Canlı veri bayat veya doğrulanamadı');
  add('activeTry',input.activeTry===true,'Aktif Binance TR TRY paritesi doğrulanamadı');
  add('spread',Number.isFinite(input.spread)&&input.spread>=0&&input.spread<=MAX_SAFE_SPREAD_PCT,`Spread güvenli değil (maks. %${MAX_SAFE_SPREAD_PCT})`);
  add('liquidity',Number(input.qv)>=MIN_QUOTE_LIQUIDITY_TRY,`24s TRY likiditesi ${MIN_QUOTE_LIQUIDITY_TRY} altında`);
  const entry=Number(p.entry),stop=Number(p.stop),riskPct=entry>0&&stop>0?((entry-stop)/entry*100):NaN;
  add('technicalStop',Number.isFinite(stop)&&stop>0&&stop<entry&&riskPct>=.15&&riskPct<=8,'Teknik stop güvenilir değil');
  add('profitArea',Number(input.upside)>=MIN_AUTO_UPSIDE_PCT,`D1 kâr alanı %${MIN_AUTO_UPSIDE_PCT} altında`);
  add('riskReward',Number.isFinite(p.rr)&&p.rr>=MIN_AUTO_RR,`Risk/kazanç 1:${MIN_AUTO_RR.toFixed(2)} altında`);
  add('support',!p.closeBreak&&Number.isFinite(p.support)&&p.support>0&&Number(p.zoneLow)>0,'Destek kapanışla kırılmış veya geçersiz');
  const monitoring=input.monitoring||{status:'UNKNOWN'};if(monitoring.status==='UNKNOWN')unknowns.push('MONITORING STATUS: UNKNOWN');add('monitoring',monitoring.status!=='VERIFIED_TAG','Doğrulanmış Binance Monitoring Tag riski');
  const official=input.official||{status:'UNKNOWN'};if(official.status==='UNKNOWN')unknowns.push('RESMÎ OLAY: UNKNOWN');add('officialRisk',official.status!=='VERIFIED_SERIOUS','Doğrulanmış ciddi resmî olay riski');
  add('shockProtection',input.shockCritical!==true,'Şok Koruması: coin düşüşü + yüksek hacim + destek kırılımı + piyasa eşliği');
  return{passed:reasons.length===0,reasons,checks,unknowns,checkedAt:Date.now()};
}

function rawDecision(p,gate,upside){
  if(!gate.passed){if(Number(p.dist)>3||(!gate.checks.profitArea.pass&&Number(p.dist)>1.5))return 'GEÇ KALINDI';return 'FIRSAT BOZULDU';}
  if(p.closeBreak)return 'FIRSAT BOZULDU';
  if(Number(p.dist)>3.25)return 'GEÇ KALINDI';
  const structural=Boolean(p.reclaim||p.retest||p.higherLow||p.wickBreak);
  if(p.bounce&&p.bonusCount>=3)return 'TEYİTLİ GİRİŞ';
  if(structural&&p.earlyCount>=4)return 'ERKEN GİRİŞ';
  if((p.near||structural)&&p.earlyCount>=3)return 'HAZIRLAN';
  if(p.earlyCount>=2&&Number(upside)>=MIN_AUTO_UPSIDE_PCT)return 'DİP ADAYI';
  return 'BEKLE';
}

function qualityClass(scoreValue,p,gate){
  if(!gate?.passed)return 'UYGUN DEĞİL';const b=Number(scoreValue||0),rr=Number(p?.rr||0),early=Number(p?.earlyCount||0),bonus=Number(p?.bonusCount||0);
  if(b>=8.3&&rr>=3&&early>=5&&bonus>=3)return 'A++';
  if(b>=7.3&&(rr>=2||early>=4))return 'A+';
  return 'A';
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

  const c=k15.map(x=>+x[4]),rsi15=rsiSeries(c),last=k15.at(-1),prev=k15.at(-2),prev2=k15.at(-3);
  const lo=+last[3],hi=+last[2],op=+last[1],cl=+last[4],pcl=+prev[4],pop=+prev[1],plo=+prev[3],p2lo=+prev2[3],tol=Math.max(A*.10,support*.001);
  const closeBreak=cl<zoneLow-tol&&pcl<zoneLow,wickBreak=lo<zoneLow-tol&&cl>=zoneLow,reclaim=pcl<zoneLow&&cl>zoneHigh,retest=(reclaim||(pcl>zoneHigh&&+prev2[4]<=zoneHigh))&&lo<=zoneHigh+tol&&cl>=zoneHigh;
  const recentLows=lows15.slice(-3),higherLow=recentLows.length>=2?recentLows.at(-1)>recentLows.at(-2)*1.001:(lo>plo&&plo<=p2lo);
  const supportState=closeBreak?'DESTEK KIRILDI — KAPANIŞ':reclaim?'RECLAIM':retest?'RETEST':wickBreak?'FİTİL/SWEEP — DESTEK KORUNDU':higherLow?'HIGHER-LOW':'DESTEK GEÇERLİ';
  const body=Math.abs(cl-op),lowerWick=Math.max(0,Math.min(op,cl)-lo),lowerWickRejection=lowerWick>Math.max(body*1.25,A*.12)&&cl>lo,redBody=x=>Math.max(0,+x[1]-+x[4]),sellingPressureFading=redBody(last)<redBody(prev)&&redBody(prev)<=redBody(prev2)*1.25,firstGreen=cl>op&&pcl<=pop,rsiRecovery=Number.isFinite(rsi15.at(-2))&&m.rsi>rsi15.at(-2)+.35,emaMacdRecovery=m.hist>m.prevHist||(m.price>=m.ema9&&pcl<m.ema9);
  const volOk=Number.isFinite(m.vma5)&&m.vma5>0&&m.vol>=m.vma5*.80&&m.volumeDirection!=='SATIŞ YÖNLÜ',rsiOk=m.rsi>=40&&m.rsi<=70,emaOk=m.ema9>=m.ema21&&m.price>=m.ema9,macdOk=m.macd>=m.signal&&m.hist>m.prevHist,hourlyOk=h.ema9>=h.ema21||h.hist>h.prevHist;
  const earlySignals={supportNear:near||Math.abs(dist)<=1,sweepReclaim:wickBreak||reclaim,higherLow,retest,lowerWickRejection,sellingPressureFading,firstGreen,rsiRecovery,emaMacdRecovery,volumeSupport:volOk},earlyCount=Object.values(earlySignals).filter(Boolean).length;
  const bonusSignals={emaTrend:emaOk,macdConfirm:macdOk,hourlyTrend:hourlyOk,rsiHealthy:rsiOk,volumeStrong:m.vol>=m.vma5&&m.volumeDirection!=='SATIŞ YÖNLÜ'},bonusCount=Object.values(bonusSignals).filter(Boolean).length,bounce=!closeBreak&&(near||reclaim||retest)&&earlyCount>=4;

  const stop=Math.max(0,zoneLow-Math.max(A*.65,support*.0035));
  const allRes=[...highs15,...highs1,m.bollUp].filter(Number.isFinite).filter(x=>x>support*1.002).sort((a,b)=>a-b),uniqueRes=allRes.filter((x,i,a)=>i===0||Math.abs(x-a[i-1])/x>.0015),priorResistance=uniqueRes.filter(x=>x<cl).at(-1),resistanceWickBreak=Number.isFinite(priorResistance)&&hi>priorResistance*1.001&&cl<=priorResistance,resistanceCloseBreak=Number.isFinite(priorResistance)&&cl>priorResistance*1.001,resistanceRetest=resistanceCloseBreak&&lo<=priorResistance*1.003&&cl>=priorResistance,baseForTargets=Math.max(price,zoneHigh,Number.isFinite(priorResistance)&&resistanceCloseBreak?priorResistance:0),resist=uniqueRes.filter(x=>x>baseForTargets*1.002);
  const hasResistance=resist.length>0,t1=hasResistance?resist[0]:NaN,t2=resist.find(x=>x>t1*1.006)||NaN,resistanceState=resistanceCloseBreak?(resistanceRetest?'D1 KAPANIŞLA KIRILDI — RETEST':'D1 KAPANIŞLA KIRILDI — YENİ D1 AKTİF'):resistanceWickBreak?'D1 FİTİLİ — KIRILIM DEĞİL':'D1 GEÇERLİ';
  const entry=near?price:(zoneLow+zoneHigh)/2;
  const risk=entry-stop,rr=Number.isFinite(t1)&&risk>0?(t1-entry)/risk:NaN,status=closeBreak?'FIRSAT BOZULDU':bounce&&bonusCount>=3?'TEYİTLİ GİRİŞ':bounce?'ERKEN GİRİŞ':near?'HAZIRLAN':dist>3?'GEÇ KALINDI':'DİP ADAYI';
  return{support,zoneLow,zoneHigh,dist,near,bounce,volOk,rsiOk,emaOk,macdOk,hourlyOk,stop,t1,t2,entry,rr,hasResistance,status,supportState,closeBreak,wickBreak,reclaim,retest,higherLow,earlySignals,earlyCount,bonusSignals,bonusCount,priorResistance,resistanceWickBreak,resistanceCloseBreak,resistanceRetest,resistanceState};
}

function score(m,h,p){
  const d=Number(p?.dist??99), ad=Math.abs(d);
  let entryPts=0;
  if(p?.bounce)entryPts=3.0; else if(p?.near)entryPts=2.7; else if(d>=0&&d<=0.50)entryPts=2.4; else if(d<=1.0&&d>0)entryPts=2.0; else if(d<=1.75&&d>1.0)entryPts=1.3; else if(d<=2.5&&d>1.75)entryPts=.7; else if(d<0&&ad<=.75)entryPts=.4;
  const entry=Number(p?.entry||p?.support||m.price),target=Number(p?.t1),upside=Number.isFinite(target)&&Number.isFinite(entry)&&entry>0?((target-entry)/entry*100):0;
  const profitPts=upside>=10?2:upside>=7?1.8:upside>=5?1.5:upside>=3?1.1:upside>0?Math.max(0,upside/3):0,rr=Number(p?.rr||0),rrPts=rr>=3?1:rr>=2?.85:rr>=1.5?.65:rr>=1.3?.45:0,volPts=(m.vol>m.vma5?.65:.2)+(m.vma5>m.vma10?.35:0),trendPts=(m.ema9>m.ema21?.55:0)+(h.ema9>h.ema21?.65:0)+(m.price>m.ema9?.30:0),momentumPts=(m.rsi>=45&&m.rsi<=66?.45:m.rsi>72?0:.20)+(m.macd>m.signal?.55:0)+(m.hist>m.prevHist?.50:0);
  let b=Math.round(Math.max(0,Math.min(10,entryPts+profitPts+rrPts+volPts+trendPts+momentumPts))*10)/10,sell=0;
  if(m.rsi>72)sell+=2;if(m.macd<m.signal)sell+=1.5;if(m.hist<m.prevHist)sell+=1;if(m.price<m.ema9)sell+=1;if(h.ema9<h.ema21)sell+=1;if(d<-.75)sell+=2;if(upside<=.5)sell+=1.5;
  if(p && !p.near && d>1.75)b=Math.min(b,6.9);
  if(p && !p.near && d>2.5)b=Math.min(b,5.9);
  if(p && p.closeBreak)b=Math.min(b,4.9);
  if(p && !p.bounce)b=Math.min(b,7.4);
  if(p && !p.hasResistance)b=Math.min(b,6.9);
  if(upside<3)b=Math.min(b,6.8);
  return{buy:b,sell:Math.round(Math.min(10,sell)*10)/10,upside:Math.round(upside*100)/100,profitPts:Math.round(profitPts*10)/10};
}

function calc(k){
  const c=k.map(x=>+x[4]),v=k.map(x=>+x[5]),i=c.length-1;
  const E9=emaSeries(c,9),E21=emaSeries(c,21),E50=emaSeries(c,50),R=rsiSeries(c),M12=emaSeries(c,12),M26=emaSeries(c,26);
  const macd=M12.map((x,j)=>x-M26[j]),sig=emaSeries(macd,9),hist=macd.map((x,j)=>x-sig[j]);
  const ma5=sma(v,5),ma10=sma(v,10),mid=sma(c,20),sd=stdev(c.slice(-20));
  const quote=+k[i][7]||0,buyQuote=+k[i][10]||0,netQuote=buyQuote-(quote-buyQuote),flowRatio=quote>0?netQuote/quote:NaN,volRatio=ma5[i]>0?v[i]/ma5[i]:0;
  return{price:c[i],vol:v[i],vma5:ma5[i],vma10:ma10[i],volRatio,volumeStrength:volumeStrength(volRatio),volumeDirection:Number.isFinite(flowRatio)?flowDirection(flowRatio):'VERİ YOK',quoteVolume:quote,takerBuyQuote:buyQuote,netQuote,flowRatio,ema9:E9[i],ema21:E21[i],ema50:E50[i],rsi:R[i],macd:macd[i],signal:sig[i],hist:hist[i],prevHist:hist[i-1],bollMid:mid[i],bollUp:mid[i]+2*sd,bollDn:mid[i]-2*sd,change:(c[i]/c[i-1]-1)*100};
}

function volumeStrength(r){return r<.65?'ZAYIF':r<1.10?'NORMAL':r<1.80?'GÜÇLÜ':'ÇOK GÜÇLÜ';}
function flowDirection(r){return r>.08?'ALIM YÖNLÜ':r<-.08?'SATIŞ YÖNLÜ':'NÖTR';}
function klineFlow(k,count,label){const rows=k.slice(-count),quote=rows.reduce((s,x)=>s+(+x[7]||0),0),buy=rows.reduce((s,x)=>s+(+x[10]||0),0),net=buy-(quote-buy),ratio=quote>0?net/quote:NaN;return{status:quote>0?'REAL':'VERİ YOK',label,quote,buy,sell:quote-buy,net,ratio,direction:Number.isFinite(ratio)?flowDirection(ratio):'VERİ YOK',source:quote>0?'BINANCE_TR_KLINE_TAKER_QUOTE':null};}
function attachFlowContext(m,k15){m.closedChange15=m.change;m.flow={m15:klineFlow(k15,1,'15 dk'),m30:klineFlow(k15,2,'30 dk'),h1:klineFlow(k15,4,'1 saat')};m.orderFlow={status:'VERİ YOK',reason:'Arka plan taramasında birleşik işlem örneklemi alınmaz',source:null,windows:{}};return m;}
let marketWindMemo={at:0,value:null,promise:null};
function marketLeg(k){const m=calc(k),last=k.at(-1),prev=k.at(-2),h1=k.at(-5);return{change15:+prev[4]>0?(+last[4]/+prev[4]-1)*100:0,change1h:+h1[4]>0?(+last[4]/+h1[4]-1)*100:0,volumeStrength:m.volumeStrength,volumeRatio:m.volRatio};}
async function marketWind(){if(marketWindMemo.value&&Date.now()-marketWindMemo.at<60000)return marketWindMemo.value;if(marketWindMemo.promise)return marketWindMemo.promise;marketWindMemo.promise=(async()=>{try{const [btc,eth]=await Promise.all([klines('BTC','15m'),klines('ETH','15m')]),b=marketLeg(btc),e=marketLeg(eth),shock=b.change15<=-1.2&&e.change15<=-1.2&&(b.volumeRatio>=1.25||e.volumeRatio>=1.25),value={status:'REAL',source:'BINANCE_TR_KLINE',btc:b,eth:e,shock,dominance:{status:'UNKNOWN'}};marketWindMemo={at:Date.now(),value,promise:null};return value;}catch(e){const value={status:'VERİ YOK',source:null,shock:false,dominance:{status:'UNKNOWN'},reason:e.message};marketWindMemo={at:Date.now(),value,promise:null};return value;}})();return marketWindMemo.promise;}
function buildRiskContext(m,p,wind){const f=m.flow?.m15,distribution=m.change>0&&f?.status==='REAL'&&f.net<0,confluence=false,coinShock=Number(m.closedChange15)<=-2&&['GÜÇLÜ','ÇOK GÜÇLÜ'].includes(m.volumeStrength)&&p.closeBreak,shockCritical=Boolean(coinShock&&wind?.status==='REAL'&&wind.shock);let riskScore=distribution?2:0;if(coinShock)riskScore+=2;if(shockCritical)riskScore+=4;return{monitoring:{status:'UNKNOWN'},official:{status:'UNKNOWN'},category:{status:'UNKNOWN'},marketWind:wind||{status:'VERİ YOK',dominance:{status:'UNKNOWN'}},distribution,confluence,largeNet:NaN,riskScore,coinShock,shockCritical};}
function contextAdjustedScore(base,m,risk){let adjustment=0,f=m.flow?.m15;if(f?.status==='REAL')adjustment+=f.ratio>.08?.35:f.ratio<-.08?-.45:0;if(risk?.distribution)adjustment-=.65;if(risk?.shockCritical)adjustment-=1.5;return{...base,buy:Math.round(Math.max(0,Math.min(10,base.buy+adjustment))*10)/10,contextAdjustment:Math.round(adjustment*100)/100,riskScore:risk?.riskScore||0};}

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
      url:notificationAppUrl(env)
    })
  });
  if(!r.ok)throw new Error(`OneSignal ${r.status}: ${await r.text()}`);
}
function notificationAppUrl(env){const fallback='https://fatihhanfan-orhan.github.io/Coin-analiz/';try{const u=new URL(env.APP_URL||fallback);if(!/^https:$/.test(u.protocol))return fallback;u.hash='';return u.href}catch{return fallback}}

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

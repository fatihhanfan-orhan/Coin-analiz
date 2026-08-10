const BINANCE = "https://api.binance.com/api/v3";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/test") {
      const result = await scan(env, false);
      return Response.json(result);
    }

    return new Response("Coin Analiz 7/24 Worker aktif", {
      headers: { "content-type": "text/plain; charset=UTF-8" }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scan(env, true));
  }
};

async function scan(env, sendNotifications = true) {
  const coins = (env.COINS || "BTCUSDT,ETHUSDT,SOLUSDT")
    .split(",")
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);

  const results = [];

  for (const symbol of coins) {
    try {
      const result = await analyse(symbol);
      results.push(result);

      if (
        sendNotifications &&
        result.buyScore >= 8.5 &&
        result.rewardPct >= 3 &&
        result.rr >= 1.3
      ) {
        await notify(env, result);
      }
    } catch (e) {
      results.push({
        symbol,
        error: e?.message || String(e)
      });
    }
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    threshold: 8.5,
    results
  };
}

async function analyse(symbol) {
  const [k15, k1h] = await Promise.all([
    klines(symbol, "15m", 120),
    klines(symbol, "1h", 100)
  ]);

  const close15 = k15.map(x => +x[4]);
  const high15 = k15.map(x => +x[2]);
  const low15 = k15.map(x => +x[3]);
  const vol15 = k15.map(x => +x[5]);
  const close1h = k1h.map(x => +x[4]);

  const price = last(close15);

  const support = Math.min(...low15.slice(-24));
  const resistance = Math.max(...high15.slice(-24));

  const supportDistancePct =
    ((price - support) / price) * 100;

  const rewardPct =
    ((resistance - price) / price) * 100;

  const riskPct =
    Math.max(((price - support) / price) * 100, 0.15);

  const rr = rewardPct / riskPct;

  const ema9 = EMA(close15, 9);
  const ema21 = EMA(close15, 21);

  const ema9h = EMA(close1h, 9);
  const ema21h = EMA(close1h, 21);

  const rsi = RSI(close15, 14);

  const macdFast = EMA(close15, 12);
  const macdSlow = EMA(close15, 26);
  const macd = macdFast - macdSlow;

  const volumes = vol15.slice(-21, -1);
  const avgVol =
    volumes.reduce((a, b) => a + b, 0) /
    Math.max(volumes.length, 1);

  const volumeRatio =
    avgVol > 0 ? last(vol15) / avgVol : 0;

  let score = 0;

  // GİRİŞ NOKTASI: toplam 4 puan
  if (supportDistancePct <= 0.5) score += 2.0;
  else if (supportDistancePct <= 1) score += 1.6;
  else if (supportDistancePct <= 1.5) score += 1.1;
  else if (supportDistancePct <= 2) score += 0.5;

  if (rewardPct >= 5) score += 1.2;
  else if (rewardPct >= 4) score += 1.0;
  else if (rewardPct >= 3) score += 0.7;

  if (rr >= 2) score += 0.8;
  else if (rr >= 1.5) score += 0.6;
  else if (rr >= 1.3) score += 0.4;

  // 15 DK TREND
  if (price > ema9 && ema9 > ema21) score += 1.5;
  else if (price > ema21) score += 0.7;

  // 1 SAAT TEYİDİ
  if (last(close1h) > ema9h && ema9h > ema21h)
    score += 1.5;
  else if (last(close1h) > ema21h)
    score += 0.7;

  // RSI
  if (rsi >= 45 && rsi <= 65) score += 1.0;
  else if (rsi >= 40 && rsi < 70) score += 0.5;

  // MACD
  if (macd > 0) score += 1.0;

  // HACİM
  if (volumeRatio >= 1.5) score += 1.0;
  else if (volumeRatio >= 1.15) score += 0.5;

  const buyScore =
    Math.min(10, Math.round(score * 10) / 10);

  return {
    symbol,
    price,
    support,
    resistance

const BINANCE_ENDPOINTS = [
  "https://data-api.binance.vision/api/v3",
  "https://api-gcp.binance.com/api/v3",
  "https://api1.binance.com/api/v3",
  "https://api2.binance.com/api/v3",
  "https://api3.binance.com/api/v3",
  "https://api4.binance.com/api/v3"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/scan") {
      const results = await scan(env, false);
      return Response.json(results);
    }

    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json({
        ok: true,
        service: "Coin Analiz Worker",
        oneSignalAppIdConfigured: Boolean(env.ONESIGNAL_APP_ID),
        oneSignalApiKeyConfigured: Boolean(env.ONESIGNAL_API_KEY),
        cronCoins: (env.COINS || "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map(x => x.trim()).filter(Boolean)
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scan(env, true));
  }
};

async function scan(env, sendNotification = false) {
  const coins = (env.COINS || "BTCUSDT,ETHUSDT,SOLUSDT")
    .split(",")
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);

  const results = [];

  for (const symbol of coins) {
    try {
      const result = await analyze(symbol);
      results.push(result);

      if (
        sendNotification &&
        result.buyScore >= 8.5
      ) {
        await sendOneSignal(env, result);
      }
    } catch (error) {
      results.push({
        symbol,
        error: String(error.message || error)
      });
    }
  }

  return results;
}

async function analyze(symbol) {
  const k15 = await klines(symbol, "15m", 120);
  const k1h = await klines(symbol, "1h", 80);

  const close15 = k15.map(x => Number(x[4]));
  const close1h = k1h.map(x => Number(x[4]));
  const volumes = k15.map(x => Number(x[5]));

  const price = last(close15);

  const ema9 = ema(close15, 9);
  const ema21 = ema(close15, 21);

  const ema9h = ema(close1h, 9);
  const ema21h = ema(close1h, 21);

  const rsiValue = rsi(close15, 14);
  const macdValue = macd(close15);

  const recentVolume = avg(volumes.slice(-5));
  const previousVolume = avg(volumes.slice(-10, -5));
  const volumeRatio =
    previousVolume > 0 ? recentVolume / previousVolume : 1;

  const lows = k15.slice(-30).map(x => Number(x[3]));
  const highs = k15.slice(-30).map(x => Number(x[2]));

  const support = Math.min(...lows);
  const resistance = Math.max(...highs);

  const supportDistancePct =
    ((price - support) / price) * 100;

  const rewardPct =
    ((resistance - price) / price) * 100;

  const riskPct =
    ((price - support) / price) * 100;

  const rr =
    riskPct > 0 ? rewardPct / riskPct : 0;

  let score = 0;

  // 15 DK TREND
  if (price > ema9 && ema9 > ema21) {
    score += 2.5;
  } else if (price > ema21) {
    score += 1;
  }

  // 1 SAAT TEYİDİ
  if (
    last(close1h) > ema9h &&
    ema9h > ema21h
  ) {
    score += 1.5;
  } else if (last(close1h) > ema21h) {
    score += 0.7;
  }

  // RSI
  if (rsiValue >= 45 && rsiValue <= 65) {
    score += 1.5;
  } else if (rsiValue >= 40 && rsiValue < 70) {
    score += 0.7;
  }

  // MACD
  if (macdValue > 0) {
    score += 1;
  }

  // HACİM
  if (volumeRatio >= 1.5) {
    score += 1;
  } else if (volumeRatio >= 1.15) {
    score += 0.5;
  }

  // DESTEK YAKINLIĞI
  if (supportDistancePct <= 2) {
    score += 1;
  }

  // RİSK / ÖDÜL
  if (rr >= 2) {
    score += 1.5;
  } else if (rr >= 1.5) {
    score += 1;
  }

  const buyScore =
    Math.min(10, Math.round(score * 10) / 10);

  return {
    symbol,
    price: round(price),
    support: round(support),
    resistance: round(resistance),
    supportDistancePct: round(supportDistancePct),
    rewardPct: round(rewardPct),
    riskPct: round(riskPct),
    rr: round(rr),
    rsi: round(rsiValue),
    volumeRatio: round(volumeRatio),
    buyScore
  };
}

async function klines(symbol, interval, limit) {
  const url =
    `${BINANCE}/klines?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&limit=${limit}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Binance ${symbol}: HTTP ${response.status}`
    );
  }

  return response.json();
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  let value = values[0];

  for (let i = 1; i < values.length; i++) {
    value =
      values[i] * multiplier +
      value * (1 - multiplier);
  }

  return value;
}

function rsi(values, period = 14) {
  let gains = 0;
  let losses = 0;

  const start = Math.max(1, values.length - period);

  for (let i = start; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function macd(values) {
  return ema(values, 12) - ema(values, 26);
}

function avg(values) {
  if (!values.length) return 0;

  return (
    values.reduce((sum, value) => sum + value, 0) /
    values.length
  );
}

function last(values) {
  return values[values.length - 1];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function sendOneSignal(env, result) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_API_KEY) {
    return;
  }

  const message =
    `${result.symbol} ALIM SİNYALİ\n` +
    `Puan: ${result.buyScore}/10\n` +
    `Fiyat: ${result.price}\n` +
    `RSI: ${result.rsi}\n` +
    `Hacim: ${result.volumeRatio}x`;

  const response = await fetch(
    "https://api.onesignal.com/notifications",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Key ${env.ONESIGNAL_API_KEY}`
      },
      body: JSON.stringify({
        app_id: env.ONESIGNAL_APP_ID,
        included_segments: ["Subscribed Users"],
        headings: {
          en: "Coin Analiz"
        },
        contents: {
          en: message
        }
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OneSignal: ${response.status} ${text}`);
  }
}

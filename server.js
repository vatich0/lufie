import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, istanbulDateKey } from './config.js';
import { getTrendyolMetrics, getTrendyolLines } from './trendyol.js';
import { getShopifyMetrics, getShopifyLines } from './shopify.js';
import { updateHistory, getSeries } from './history.js';
import { consolidateByColor } from './colors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// --- Basit şifre kapısı ---------------------------------------------------
// Şifre config.sitePassword (env SITE_PASSWORD, varsayılan "lufie"). Doğru şifre
// girilince imzalı bir çerez bırakılır; sonraki isteklerde çerez kontrol edilir.
const AUTH_COOKIE = 'lufie_auth';
const AUTH_TOKEN = crypto.createHash('sha256').update('lufie::' + config.sitePassword).digest('hex').slice(0, 32);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function loginPage(error) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>Lufie · Giriş</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0e1116;color:#f2f5f9;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;min-height:100vh;
display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#171b22;border:1px solid #2a313c;border-radius:16px;padding:32px;width:min(360px,100%);text-align:center}
h1{font-size:26px;letter-spacing:-.02em;margin-bottom:6px}h1 span{color:#4c9ffe}
p{color:#6b7482;font-size:14px;margin-bottom:22px}
input{width:100%;background:#1e242d;border:1px solid #2a313c;color:#f2f5f9;border-radius:10px;
padding:13px 14px;font-size:16px;margin-bottom:12px}
button{width:100%;background:#4c9ffe;color:#fff;border:none;border-radius:10px;padding:13px;
font-size:16px;font-weight:700;cursor:pointer}button:hover{filter:brightness(1.08)}
.err{color:#e5544b;font-size:14px;margin-bottom:12px}</style></head>
<body><form class="card" method="POST" action="/login">
<h1><span>Lufie</span> İmalat Panosu</h1><p>Devam etmek için şifre girin</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<input type="password" name="password" placeholder="Şifre" autofocus autocomplete="current-password"/>
<button type="submit">Giriş</button></form></body></html>`;
}

app.use(express.urlencoded({ extended: false }));

app.get('/login', (req, res) => res.send(loginPage(null)));
app.post('/login', (req, res) => {
  if ((req.body?.password || '') === config.sitePassword) {
    res.cookie(AUTH_COOKIE, AUTH_TOKEN, {
      httpOnly: true, sameSite: 'lax', path: '/',
      maxAge: 180 * 24 * 60 * 60 * 1000, // ~180 gün
    });
    return res.redirect('/');
  }
  res.status(401).send(loginPage('Şifre yanlış, tekrar deneyin.'));
});

// Kapı: /login ve /healthz hariç her şey şifre ister
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/healthz') return next();
  if (getCookie(req, AUTH_COOKIE) === AUTH_TOKEN) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

// Önbellek: veriyi arka planda tazeler, isteklere anında yanıt verir.
// (Tam çekim throttle nedeniyle 15-20 sn sürebildiği için pano beklememeli.)
let cache = { at: 0, data: null };
let refreshing = null;
const CACHE_MS = 45 * 1000;

async function buildDashboard() {
  const trendyolReady = config.trendyol.sellerId && config.trendyol.apiKey && config.trendyol.apiSecret;
  const shopifyReady = config.shopify.shop &&
    (config.shopify.token || (config.shopify.clientId && config.shopify.clientSecret));

  const result = {
    updatedAt: new Date().toISOString(),
    refreshSeconds: config.refreshSeconds,
    trendyol: null,
    shopify: null,
    errors: [],
    configured: { trendyol: Boolean(trendyolReady), shopify: Boolean(shopifyReady) },
  };

  const jobs = [];
  if (trendyolReady) {
    jobs.push(
      getTrendyolMetrics()
        .then((d) => { result.trendyol = d; })
        .catch((e) => { result.errors.push(`Trendyol: ${e.message}`); })
    );
  }
  if (shopifyReady) {
    jobs.push(
      getShopifyMetrics()
        .then((d) => { result.shopify = d; })
        .catch((e) => { result.errors.push(`Shopify: ${e.message}`); })
    );
  }
  await Promise.all(jobs);

  const rt = result.trendyol || {};
  const sh = result.shopify || {};
  result.totals = {
    receivedToday: (rt.receivedToday || 0) + (sh.receivedToday || 0),
    receivedUnits: (rt.receivedUnits || 0) + (sh.receivedUnits || 0),
    shippedToday: (rt.shippedToday || 0) + (sh.shippedToday || 0),
    shippedUnits: (rt.shippedUnits || 0) + (sh.shippedUnits || 0),
    openTotal: rt.openTotal || 0,
    openUnits: rt.openUnits || 0,
  };

  // Günlük geçmişi güncelle: bugünün tam snapshot'ı + geçmiş "gelen"in geç-doldurulması.
  // Trendyol verisi gelmediyse (hata) yanlış sıfırlar kaydetmemek için snapshot atlanır.
  try {
    const today = result.trendyol
      ? {
          date: istanbulDateKey(),
          receivedOrders: result.totals.receivedToday,
          receivedUnits: result.totals.receivedUnits,
          shippedOrders: result.totals.shippedToday,
          shippedUnits: result.totals.shippedUnits,
          openOrders: result.totals.openTotal,
          openUnits: result.totals.openUnits,
        }
      : null;
    // gün bazında gelen kırılımını Trendyol + Shopify birleştir
    const merged = new Map();
    for (const src of [rt.receivedByDay, sh.receivedByDay]) {
      for (const d of src || []) {
        const m = merged.get(d.date) || { date: d.date, orders: 0, units: 0 };
        m.orders += d.orders || 0;
        m.units += d.units || 0;
        merged.set(d.date, m);
      }
    }
    await updateHistory({ today, receivedByDay: [...merged.values()] });
  } catch (e) {
    result.errors.push(`Geçmiş kaydı: ${e.message}`);
  }
  result.history = await getSeries();

  return result;
}

function triggerRefresh() {
  if (refreshing) return refreshing;
  refreshing = buildDashboard()
    .then((data) => { cache = { at: Date.now(), data }; })
    .catch(() => {})
    .finally(() => { refreshing = null; });
  return refreshing;
}

app.get('/api/dashboard', async (req, res) => {
  const stale = !cache.data || Date.now() - cache.at >= CACHE_MS;
  if (stale) {
    const job = triggerRefresh();
    if (!cache.data) await job; // ilk yükleme: bitmesini bekle
  }
  res.json(cache.data);
});

// Renk / numara konsolidasyonu — tarih aralığındaki gelen siparişler
const DAY_MS = 24 * 60 * 60 * 1000;
function parseDayParam(str, fallbackMs, endOfDay) {
  const s = String(str || '');
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const base = ok ? Date.parse(`${s}T00:00:00+03:00`) : NaN;
  if (Number.isNaN(base)) return fallbackMs;
  return endOfDay ? base + DAY_MS - 1 : base;
}

app.get('/api/colors', async (req, res) => {
  const now = Date.now();
  let since = parseDayParam(req.query.from, now - 6 * DAY_MS, false);
  let until = parseDayParam(req.query.to, now, true);
  if (since > until) [since, until] = [until, since];
  // aralığı en fazla 92 günle sınırla (aşırı yükü önler)
  if (until - since > 92 * DAY_MS) since = until - 92 * DAY_MS;

  const trendyolReady = config.trendyol.sellerId && config.trendyol.apiKey && config.trendyol.apiSecret;
  const shopifyReady = config.shopify.shop &&
    (config.shopify.token || (config.shopify.clientId && config.shopify.clientSecret));

  const errors = [];
  const jobs = [];
  let tLines = [], sLines = [];
  if (trendyolReady) jobs.push(getTrendyolLines({ since, until }).then((d) => { tLines = d; }).catch((e) => errors.push(`Trendyol: ${e.message}`)));
  if (shopifyReady) jobs.push(getShopifyLines({ since, until }).then((d) => { sLines = d; }).catch((e) => errors.push(`Shopify: ${e.message}`)));
  await Promise.all(jobs);

  const data = consolidateByColor([...tLines, ...sLines]);
  res.json({
    from: istanbulDateKey(since),
    to: istanbulDateKey(until),
    configured: { trendyol: Boolean(trendyolReady), shopify: Boolean(shopifyReady) },
    errors,
    ...data,
  });
});

app.get('/renkler', (req, res) => res.sendFile(path.join(__dirname, 'public', 'renkler.html')));

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(config.port, () => {
  console.log(`Lufie imalat panosu çalışıyor: http://localhost:${config.port}`);
  console.log(`Trendyol yapılandırıldı: ${Boolean(config.trendyol.apiKey)}`);
  console.log(`Shopify yapılandırıldı: ${Boolean(config.shopify.token || (config.shopify.clientId && config.shopify.clientSecret))}`);
});

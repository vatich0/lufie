import { config, istanbulDayStart, istanbulDayEnd, addDays, istanbulDateKey } from './config.js';

const s = config.shopify;

function apiBase() {
  return `https://${s.shop}/admin/api/${s.apiVersion}`;
}

// Erişim token'ı yönetimi.
//  - Statik SHOPIFY_ACCESS_TOKEN (shpat_...) verilmişse doğrudan onu kullanır.
//  - Aksi halde client credentials ile Shopify'dan 24 saatlik token alır, önbelleğe
//    alır ve süresi dolmadan (60 sn pay) otomatik yeniler.
let tokenCache = { token: null, exp: 0 };

async function getAccessToken() {
  if (s.token) return s.token; // klasik statik token
  const now = Date.now();
  if (tokenCache.token && tokenCache.exp > now + 60_000) return tokenCache.token;

  const res = await fetch(`https://${s.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: s.clientId,
      client_secret: s.clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify token isteği ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 86399) * 1000 };
  return tokenCache.token;
}

async function shopifyGet(path, retry = true) {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  });
  // Yetki/onay değişince (401/403) önbellekteki eski token'ı at, bir kez taze token'la dene.
  // Böylece scope onaylanınca restart gerekmeden düzelir.
  if ((res.status === 401 || res.status === 403) && retry && !s.token) {
    tokenCache = { token: null, exp: 0 };
    return shopifyGet(path, false);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

// Link header'a göre sonraki sayfanın path'ini çıkarır (cursor pagination)
function nextPageInfo(res) {
  const link = res.headers.get('link') || '';
  const m = link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return m ? m[1] : null;
}

// Bir sorgunun tüm sayfalarını dolaşıp siparişleri toplar (cursor pagination)
async function fetchAllOrders(query) {
  const orders = [];
  let path = `/orders.json?${query}`;
  let guard = 0;
  while (path && guard < 20) {
    const res = await shopifyGet(path);
    for (const o of (await res.json()).orders || []) orders.push(o);
    const info = nextPageInfo(res);
    path = info ? `/orders.json?limit=250&page_info=${info}` : null;
    guard += 1;
  }
  return orders;
}

export async function getShopifyMetrics() {
  const now = new Date();
  const todayStartISO = istanbulDayStart(now).toISOString();
  const todayEndISO = istanbulDayEnd(now).toISOString();

  const dayStart = istanbulDayStart(now).getTime();
  const dayEnd = istanbulDayEnd(now).getTime();
  const lineUnits = (arr) => (arr || []).reduce((s, l) => s + (l.quantity || 0), 0);

  // 1) Gelen siparişler — son N gün, güne göre gruplu (bugün + geçmiş için geç-doldurma).
  //    line_items çekip hem sipariş sayısını hem ürün adedini tek geçişte buluruz.
  const days = config.historyDays;
  const rangeStartISO = istanbulDayStart(addDays(now, -(days - 1))).toISOString();
  const createdOrders = await fetchAllOrders(
    `status=any&created_at_min=${encodeURIComponent(rangeStartISO)}&created_at_max=${encodeURIComponent(todayEndISO)}&limit=250&fields=id,created_at,cancelled_at,line_items`
  );
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(istanbulDateKey(addDays(now, -i)));
  const validKey = new Set(dayKeys);
  const recvByKey = new Map();
  for (const o of createdOrders) {
    if (o.cancelled_at) continue; // iptal edilmiş siparişi gelen sayma
    const key = istanbulDateKey(new Date(o.created_at).getTime());
    if (!validKey.has(key)) continue;
    const units = lineUnits(o.line_items);
    if (units === 0) continue;
    const b = recvByKey.get(key) || { orders: 0, units: 0 };
    b.orders += 1;
    b.units += units;
    recvByKey.set(key, b);
  }
  const receivedByDay = dayKeys.map((date) => ({
    date,
    orders: recvByKey.get(date)?.orders || 0,
    units: recvByKey.get(date)?.units || 0,
  }));
  const todayRecv = recvByKey.get(istanbulDateKey(now)) || { orders: 0, units: 0 };
  const receivedToday = todayRecv.orders;
  const receivedUnits = todayRecv.units;

  // 2) Kargolanan — fulfillment (kargo) tarihine göre, SON N gün güne göre gruplu.
  //    Böylece grafik verisi API'den yeniden hesaplanabilir (snapshot kaybolsa geri gelir).
  const shipSinceISO = istanbulDayStart(addDays(now, -(days - 1))).toISOString();
  const shippedOrders = await fetchAllOrders(
    `status=any&fulfillment_status=shipped&updated_at_min=${encodeURIComponent(shipSinceISO)}&limit=250&fields=id,fulfillments`
  );
  const shipDayOrders = new Map(); // gün anahtarı -> Set(sipariş id) (aynı gün mükerrer saymamak için)
  const shipDayUnits = new Map(); // gün anahtarı -> ürün adedi
  for (const o of shippedOrders) {
    for (const f of o.fulfillments || []) {
      const key = istanbulDateKey(new Date(f.created_at).getTime());
      if (!validKey.has(key)) continue;
      if (!shipDayOrders.has(key)) shipDayOrders.set(key, new Set());
      shipDayOrders.get(key).add(o.id);
      shipDayUnits.set(key, (shipDayUnits.get(key) || 0) + lineUnits(f.line_items));
    }
  }
  const shippedByDay = dayKeys.map((date) => ({
    date,
    orders: shipDayOrders.get(date)?.size || 0,
    units: shipDayUnits.get(date) || 0,
  }));
  const todayShipKey = istanbulDateKey(now);
  const shippedToday = shipDayOrders.get(todayShipKey)?.size || 0;
  const shippedUnits = shipDayUnits.get(todayShipKey) || 0;

  // 3) Kargolanmamış (unfulfilled) açık siparişler — SON 30 GÜN.
  //    Hem toplam açık kuyruğu (sipariş + ürün) sayarız, hem "acil" etiketlileri listeleriz.
  //    (Daha eski takılı siparişlere bakmaya gerek yok.)
  const openSinceISO = istanbulDayStart(addDays(now, -30)).toISOString();
  const urgent = [];
  let openOrders = 0;
  let openUnits = 0;
  let path =
    `/orders.json?status=open&fulfillment_status=unfulfilled&created_at_min=${encodeURIComponent(openSinceISO)}&limit=250&fields=id,name,created_at,cancelled_at,tags,note,shipping_address,line_items`;
  let guard = 0;
  while (path && guard < 20) {
    const res = await shopifyGet(path);
    const orders = (await res.json()).orders || [];
    for (const o of orders) {
      if (o.cancelled_at) continue;
      openOrders += 1;
      // iade sonrası kalan adet (current_quantity yoksa quantity)
      openUnits += (o.line_items || []).reduce((sum, l) => sum + ((l.current_quantity != null ? l.current_quantity : l.quantity) || 0), 0);
      const tags = (o.tags || '').split(',').map((x) => x.trim().toLowerCase());
      if (tags.includes(s.urgentTag)) {
        urgent.push({
          name: o.name,
          createdAt: o.created_at,
          customer: o.shipping_address?.name || '',
          tags: o.tags,
          items: (o.line_items || []).map((l) => ({
            name: l.title || l.name || '—',
            variant: l.variant_title || '',
            sku: l.sku || '',
            quantity: (l.current_quantity != null ? l.current_quantity : l.quantity) || 0,
          })),
        });
      }
    }
    // Cursor sayfalamada (page_info) status/fulfillment_status/created_at gönderilemez;
    // yalnızca limit + fields taşınabilir.
    const info = nextPageInfo(res);
    path = info
      ? `/orders.json?limit=250&fields=id,name,created_at,cancelled_at,tags,note,shipping_address,line_items&page_info=${info}`
      : null;
    guard += 1;
  }
  urgent.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return { receivedToday, receivedUnits, receivedByDay, shippedToday, shippedUnits, shippedByDay, openTotal: openOrders, openUnits, urgent };
}

// Belirli tarih aralığında (created_at) gelen siparişlerin ürün satırlarını döndürür.
// İptal edilmiş siparişler hariç. Renk/numara konsolidasyonu için kullanılır.
export async function getShopifyLines({ since, until }) {
  const sinceISO = new Date(since).toISOString();
  const untilISO = new Date(until).toISOString();
  const orders = await fetchAllOrders(
    `status=any&created_at_min=${encodeURIComponent(sinceISO)}&created_at_max=${encodeURIComponent(untilISO)}&limit=250&fields=id,created_at,cancelled_at,line_items`
  );
  const out = [];
  for (const o of orders) {
    if (o.cancelled_at) continue; // tamamen iptal edilen sipariş
    for (const l of o.line_items || []) {
      // current_quantity = iade/iptal sonrası kalan gerçek adet (yoksa quantity)
      const qty = (l.current_quantity != null ? l.current_quantity : l.quantity) || 0;
      if (qty <= 0) continue; // tamamen iade edilen satırı gösterme
      out.push({
        sku: l.sku || '',
        size: l.variant_title || null,
        quantity: qty,
        platform: 'shopify',
      });
    }
  }
  return out;
}

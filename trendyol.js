import { config, istanbulDayStart, istanbulDayEnd, addDays, istanbulDateKey } from './config.js';

const t = config.trendyol;
const DAY = 24 * 60 * 60 * 1000;
// Trendyol sipariş sorgularında startDate–endDate aralığı ~2 haftayı geçemez.
const CHUNK_DAYS = 13;

function authHeader() {
  const basic = Buffer.from(`${t.apiKey}:${t.apiSecret}`).toString('base64');
  return {
    Authorization: `Basic ${basic}`,
    'User-Agent': `${t.sellerId} - SelfIntegration`,
    'Content-Type': 'application/json',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// İstekleri sıraya alıp aralarında en az MIN_GAP bekleterek Trendyol hız limitini korur.
// 429 gelirse artan bekleme ile tekrar dener.
const MIN_GAP = 700;
let chain = Promise.resolve();
let lastAt = 0;

function throttledFetch(url, opts) {
  const run = async () => {
    const wait = MIN_GAP - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(url, opts);
      if (res.status !== 429) break;
      await sleep(1500 * (attempt + 1)); // 1.5s, 3s, 4.5s
    }
    lastAt = Date.now();
    return res;
  };
  chain = chain.then(run, run);
  return chain;
}

// Tek bir tarih penceresi için tüm sayfaları toplar
async function fetchWindow({ status, startDate, endDate }) {
  const all = [];
  let page = 0;
  const size = 200;
  let totalPages = 1;
  let totalElements = 0;

  do {
    const params = new URLSearchParams({ page: String(page), size: String(size) });
    if (status) params.set('status', status);
    params.set('startDate', String(startDate));
    params.set('endDate', String(endDate));

    const url = `${t.baseUrl}/order/sellers/${t.sellerId}/orders?${params}`;
    const res = await throttledFetch(url, { headers: authHeader() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Trendyol API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    totalPages = data.totalPages ?? 1;
    totalElements = data.totalElements ?? (data.content?.length || 0);
    for (const o of data.content || []) all.push(o);
    page += 1;
    if (page >= 25) break; // güvenlik freni (pencere başına en fazla 5000 kayıt)
  } while (page < totalPages);

  return { orders: all, totalElements };
}

// [since, until] aralığını ≤13 günlük dilimlere bölerek sorgular, orderNumber'a göre tekilleştirir
async function fetchRange({ status, since, until }) {
  const byNo = new Map();
  let cursor = since;
  while (cursor < until) {
    const end = Math.min(cursor + CHUNK_DAYS * DAY, until);
    const { orders } = await fetchWindow({ status, startDate: cursor, endDate: end });
    for (const o of orders) byNo.set(o.orderNumber || o.id, o);
    cursor = end + 1;
  }
  return [...byNo.values()];
}

const NOT_SHIPPED = ['Created', 'Picking', 'Invoiced', 'Awaiting'];
const totalQty = (o) => (o.lines || []).reduce((s, l) => s + (l.quantity || 0), 0);

// İptal / iade sayılan sipariş statüleri (tümü iptalse "gelen" saymayız)
const CANCEL_STATUS = new Set(['Cancelled', 'UnSupplied', 'Returned', 'UnDelivered']);
// Satır (line) düzeyinde iptal — kısmi iptalleri de yakalar
const isCancelledLine = (l) => /cancel|iptal|unsupplied|return|iade/i.test(l.orderLineItemStatusName || '');
// Bir siparişin iptal edilmemiş (aktif) ürün adedi
const activeQty = (o) => (o.lines || []).reduce((s, l) => s + (isCancelledLine(l) ? 0 : (l.quantity || 0)), 0);

// Trendyol'un orderDate alanı, gerçek sipariş anını İstanbul duvar-saati olarak alıp
// UTC epoch gibi saklar; bu yüzden 3 saat ileri kaymıştır (İstanbul yıl boyu UTC+3, DST yok).
// Gerçek sipariş anı = orderDate - 3s. (packageHistories/originShipmentDate ve Trendyol'un
// kendi Excel/panel "Sipariş Tarihi" değerleriyle bu düzeltme birebir örtüşür.)
const ORDERDATE_FIX_MS = 3 * 60 * 60 * 1000;
const orderTime = (o) => o.orderDate - ORDERDATE_FIX_MS;

// Sipariş satırlarını pano pop-up'ında gösterilecek sade ürün listesine indirger
const productLines = (o) =>
  (o.lines || []).map((l) => ({
    name: l.productName || '—',
    color: l.productColor || '',
    size: l.productSize || '',
    sku: l.merchantSku || l.stockCode || l.barcode || '',
    quantity: l.quantity || 0,
  }));

export async function getTrendyolMetrics() {
  const now = new Date();
  const nowMs = now.getTime();
  const todayStart = istanbulDayStart(now).getTime();
  const todayEnd = istanbulDayEnd(now).getTime();
  const delayThreshold = addDays(istanbulDayEnd(now), config.delayOffsetDays).getTime();

  // 1) Gelen siparişler: Trendyol'un startDate/endDate filtresi orderDate'e DEĞİL
  //    lastModifiedDate'e göre çalışır; yani pencere "o aralıkta hareket gören" tüm
  //    paketleri döner. Gerçekten BUGÜN/o gün oluşturulanları orderDate ile süzüp güne
  //    göre grupluyoruz. Bir siparişin lastModified'ı orderDate'inden önce olamayacağı
  //    için, son N günde oluşan hiçbir sipariş bu pencereden kaçmaz.
  const days = config.historyDays;
  const rangeStart = istanbulDayStart(addDays(now, -(days - 1))).getTime();
  const receivedWin = await fetchRange({ since: rangeStart, until: todayEnd });

  // gün anahtarına göre grupla (yalnızca penceredeki N günün anahtarları tutulur)
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(istanbulDateKey(addDays(now, -i)));
  const validKey = new Set(dayKeys);
  const recvByKey = new Map();
  for (const o of receivedWin) {
    const key = istanbulDateKey(orderTime(o)); // +3s kaymayı düzelt
    if (!validKey.has(key)) continue;
    if (CANCEL_STATUS.has(o.status)) continue; // tamamı iptal edilmiş siparişi sayma
    const units = activeQty(o); // iptal edilen satırların adedini çıkar
    if (units === 0) continue; // tüm satırları iptal olmuşsa gelen sayılmaz
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
  const todayKey = istanbulDateKey(now);
  const todayRecv = recvByKey.get(todayKey) || { orders: 0, units: 0 };

  // 2) Bugün kargoya verilenler: son 15 gündeki Shipped siparişlerden, GERÇEK kargolama anı
  //    (packageHistories'daki "Shipped" olayı) bugüne düşenler. lastModifiedDate yanıltıcıydı —
  //    önceden kargolanıp bugün sadece kargo takip güncellemesi alan siparişleri de sayıyordu.
  const shippedAll = await fetchRange({ status: 'Shipped', since: nowMs - 15 * DAY, until: nowMs });
  const shipEventTime = (o) => {
    const ev = (o.packageHistories || []).filter((h) => h.status === 'Shipped').map((h) => h.createdDate);
    return ev.length ? Math.max(...ev) : 0;
  };
  const shippedTodayOrders = shippedAll.filter((o) => {
    const ts = shipEventTime(o);
    return ts >= todayStart && ts <= todayEnd;
  });

  // 3) Henüz kargolanmamış TÜM açık siparişler — kuyruk + gecikme hesabı
  const openOrders = [];
  const seen = new Set();
  const openSince = nowMs - config.openWindowDays * DAY;
  for (const status of NOT_SHIPPED) {
    const orders = await fetchRange({ status, since: openSince, until: nowMs });
    for (const o of orders) {
      const id = o.orderNumber || o.id;
      if (!seen.has(id)) { seen.add(id); openOrders.push(o); }
    }
  }

  const delayed = openOrders
    .filter((o) => (o.agreedDeliveryDate || o.estimatedDeliveryDate || Infinity) <= delayThreshold)
    .map((o) => {
      const deadline = o.agreedDeliveryDate || o.estimatedDeliveryDate || 0;
      return {
        orderNumber: o.orderNumber || o.id,
        status: o.status,
        deadline,
        // Termin ANINDAN önce geçtiyse gecikmiş. (Önceki gün DEĞİL; bugün olup saati
        // geçmiş terminler de gecikmiştir — Trendyol'un "gecikmeye girmiş" ölçütü.)
        overdue: deadline < nowMs,
        orderedAt: orderTime(o), // düzeltilmiş geliş anı (+3s kayma giderilmiş)
        quantity: totalQty(o),
        customer: [o.customerFirstName, o.customerLastName].filter(Boolean).join(' '),
        items: productLines(o),
      };
    })
    // Önce termini en yakın/geçmiş (en acil), eşit terminde en eski geliş üstte
    .sort((a, b) => (a.deadline - b.deadline) || (a.orderedAt - b.orderedAt));

  const sumQty = (arr) => arr.reduce((s, o) => s + totalQty(o), 0);

  return {
    receivedToday: todayRecv.orders,
    receivedUnits: todayRecv.units,
    receivedByDay,
    shippedToday: shippedTodayOrders.length,
    shippedUnits: sumQty(shippedTodayOrders),
    openTotal: openOrders.length,
    openUnits: sumQty(openOrders),
    delayed,
  };
}

// Belirli tarih aralığında (orderDate) gelen siparişlerin ürün satırlarını döndürür.
// İptaller hariç. Renk/numara konsolidasyonu için kullanılır.
export async function getTrendyolLines({ since, until }) {
  // Pencere lastModified'e göre süzdüğünden, orderDate'i aralıkta olan ama sonradan
  // güncellenmiş siparişleri kaçırmamak için üst sınırı "şimdi" alıp orderDate ile süzeriz.
  const orders = await fetchRange({ since, until: Date.now() });
  const out = [];
  for (const o of orders) {
    const t = orderTime(o); // +3s kaymayı düzelt
    if (t < since || t > until) continue;
    if (CANCEL_STATUS.has(o.status)) continue;
    for (const l of o.lines || []) {
      if (isCancelledLine(l)) continue;
      out.push({
        sku: l.merchantSku || l.stockCode || l.barcode || '',
        size: l.productSize || null,
        quantity: l.quantity || 0,
        platform: 'trendyol',
      });
    }
  }
  return out;
}

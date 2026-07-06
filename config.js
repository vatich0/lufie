// Ortam değişkenleri ve ortak yardımcılar
export const config = {
  port: process.env.PORT || 3000,

  trendyol: {
    sellerId: process.env.TRENDYOL_SELLER_ID || '',
    apiKey: process.env.TRENDYOL_API_KEY || '',
    apiSecret: process.env.TRENDYOL_API_SECRET || '',
    // Yeni entegrasyon ağ geçidi. Eski adres için ortam değişkeni ile değiştirilebilir.
    baseUrl: process.env.TRENDYOL_BASE_URL || 'https://apigw.trendyol.com/integration',
  },

  shopify: {
    // API çağrıları .myshopify.com adresine gider. Custom domain (ör. lufie.com.tr) DEĞİL,
    // mağazanın kalıcı adı kullanılır. Örn: xst1gd-b8.myshopify.com
    shop: process.env.SHOPIFY_SHOP || '',
    // Klasik statik Admin API token (shpat_...) — varsa doğrudan kullanılır
    token: process.env.SHOPIFY_ACCESS_TOKEN || '',
    // Dev dashboard uygulaması: client credentials ile 24 saatlik token alınır
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
    // Hangi etiket "acil" sayılacak (küçük harfe çevrilerek karşılaştırılır)
    urgentTag: (process.env.SHOPIFY_URGENT_TAG || 'acil').toLowerCase(),
  },

  // Trendyol termini bu kadar gün içinde dolacaklar da "gecikecek" sayılır.
  // 0 = sadece bugün ve geçmiş; 1 = yarın dolacaklar da dahil.
  delayOffsetDays: Number(process.env.DELAY_OFFSET_DAYS || 0),

  // Açık (kargolanmamış) siparişler kaç gün geriye kadar taranacak.
  // Açık siparişler doğası gereği yenidir; 30 gün pratikte tümünü kapsar.
  openWindowDays: Number(process.env.OPEN_WINDOW_DAYS || 30),

  // Panonun kaç saniyede bir yenileneceği
  refreshSeconds: Number(process.env.REFRESH_SECONDS || 60),

  // Basit giriş şifresi (açılışta sorulur). Ortam değişkeni ile değiştirilebilir.
  sitePassword: process.env.SITE_PASSWORD || 'lufie',

  // Günlük geçmiş snapshot'larının yazılacağı JSON dosyası.
  // Railway'de kalıcı bir Volume mount edip HISTORY_FILE=/data/history.json verin.
  historyFile: process.env.HISTORY_FILE || 'history.json',
  // Alt grafiklerde gösterilecek gün sayısı
  historyDays: Number(process.env.HISTORY_DAYS || 7),

  timezone: 'Europe/Istanbul',
};

// Türkiye saatine göre "bugünün" başlangıcı (00:00 +03:00) — Date nesnesi (UTC epoch)
export function istanbulDayStart(date = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  return new Date(`${ymd}T00:00:00+03:00`);
}

export function istanbulDayEnd(date = new Date()) {
  const start = istanbulDayStart(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// Bir zamanı (Date ya da epoch ms) Türkiye saatine göre "YYYY-MM-DD" gün anahtarına çevirir
export function istanbulDateKey(date = new Date()) {
  const d = typeof date === 'number' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// Renk kodu → kanonik Türkçe ad eşlemesi.
// SKU'daki renk kodu (FF03[BR]39 → BR) her iki platformda ortak olduğu için,
// ürün isimleri farklı olsa da (Trendyol "Bordo Rugan" ↔ Shopify "Parlak Bordo")
// renk koduyla kovalamak çift sayımı engeller.
export const COLOR_NAMES = {
  R: 'Kırmızı',
  JB: 'Siyah',
  BR: 'Bordo',
  DB: 'Kahve',
  W: 'Kemik',
  GD: 'Altın',
  SS: 'Gümüş',
  GR: 'Gri',
  LP: 'Leopar',
  SX: 'Saks Mavisi',
  B: 'Açık Mavi',
  YS: 'Yeşil',
  LL: 'Lila',
  SM: 'Somon',
  SR: 'Sarı',
  CC: 'Çiçekli',
  KA: 'Kaz Ayağı',
  ZB: 'Zebra',
};

// SKU'yu ayrıştırır: ön ek (FF/KR...), model (2 hane), renk kodu (harfler), numara (opsiyonel).
// Örn: FF03BR39 → { prefix:'FF', model:'03', code:'BR', size:'39' }
//      KR01DB   → { prefix:'KR', model:'01', code:'DB', size:null }
export function parseSku(sku) {
  const m = String(sku || '').toUpperCase().trim().match(/^([A-Z]{2})(\d{2})([A-Z]+)(\d{2,3})?$/);
  if (!m) return null;
  return { prefix: m[1], model: m[2], code: m[3], size: m[4] || null };
}

export function colorName(code) {
  return COLOR_NAMES[code] || code || 'Bilinmeyen';
}

// Numara ancak sayısal görünüyorsa geçerli sayılır; aksi halde "Numarasız"
// (ör. KR ürünlerinde variant_title numara değil renk sözcüğü olabilir).
function normSize(...cands) {
  for (const c of cands) {
    if (c != null && /^\d{2,3}$/.test(String(c).trim())) return String(c).trim();
  }
  return 'Numarasız';
}

// Ürün adı = renk + (model 03 => " Rugan"). Model 03 = Rugan/Parlak, 01 = mat.
// Böylece "Siyah" (FF01JB) ile "Siyah Rugan" (FF03JB) ayrı ürün olarak kalır.
export function variantName(p) {
  const base = colorName(p.code);
  return p.model === '03' ? `${base} Rugan` : base;
}

// Numaraları sayısal sırala; "Numarasız" en sona
function sizeSort(a, b) {
  const na = parseInt(a.size, 10);
  const nb = parseInt(b.size, 10);
  const aa = Number.isNaN(na);
  const bb = Number.isNaN(nb);
  if (aa && bb) return String(a.size).localeCompare(String(b.size));
  if (aa) return 1;
  if (bb) return -1;
  return na - nb;
}

// Normalize edilmiş satırları ({ sku, size, quantity, platform }) renge/numaraya göre konsolide eder.
// KR ile başlayanlar ayrı gruba ("Diğer (KR)"), FF olanlar "Terlikler" grubuna girer.
export function consolidateByColor(lines) {
  const groups = new Map(); // key -> { key, title, colors: Map(name -> {...}) }
  const ensure = (key, title) => {
    if (!groups.has(key)) groups.set(key, { key, title, colors: new Map() });
    return groups.get(key);
  };
  const totals = { units: 0, trendyol: 0, shopify: 0 };

  for (const ln of lines) {
    const q = ln.quantity || 0;
    if (!q) continue;
    totals.units += q;
    if (ln.platform in totals) totals[ln.platform] += q;

    const p = parseSku(ln.sku);
    let groupKey, groupTitle, name, size;
    if (p && p.prefix === 'FF') {
      groupKey = 'ff'; groupTitle = 'Terlikler';
      name = variantName(p); // renk + rugan/mat ayrımı
      size = normSize(p.size, ln.size);
    } else if (p && p.prefix === 'KR') {
      groupKey = 'kr'; groupTitle = 'Diğer (KR)';
      name = variantName(p);
      size = normSize(p.size, ln.size);
    } else {
      groupKey = 'diger'; groupTitle = 'Diğer';
      name = ln.sku ? `Bilinmeyen (${ln.sku})` : 'Bilinmeyen';
      size = normSize(ln.size);
    }

    const g = ensure(groupKey, groupTitle);
    if (!g.colors.has(name)) {
      g.colors.set(name, { name, total: 0, byPlatform: { trendyol: 0, shopify: 0 }, sizes: new Map() });
    }
    const c = g.colors.get(name);
    c.total += q;
    if (ln.platform in c.byPlatform) c.byPlatform[ln.platform] += q;
    if (!c.sizes.has(size)) c.sizes.set(size, { size, qty: 0, byPlatform: { trendyol: 0, shopify: 0 } });
    const sz = c.sizes.get(size);
    sz.qty += q;
    if (ln.platform in sz.byPlatform) sz.byPlatform[ln.platform] += q;
  }

  const order = ['ff', 'kr', 'diger'];
  const outGroups = order
    .filter((k) => groups.has(k))
    .map((k) => {
      const g = groups.get(k);
      const colors = [...g.colors.values()]
        .sort((a, b) => b.total - a.total)
        .map((c) => ({ ...c, sizes: [...c.sizes.values()].sort(sizeSort) }));
      return { key: g.key, title: g.title, total: colors.reduce((s, c) => s + c.total, 0), colors };
    });

  return { groups: outGroups, totals };
}

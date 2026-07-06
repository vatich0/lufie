import fs from 'node:fs/promises';
import path from 'node:path';
import { config, istanbulDateKey } from './config.js';

const FILE = path.resolve(config.historyFile);
const KEEP_DAYS = 60; // dosyada en fazla bu kadar günlük kayıt tutulur

async function read() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return []; // dosya yoksa/bozuksa boş geçmiş
  }
}

async function write(rows) {
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const trimmed = rows.slice(-KEEP_DAYS);
  await fs.mkdir(path.dirname(FILE), { recursive: true }).catch(() => {});
  await fs.writeFile(FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

const EMPTY = (date) => ({
  date,
  receivedOrders: null, receivedUnits: null,
  shippedOrders: null, shippedUnits: null,
  openOrders: null, openUnits: null,
});

// Tek okuma-yaz döngüsünde:
//  - bugünün tam kaydını (gelen/kargolanan/açık) günceller
//  - receivedByDay ile geçmiş günlerin "gelen" değerlerini (geç-)doldurur
export async function updateHistory({ today, receivedByDay }) {
  const rows = await read();
  const byDate = new Map(rows.map((r) => [r.date, r]));

  // 1) Geçmiş günlerin GELEN değerini API'den doldur (varsa üzerine yazar, doğrudur)
  for (const d of receivedByDay || []) {
    const row = byDate.get(d.date) || EMPTY(d.date);
    row.receivedOrders = d.orders;
    row.receivedUnits = d.units;
    byDate.set(d.date, row);
  }

  // 2) Bugünün tam snapshot'ı (gelen + kargolanan + açık kuyruk)
  if (today) {
    const row = byDate.get(today.date) || EMPTY(today.date);
    Object.assign(row, today);
    byDate.set(today.date, row);
  }

  await write([...byDate.values()]);
}

// Bugün dahil son `days` takvim gününü, boş günler null olacak şekilde döndürür
export async function getSeries(days = config.historyDays) {
  const rows = await read();
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out = [];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  for (let i = days - 1; i >= 0; i--) {
    const key = istanbulDateKey(now - i * DAY);
    out.push(byDate.get(key) || EMPTY(key));
  }
  return out;
}

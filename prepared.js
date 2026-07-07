import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// "Hazırlanıyor" işaretli sipariş anahtarları — history.json ile aynı klasörde tutulur.
// (HISTORY_FILE bir Volume'a bakıyorsa bu da kalıcı olur.)
const FILE = path.join(path.dirname(path.resolve(config.historyFile)), 'prepared.json');

async function read() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

async function write(keys) {
  await fs.mkdir(path.dirname(FILE), { recursive: true }).catch(() => {});
  await fs.writeFile(FILE, JSON.stringify([...new Set(keys.map(String))]), 'utf8');
}

export async function getPrepared() {
  return read();
}

export async function togglePrepared(key, on) {
  const set = new Set(await read());
  if (on) set.add(String(key));
  else set.delete(String(key));
  const keys = [...set];
  await write(keys);
  return keys;
}

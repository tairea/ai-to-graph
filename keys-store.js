// Per-server API key storage. Keys live encrypted on Gun (under the user's
// SEA pair) so they survive restarts and can sync across instances of the
// same identity. A local JSON cache mirrors the decrypted values so requests
// don't pay the Gun round-trip on the hot path. Environment variables are a
// last-resort fallback (so the existing .env workflow still works).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEA, seaPair, $u, did } from './gun-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ENV_BY_NAME = {
  openai:     'OPENAI_API_KEY',
  anthropic:  'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

let cache = { openai: '', anthropic: '', openrouter: '' };

function loadLocal() {
  if (!fs.existsSync(KEYS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
    for (const k of Object.keys(cache)) {
      if (typeof raw[k] === 'string') cache[k] = raw[k];
    }
  } catch (err) {
    console.warn('[keys-store] failed to read local cache:', err.message);
  }
}

function saveLocal() {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[keys-store] failed to write local cache:', err.message);
  }
}

loadLocal();

// Best-effort hydrate from Gun: if the local file is missing or stale, the
// encrypted blob in Gun rehydrates the cache. Fires once on startup.
(function hydrateFromGun() {
  $u(did, 'keys').once(async (data) => {
    if (!data || typeof data !== 'object') return;
    let changed = false;
    for (const k of Object.keys(cache)) {
      const enc = data[k];
      if (typeof enc !== 'string' || !enc) continue;
      try {
        const dec = await SEA.decrypt(enc, seaPair);
        if (typeof dec === 'string' && dec && dec !== cache[k]) {
          cache[k] = dec;
          changed = true;
        }
      } catch {}
    }
    if (changed) saveLocal();
  });
})();

export function getKey(name) {
  const v = cache[name];
  if (v) return v;
  const envName = ENV_BY_NAME[name];
  return (envName && process.env[envName]) || '';
}

export async function setKeys(patch) {
  if (!patch || typeof patch !== 'object') return cache;
  let touched = false;
  for (const k of Object.keys(cache)) {
    if (k in patch && typeof patch[k] === 'string') {
      cache[k] = patch[k].trim();
      touched = true;
    }
  }
  if (!touched) return cache;
  saveLocal();
  // Mirror encrypted to Gun (best-effort, fire-and-forget)
  const node = $u(did, 'keys');
  for (const k of Object.keys(cache)) {
    try {
      const v = cache[k];
      if (v) {
        const enc = await SEA.encrypt(v, seaPair);
        node.get(k).put(enc);
      } else {
        node.get(k).put(null);
      }
    } catch (err) {
      console.warn(`[keys-store] gun mirror failed for ${k}:`, err.message);
    }
  }
  return cache;
}

function mask(s) {
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '••••' + s.slice(-4);
}

export function getMaskedKeys() {
  const status = {};
  for (const k of Object.keys(cache)) {
    const v = cache[k];
    const env = ENV_BY_NAME[k];
    const fromEnv = !v && !!(env && process.env[env]);
    status[k] = {
      set: !!v || fromEnv,
      source: v ? 'stored' : (fromEnv ? 'env' : 'none'),
      masked: v ? mask(v) : (fromEnv ? mask(process.env[env]) : ''),
    };
  }
  return status;
}

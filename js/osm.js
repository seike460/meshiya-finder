'use strict';

// ---------------------------------------------------------------------------
// 飯屋ファインダー（静的版）データ層
//
// ブラウザから Nominatim / Overpass API を直接呼び出す。サーバーは存在しない。
//  - User-Agent はブラウザが設定できないため、Referer による識別に任せる
//    （独自ヘッダを付けない＝ CORS プリフライトを避ける）。
//  - Nominatim は 1 秒 1 リクエスト以下に直列スロットリングし、結果を
//    localStorage にキャッシュ（24h / 失敗は 1h）。
//  - Overpass は複数ミラーへ順にフォールバック（GET + ?data= でプリフライト回避）。
// ---------------------------------------------------------------------------

import opening_hours from '../vendor/opening_hours.js';

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
export const ALLOWED_RADII = [500, 1000, 3000, 5000];
export const DEFAULT_RADIUS = 1000;

const AMENITY_VALUES = ['restaurant', 'fast_food', 'cafe', 'food_court', 'pub', 'bar', 'izakaya'];

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_MIN_INTERVAL_MS = 1100; // >= 1 秒 1 リクエスト
const NOMINATIM_TIMEOUT_MS = 15 * 1000;
const NOMINATIM_LAST_KEY = 'mf:nominatim:last'; // 直近呼び出し時刻（リロードをまたいでも連打しない）

const GEO_PREFIX = 'mf:geo:';
const GEO_TTL_MS = 24 * 60 * 60 * 1000; // 24 時間（ヒット）
const GEO_NEG_TTL_MS = 60 * 60 * 1000; // 1 時間（ヒットなし）

// 既定の Overpass ミラー（順にフォールバック）。timeout は AbortController 用。
const DEFAULT_OVERPASS_MIRRORS = [
  { url: 'https://overpass-api.de/api/interpreter', timeout: 15000 },
  { url: 'https://overpass.private.coffee/api/interpreter', timeout: 15000 },
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', timeout: 45000 },
];
// テスト用に JS 定数でも上書き可（カンマ区切りの http(s) URL）。
const OVERPASS_OVERRIDE = '';

const OVERPASS_BACKOFFS = [1000, 2000]; // ミラー切替前の待機
const OVERPASS_CACHE_PREFIX = 'mf:ovp:';
const OVERPASS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分
const OVERPASS_FAIL_PREFIX = 'mf:ovpfail:'; // ミラーごとの直近 429/406 時刻
const OVERPASS_FAIL_SKIP_MS = 30 * 1000; // 直近 30 秒以内に 429/406 を返したミラーは飛ばす

// ---------------------------------------------------------------------------
// 汎用ユーティリティ
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return url;
  }
}

async function fetchWithTimeout(resource, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000; // m
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// localStorage / sessionStorage は例外を投げうる（容量超過・プライベートモード）。
function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* 容量超過などは無視 */
  }
}
function ssGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch (e) {
    return null;
  }
}
function ssSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch (e) {
    /* 無視 */
  }
}

// ---------------------------------------------------------------------------
// Overpass ミラーの決定（開発時のみ JS 定数 OVERPASS_OVERRIDE で上書き可。
// 公開サイトで任意URLを指定できないよう、URLパラメータでの上書きは受け付けない）
// ---------------------------------------------------------------------------
export function resolveOverpassMirrors() {
  const parseList = (raw) =>
    String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//i.test(s))
      .map((url) => ({ url, timeout: 25000 }));

  if (OVERPASS_OVERRIDE) {
    const list = parseList(OVERPASS_OVERRIDE);
    if (list.length) return list;
  }
  return DEFAULT_OVERPASS_MIRRORS.slice();
}

// ---------------------------------------------------------------------------
// ジオコーディング（Nominatim）: 直列スロットリング ＋ localStorage キャッシュ
// ---------------------------------------------------------------------------
let nominatimQueue = Promise.resolve();

function enqueueNominatim(fn) {
  const run = nominatimQueue.then(async () => {
    const last = parseInt(lsGet(NOMINATIM_LAST_KEY) || '0', 10) || 0;
    const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lsSet(NOMINATIM_LAST_KEY, String(Date.now()));
    }
  });
  // 失敗してもキューを継続させる
  nominatimQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * 地名・駅名をジオコーディングする。
 * @returns {Promise<{lat:number,lng:number,label:string}|null>} ヒットなしは null
 */
export async function geocode(place) {
  const key = place.trim().toLowerCase();
  const cacheKey = GEO_PREFIX + key;
  const raw = lsGet(cacheKey);
  if (raw) {
    try {
      const cached = JSON.parse(raw);
      const ttl = cached.value ? GEO_TTL_MS : GEO_NEG_TTL_MS;
      if (cached && typeof cached.ts === 'number' && Date.now() - cached.ts < ttl) {
        return cached.value;
      }
    } catch (e) {
      /* 壊れたキャッシュは無視 */
    }
  }

  const value = await enqueueNominatim(async () => {
    const u = new URL(NOMINATIM_URL);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('limit', '1');
    u.searchParams.set('countrycodes', 'jp');
    u.searchParams.set('accept-language', 'ja');
    u.searchParams.set('q', place);
    // ブラウザでは User-Agent を付けられない。独自ヘッダも付けず Referer に任せる。
    const res = await fetchWithTimeout(u, {}, NOMINATIM_TIMEOUT_MS);
    if (!res.ok) throw new Error('Nominatim ステータス ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const d = data[0];
    const lat = parseFloat(d.lat);
    const lng = parseFloat(d.lon);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng, label: d.display_name || place };
  });

  lsSet(cacheKey, JSON.stringify({ ts: Date.now(), value }));
  return value;
}

// ---------------------------------------------------------------------------
// Overpass: クエリ・フォールバック・キャッシュ
// ---------------------------------------------------------------------------
function overpassCacheKey(lat, lng, radius) {
  return `${OVERPASS_CACHE_PREFIX}${lat.toFixed(4)},${lng.toFixed(4)},${radius}`;
}

export function buildOverpassQuery(lat, lng, radius) {
  // amenity を持つ node/way を先に半径で絞り、その中から対象 amenity を選ぶ（正規表現を全体に掛けるより軽い）
  const re = AMENITY_VALUES.join('|');
  const around = `around:${radius},${lat},${lng}`;
  return (
    `[out:json][timeout:25];\n` +
    `node(${around})[amenity]->.n;\n` +
    `way(${around})[amenity]->.w;\n` +
    `(node.n["amenity"~"^(${re})$"];way.w["amenity"~"^(${re})$"];);\n` +
    `out center;`
  );
}

function readOverpassCache(key) {
  const raw = ssGet(key) || lsGet(key);
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw);
    if (cached && typeof cached.ts === 'number' && Date.now() - cached.ts < OVERPASS_CACHE_TTL_MS) {
      return Array.isArray(cached.elements) ? cached.elements : null;
    }
  } catch (e) {
    /* 壊れたキャッシュは無視 */
  }
  return null;
}

function writeOverpassCache(key, elements) {
  const payload = JSON.stringify({ ts: Date.now(), elements });
  try {
    sessionStorage.setItem(key, payload);
  } catch (e) {
    // 容量超過: 古い mf:ovp: エントリを掃除して再試行
    evictOverpassCache();
    try {
      sessionStorage.setItem(key, payload);
    } catch (e2) {
      /* それでも入らなければ諦める */
    }
  }
}

function evictOverpassCache() {
  try {
    const toRemove = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(OVERPASS_CACHE_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) sessionStorage.removeItem(k);
  } catch (e) {
    /* 無視 */
  }
}

// 直近 30 秒以内に 429/406 を返したミラーか？
function mirrorRecentlyFailed(url) {
  const ts = parseInt(ssGet(OVERPASS_FAIL_PREFIX + hostOf(url)) || '0', 10) || 0;
  return ts > 0 && Date.now() - ts < OVERPASS_FAIL_SKIP_MS;
}
function markMirrorFailed(url) {
  ssSet(OVERPASS_FAIL_PREFIX + hostOf(url), String(Date.now()));
}

/**
 * Overpass へクエリを投げ、失敗時は次のミラーへフォールバックする。
 * 並列呼び出しはしない。全滅時は attempts を持つ Error を throw。
 * @param {string} query
 * @param {Array<{url:string,timeout:number}>} mirrors
 * @param {(host:string)=>void} [onProgress] 試行中ミラーの通知
 */
async function overpassFetch(query, mirrors, onProgress) {
  const attempts = [];
  const data = 'data=' + encodeURIComponent(query);
  for (let i = 0; i < mirrors.length; i++) {
    const { url, timeout } = mirrors[i];
    const host = hostOf(url);

    // 直近に 429/406 を返したミラーはスキップ
    if (mirrorRecentlyFailed(url)) {
      attempts.push({ host, status: 'skip（直近に 429/406）' });
      continue;
    }

    if (typeof onProgress === 'function') onProgress(host);

    try {
      // GET + ?data= （単純リクエスト＝プリフライトなし）。独自ヘッダは付けない。
      const res = await fetchWithTimeout(url + '?' + data, { method: 'GET' }, timeout);
      if (res.status === 429 || res.status === 406) {
        markMirrorFailed(url);
        attempts.push({ host, status: res.status });
      } else if (res.status >= 500 || !res.ok) {
        attempts.push({ host, status: res.status });
      } else {
        let json;
        try {
          json = await res.json();
        } catch (e) {
          attempts.push({ host, error: 'non-JSON' });
          json = null;
        }
        if (json) {
          return { elements: Array.isArray(json.elements) ? json.elements : [], attempts };
        }
      }
    } catch (e) {
      const error = e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'network error';
      attempts.push({ host, error });
    }

    // 次のミラーがあればバックオフ
    if (i < mirrors.length - 1) {
      await sleep(OVERPASS_BACKOFFS[Math.min(i, OVERPASS_BACKOFFS.length - 1)]);
    }
  }
  const err = new Error('Overpass 全ミラー失敗');
  err.attempts = attempts;
  throw err;
}

/**
 * 周辺要素を取得する（10 分キャッシュ付き）。
 * @returns {Promise<Array>} Overpass element 配列
 */
export async function getOverpassElements(lat, lng, radius, options = {}) {
  const key = overpassCacheKey(lat, lng, radius);
  const cached = readOverpassCache(key);
  if (cached) return cached;

  const mirrors = options.mirrors || resolveOverpassMirrors();
  const query = buildOverpassQuery(lat, lng, radius);
  const { elements } = await overpassFetch(query, mirrors, options.onProgress);
  writeOverpassCache(key, elements);
  return elements;
}

// ---------------------------------------------------------------------------
// 営業状況・住所・結果整形
// ---------------------------------------------------------------------------
export function evalOpenStatus(value) {
  if (!value) return 'unknown';
  try {
    const oh = new opening_hours(value, { address: { country_code: 'jp' } });
    return oh.getState() ? 'open' : 'closed';
  } catch (e) {
    return 'unknown';
  }
}

export function buildAddress(tags) {
  if (tags['addr:full']) return tags['addr:full'];
  const parts = [];
  const keys = [
    'addr:province',
    'addr:city',
    'addr:ward',
    'addr:quarter',
    'addr:neighbourhood',
    'addr:block_number',
    'addr:housenumber',
  ];
  for (const k of keys) {
    if (tags[k]) parts.push(tags[k]);
  }
  let addr = parts.join('');
  if (tags['addr:postcode']) {
    addr = addr ? `〒${tags['addr:postcode']} ${addr}` : `〒${tags['addr:postcode']}`;
  }
  return addr || null;
}

export function buildResult(el, origin) {
  const tags = el.tags || {};
  const name = tags['name:ja'] || tags.name;
  if (!name) return null; // 無名の施設は除外

  let lat;
  let lng;
  if (el.type === 'node' && typeof el.lat === 'number') {
    lat = el.lat;
    lng = el.lon;
  } else if (el.center && typeof el.center.lat === 'number') {
    lat = el.center.lat;
    lng = el.center.lon;
  } else {
    return null;
  }

  const cuisine = tags.cuisine
    ? tags.cuisine
        .split(';')
        .map((c) => c.trim())
        .filter(Boolean)
    : [];
  const openingHours = tags.opening_hours || null;
  const distance = Math.round(haversine(origin.lat, origin.lng, lat, lng));
  const mapsUrl =
    'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent(`${name} ${lat},${lng}`);

  return {
    id: `${el.type}/${el.id}`,
    name,
    lat,
    lng,
    kind: tags.amenity || null,
    cuisine,
    address: buildAddress(tags),
    openingHours,
    openStatus: evalOpenStatus(openingHours),
    website: tags.website || tags['contact:website'] || tags.url || null,
    phone: tags.phone || tags['contact:phone'] || null,
    distance,
    mapsUrl,
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}

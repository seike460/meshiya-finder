'use strict';

// ---------------------------------------------------------------------------
// 飯屋ファインダー（静的版）データ層
//
// ブラウザから Nominatim / Overpass API を直接呼び出す。サーバーは存在しない。
//  - User-Agent はブラウザが設定できないため、Referer による識別に任せる
//    （独自ヘッダを付けない＝ CORS プリフライトを避ける）。
//  - Nominatim は 1 秒 1 リクエスト以下に直列スロットリングし、結果を
//    localStorage にキャッシュ（24h / 失敗は 1h）。
//  - Overpass は複数ミラーへヘッジ要求（GET + ?data= でプリフライト回避）。
//    遅い・全滅時は OpenFreeMap タイル / Nominatim のキー不要検索へフォールバック。
// ---------------------------------------------------------------------------

import opening_hours from '../vendor/opening_hours.js';
import { VectorTile, Pbf } from '../vendor/vector-tile.js';

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

// Overpass ミラー（運営者が異なる 3 系統）。順に「ずらして」起動するヘッジ要求で、
// 最初に成功した応答を採用し残りは AbortController で中断する。
//  - overpass-api.de        : FOSSGIS 本家（混雑時 504/timeout が多い）
//  - overpass.private.coffee: 旧 overpass.kumi.systems
//  - maps.mail.ru           : VK Maps（ACAO * を確認済み）
// z./lz4.overpass-api.de は本家と同じ運営・同じ負荷なので重複させない。
const DEFAULT_OVERPASS_MIRRORS = [
  { url: 'https://overpass-api.de/api/interpreter', timeout: 25000 },
  { url: 'https://overpass.private.coffee/api/interpreter', timeout: 25000 },
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', timeout: 25000 },
];
// テスト用に JS 定数でも上書き可（カンマ区切りの http(s) URL）。
const OVERPASS_OVERRIDE = '';

const OVERPASS_HEDGE_DELAY_MS = 2500; // 応答が無ければ次のミラーを起動するまでの間隔
const OVERPASS_DEADLINE_MS = 28 * 1000; // Overpass 全体の打ち切り
const FALLBACK_START_MS = 5000; // Overpass が遅いとき、キー不要の簡易検索を先行起動するまでの時間
const OVERPASS_CACHE_PREFIX = 'mf:ovp:';
const OVERPASS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分
const OVERPASS_FAIL_PREFIX = 'mf:ovpfail:'; // ミラーごとの直近 429/406 時刻
const OVERPASS_FAIL_SKIP_MS = 30 * 1000; // 直近 30 秒以内に 429/406 を返したミラーは飛ばす
const OVERPASS_BAD_PREFIX = 'mf:ovpbad:'; // 直近の timeout/5xx 時刻（順番を後ろへ回す）
const OVERPASS_BAD_DEMOTE_MS = 2 * 60 * 1000;

// フォールバック用: OpenFreeMap のベクタータイル（キー不要・ACAO *・版付き URL で長期キャッシュ）
const OFM_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const OFM_TEMPLATE_KEY = 'mf:ofm:tpl';
const OFM_TEMPLATE_TTL_MS = 12 * 60 * 60 * 1000;
const TILE_Z = 14; // OpenMapTiles の poi レイヤは z14 で全件入る
const TILE_MAX = 36;
const TILE_CONCURRENCY = 6;
const TILE_TIMEOUT_MS = 12 * 1000;

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
// Overpass: クエリ・ヘッジ要求・キャッシュ
// ---------------------------------------------------------------------------
const AMENITY_RE = AMENITY_VALUES.join('|');

function filterSignature(resolved) {
  if (!resolved) return '*';
  return [resolved.cuisines.join('|'), resolved.amenities.join('|'), resolved.names.join('|')].join('/');
}

function overpassCacheKey(lat, lng, radius, resolved, source = 'ovp') {
  return `${OVERPASS_CACHE_PREFIX}${source}:${lat.toFixed(4)},${lng.toFixed(4)},${radius}:${filterSignature(resolved)}`;
}

// Overpass 正規表現（POSIX ERE）と QL 文字列の両方に安全な形へエスケープ
function qlRegexLiteral(str) {
  const re = String(str).replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');
  return re.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
}

/**
 * 軽量クエリ: 半径内の飲食 amenity を 1 回だけ空間検索し、キーワードがあれば
 * cuisine / 店名 / 追加 amenity でサーバー側で絞り込む（返すデータ量を最小化）。
 */
export function buildOverpassQuery(lat, lng, radius, resolved) {
  const head = `[out:json][timeout:20][maxsize:33554432];\n`;
  const base = `nwr(around:${radius},${lat.toFixed(6)},${lng.toFixed(6)})["amenity"~"^(${AMENITY_RE})$"]`;
  if (!resolved) return head + base + ';\nout center qt;';

  const parts = [];
  if (resolved.cuisines.length) {
    const cs = resolved.cuisines.map(qlRegexLiteral).join('|');
    parts.push(
      resolved.mapped
        ? `nwr.a["cuisine"~"(^|;) *(${cs}) *(;|$)",i];`
        : `nwr.a["cuisine"~"${cs}",i];`
    );
  }
  for (const n of resolved.names) {
    const lit = qlRegexLiteral(n);
    parts.push(`nwr.a["name"~"${lit}",i];`, `nwr.a["name:ja"~"${lit}",i];`, `nwr.a["name:en"~"${lit}",i];`);
  }
  if (resolved.amenities.length) {
    parts.push(`nwr.a["amenity"~"^(${resolved.amenities.map(qlRegexLiteral).join('|')})$"];`);
  }
  return head + base + '->.a;\n(' + parts.join('') + ');\nout center qt;';
}

function readOverpassCache(key) {
  const raw = ssGet(key);
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

function stampAge(prefix, url) {
  const ts = parseInt(ssGet(prefix + hostOf(url)) || '0', 10) || 0;
  return ts > 0 ? Date.now() - ts : Infinity;
}
const mirrorRecentlyFailed = (url) => stampAge(OVERPASS_FAIL_PREFIX, url) < OVERPASS_FAIL_SKIP_MS;
const mirrorRecentlyBad = (url) => stampAge(OVERPASS_BAD_PREFIX, url) < OVERPASS_BAD_DEMOTE_MS;
const markMirrorFailed = (url) => ssSet(OVERPASS_FAIL_PREFIX + hostOf(url), String(Date.now()));
const markMirrorBad = (url) => ssSet(OVERPASS_BAD_PREFIX + hostOf(url), String(Date.now()));
const clearMirrorBad = (url) => ssSet(OVERPASS_BAD_PREFIX + hostOf(url), '0');

/**
 * ヘッジ要求: ミラー 1 を起動し、HEDGE_DELAY 以内に成功しなければ次を起動…。
 * 失敗が確定したら待たずに次を起動。最初の成功を採用し、残りは中断する。
 * 同一ミラーへの同時要求は 1 本だけ（連打しない）。
 * @returns {Promise<{elements:Array, host:string, attempts:Array}>}
 */
function overpassHedged(query, mirrors, { onProgress, signal, deadlineMs = OVERPASS_DEADLINE_MS } = {}) {
  const attempts = [];
  // 直近 429/406 のミラーは除外、直近 timeout/5xx のミラーは後ろへ
  const usable = [];
  for (const m of mirrors) {
    if (mirrorRecentlyFailed(m.url)) attempts.push({ host: hostOf(m.url), status: 'skip（直近に 429/406）' });
    else usable.push(m);
  }
  usable.sort((x, y) => (mirrorRecentlyBad(x.url) ? 1 : 0) - (mirrorRecentlyBad(y.url) ? 1 : 0));

  return new Promise((resolve, reject) => {
    const controllers = [];
    const timers = [];
    let next = 0;
    let running = 0;
    let done = false;
    const data = 'data=' + encodeURIComponent(query);

    const finish = (ok, value) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      controllers.forEach((c) => c.abort());
      if (ok) resolve(value);
      else {
        const err = new Error('Overpass 全ミラー失敗');
        err.attempts = attempts;
        reject(err);
      }
    };
    const maybeAllFailed = () => {
      if (!done && running === 0 && next >= usable.length) finish(false);
    };

    const launch = () => {
      if (done || next >= usable.length) return;
      const item = usable[next];
      const wait = (item.notBefore || 0) - Date.now();
      if (wait > 0) {
        timers.push(setTimeout(launch, wait));
        return;
      }
      next++;
      const { url, timeout } = item;
      const host = hostOf(url);
      const ctrl = new AbortController();
      controllers.push(ctrl);
      running++;
      if (typeof onProgress === 'function') onProgress(host);
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeout);
      timers.push(t);
      // 次ミラーの起動予約（これが成功すれば取り消される）
      if (next < usable.length) timers.push(setTimeout(launch, OVERPASS_HEDGE_DELAY_MS));

      (async () => {
        const started = Date.now();
        try {
          // GET + ?data= （単純リクエスト＝プリフライトなし）。独自ヘッダは付けない。
          const res = await fetch(url + '?' + data, { method: 'GET', signal: ctrl.signal });
          if (res.status === 429 || res.status === 406) {
            markMirrorFailed(url);
            throw Object.assign(new Error(String(res.status)), { status: res.status });
          }
          if (!res.ok) {
            markMirrorBad(url);
            throw Object.assign(new Error(String(res.status)), { status: res.status });
          }
          const json = await res.json();
          // Overpass は過負荷時に 200 + remark（runtime error）で空を返すことがある
          if (json && json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) {
            markMirrorBad(url);
            throw new Error('remark: ' + String(json.remark).slice(0, 80));
          }
          clearMirrorBad(url);
          attempts.push({ host, status: 'OK', ms: Date.now() - started });
          finish(true, { elements: Array.isArray(json.elements) ? json.elements : [], host, attempts });
        } catch (e) {
          if (done) return; // 他ミラーが勝って中断された
          if (timedOut) markMirrorBad(url);
          const error = timedOut ? 'timeout' : e && e.status ? undefined : (e && e.message) || 'network error';
          attempts.push(error ? { host, error } : { host, status: e.status });
          // 即座に返る 502/503/504（ゲートウェイ混雑）は 1 回だけ間をおいて再試行
          if (e && e.status >= 502 && e.status <= 504 && !item.retried && Date.now() - started < 5000) {
            usable.push({ ...item, retried: true, notBefore: Date.now() + 2000 });
          }
          running--;
          launch(); // 失敗が確定したら待たずに次へ
          maybeAllFailed();
        } finally {
          clearTimeout(t);
        }
      })();
    };

    if (usable.length === 0) return finish(false);
    timers.push(setTimeout(() => finish(false), deadlineMs));
    if (signal) {
      if (signal.aborted) return finish(false);
      signal.addEventListener('abort', () => finish(false), { once: true });
    }
    launch();
  });
}

// ---------------------------------------------------------------------------
// キー不要の簡易検索（Overpass が遅い・全滅したときのフォールバック）
//  - OpenFreeMap ベクタータイル（poi レイヤ）: 半径内の飲食店を店名・種別つきで網羅的に取得し、
//    店名の部分一致・amenity でクライアント側で絞り込む（cuisine・営業時間は含まれない）
//  - Nominatim: cuisine 英語名・キーワードで viewbox 内を検索（extratags で cuisine/営業時間も得られる）
// 結果は Overpass element 互換に変換してマージする。
// ---------------------------------------------------------------------------
function viewboxOf(lat, lng, radius) {
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  return { west: lng - dLng, east: lng + dLng, south: lat - dLat, north: lat + dLat };
}

function nominatimTerms(resolved) {
  if (!resolved) return []; // キーワードなしはタイルだけで十分
  const terms = [];
  if (resolved.mapped && resolved.cuisines[0]) terms.push(resolved.cuisines[0]);
  terms.push(resolved.keyword);
  return terms.slice(0, 2);
}

async function nominatimSearch(term, box) {
  return enqueueNominatim(async () => {
    const u = new URL(NOMINATIM_URL);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('q', term);
    u.searchParams.set('viewbox', `${box.west},${box.north},${box.east},${box.south}`);
    u.searchParams.set('bounded', '1');
    u.searchParams.set('limit', '40');
    u.searchParams.set('extratags', '1');
    u.searchParams.set('namedetails', '1');
    u.searchParams.set('accept-language', 'ja');
    const res = await fetchWithTimeout(u, {}, NOMINATIM_TIMEOUT_MS);
    if (!res.ok) throw new Error('Nominatim ' + res.status);
    const data = await res.json();
    return (Array.isArray(data) ? data : [])
      .filter((d) => d.category === 'amenity' && d.osm_type && d.osm_id)
      .map((d) => ({
        type: d.osm_type,
        id: d.osm_id,
        lat: parseFloat(d.lat),
        lon: parseFloat(d.lon),
        tags: {
          ...(d.extratags || {}),
          ...(d.namedetails || {}),
          name: (d.namedetails && d.namedetails.name) || d.name,
          amenity: d.type,
        },
      }));
  });
}

async function ofmTileTemplate() {
  const raw = lsGet(OFM_TEMPLATE_KEY);
  if (raw) {
    try {
      const c = JSON.parse(raw);
      if (c && Date.now() - c.ts < OFM_TEMPLATE_TTL_MS && /^https:\/\/tiles\.openfreemap\.org\//.test(c.tpl)) return c.tpl;
    } catch (e) {
      /* 無視 */
    }
  }
  const res = await fetchWithTimeout(OFM_TILEJSON_URL, {}, TILE_TIMEOUT_MS);
  if (!res.ok) throw new Error('OpenFreeMap ' + res.status);
  const tj = await res.json();
  const tpl = tj && Array.isArray(tj.tiles) && tj.tiles[0];
  if (!tpl || !/^https:\/\/tiles\.openfreemap\.org\//.test(tpl)) throw new Error('OpenFreeMap tilejson');
  lsSet(OFM_TEMPLATE_KEY, JSON.stringify({ ts: Date.now(), tpl }));
  return tpl;
}

const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
};

async function tileSearch(box) {
  const tpl = await ofmTileTemplate();
  const z = TILE_Z;
  const x0 = lon2tile(box.west, z);
  const x1 = lon2tile(box.east, z);
  const y0 = lat2tile(box.north, z);
  const y1 = lat2tile(box.south, z);
  const tiles = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([x, y]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  tiles.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  tiles.length = Math.min(tiles.length, TILE_MAX);

  const typeOf = { 1: 'node', 2: 'way', 3: 'relation' };
  const out = [];
  let ok = 0;
  let idx = 0;
  const worker = async () => {
    while (idx < tiles.length) {
      const [x, y] = tiles[idx++];
      try {
        const url = tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        const res = await fetchWithTimeout(url, {}, TILE_TIMEOUT_MS);
        if (!res.ok) continue;
        const vt = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
        ok++;
        const layer = vt.layers.poi;
        if (!layer) continue;
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          const p = f.properties || {};
          if (!AMENITY_VALUES.includes(p.subclass) || !p.name) continue;
          const g = f.toGeoJSON(x, y, z).geometry;
          if (!g || g.type !== 'Point') continue;
          const fid = Number(f.id);
          const hasId = Number.isFinite(fid) && fid > 0;
          out.push({
            type: (hasId && typeOf[fid % 10]) || 'node',
            id: hasId ? Math.floor(fid / 10) : `t${x}-${y}-${i}`,
            lat: g.coordinates[1],
            lon: g.coordinates[0],
            tags: {
              name: p.name,
              ...(p['name:ja'] ? { 'name:ja': p['name:ja'] } : {}),
              ...(p['name:en'] ? { 'name:en': p['name:en'] } : {}),
              amenity: p.subclass,
            },
          });
        }
      } catch (e) {
        /* 個別タイルの失敗は無視 */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, tiles.length) }, worker));
  if (!ok) throw new Error('タイル取得失敗');
  return out;
}

async function fallbackSearch(lat, lng, radius, resolved, attempts) {
  const box = viewboxOf(lat, lng, radius);
  const tasks = [
    ['tiles.openfreemap.org', () => tileSearch(box)],
    ...nominatimTerms(resolved).map((t) => ['nominatim.openstreetmap.org', () => nominatimSearch(t, box)]),
  ];
  const settled = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  const byId = new Map();
  let anyOk = false;
  settled.forEach((s, i) => {
    const host = tasks[i][0];
    if (s.status === 'fulfilled') {
      anyOk = true;
      attempts.push({ host, status: `OK（${s.value.length}件）` });
      for (const el of s.value) {
        const k = `${el.type}/${el.id}`;
        const prev = byId.get(k);
        // タグの多い方（Nominatim: cuisine・営業時間あり）を優先
        if (!prev || Object.keys(el.tags).length > Object.keys(prev.tags).length) byId.set(k, el);
      }
    } else {
      attempts.push({ host, error: (s.reason && s.reason.message) || 'error' });
    }
  });
  if (!anyOk) {
    const err = new Error('フォールバック失敗');
    err.attempts = attempts;
    throw err;
  }
  return Array.from(byId.values()).filter(
    (el) =>
      isFinite(el.lat) &&
      AMENITY_VALUES.includes(String(el.tags.amenity)) &&
      haversine(lat, lng, el.lat, el.lon) <= radius
  );
}

/**
 * 周辺の飲食店要素を取得する。
 *  1) Overpass ヘッジ要求（最大 OVERPASS_DEADLINE_MS）
 *  2) FALLBACK_START_MS 経っても Overpass が返らなければ簡易検索を並行起動し、
 *     先に返れば onPartial で暫定表示。Overpass が成功すれば差し替え。
 *  3) Overpass が全滅したら簡易検索の結果を返す（source: 'fallback'）。
 * @returns {Promise<{elements:Array, source:'overpass'|'fallback', attempts:Array}>}
 */
export async function getPlaceElements(lat, lng, radius, resolved, options = {}) {
  const { onProgress, onPartial } = options;
  const key = overpassCacheKey(lat, lng, radius, resolved);
  const cached = readOverpassCache(key);
  if (cached) return { elements: cached, source: 'overpass', attempts: [] };

  const mirrors = options.mirrors || resolveOverpassMirrors();
  const query = buildOverpassQuery(lat, lng, radius, resolved);
  const fbKey = overpassCacheKey(lat, lng, radius, resolved, 'fb');
  const fbAttempts = [];
  let fallbackPromise = null;
  const startFallback = () => {
    if (!fallbackPromise) {
      const c = readOverpassCache(fbKey);
      fallbackPromise = c
        ? Promise.resolve(c)
        : fallbackSearch(lat, lng, radius, resolved, fbAttempts).then((els) => {
            writeOverpassCache(fbKey, els);
            return els;
          });
      fallbackPromise.catch(() => {});
    }
    return fallbackPromise;
  };

  let overpassDone = false;
  const fbTimer = setTimeout(() => {
    if (overpassDone) return;
    startFallback().then(
      (els) => {
        if (!overpassDone && els.length && typeof onPartial === 'function') onPartial(els);
      },
      () => {}
    );
  }, FALLBACK_START_MS);

  try {
    const r = await overpassHedged(query, mirrors, { onProgress });
    overpassDone = true;
    writeOverpassCache(key, r.elements);
    return { elements: r.elements, source: 'overpass', attempts: r.attempts };
  } catch (e) {
    overpassDone = true;
    const attempts = (e && e.attempts) || [];
    if (typeof onProgress === 'function') onProgress('簡易検索（OpenFreeMap / Nominatim）');
    try {
      const els = await startFallback();
      return { elements: els, source: 'fallback', attempts: attempts.concat(fbAttempts) };
    } catch (e2) {
      const err = new Error('全データソース失敗');
      err.attempts = attempts.concat(fbAttempts);
      throw err;
    }
  } finally {
    clearTimeout(fbTimer);
  }
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

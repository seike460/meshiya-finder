'use strict';

import { resolveKeyword, elementMatches } from './keywords.js';
import {
  ALLOWED_RADII,
  DEFAULT_RADIUS,
  geocode,
  getOverpassElements,
  buildResult,
} from './osm.js';

// ---- 要素参照 ------------------------------------------------------------
const form = document.getElementById('search-form');
const placeInput = document.getElementById('place');
const useLocationBtn = document.getElementById('use-location');
const geoStatus = document.getElementById('geo-status');
const keywordInput = document.getElementById('keyword');
const radiusSelect = document.getElementById('radius');
const sortSelect = document.getElementById('sort');
const openNowCheck = document.getElementById('openNow');
const excludeUnknownCheck = document.getElementById('excludeUnknown');
const submitBtn = document.getElementById('submit-btn');

const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const errorBox = document.getElementById('error-box');
const errorMessage = document.getElementById('error-message');
const errorDetails = document.getElementById('error-details');
const errorAttempts = document.getElementById('error-attempts');
const retryBtn = document.getElementById('retry-btn');
const countLine = document.getElementById('count-line');
const resultsEl = document.getElementById('results');

let currentCoords = null; // {lat, lng} 現在地を使った場合に保持
let lastState = null; // 再試行用に直近の検索条件を保持
let searching = false;

// ---- ユーティリティ ------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDistance(m) {
  if (typeof m !== 'number' || !isFinite(m)) return '';
  if (m >= 1000) return `約 ${(m / 1000).toFixed(m >= 10000 ? 0 : 1)}km`;
  return `約 ${m}m`;
}

function statusLabel(s) {
  if (s === 'open') return { text: '営業中', cls: 'status-open' };
  if (s === 'closed') return { text: '営業時間外', cls: 'status-closed' };
  return { text: '営業時間不明', cls: 'status-unknown' };
}

function show(el, visible) {
  if (visible) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

// ---- 表示ラベル（OSMタグ → 日本語） --------------------------------------
const KIND_JA = { restaurant: 'レストラン', fast_food: 'ファストフード', cafe: 'カフェ', food_court: 'フードコート', pub: '居酒屋・パブ', bar: 'バー', izakaya: '居酒屋' };
const CUISINE_JA = { ramen: 'ラーメン', noodle: '麺類', sushi: '寿司', yakiniku: '焼肉', barbecue: 'バーベキュー', korean_barbecue: '韓国焼肉', udon: 'うどん', soba: 'そば', curry: 'カレー', indian: 'インド料理', yakitori: '焼き鳥', tempura: '天ぷら', tonkatsu: 'とんかつ', donburi: '丼', japanese: '和食', teishoku: '定食', izakaya: '居酒屋', coffee_shop: 'カフェ', burger: 'ハンバーガー', pizza: 'ピザ', chinese: '中華', italian: 'イタリアン', korean: '韓国料理', motsunabe: 'もつ鍋', okonomiyaki: 'お好み焼き', french: 'フレンチ', thai: 'タイ料理', vietnamese: 'ベトナム料理', seafood: '海鮮', chicken: 'チキン', steak_house: 'ステーキ', beef_bowl: '牛丼', regional: '郷土料理', vegan: 'ヴィーガン', western: '洋食', sandwich: 'サンドイッチ', bakery: 'パン', dessert: 'デザート', cake: 'ケーキ', ice_cream: 'アイス' };
const jaLabel = (map, v) => map[String(v).toLowerCase()] || v;
const safeHttpUrl = (u) => (/^https?:\/\//i.test(String(u)) ? u : null);

// ---- 検索条件の収集 ------------------------------------------------------
function collectState() {
  const place = placeInput.value.trim();
  const coords = currentCoords ? { lat: currentCoords.lat, lng: currentCoords.lng } : null;
  if (!coords && !place) {
    return { error: '場所（地名・駅名）を入力するか、「現在地を使う」を押してください。' };
  }

  let radius = parseInt(radiusSelect.value, 10);
  if (!ALLOWED_RADII.includes(radius)) radius = DEFAULT_RADIUS;

  let sort = sortSelect.value;
  if (sort !== 'name' && sort !== 'distance') sort = 'distance';

  return {
    state: {
      place,
      coords,
      keyword: keywordInput.value.trim(),
      radius,
      sort,
      openNow: openNowCheck.checked,
      excludeUnknown: excludeUnknownCheck.checked,
    },
  };
}

// URL に反映する検索条件（座標は残さない）
function stateToUrlParams(state) {
  const params = new URLSearchParams();
  if (state.place) params.set('place', state.place);
  if (state.keyword) params.set('keyword', state.keyword);
  params.set('radius', String(state.radius));
  params.set('sort', state.sort);
  if (state.openNow) params.set('openNow', '1');
  if (state.excludeUnknown) params.set('excludeUnknown', '1');
  return params;
}

// ---- 検索実行 ------------------------------------------------------------
async function runSearch(state) {
  if (searching) return;
  searching = true;
  lastState = state;

  // 検索条件を URL に反映（共有・リロード用。現在地の座標は残さない）
  if (state.place && !state.coords) {
    try {
      history.replaceState(null, '', '?' + stateToUrlParams(state).toString());
    } catch (e) {
      /* 無視 */
    }
  }

  show(errorBox, false);
  show(errorDetails, false);
  show(countLine, false);
  resultsEl.innerHTML = '';
  loadingText.textContent = '検索中…';
  show(loading, true);
  submitBtn.disabled = true;

  try {
    // 1) 中心座標の決定（座標指定があれば優先、無ければジオコーディング）
    let origin;
    if (state.coords) {
      origin = { lat: state.coords.lat, lng: state.coords.lng, label: '現在地' };
    } else {
      loadingText.textContent = '場所を検索中…（nominatim.openstreetmap.org）';
      let geo;
      try {
        geo = await geocode(state.place);
      } catch (e) {
        showError(
          '場所の検索（ジオコーディング）に失敗しました。時間をおいて再試行してください。',
          [{ host: 'nominatim.openstreetmap.org', error: (e && e.message) || 'エラー' }]
        );
        return;
      }
      if (!geo) {
        showError('場所が見つかりませんでした');
        return;
      }
      origin = geo;
    }

    // 2) Overpass で周辺要素を取得（ミラーを順に試す）
    let elements;
    try {
      elements = await getOverpassElements(origin.lat, origin.lng, state.radius, {
        onProgress: (host) => {
          loadingText.textContent = `地図データを取得中…（${host}）`;
        },
      });
    } catch (e) {
      showError(
        'お店の検索に失敗しました（地図データサーバーが混雑しているか応答していません）。時間をおいて「再試行」してください。',
        e.attempts
      );
      return;
    }

    // 3) キーワード絞り込み・結果整形
    const resolved = resolveKeyword(state.keyword);
    let results = [];
    for (const el of elements) {
      if (resolved && !elementMatches(el, resolved)) continue;
      const r = buildResult(el, origin);
      if (r) results.push(r);
    }

    // 4) 営業フィルタ
    if (state.openNow) results = results.filter((r) => r.openStatus !== 'closed');
    if (state.excludeUnknown) results = results.filter((r) => r.openStatus !== 'unknown');

    // 5) 並び順
    if (state.sort === 'name') {
      results.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    } else {
      results.sort((a, b) => a.distance - b.distance);
    }

    render({ origin, radius: state.radius, count: results.length, results });
  } catch (e) {
    showError('通信に失敗しました。ネットワークを確認して再試行してください。');
  } finally {
    show(loading, false);
    submitBtn.disabled = false;
    searching = false;
  }
}

function showError(message, attempts) {
  errorMessage.textContent = message;
  errorAttempts.innerHTML = '';
  if (Array.isArray(attempts) && attempts.length) {
    errorAttempts.innerHTML = attempts
      .map((a) => {
        const host = escapeHtml(a.host || a.url || '不明');
        const detail = a.error ? escapeHtml(a.error) : escapeHtml(String(a.status));
        return `<li>${host}: ${detail}</li>`;
      })
      .join('');
    show(errorDetails, true);
  } else {
    show(errorDetails, false);
  }
  show(errorBox, true);
  show(countLine, false);
  resultsEl.innerHTML = '';
}

// ---- 結果描画 ------------------------------------------------------------
function render(data) {
  const results = Array.isArray(data.results) ? data.results : [];
  const origin = data.origin || {};
  const label = origin.label
    ? origin.label.split(',').slice(0, 3).map((x) => x.trim()).join(', ')
    : '指定地点';
  const radius = data.radius || '';

  countLine.textContent = `${data.count || results.length}件見つかりました（中心: ${label}、半径 ${radius}m）`;
  show(countLine, true);

  if (results.length === 0) {
    resultsEl.innerHTML =
      '<div class="empty-state">条件に合うお店が見つかりませんでした。キーワードを変える、距離を広げる、フィルタを外すなどして再検索してください。</div>';
    return;
  }

  resultsEl.innerHTML = results.map(cardHtml).join('');
}

function cardHtml(r) {
  const st = statusLabel(r.openStatus);
  const badges = [`<span class="status-badge ${st.cls}">${st.text}</span>`];
  if (r.kind) badges.push(`<span class="badge kind">${escapeHtml(jaLabel(KIND_JA, r.kind))}</span>`);
  if (Array.isArray(r.cuisine)) {
    r.cuisine.forEach((c) => badges.push(`<span class="badge">${escapeHtml(jaLabel(CUISINE_JA, c))}</span>`));
  }

  const rows = [];
  rows.push(
    `<p class="card-row"><span class="label">住所</span>${r.address ? escapeHtml(r.address) : '住所情報なし'}</p>`
  );
  if (r.openingHours) {
    rows.push(
      `<p class="card-row"><span class="label">営業時間</span><span class="opening-hours">${escapeHtml(r.openingHours)}</span></p>`
    );
  }
  if (r.website && safeHttpUrl(r.website)) {
    rows.push(
      `<p class="card-row"><span class="label">Web</span><a href="${escapeHtml(r.website)}" target="_blank" rel="noopener">${escapeHtml(r.website)}</a></p>`
    );
  }
  if (r.phone) {
    rows.push(
      `<p class="card-row"><span class="label">電話</span><a href="tel:${escapeHtml(r.phone)}">${escapeHtml(r.phone)}</a></p>`
    );
  }

  const links = [];
  if (r.mapsUrl) {
    links.push(
      `<a class="maps-link" href="${escapeHtml(r.mapsUrl)}" target="_blank" rel="noopener">Googleマップで開く</a>`
    );
  }
  if (r.osmUrl) {
    links.push(
      `<a class="osm-link" href="${escapeHtml(r.osmUrl)}" target="_blank" rel="noopener">OSMで見る</a>`
    );
  }

  return (
    `<article class="card">` +
    `<div class="card-head">` +
    `<h2 class="card-name">${escapeHtml(r.name)}</h2>` +
    `<span class="card-distance">${escapeHtml(formatDistance(r.distance))}</span>` +
    `</div>` +
    `<div class="badges">${badges.join('')}</div>` +
    rows.join('') +
    `<div class="card-links">${links.join('')}</div>` +
    `</article>`
  );
}

// ---- 現在地 --------------------------------------------------------------
function useLocation() {
  if (!navigator.geolocation) {
    geoStatus.textContent = 'このブラウザは現在地取得に対応していません。';
    return;
  }
  geoStatus.textContent = '現在地を取得しています…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      currentCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      geoStatus.textContent = '現在地を使用します（場所入力より優先されます）。';
    },
    (err) => {
      currentCoords = null;
      const msg =
        err && err.code === 1
          ? '現在地の利用が許可されませんでした。'
          : '現在地を取得できませんでした。';
      geoStatus.textContent = msg;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// 場所入力を変更したら現在地指定は解除
placeInput.addEventListener('input', () => {
  if (currentCoords) {
    currentCoords = null;
    geoStatus.textContent = '';
  }
});

// ---- イベント ------------------------------------------------------------
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const { state, error } = collectState();
  if (error) {
    showError(error);
    return;
  }
  runSearch(state);
});

useLocationBtn.addEventListener('click', useLocation);

retryBtn.addEventListener('click', () => {
  if (lastState) runSearch(lastState);
});

// ---- URL クエリによる初期化（prefill + 自動検索） ------------------------
function prefillFromUrl() {
  const sp = new URLSearchParams(window.location.search);
  let hasPlace = false;
  if (sp.has('place')) {
    placeInput.value = sp.get('place');
    hasPlace = true;
  }
  if (sp.has('keyword')) keywordInput.value = sp.get('keyword');
  if (sp.has('radius') && radiusSelect.querySelector(`option[value="${sp.get('radius')}"]`)) {
    radiusSelect.value = sp.get('radius');
  }
  if (sp.has('sort') && sortSelect.querySelector(`option[value="${sp.get('sort')}"]`)) {
    sortSelect.value = sp.get('sort');
  }
  if (sp.get('openNow') === '1') openNowCheck.checked = true;
  if (sp.get('excludeUnknown') === '1') excludeUnknownCheck.checked = true;

  // 場所が指定されていれば自動検索（座標は URL に残さない仕様）
  if (hasPlace) {
    const { state } = collectState();
    if (state) runSearch(state);
  }
}

// ---- 起動 ----------------------------------------------------------------
prefillFromUrl();

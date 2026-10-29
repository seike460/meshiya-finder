// ページ最下部の広告枠（1 つだけ）。自動広告・アンカー・モバイル全画面広告は使わない。
// 広告の読み込み失敗・広告ブロッカーでアプリが壊れないよう、すべて try/catch で握りつぶす。
import { ADSENSE_CLIENT, AD_SLOT } from './ads-config.js';

const LOADER_BASE = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';

function injectLoader() {
  if (!/^ca-pub-\d+$/.test(ADSENSE_CLIENT)) return false;
  if (document.querySelector('script[data-mf-adsense-loader]')) return true;
  const s = document.createElement('script');
  s.async = true;
  s.src = `${LOADER_BASE}?client=${encodeURIComponent(ADSENSE_CLIENT)}`;
  s.crossOrigin = 'anonymous';
  s.setAttribute('data-mf-adsense-loader', '');
  s.onerror = () => {}; // ブロックされても何もしない
  document.head.appendChild(s);
  return true;
}

function renderSlot(box) {
  const slot = String(AD_SLOT || '').trim();
  if (!/^\d+$/.test(slot)) return; // スロット未設定: ラベルだけの枠を残す（無効な ins は push しない）
  const wide = window.matchMedia('(min-width: 768px)').matches;
  const [w, h] = wide ? [728, 90] : [320, 100];
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.style.display = 'inline-block';
  ins.style.width = `${w}px`;
  ins.style.height = `${h}px`;
  ins.setAttribute('data-ad-client', ADSENSE_CLIENT);
  ins.setAttribute('data-ad-slot', slot);
  box.appendChild(ins);
  (window.adsbygoogle = window.adsbygoogle || []).push({});
}

try {
  const box = document.getElementById('ad-box');
  if (box && injectLoader()) renderSlot(box);
} catch (e) {
  /* 広告の失敗はアプリに影響させない */
}

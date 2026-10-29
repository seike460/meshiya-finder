'use strict';

/**
 * 日本語キーワード → OSM の cuisine 値 / 追加 amenity / 店名部分一致 の対応表。
 *
 * 各エントリ:
 *   cuisines   : マッチ対象の cuisine 値（OSM は英語表記）
 *   amenities  : マッチ対象の追加 amenity 値（例: 居酒屋 → pub/bar）
 *   names      : 店名（name / name:ja / name:en）に含まれていればマッチする部分文字列
 *
 * 変換表にないキーワードは「店名の部分一致」または「cuisine の部分一致」で検索する。
 */
export const KEYWORD_MAP = {
  'ラーメン': { cuisines: ['ramen', 'noodle'] },
  '寿司': { cuisines: ['sushi'] },
  'すし': { cuisines: ['sushi'] },
  '焼肉': { cuisines: ['yakiniku', 'barbecue', 'korean_barbecue'] },
  'うどん': { cuisines: ['udon'] },
  'そば': { cuisines: ['soba'] },
  'カレー': { cuisines: ['curry', 'indian'] },
  '焼き鳥': { cuisines: ['yakitori'] },
  '焼鳥': { cuisines: ['yakitori'] },
  '天ぷら': { cuisines: ['tempura'] },
  'てんぷら': { cuisines: ['tempura'] },
  'とんかつ': { cuisines: ['tonkatsu'] },
  '丼': { cuisines: ['donburi'] },
  '定食': { cuisines: ['japanese', 'teishoku'], names: ['定食'] },
  '居酒屋': { cuisines: ['izakaya'], amenities: ['pub', 'bar', 'izakaya'], names: ['居酒屋'] },
  'カフェ': { cuisines: ['coffee_shop'], amenities: ['cafe'] },
  'ハンバーガー': { cuisines: ['burger'] },
  'ピザ': { cuisines: ['pizza'] },
  '中華': { cuisines: ['chinese'] },
  'イタリアン': { cuisines: ['italian'] },
  '韓国': { cuisines: ['korean'] },
  'もつ鍋': { cuisines: ['motsunabe'] },
  'お好み焼き': { cuisines: ['okonomiyaki'] },
};

/**
 * キーワードを検索条件に解決する。
 * @param {string} keyword
 * @returns {{keyword:string, mapped:boolean, cuisines:string[], amenities:string[], names:string[]}|null}
 */
export function resolveKeyword(keyword) {
  if (!keyword) return null;
  const kw = String(keyword).trim();
  if (!kw) return null;
  const entry = KEYWORD_MAP[kw];
  if (entry) {
    const names = [kw, ...(entry.names || [])];
    return {
      keyword: kw,
      mapped: true,
      cuisines: (entry.cuisines || []).map((c) => c.toLowerCase()),
      amenities: (entry.amenities || []).map((a) => a.toLowerCase()),
      names: dedupe(names),
    };
  }
  // 変換表にない語: 店名部分一致 ＋ cuisine 部分一致
  return {
    keyword: kw,
    mapped: false,
    cuisines: [kw.toLowerCase()],
    amenities: [],
    names: [kw],
  };
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}

/**
 * Overpass で取得した要素がキーワード条件にマッチするか判定する。
 * cuisine は ';' 区切り・大文字小文字無視。
 * 変換表にない語は cuisine の部分一致も許可する。
 * @param {object} el Overpass element（tags を持つ）
 * @param {object} resolved resolveKeyword() の戻り値
 */
export function elementMatches(el, resolved) {
  if (!resolved) return true;
  const tags = (el && el.tags) || {};

  // 店名マッチ（name / name:ja / name:en）
  const names = [tags.name, tags['name:ja'], tags['name:en']]
    .filter(Boolean)
    .map((n) => n.toLowerCase());
  if (names.length) {
    for (const sub of resolved.names) {
      const s = sub.toLowerCase();
      if (names.some((n) => n.includes(s))) return true;
    }
  }

  // cuisine マッチ
  if (tags.cuisine) {
    const cuisineVals = tags.cuisine
      .split(';')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    if (resolved.mapped) {
      if (resolved.cuisines.some((c) => cuisineVals.includes(c))) return true;
    } else {
      // 未マッピング語は部分一致
      if (resolved.cuisines.some((c) => cuisineVals.some((v) => v.includes(c)))) {
        return true;
      }
    }
  }

  // 追加 amenity マッチ（例: 居酒屋 → pub/bar/izakaya, カフェ → cafe）
  if (resolved.amenities.length && tags.amenity) {
    if (resolved.amenities.includes(String(tags.amenity).toLowerCase())) return true;
  }

  return false;
}

export default { KEYWORD_MAP, resolveKeyword, elementMatches };

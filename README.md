# 飯屋ファインダー（静的・サーバーレス版）

地名・駅名とキーワード（ラーメン、寿司など）から、周辺の実在する飲食店を検索して一覧表示する小さな Web アプリです。**サーバーを持たず、ブラウザから OpenStreetMap 系 API（Nominatim / Overpass）を直接呼び出す**完全静的サイトとして、GitHub Pages で公開できます。

## 概要

- データソースは **OpenStreetMap（OSM）**。API キー不要・無料で利用できます。
  - 場所の検索（ジオコーディング）に **Nominatim**、店舗の検索に **Overpass API** を使用します。
- サーバーサイドのコードはありません。すべてブラウザ上の ES モジュール（`js/*.js`）で動作します。
- 営業時間の判定には [opening_hours.js](https://github.com/opening-hours/opening_hours.js) をローカルにバンドルした `vendor/opening_hours.js` を使用します（**実行時に CDN へアクセスしません**）。
- 日本語 UI・スマホ対応。地図データの出典（© OpenStreetMap contributors / ODbL）を画面に明記します。

## 公開 URL

<https://seike460.github.io/meshiya-finder/>

GitHub Pages で `/` ではなくサブパス（`/meshiya-finder/`）配信になるため、HTML/CSS/JS 内のパスはすべて**相対パス**（先頭に `/` を付けない）にしています。

## ローカルでの動かし方

ES モジュールを使用しているため、`file://` では動きません（CORS 制約）。簡易 HTTP サーバーで配信してください。

```
cd meshiya-finder-static
python3 -m http.server 8000
```

ブラウザで <http://localhost:8000/> を開きます。

## vendor（opening_hours）の再生成

`vendor/opening_hours.js` は `npm run build:vendor` で生成済みのものをコミットしています。依存を更新したいときのみ再生成してください。

```
npm install
npm run build:vendor
```

`build:vendor` は esbuild で `opening_hours`（および依存の i18next / suncalc）を 1 ファイルの ES モジュール（default export）にバンドルし、ミニファイ＋ライセンスバナー付きで `vendor/opening_hours.js` に出力します。

## 機能

- **場所指定**: 地名・駅名を Nominatim でジオコーディング。「現在地を使う」ボタン（ブラウザの Geolocation）にも対応（場所入力より優先）。
- **キーワード**: 店名・cuisine タグにマッチ。日本語キーワードは OSM の cuisine 値などへ変換（下記対応表）。変換表にない語は店名・cuisine の部分一致で検索。
- **対象施設**: `amenity=restaurant / fast_food / cafe / food_court / pub / bar / izakaya` を半径内で取得（node / way / relation、way・relation は中心点を使用）。
- **フィルタ**: 最大距離（500m / 1km / 3km / 5km、既定 1km）、営業中のみ（営業時間外のみ除外）、営業時間不明を除外。
- **並び順**: 距離順（既定）／名前順。
- **結果カード**: 店名、ジャンル（種別・cuisine）、距離、住所（無い場合は「住所情報なし」）、営業時間（原文）と営業中／営業時間外／不明バッジ、Web・電話（あれば）、「Googleマップで開く」「OSMで見る」リンク。
- **営業状況**: `opening_hours.js` でブラウザの現在時刻に対して判定（解析不能・未登録は「営業時間不明」）。
- **URL 連携**: `place` / `keyword` / `radius` / `sort` / `openNow` / `excludeUnknown` を URL クエリで prefill し自動検索。`history.replaceState` で共有可能な URL を生成します（**座標は URL に残しません**）。
- **エラー表示**: 全ミラー失敗・ジオコーディング失敗・場所が見つからない等を赤いボックスで日本語表示し、「再試行」ボタンで同じ条件を再実行できます。各ミラーの試行結果は `<details>` に表示します。

## キーワード対応表

日本語キーワードを OSM の `cuisine` 値（必要に応じて追加 `amenity` や店名部分一致）に変換します。対応表にない語は店名・cuisine の部分一致で検索します。

| キーワード | 変換先（cuisine / amenity / 店名） |
| --- | --- |
| ラーメン | ramen, noodle |
| 寿司 / すし | sushi |
| 焼肉 | yakiniku, barbecue, korean_barbecue |
| うどん | udon |
| そば | soba |
| カレー | curry, indian |
| 焼き鳥 / 焼鳥 | yakitori |
| 天ぷら / てんぷら | tempura |
| とんかつ | tonkatsu |
| 丼 | donburi |
| 定食 | cuisine=japanese/teishoku＋店名「定食」 |
| 居酒屋 | cuisine=izakaya＋amenity=pub/bar/izakaya＋店名「居酒屋」 |
| カフェ | cuisine=coffee_shop＋amenity=cafe |
| ハンバーガー | burger |
| ピザ | pizza |
| 中華 | chinese |
| イタリアン | italian |
| 韓国 | korean |
| もつ鍋 | motsunabe |
| お好み焼き | okonomiyaki |

対応表の定義は `js/keywords.js` にあります。

## データの制約

- OSM には **評価・レビュー数・価格帯がありません**（本静的版では Google Places モードを廃止しています）。
- 営業時間（`opening_hours`）や住所（`addr:*`）の**登録率は店舗によってばらつきます**。未登録の場合は「営業時間不明」「住所情報なし」と表示します。
- 店舗の掲載状況は地域によってカバレッジが異なります。本アプリの結果は網羅的ではありません。

## 利用 API とマナー

ブラウザから公共の無料サービスを直接呼び出します。過度な負荷をかけないよう、以下に配慮しています。

- **Nominatim**（ジオコーディング）
  - ブラウザは `User-Agent` を設定できないため、**Referer による識別**に任せ、独自ヘッダは付けません（CORS プリフォルト回避）。メールアドレス等の個人情報も一切送りません。
  - **1 秒あたり 1 リクエスト以下**にクライアント側でスロットリング（直列化＋リクエスト間隔 1,100ms 以上）。直近リクエスト時刻を `localStorage` に保存し、リロード直後の連打も防ぎます。
  - 結果は `localStorage`（`mf:geo:`）に 24 時間キャッシュ（ヒットなしは 1 時間）。大量・業務用途には使えません（個人・非商用）。
- **Overpass API**（店舗検索）
  - 同一条件の結果を `sessionStorage`（`mf:ovp:`）に約 10 分キャッシュ。クエリは **GET + `?data=`**（単純リクエスト）でプリフライトを避けます。
  - 複数ミラーを順にフォールバック（`overpass-api.de` → `overpass.private.coffee` → `maps.mail.ru`）。タイムアウト／429／406／5xx／非 JSON 時は短いバックオフ（1s → 2s）後に次のミラーへ。**並列リクエストはしません**。
  - 直近 30 秒以内に 429/406 を返したミラーは次へスキップします（`sessionStorage` で記録）。
  - メインインスタンス（`overpass-api.de`）は混雑しており、**低頻度利用・キャッシュ・429/406 後の待機**が求められています。本アプリはこれに従います。

## 出典・ライセンス

- 地図データ: © OpenStreetMap contributors（[ODbL](https://www.openstreetmap.org/copyright)）
- 本アプリのコード: MIT License（`LICENSE` 参照 / Copyright (c) 2026 seike460）
- 同梱ライブラリ `vendor/opening_hours.js`（opening_hours: LGPL-3.0-only、i18next: MIT、suncalc: BSD-2-Clause）: `vendor/licenses/` 参照
- `vendor/opening_hours.js`: [opening_hours.js](https://github.com/opening-hours/opening_hours.js)（LGPL-3.0）をバンドルしたもの

## ファイル構成

```
meshiya-finder-static/
├── index.html           画面のマークアップ（相対パスのみ）
├── css/
│   └── style.css        スタイル
├── js/
│   ├── keywords.js      日本語キーワード → OSM cuisine 等の対応表と判定ロジック（ESM）
│   ├── osm.js           Nominatim / Overpass 呼び出し・キャッシュ・結果整形（ESM）
│   └── app.js           UI・検索フロー・描画・現在地・エラー処理（ESM エントリ）
├── vendor/
│   └── opening_hours.js opening_hours.js をバンドルした ES モジュール（CDN 不使用）
├── build/
│   └── vendor-entry.js  build:vendor の esbuild エントリ
├── package.json         devDependencies（esbuild / opening_hours）と build:vendor
├── .nojekyll            GitHub Pages で Jekyll 処理を無効化
├── README.md
├── REQUIREMENTS.md      要件メモ（静的版）
└── LICENSE              MIT
```

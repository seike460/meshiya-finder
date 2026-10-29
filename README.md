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
  - 軽量クエリ: 半径内の飲食 amenity を 1 回だけ空間検索し、キーワードがあれば cuisine / 店名 / 追加 amenity で**サーバー側で絞り込み**（`[timeout:20][maxsize:32MB]`、`out center qt`）。
  - **ヘッジ要求**: `overpass-api.de` → 2.5 秒応答が無ければ `overpass.private.coffee` → さらに 2.5 秒で `maps.mail.ru` を起動し、最初に成功した応答を採用して残りは AbortController で中断します。各要求のタイムアウトは 25 秒、全体は 28 秒で打ち切り。1 ミラーへの同時要求は 1 本だけです。即座に返る 502/503/504 は 2 秒後に 1 回だけ再試行します。
  - 直近 30 秒以内に 429/406 を返したミラーはスキップ、直近 2 分以内に timeout/5xx だったミラーは順番を後ろへ回します（`sessionStorage` で記録）。
- **簡易検索（フォールバック、キー不要）**
  - Overpass が 5 秒以内に返らない場合、並行して [OpenFreeMap](https://openfreemap.org/) のベクタータイル（z14 の `poi` レイヤ）と Nominatim（cuisine 英語名・キーワード、`viewbox` + `bounded`）で検索を始め、先に結果が出れば暫定表示します。Overpass が成功すれば自動で置き換え、Overpass が全滅した場合は簡易検索の結果を注記付きで表示します。
  - 簡易検索は主に店名・種別で探すため、店名にキーワードを含まないお店（cuisine タグのみ）は漏れることがあり、営業時間も Nominatim で取れたもの以外は「営業時間不明」になります。
  - メインインスタンス（`overpass-api.de`）は混雑しており、**低頻度利用・キャッシュ・429/406 後の待機**が求められています。本アプリはこれに従います。

## 広告（Google AdSense）

ページ最下部に**小さな広告枠を 1 つだけ**置いています（スマホ 320×100 / PC 728×90 の固定サイズ、中央寄せ・はみ出しは非表示）。検索フォームや結果を覆ったりずらしたりしません。広告の読み込み失敗や広告ブロッカーがあってもアプリは通常どおり動きます（`js/ads.js` はすべて try/catch）。

- **設定は `js/ads-config.js` の 2 つの定数だけ**です。パブリッシャー ID はリポジトリ内でここにしか書きません。`adsbygoogle.js` の読み込みタグ（`?client=…`、`crossorigin="anonymous"`）は `js/ads.js` がこの定数から生成します。
  - `ADSENSE_CLIENT`: パブリッシャー ID（例 `ca-pub-XXXXXXXXXXXXXXXX`）。**別アカウント（例: 46giken）の ID に切り替えるときはこの値だけを書き換えて**コミット・push してください。
  - `AD_SLOT`: 広告ユニットのスロット ID（数字）。空（`''`）の間は広告を出さず、薄い「広告」ラベルの枠だけを表示します（無効な広告要求は送りません）。
- **スロット ID の設定手順**: AdSense 管理画面 → 広告 → 広告ユニットごと → 「ディスプレイ広告」を作成（サイズは「固定」、320×100 推奨）→ 表示されるコードの `data-ad-slot="1234567890"` の数字を `AD_SLOT = '1234567890'` に設定。
- **自動広告・アンカー広告・モバイル全画面（ビネット）広告は必ず OFF のまま**にしてください（AdSense 管理画面 → 広告 → サイトごと → 自動広告を無効）。本サイトはページ単位・自動広告のスニペットを入れていませんが、読み込みタグがあるため、管理画面で自動広告を ON にすると自動で広告が挿入されてしまいます。
- **ads.txt はこのリポジトリには置きません**。ads.txt はドメインのルート（`https://seike460.github.io/ads.txt`）でしか有効にならず、プロジェクトサイト（`/meshiya-finder/`）配下では意味がありません。必要ならユーザーサイト用リポジトリ（`seike460/seike460.github.io`）のルートに置いてください。

## 出典・ライセンス

- 地図データ: © OpenStreetMap contributors（[ODbL](https://www.openstreetmap.org/copyright)）
- 本アプリのコード: MIT License（`LICENSE` 参照 / Copyright (c) 2026 seike460）
- 同梱ライブラリ `vendor/opening_hours.js`（opening_hours: LGPL-3.0-only、i18next: MIT、suncalc: BSD-2-Clause）、`vendor/vector-tile.js`（@mapbox/vector-tile・pbf: BSD-3-Clause、@mapbox/point-geometry: ISC）: `vendor/licenses/` 参照
- フォールバック用タイル: [OpenFreeMap](https://openfreemap.org/)（OpenMapTiles スキーマ、データは © OpenStreetMap contributors）
- `vendor/opening_hours.js`: [opening_hours.js](https://github.com/opening-hours/opening_hours.js)（LGPL-3.0）をバンドルしたもの

## ファイル構成

```
meshiya-finder-static/
├── index.html           画面のマークアップ（相対パスのみ）
├── css/
│   └── style.css        スタイル
├── js/
│   ├── keywords.js      日本語キーワード → OSM cuisine 等の対応表と判定ロジック（ESM）
│   ├── ads-config.js    AdSense のパブリッシャー ID / スロット ID（唯一の設定場所）
│   ├── ads.js           最下部の広告枠 1 つを描画（失敗してもアプリに影響しない）
│   ├── osm.js           Nominatim / Overpass 呼び出し・キャッシュ・結果整形（ESM）
│   └── app.js           UI・検索フロー・描画・現在地・エラー処理（ESM エントリ）
├── vendor/
│   ├── opening_hours.js opening_hours.js をバンドルした ES モジュール（CDN 不使用）
│   └── vector-tile.js   ベクタータイル（MVT）デコーダ（フォールバック検索用）
├── build/
│   ├── vendor-entry.js  build:vendor:oh の esbuild エントリ
│   └── vector-tile-entry.js build:vendor:vt の esbuild エントリ
├── package.json         devDependencies（esbuild / opening_hours / @mapbox/vector-tile / pbf）と build:vendor
├── .nojekyll            GitHub Pages で Jekyll 処理を無効化
├── README.md
├── REQUIREMENTS.md      要件メモ（静的版）
└── LICENSE              MIT
```

# 飯屋ファインダー 要件メモ（静的・サーバーレス版）

## 1. 目的
地名・駅名とキーワード（ラーメン、寿司など）から、周辺の実在する飲食店を検索して一覧表示する小さな Web アプリ。API キー不要・無料の OpenStreetMap（OSM）データを主データソースとし、**サーバーを持たない完全静的サイト**として GitHub Pages で公開する。

## 2. 構成方針（静的版の前提）
- **サーバーレス**: バックエンドを持たず、ブラウザ上の ES モジュール（`js/*.js`）から Nominatim / Overpass API を**直接**呼び出す。GitHub Pages で配信。
- **サブパス配信**: 公開 URL は `https://seike460.github.io/meshiya-finder/`。アセット・リンクのパスはすべて**相対パス**（先頭に `/` を付けない）。
- **CORS とプリフライト回避**:
  - 独自ヘッダ（`User-Agent` 等）はブラウザから設定できず、付けると CORS プリフライトを誘発するため**付けない**。サービス側は `Referer` で識別する。
  - Overpass は **GET + `?data=<encodeURIComponent(query)>`** の単純リクエストにしてプリフライトを避ける。
- **opening_hours のバンドル**: 営業時間判定ライブラリ opening_hours.js（依存 i18next / suncalc 含む）を esbuild で 1 ファイルの ES モジュール（default export）にバンドルし `vendor/opening_hours.js` としてコミット。**実行時に CDN へアクセスしない**。
- **API キー・個人情報を持たない**: コード・リポジトリ・通信のいずれにもメールアドレスや API キーを含めない。

## 3. 機能要件
- **検索条件**
  - 場所（地名・駅名）: Nominatim でジオコーディングして中心座標を取得。
  - 「現在地を使う」ボタン（任意）: ブラウザの Geolocation で中心座標を取得（場所入力より優先）。
  - キーワード: 店名・cuisine タグにマッチ。日本語キーワードは OSM の cuisine 値などに変換（ラーメン→ramen、寿司→sushi、焼肉→yakiniku/barbecue、うどん→udon、そば→soba、カレー→curry/indian、焼き鳥→yakitori、天ぷら→tempura、とんかつ→tonkatsu、丼→donburi、定食→japanese/teishoku＋店名「定食」、居酒屋→cuisine=izakaya＋amenity=pub/bar/izakaya＋店名「居酒屋」、カフェ→coffee_shop/cafe、ハンバーガー→burger、ピザ→pizza、中華→chinese、イタリアン→italian、韓国→korean 等）。変換表にない語は店名・cuisine の部分一致で検索。
- **対象施設**: Overpass API で `amenity=restaurant / fast_food / cafe / food_court / pub / bar / izakaya` を中心から半径内で取得（`nwr` ＝ node / way / relation、way・relation は `out center` の中心点を使用）。
- **フィルタ**
  - 最大距離（500m / 1km / 3km / 5km、既定 1km。Overpass の検索半径にも使用）。
  - 営業中のみ（opening_hours を解析できる店のみ判定。営業時間外の店は除外するが、解析不能・未登録の店は既定では除外せず「営業時間不明」バッジ付きで表示）。
  - 営業時間不明の店を除外（別トグル）。
- **並び順**: 距離順（既定）／名前順。
- **営業状況判定**: `new opening_hours(value, {address:{country_code:'jp'}})` を try/catch で評価し、`getState()` で open / closed を判定（例外時は unknown）。**ユーザーのブラウザ現在時刻**に対して評価する。
- **結果カード表示項目**: 店名、ジャンル（cuisine・種別、KIND_JA / CUISINE_JA で日本語化）、距離（m / km）、住所（`addr:*` から組立。無い場合は「住所情報なし」）、営業時間（opening_hours 原文）と営業中／営業時間外／不明バッジ、Web サイト（http(s) のみ）・電話（あれば）、「Googleマップで開く」リンク（`https://www.google.com/maps/search/?api=1&query=<店名> <緯度>,<経度>`、target=_blank rel=noopener）、「OSMで見る」リンク。
- 件数表示（中心ラベルは先頭 3 カンマ要素に短縮）、0 件時のメッセージ、エラー表示。
- **URL 連携**: `place` / `keyword` / `radius` / `sort` / `openNow` / `excludeUnknown` を URL クエリで prefill し自動検索。`history.replaceState` で共有 URL を生成。**座標は URL に残さない**。
- 出典表示: 「地図データ © OpenStreetMap contributors（ODbL）」および「検索: Nominatim / Overpass API」をフッターに明記。

## 4. 非機能要件 / 耐障害性
- **外部 API 利用マナー**
  - **Nominatim**: 独自ヘッダを付けず Referer による識別に任せる（ブラウザは UA を設定できない）。**1 秒 1 リクエスト以下**にクライアント側でスロットリング（直列化＋間隔 1,100ms 以上、直近リクエスト時刻を `localStorage` に保存しリロード直後の連打も防止）。結果を `localStorage`（`mf:geo:`）に 24 時間キャッシュ（ヒットなしは 1 時間）。**最大 1 req/s・重い利用は不可、個人・非商用**という利用方針に従う。
  - **Overpass**: GET + `?data=` の単純リクエスト。同一条件（lat/lng を小数 4 桁に丸め＋radius をキー）の結果を `sessionStorage`（`mf:ovp:`）に約 10 分キャッシュ。容量超過時は `mf:ovp:` エントリを掃除して再試行（try/catch で保護）。
  - **Overpass 耐障害性（ヘッジ要求）**: `overpass-api.de` → 2.5 秒で `overpass.private.coffee` → 2.5 秒で `maps.mail.ru` をずらして起動し、最初の成功を採用・残りは AbortController で中断（各 25 秒、全体 28 秒）。1 ミラーへの同時要求は 1 本。即時の 502/503/504 は 2 秒後に 1 回だけ再試行。直近 30 秒以内に 429/406 のミラーはスキップ、直近 2 分以内に timeout/5xx のミラーは後回し。クエリは半径内の飲食 amenity を 1 回だけ空間検索し、キーワードは cuisine / 店名でサーバー側絞り込み（`[timeout:20][maxsize:32MB]`、`out center qt`）。開発時のみ `js/osm.js` の定数 `OVERPASS_OVERRIDE` で上書き可（URL パラメータでの上書きは受け付けない）。
  - **簡易検索フォールバック（キー不要）**: Overpass が 5 秒以内に返らなければ OpenFreeMap ベクタータイル（z14 `poi` レイヤ、ACAO *）と Nominatim（viewbox + bounded、1 秒 1 リクエスト以下）で並行検索し、先に出た結果を暫定表示。Overpass 成功で置き換え、全滅時は簡易検索結果を「簡易検索の結果」注記付きで表示（店名ベースのため漏れあり・営業時間が欠ける場合あり）。
  - **メインインスタンスは混雑**しており、低頻度利用・キャッシュ・429/406 後の待機が求められている旨に従う。短時間の大量検索は避ける。
  - Overpass・簡易検索とも失敗した場合は分かりやすい日本語エラーと「再試行」ボタンを表示し、同じ条件で再検索できる。各ミラーの試行結果（host + status / timeout）を `<details>` に表示。
- **進捗表示**: 検索中はどのミラーを試行中かを示すテキスト（例: 「地図データを取得中…（overpass-api.de）」）を表示。
- **UI**: 日本語、スマホ対応（幅 360〜390px で横スクロールが出ないよう長い URL・住所・営業時間を `overflow-wrap:anywhere` で折り返し、入力は `width:100%` + `box-sizing:border-box`、`flex-wrap` を使用。`<meta name="viewport">` 設定）。HTML エスケープ徹底。`[hidden]{display:none !important}`。
- **データの限界**: OSM には評価・レビュー数・価格帯が無く、営業時間や住所の登録率も店舗によりばらつく旨を README に明記。

## 5. 変更点（旧サーバー版からの差分）
- Node.js の HTTP サーバー兼プロキシ（`server.js`）を廃止し、処理をすべてブラウザへ移行。
- **Google Places モードを完全に廃止**（最低評価フィルタ・評価順・API キー関連コードを削除）。
- サーバー側ファイルキャッシュ／メモリキャッシュを、ブラウザの `localStorage` / `sessionStorage` に置き換え。
- Nominatim のスロットリング・Overpass のフォールバックをクライアント側で再実装。

## 6. 対象外
- ユーザー登録、お気に入り保存、地図埋め込み表示（今後の課題）。

## 7. 今後の課題
- 地図表示（Leaflet＋OSM タイル）、検索結果のページング、キャッシュの永続化・共有。

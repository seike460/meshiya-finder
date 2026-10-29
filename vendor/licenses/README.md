# vendor/ 以下の同梱ライブラリについて

`vendor/opening_hours.js` は以下のライブラリを esbuild で 1 ファイルにまとめたものです（`npm install && npm run build:vendor` で再生成できます）。

| ライブラリ | バージョン | ライセンス | ソース |
|---|---|---|---|
| opening_hours | 3.15.0 | LGPL-3.0-only（`opening_hours-LGPL-3.0-only.txt`。LGPL は GPL-3.0 https://www.gnu.org/licenses/gpl-3.0.txt を参照） | https://github.com/opening-hours/opening_hours.js |
| i18next | 26.5.11 | MIT（`i18next-LICENSE.txt`） | https://github.com/i18next/i18next |
| suncalc | 2.1.1 | BSD-2-Clause（`suncalc-LICENSE.txt`） | https://github.com/mourner/suncalc |

`vendor/vector-tile.js` は OpenFreeMap のベクタータイル（フォールバック検索用）を読むためのバンドルです。

| ライブラリ | バージョン | ライセンス | ソース |
|---|---|---|---|
| @mapbox/vector-tile | 2.0.5 | BSD-3-Clause（`mapbox-vector-tile-LICENSE.txt`） | https://github.com/mapbox/vector-tile-js |
| @mapbox/point-geometry | 1.1.0 | ISC（`mapbox-point-geometry-LICENSE.txt`） | https://github.com/mapbox/point-geometry |
| pbf | 4.0.2 | BSD-3-Clause（`pbf-LICENSE.txt`） | https://github.com/mapbox/pbf |

バンドルは改変していません。差し替える場合は `package.json` のバージョンを変えて `npm run build:vendor` を実行してください。

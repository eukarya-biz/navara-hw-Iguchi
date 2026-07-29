# 波の描写 — Shore Waves on Navara

地図の上に**打ち寄せて引く波**を描く。Product Group Skill Up 課題の提出物。

海岸線の位置は地形データから取る。Navara が海面の描画に使っているのと同じ quantized-mesh の **watermask** 拡張を起動時に読み、そこから **signed distance field**（海岸線からの符号つき距離）を作って波を駆動している。海岸線の形を実装側に持っていないので、砂浜が曲がっていればその形に沿って波が来る。

## 特徴

- **実際の海岸線に沿う波** — watermask から signed distance field を起動時に生成し、その距離で波を駆動する。海岸線の形は地図データが持っている
- **1波ずつ処理するモデル** — 1つの波が浜へ駆け上がり、引き切ってから次が来る。1波の周期 7.5 秒、全体は 60 秒でループ
- **濡れた砂が残る** — 波が到達した位置に濡れ跡が残り、波と一緒に動かず、その場で減衰する（時定数 18 秒）
- **時刻 t の純関数** — 時間依存の項をすべて 60 秒周期の関数にしてあるので、任意の t へ飛んでも同じフレームが再現される（フレーム書き出し・シームレスループが成立する）
- **ランタイムの調整 UI** — `toneMappingExposure` と波の uniform をスライダーで変更できる。現在値の一覧出力つき
- **カメラ値の表示** — `camera.positionGeographic` / `camera.orientation` を常時表示

## 仕様

| 項目 | 値 | 備考 |
|---|---|---|
| 波の周期 | 7.5 秒 | 1波が駆け上がって引き切るまで |
| ループ長 | 60 秒 | 周期 7.5 秒 × 8 波 |
| 波の間隔 | 31 m | 沖へ向かって繰り返す |
| 表示する波の本数 | 岸から 1.5 本ぶん | それより沖では消える |
| 駆け上がりの距離 | 最大 4 m | 波ごとに強度が変わる |
| 描画する範囲 | 汀線から沖 80 m | それより沖は透明 |
| 濡れた砂の減衰 | 時定数 18 秒 | 直近 4 波の到達線を保持 |
| distance field の解像度 | 1 px ≈ 4.5 m | watermask（1タイル 256×256）を zoom 14 で取得 |
| distance field の範囲 | 6×6 タイル ≒ 6.6 km 角 | **起動時に `SHOT.camera` の位置を中心に1回だけ生成する。カメラが動いても作り直さないため、この範囲の外に波は出ない**（境界では透明にフェードする） |
| 海面の標高（`SEA_LEVEL`） | 27.6 m | 下記 |
| 太陽位置 | JST 15:00 固定 | `atmosphere.date` |

### 海面の標高について

この地形データの標高は楕円体高で、EGM2008 のジオイド起伏を含む。そのため海面は標高 0 ではなくジオイド高の位置に来る。`SEA_LEVEL` はその測定値で、初期画角の周辺で外洋だけを含む地形タイルの `minimumHeight` = `maximumHeight` が 27.34〜27.66 m だったことから 27.6 m としている。

ジオイド高は場所によって変わるため、この値が正しいのは初期画角の周辺のみ。遠くの海岸へ移す場合は同じ方法で測り直して `SEA_LEVEL` を差し替える。

## 使った Navara の機能

| API / 機能 | 使い方 |
|---|---|
| `addSource` / `addLayer`（`raster-tile`） | 地理院タイルの航空写真を basemap に |
| `addSource` / `addLayer`（`quantized-mesh` / `terrain`） | Re:Earth Terrain。`requestVertexNormals` と `requestWaterMask` を有効化 |
| `requestWaterMask` | 波の基準になる watermask。地形タイルを実行時にパースして取り出している |
| `registerMesh` / `addMesh`（`MeshDesc`） | 波を `ShaderMaterial` のカスタムメッシュとして登録・配置 |
| `getPassKey()` → `"transparent"` | 波を transparent パスに置く |
| `geodeticToVector3` / `eastNorthUpToFixedFrame` | 緯度経度から ENU frame を作り、波の plane をメートル単位で組む |
| `addEffect`（`ssr`） | SSR（screen space reflection） |
| `addDefaultPhotorealScene` | sun / sky / stars / aerial perspective / lens flare / tone mapping / SMAA |
| `atmosphere.date` | 太陽位置（現地時間 15:00 に固定） |
| `toneMappingExposure` | 露出（UI から変更可） |
| `setCamera` / `camera.positionGeographic` / `camera.orientation` | 初期画角の設定と現在値の読み出し |
| `attribution.add` | attribution UI |

## セットアップ

Node.js 18+ / pnpm

```bash
pnpm i
pnpm dev     # http://localhost:8080/
pnpm build
```

### 操作

- ドラッグ / スクロールでカメラを動かせる（初期画角は `src/main.ts` の `SHOT.camera`）。ただし波が出るのは起動時に生成した範囲内だけ（下記「仕様」参照）
- **`L`** — 右上の調整パネル（exposure と波の uniform）を開閉。「今の値を出力」で現在値を一覧表示
- **`H`** — 左下のカメラパネルを開閉
- 録画・スクリーンショット時は `?ui=0&look=0` を付けて開くと両方のパネルが非表示で始まる

## プロジェクト構成

```
src/
├── main.ts         初期化・source/layer 宣言・カメラ・UI の組み立て
├── waterMask.ts    quantized-mesh の watermask から signed distance field を生成
├── WaveLayer.ts    波の ShaderMaterial（MeshDesc のカスタムメッシュ）
├── cameraPanel.ts  カメラ値の表示 UI
└── lookPanel.ts    ランタイム調整 UI
public/
└── waternormals.jpg  water normal texture（下記クレジット参照）
```

### waterMask.ts

地形レイヤーに指定しているのと同じ URL のタイルを 6×6 枚取得し、quantized-mesh をパースして extension id=2（watermask、1タイル 256×256、0 = land / 255 = water）を取り出す。そこから Felzenszwalb の distance transform で signed distance field（1 px ≈ 4.5 m）を作り、`DataTexture` にしてシェーダーへ渡す。境界の段差が出ないよう 9 m 幅の Gaussian をかけている。

⚠️ watermask は Navara のエンジン内部（worker → buffer handle → tile material）で完結していて、`@navara/three` の公開 API からは読めない。そのため同じタイルを二重に取得している。

### WaveLayer.ts

岸に直交する距離 `dw`（0 が海岸線、正が陸側、負が沖）を軸に、次の3層を航空写真の上に重ねる。

1. **wave line** — 沖から岸へ 31 m 間隔で進む白い前縁。岸から 1.5 本ぶんより沖では消す
2. **swash foam** — 1周期の前 28% で一気に駆け上がり、92% で完全に引き切る。最大 4 m
3. **wet sand** — 直近4波の到達線をその場に保持し、指数関数で減衰させる

海面そのものは描いていない。海面の見た目は航空写真と、Navara の terrain material が watermask を見て与える specular が担う。

## 出典・クレジット

### 地理院タイル（国土地理院）

<https://maps.gsi.go.jp/development/ichiran.html>

- basemap: 地理院タイル「全国最新写真（シームレス）」をブラウザから直接読み込んで表示（加工・再配布はしていない）
- 写真に GRUS 画像が含まれる場合の出所表示として「GRUS画像（© Axelspace）」を併記

利用規約: [国土地理院コンテンツ利用規約](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html)

### Re:Earth Terrain

地形サービスの `layer.json` が示している出典をすべて記載する。**波の海岸線に使っている watermask もこの地形データの一部**。

- © [Re:Earth Terrain](https://terrain.reearth.land/)
- 標高: © [Mapterhorn](https://mapterhorn.com/)
- geoid: [EGM2008 (NGA)](https://earth-info.nga.mil/)
- © [Protomaps](https://protomaps.com/)
- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)（ODbL）

signed distance field はブラウザ上で毎回計算しており、**派生データをこのリポジトリに同梱していない**。

### 同梱アセット

- `public/waternormals.jpg` — Navara パッケージ同梱の water normal texture を複製したもの。既定の参照先（`import.meta.env.BASE_URL` + `assets/water/...`）が解決できないため、明示的に URL を指定している

## License

Licensed under either of

- Apache License, Version 2.0
  ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
- MIT license
  ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.

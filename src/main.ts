import ThreeView from "@navara/three";
import { DefaultDescriptions, DefaultPlugin } from "@navara/three_default_plugin";
import type { SSREffectDesc } from "@navara/three_default_descs";

import { WaveLayer, coastFrame, type WaveLayerConfig } from "./WaveLayer";
import { buildCoastFromWaterMask } from "./waterMask";
import { setupCameraPanel, type Cam } from "./cameraPanel";
import { setupLookPanel, type Section } from "./lookPanel";
import { WAVE_KNOBS } from "./WaveLayer";

/** 自作の波レイヤーを addMesh() で使えるように、記述子の型に足す */
type AppDescriptions = DefaultDescriptions | { mesh: WaveLayerConfig };

/* ============================================================
   初期画角。波が見える構図を1つ選んだもので、実装は特定の場所に依存しない
   （海岸線の位置と向きは watermask から作る distance field が持っている）。

   カメラは起動時にこの画角に置く。以後は自由に操作できる（固定はしない）。
   画面左下のパネルに現在の値が出る。
   ============================================================ */
/**
 * この地形データにおける海面の標高（m）。
 * Re:Earth Terrain の標高は楕円体高で、EGM2008 のジオイド起伏を含むため、
 * 海面は標高 0 ではなくジオイド高の位置に来る。ここでは 27.6 m
 * （初期画角の周辺で、外洋だけを含む地形タイルの minimumHeight = maximumHeight が
 * 27.34〜27.66 m だったことから測定）。
 *
 * ⚠️ ジオイド高は場所によって変わるので、この値は初期画角の周辺でのみ正しい。
 * 遠くの海岸へ移すときは測り直す必要がある。
 */
const SEA_LEVEL = 27.6;

const SHOT = {
  /** 海面の高さ（m） */
  seaHeight: SEA_LEVEL,
  /** カメラ（固定1カット） */
  camera: {
    lng: 125.256724,
    lat: 24.737421,
    height: 346.0,
    heading: 107.72,
    pitch: -37.53,
    roll: 0,
  },
};

const view = new ThreeView<AppDescriptions>({
  /* 内蔵水面の波紋テクスチャ。URL を省略すると Navara は
     `import.meta.env.BASE_URL + "assets/water/waternormals.jpg"` を読もうとするが、
     BASE_URL が "/" なので `/assets/water/...` になり、そこにファイルが無い
     （dev サーバは index.html を返す）。読めないと水面が完全に平らになるので、
     テクスチャを public/ に置いて明示的に指定する。 */
  waterTexture: { enabled: true, url: "waternormals.jpg" },
  // 波を毎フレーム更新するので、常時描画にする
  animation: true,
});

const defaultPlugin = new DefaultPlugin();
view.addPlugin(defaultPlugin);

// Initialization

await view.init();

// Setup scene
defaultPlugin.addDefaultPhotorealScene();

/* 光の設定。時刻は JST 15:00 固定（変更不可）。露出だけ調整できる。 */
const lightQs = new URLSearchParams(location.search || location.hash.replace(/^#/, "?"));
const INITIAL_EXPOSURE = Number.isFinite(parseFloat(lightQs.get("exposure") ?? ""))
  ? parseFloat(lightQs.get("exposure") ?? "")
  : 15.5;

/** JST（UTC+9）で時刻を設定する */
const setHour = (hour: number) => {
  const d = new Date(Date.UTC(2026, 0, 15, 0, 0, 0));
  const total = Math.round(hour * 60);
  d.setUTCMinutes(total - 9 * 60); // JST -> UTC
  view.atmosphere.date = d;
};
setHour(15.0);

view.toneMappingExposure = INITIAL_EXPOSURE;

// Layer declaration

const raster = view.addSource({
  type: "raster-tile",
  // 国土地理院 seamlessphoto（日本の高解像度航空写真、ズーム18相当）
  url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
  maxZoom: 18,
});

view.addLayer({
  type: "raster",
  source: raster,
  raster: {},
});

const TERRAIN_URL =
  "https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain";

const terrain = view.addSource({
  type: "quantized-mesh",
  url: TERRAIN_URL,
  // このサービスの layer.json は "maxzoom": 14。18 を指定すると存在しない
  // ズームを要求することになるので、実際の上限を渡す（以降はエンジンが補間する）。
  maxZoom: 14,
  requestVertexNormals: true,
  requestWaterMask: true,
});

view.addLayer({
  type: "terrain",
  source: terrain,
  terrain: {},
});

view.addEffect<SSREffectDesc>({ ssr: {} });

/* ============================================================
   波（自作シェーダー）
   実際の海岸線（public/coast.png）に沿って打ち寄せる。範囲はデータ側が持つ。
   ============================================================ */

view.registerMesh("wave", WaveLayer);

// 海岸線の位置は、地形ソースが返す水マスク（requestWaterMask）から作る。
// 地図エンジンが海面の描画に使っているのと同じデータ。
const coast = await buildCoastFromWaterMask({
  urlTemplate: TERRAIN_URL,
  center: { lat: SHOT.camera.lat, lng: SHOT.camera.lng },
  zoom: 14, // 水マスクの最大ズーム。1画素 約4m
  tiles: 6, // 6x6 タイル ≒ 6.6km 角（橋の奥まで波を出すため）
  debug: new URLSearchParams(location.search).get("debug") === "1",
});

const waveHandle = view.addMesh<WaveLayer>({
  wave: { coast, height: SHOT.seaHeight },
  matrixWorld: coastFrame(coast.meta, SHOT.seaHeight),
});

const wave = waveHandle.ref;

/* 見ながら詰めるための実行時ノブ。
   例: ?gain=0.3&seaOpacity=0.7  /  指定した秒で止めて確認: ?t=12  */
const qs = new URLSearchParams(location.search || location.hash.replace(/^#/, "?"));
const OVERRIDES = [
  ["gain", "uGain"],
  ["seaOpacity", "uSeaOpacity"],
  ["wetStrength", "uWetStrength"],
  ["foamAmount", "uFoamAmount"],
  ["edgeFade", "uEdgeFade"],
] as const;
const frozenT = parseFloat(qs.get("t") ?? "");

// メッシュは addMesh の直後にはまだ作られていないことがあるので、
// ノブの適用は最初のフレームで行う。
let knobsApplied = false;
view.on("preUpdate", (ms: number) => {
  if (!knobsApplied) {
    for (const [key, uniform] of OVERRIDES) {
      const v = parseFloat(qs.get(key) ?? "");
      if (Number.isFinite(v)) wave.setUniform(uniform, v);
    }
    knobsApplied = true;
  }
  wave.setTime(Number.isFinite(frozenT) ? frozenT : ms * 0.001);
});

/* ============================================================
   カメラ（固定1カット）
   画面左下のパネルに今のカメラの値が出る。「この画角で固定」を押すと
   その画角が保存され、以後は操作できなくなる（リロードしても保持）。
   パネルは H キーで消せる。?ui=0 で最初から隠して開く。
   ============================================================ */

// 起動時の画角。カメラは常に操作できる（固定はしない）。
view.setCamera(SHOT.camera);

const frameHooks: Array<() => void> = [];
view.on("preUpdate", () => {
  for (const cb of frameHooks) cb();
});

setupCameraPanel({
  read: (): Cam => {
    const p = view.camera.positionGeographic;
    const o = view.camera.orientation;
    return {
      lng: p.lng,
      lat: p.lat,
      height: p.height,
      heading: o.heading ?? 0,
      pitch: o.pitch ?? 0,
      roll: o.roll ?? 0,
    };
  },
  onFrame: (cb) => frameHooks.push(cb),

  // 画角を詰めている間は操作できる状態にしておく。
  // 決まったら「この画角で固定」を押す（?lock=1 付きで開いても固定できる）。
  // パネルは既定で表示。消したいときは H キーか ?ui=0。
  hiddenAtStart: qs.get("ui") === "0",
});

/* ============================================================
   見た目の調整パネル（画面右上・L キーで開閉）
   光は太陽の位置と露出、波は自作シェーダーの uniform を直接動かす。
   実行中に変えても効かない項目は置いていない。 */
const num = (
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  set: (v: number) => void,
  digits = 2,
): Section["controls"][number] => ({
  kind: "number",
  label,
  min,
  max,
  step,
  value,
  fmt: (v) => v.toFixed(digits),
  set,
});

const K = WAVE_KNOBS;
const lookSections: Section[] = [
  {
    title: "光",
    controls: [
      num("露出", 0.5, 30, 0.5, INITIAL_EXPOSURE, (v) => {
        view.toneMappingExposure = v;
      }),
    ],
  },
  {
    title: "波（自作シェーダー）",
    controls: [
      num("波の間隔 m", 5, 120, 1, -K.lineFar, (v) => wave.setUniform("uLineFar", -v), 0),
      num("駆け上がり m", 0.5, 30, 0.5, K.reach, (v) => wave.setUniform("uReach", v), 1),
      num("見せる本数", 1, 8, 0.5, K.lineKeep, (v) => wave.setUniform("uLineKeep", v), 1),
      num("線の幅", 0.02, 0.4, 0.01, K.lineWidth, (v) => wave.setUniform("uLineWidth", v)),
      num("泡の量", 0, 5, 0.1, K.foamAmount, (v) => wave.setUniform("uFoamAmount", v)),
      num("明るさ", 0.02, 1.5, 0.02, K.gain, (v) => wave.setUniform("uGain", v)),
      num("透明度", 0, 1, 0.05, K.alpha, (v) => wave.setUniform("uAlpha", v)),
      num("濡れ砂", 0, 1, 0.05, K.wetStrength, (v) => wave.setUniform("uWetStrength", v)),
      num("描く範囲 m", 20, 400, 10, K.bandOffshore, (v) =>
        wave.setUniform("uBandOffshore", v), 0,
      ),
      num("汀線の揺れ m", 0, 8, 0.1, K.warpStrength, (v) =>
        wave.setUniform("uWarpStrength", v), 1,
      ),
    ],
  },
];

setupLookPanel(lookSections, qs.get("look") !== "0");

// Attribution

view.attribution?.add([
  {
    attribution: "地理院タイル（国土地理院）",
    attributionUrl: "https://maps.gsi.go.jp/development/ichiran.html",
    children: [
      { attribution: "背景の航空写真: 全国最新写真（シームレス）" },
      { attribution: "上記写真に含まれる場合: GRUS画像（© Axelspace）" },
    ],
  },
  {
    // 地形サービスの layer.json が示している出典。海岸線の位置に使っている
    // 水マスク（quantized-mesh の watermask 拡張）もこの地形データの一部。
    attribution: "© Re:Earth Terrain",
    attributionUrl: "https://terrain.reearth.land/",
    children: [
      { attribution: "標高: © Mapterhorn" },
      { attribution: "ジオイド: EGM2008 (NGA)" },
      { attribution: "© Protomaps" },
      { attribution: "© OpenStreetMap contributors (ODbL)" },
    ],
  },
]);

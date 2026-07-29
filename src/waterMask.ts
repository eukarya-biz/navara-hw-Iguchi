/**
 * 地形タイルの水マスクから「海岸線からの距離」を作る。
 *
 * 波を海岸線に沿わせるには、各地点が海岸線から何メートル離れているかが必要になる。
 * その元データとして、地形ソースに `requestWaterMask: true` を指定したときに
 * サーバーが返す **水マスク**（quantized-mesh の拡張 id=2）を使う。
 * 1タイルにつき 256×256 バイトで、0 = 陸 / 255 = 水。地図エンジンが海面の描画に
 * 使っているのと同じデータ。
 *
 * ⚠️ 水マスクは Navara のエンジン内部（ワーカー → 数値ハンドル → 地形マテリアル）で
 * 完結しており、`@navara/three` の公開 API からは読めない。そのため、
 * 地形レイヤーに指定しているのと同じ URL のタイルを自分でも取得して解析している。
 * エンジン側から読めるようになれば、この二重取得は不要になる。
 *
 * タイルの並びは TMS / EPSG:4326（レベル z で 横 2^(z+1) × 縦 2^z、行番号は南から）。
 */

import { DataTexture, NearestFilter, NoColorSpace, RGBAFormat, Texture } from "three";

export type CoastMeta = {
  bounds: { west: number; east: number; north: number; south: number };
  widthMeters: number;
  heightMeters: number;
  metersPerPixel: number;
  distMin: number;
  distMax: number;
  size: number;
};

export type CoastData = { texture: Texture; meta: CoastMeta };

const DIST_MIN = -400;
const DIST_MAX = 800;
/** 汀線をこの幅（m）でぼかす。マスクは1画素4m級なので、そのままだと段差が角ばる */
const SMOOTH_M = 9;

/* ---------------- quantized-mesh の解析（欲しいのは水マスクだけ） ---------------- */

/** 水マスクを取り出す。1バイトのときはタイル全体が水/陸を表す */
function readWatermask(buf: ArrayBuffer): Uint8Array | number | undefined {
  const dv = new DataView(buf);
  let o = 88; // ヘッダ（中心・高さ・境界球・地平線遮蔽点）
  const vertexCount = dv.getUint32(o, true);
  o += 4;
  o += vertexCount * 2 * 3; // u, v, height（zigzag u16）
  let indexSize = 2;
  if (vertexCount > 65536) {
    o += (4 - (o % 4)) % 4; // u32 境界に揃える
    indexSize = 4;
  }
  const triangleCount = dv.getUint32(o, true);
  o += 4 + triangleCount * 3 * indexSize;
  for (let i = 0; i < 4; i++) {
    // 西・南・東・北の縁の頂点リスト
    const n = dv.getUint32(o, true);
    o += 4 + n * indexSize;
  }
  while (o + 5 <= buf.byteLength) {
    const id = dv.getUint8(o);
    const len = dv.getUint32(o + 1, true);
    o += 5;
    if (id === 2) {
      if (len === 1) return dv.getUint8(o); // 一様タイル
      return new Uint8Array(buf, o, len);
    }
    o += len;
  }
  return undefined;
}

/* ---------------- 距離変換（Felzenszwalb） ---------------- */

function edt1d(f: Float64Array, n: number, d: Float64Array) {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** seeds が true の画素までの距離（画素単位）を返す */
function distanceTo(seeds: Uint8Array, size: number): Float64Array {
  const INF = 1e12;
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const grid = new Float64Array(size * size);
  for (let i = 0; i < size * size; i++) grid[i] = seeds[i] ? 0 : INF;

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) f[y] = grid[y * size + x];
    edt1d(f, size, d);
    for (let y = 0; y < size; y++) grid[y * size + x] = d[y];
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) f[x] = grid[y * size + x];
    edt1d(f, size, d);
    for (let x = 0; x < size; x++) grid[y * size + x] = Math.sqrt(d[x]);
  }
  return grid;
}

/** 分離型ガウスぼかし（その場で書き換える） */
function blur(grid: Float64Array, size: number, sigma: number) {
  if (sigma <= 0.05) return;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;

  const tmp = new Float64Array(grid.length);
  const clamp = (v: number) => (v < 0 ? 0 : v > size - 1 ? size - 1 : v);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += k[i + r] * grid[y * size + clamp(x + i)];
      tmp[y * size + x] = acc;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += k[i + r] * tmp[clamp(y + i) * size + x];
      grid[y * size + x] = acc;
    }
  }
}

/* ---------------- 本体 ---------------- */

export async function buildCoastFromWaterMask(opts: {
  /** 地形タイルの URL テンプレート（地形レイヤーに指定しているものと同じ） */
  urlTemplate: string;
  /** 中心（度） */
  center: { lat: number; lng: number };
  /** 取得するズーム。水マスクの細かさはここで決まる（サービスの最大は 14） */
  zoom: number;
  /** 一辺のタイル数。zoom 14 なら 1タイル約1.1km */
  tiles: number;
  /** 起動時に集計値をコンソールへ出す（?debug=1 のときだけ） */
  debug?: boolean;
}): Promise<CoastData> {
  const { urlTemplate, center, zoom, tiles } = opts;
  const numCols = 2 ** (zoom + 1);
  const numRows = 2 ** zoom;
  const colCenter = Math.floor(((center.lng + 180) / 360) * numCols);
  const rowCenter = Math.floor(((center.lat + 90) / 180) * numRows);
  const colMin = colCenter - Math.floor(tiles / 2);
  const rowMin = rowCenter - Math.floor(tiles / 2);
  const rowMax = rowMin + tiles - 1;

  const size = tiles * 256;
  const water = new Uint8Array(size * size);

  const accept =
    "application/vnd.quantized-mesh;extensions=octvertexnormals-watermask," +
    "application/octet-stream";

  await Promise.all(
    Array.from({ length: tiles * tiles }, async (_, i) => {
      const col = colMin + (i % tiles);
      const row = rowMin + Math.floor(i / tiles);
      const url = urlTemplate
        .replace("{z}", String(zoom))
        .replace("{x}", String(col))
        .replace("{y}", String(row));
      let mask: Uint8Array | number | undefined;
      try {
        const res = await fetch(url, { headers: { Accept: accept } });
        if (res.ok) mask = readWatermask(await res.arrayBuffer());
      } catch {
        mask = undefined;
      }
      // 画像は北が上。TMS の行番号は南から増えるので、上下を入れ替えて並べる。
      const x0 = (col - colMin) * 256;
      const y0 = (rowMax - row) * 256;
      for (let ty = 0; ty < 256; ty++) {
        const dst = (y0 + ty) * size + x0;
        if (typeof mask === "number") {
          if (mask > 0) water.fill(1, dst, dst + 256);
        } else if (mask) {
          // タイル内の並びは北 → 南（実データで確認済み）
          const src = ty * 256;
          for (let tx = 0; tx < 256; tx++) water[dst + tx] = mask[src + tx] > 0 ? 1 : 0;
        }
      }
    }),
  );

  const bounds = {
    west: (colMin / numCols) * 360 - 180,
    east: ((colMin + tiles) / numCols) * 360 - 180,
    south: (rowMin / numRows) * 180 - 90,
    north: ((rowMax + 1) / numRows) * 180 - 90,
  };
  const latC = (bounds.north + bounds.south) / 2;
  const widthMeters =
    (bounds.east - bounds.west) * 111320 * Math.cos((latC * Math.PI) / 180);
  const heightMeters = (bounds.north - bounds.south) * 110570;
  const metersPerPixel = (widthMeters / size + heightMeters / size) / 2;

  // 符号つき距離: 海の中では岸までの距離が正、陸の中では負
  const land = new Uint8Array(size * size);
  for (let i = 0; i < water.length; i++) land[i] = water[i] ? 0 : 1;
  const dToLand = distanceTo(land, size);
  const dToWater = distanceTo(water, size);
  const signed = new Float64Array(size * size);
  for (let i = 0; i < signed.length; i++) {
    signed[i] = (water[i] ? dToLand[i] : -dToWater[i]) * metersPerPixel;
  }

  // マスクは1画素4m級。そのまま数メートルの波を描くと段差が角ばって出るのでぼかす。
  blur(signed, size, SMOOTH_M / metersPerPixel);

  // 16bit に量子化して R（上位）/ G（下位）へ。B は海マスク。A は未使用。
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const n = Math.min(
      65535,
      Math.max(0, Math.round(((signed[i] - DIST_MIN) / (DIST_MAX - DIST_MIN)) * 65535)),
    );
    data[i * 4] = (n >> 8) & 0xff;
    data[i * 4 + 1] = n & 0xff;
    data[i * 4 + 2] = water[i] ? 255 : 0;
    data[i * 4 + 3] = 255;
  }

  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = NoColorSpace;
  texture.minFilter = NearestFilter; // 値をそのまま読む（補間はシェーダー側で行う）
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false; // 1行目が北という並びのデータ。反転させない
  texture.needsUpdate = true;

  // 確認用（南西が海・北東が陸という並びになっているか。上下反転の検出）
  const q = (x0: number, y0: number) => {
    let n = 0;
    let sum = 0;
    for (let y = y0; y < y0 + size / 2; y += 4)
      for (let x = x0; x < x0 + size / 2; x += 4) {
        sum += water[y * size + x];
        n++;
      }
    return (sum / n) * 100;
  };
  let dMin = Infinity;
  let dMax = -Infinity;
  let seaCount = 0;
  for (let i = 0; i < signed.length; i++) {
    if (signed[i] < dMin) dMin = signed[i];
    if (signed[i] > dMax) dMax = signed[i];
    seaCount += water[i];
  }
  if (opts.debug)
    console.warn(
      `COASTDBG size=${size} ${metersPerPixel.toFixed(2)}m/px ` +
      `sea=${((seaCount / water.length) * 100).toFixed(1)}% ` +
      `NE=${q(size / 2, 0).toFixed(0)}% SW=${q(0, size / 2).toFixed(0)}% ` +
        `dist=${dMin.toFixed(0)}..${dMax.toFixed(0)}m`,
    );

  return {
    texture,
    meta: {
      bounds,
      widthMeters,
      heightMeters,
      metersPerPixel,
      distMin: DIST_MIN,
      distMax: DIST_MAX,
      size,
    },
  };
}

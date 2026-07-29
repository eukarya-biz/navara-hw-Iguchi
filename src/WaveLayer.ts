/**
 * WaveLayer — 実際の海岸線に沿って打ち寄せ、引く波。
 *
 * proto/wave-proto.html（Phase 2 で凍結した逐次1波モデル）の移植版。
 * 試作版との違いは2点。
 *
 *  1. 岸からの距離を、架空のまっすぐな線ではなく **実際の海岸線** から取る。
 *     地形ソースの水マスク（`requestWaterMask`）を起動時に読んで、各地点が
 *     海岸線から何メートル離れているか（海が正・陸が負）を作る（src/waterMask.ts）。
 *     波はこれを読むので、砂浜が曲がっていてもその形に沿って打ち寄せる。
 *  2. 海面そのものは描かない。海面はエンジンの内蔵水面（polygon.water + SSR）が
 *     描くので、この層は **汀線のまわりだけ**（白波・駆け上がり・濡れた砂）を重ねる。
 *     沖側と陸側はどちらも完全に透明になる。
 *
 * 面は coast.png がカバーする範囲そのままの水平面。回転も向きの指定も要らない
 * （岸の向きはデータ側が持っている）。
 */
import {
  MeshDesc,
  type MeshConfig,
  type PassKey,
  type ViewContext,
  degreeToRadian,
  eastNorthUpToFixedFrame,
  geodeticToVector3,
} from "@navara/three";
import type ThreeView from "@navara/three";
import {
  Color,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from "three";

import type { CoastData, CoastMeta } from "./waterMask";

/* ============================================================
   TUNING KNOBS
   岸に直交する距離（dw）は **メートル**。0 が海岸線、正が陸側、負が沖。
   ============================================================ */
export const WAVE_KNOBS = {
  loopLength: 60.0, // ループ長（秒）。1波の周期 P = loopLength / wavesPerLoop
  wavesPerLoop: 8, // 60秒あたりの波数 -> 周期 7.5 秒

  // --- 岸に直交する配置（m） ---
  // lineFar が波の間隔をそのまま決める。浅い海の細かい波に合わせた値。
  deepEnd: -120.0, // これより沖: 静かな沖（波はこの上でフェードイン）
  dryStart: 6.0, // これより陸: 乾いた砂（白波なし）
  lineFar: -31.0, // 波の間隔（m）。lineKeep 本ぶんだけ岸側に見せる
  reach: 4.0, // 最大の駆け上がり距離（強度最大の波で）
  lineKeep: 1.5, // 波の線を岸から何本ぶん見せるか。これより沖は消える

  // --- 波のサイクル / swash / 濡れ ---
  riseFrac: 0.28, // 1周期のうち一気に駆け上がる割合。以後は引く
  drainEnd: 0.92, // この位相で完全に引き切る（休止 -> 次の波）
  dryTime: 18.0, // 濡れた砂が乾く時定数（秒）

  // --- 汀線のぎざぎざ + 各要素の幅 ---
  jagAmp: 0.0, // 汀線の作り足しはしない（データ側の滑らかな線をそのまま使う）
  jagFreq: 0.22, // その岸沿い方向の周波数（1/m）= 波長4.5m
  lineWidth: 0.02, // 波の線（白い前縁）の半幅（波の間隔に対する割合）= 約1.4m
  edgeWidth: 1.3, // swash 先端の泡の弧の半幅（m）
  aa: 1.0, // 汀線のアンチエイリアス幅（m）。データ1画素より細くしない

  // --- 泡の量 / テクスチャ ---
  foamAmount: 5.0, // 泡全体のゲイン（白飛びしないソフトな減衰）
  texScale: 5.0, // 泡テクスチャの細かさ（1/m）= 模様 0.8m
  texDrift: 2.0, // 泡テクスチャが岸へ這う速さ（m/s）
  worleyWeight: 0.16, // 細かい斑点の重み
  fpp: 0.14, // 画素あたり周波数の目安（折り返し抑制）

  // --- 波の線のうねり + 汀線の低周波な曲がり ---
  warpStrength: 8.0, // 距離場の歪み量（m）。汀線をこの幅で揺らす
  warpScale: 0.02, // 歪みノイズの空間スケール（1/m）= 50m
  coastAmp: 0.9, // 低周波な曲がり（m）
  coastFreq: 0.016, // その周波数（1/m）= 60m

  // --- 岸沿い方向（ノイズの変化をこの向きに走らせる） ---
  coastTangentBearing: 128.0, // 砂浜が伸びる方角（度）。coast.png の汀線から算出

  // --- 重ね方 ---
  // 海面はエンジンが描くので、この層は汀線付近だけを描く。
  bandOffshore: 80.0, // 汀線から沖へ何メートルまで描くか
  bandFade: 40.0, // その外側で消えていく幅（m）
  wetStrength: 0.25, // 濡れた砂の効き
  edgeFade: 0.06, // データ範囲の縁で消えていく幅（uv 単位）
  gain: 0.7, // 出力の明るさ（描画側の露出補正を打ち消す係数）
  alpha: 0.1, // この層全体の透明度（1 で今のまま、下げると全体が薄くなる）

  // --- 配色: 海に色はない（要求仕様）。明るいまま色が無い ---
  colors: {
    foam: 0xf5f4ee, // ほぼ白のクリーム
    sandWet: 0xa2947c, // 濡れた砂
  },
};

type WaveLayerDescription = {
  wave?: {
    /** 地形の水マスクから作った「海岸線からの距離」データ */
    coast: CoastData;
    /** 海面の高さ（m） */
    height?: number;
  };
};

export type WaveLayerConfig = MeshConfig & WaveLayerDescription;
export type WaveLayerUpdate = Pick<MeshConfig, "visible"> & WaveLayerDescription;

const DEFS = `#define WK 4\n`; // 濡れた砂の記憶（直近 WK 波分）

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG =
  DEFS +
  /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uCoast;
  uniform vec2  uTexel;        // 1テクセルの大きさ（uv 単位）
  uniform float uDistMin, uDistMax;
  uniform vec2  uSizeM;        // データ範囲の実寸（m）
  uniform vec2  uTangent;      // 岸沿い方向の単位ベクトル（東, 北）

  uniform float uTime, uLoop, uP, uNW;
  uniform float uDeepEnd, uDryStart, uLineFar, uReach, uLineKeep;
  uniform float uRiseFrac, uDrainEnd, uDryTime;
  uniform float uJagAmp, uJagFreq, uLineWidth, uEdgeWidth, uAA;
  uniform float uFoamAmount, uTexScale, uTexDrift, uWorleyWeight, uFpp;
  uniform float uWarpStrength, uWarpScale, uCoastAmp, uCoastFreq;
  uniform float uBandOffshore, uBandFade, uWetStrength, uEdgeFade, uGain, uAlpha;
  uniform vec3  uFoam, uSandWet;

  const float TAU = 6.28318531;
  const float PEAK_PH = 0.30;   // swash が最高到達点に来る位相

  /* ---------- 海岸線データの読み出し ----------
     距離は 16bit を R(上位)/G(下位) に分けて入れてあるため、GPU の補間に任せると
     桁の繰り上がりで値が壊れる。テクスチャは補間なしで読み、4点から自分で滑らかに繋ぐ。 */
  float decodeDist(vec2 t){
    vec3 c = texture2D(uCoast, t).rgb;
    float q = (c.r * 255.0 * 256.0 + c.g * 255.0) / 65535.0;
    return q * (uDistMax - uDistMin) + uDistMin;   // 海が正、陸が負（m）
  }
  float coastDist(vec2 t){
    vec2 p = t / uTexel - 0.5;
    vec2 i = floor(p), f = fract(p);
    float a = decodeDist((i + vec2(0.5, 0.5)) * uTexel);
    float b = decodeDist((i + vec2(1.5, 0.5)) * uTexel);
    float c = decodeDist((i + vec2(0.5, 1.5)) * uTexel);
    float d = decodeDist((i + vec2(1.5, 1.5)) * uTexel);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  /* ---------- 基盤ノイズ（sin を使わない / 大座標でも精度が崩れない） ---------- */
  vec2 hash2(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  float hash1(float n){ n = fract(n * 0.1031); n *= n + 33.33; n *= n + n; return fract(n); }
  vec2 grad2(vec2 p){ vec2 g = hash2(p) * 2.0 - 1.0; return g / max(length(g), 1e-3); }
  float gnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*f*(f*(f*6.0 - 15.0) + 10.0);
    float a = dot(grad2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
    float b = dot(grad2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
    float c = dot(grad2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
    float d = dot(grad2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float vnoise(vec2 q){ return clamp(0.5 + 0.7071 * gnoise(q), 0.0, 1.0); }
  float fbm(vec2 q, int oct){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++){
      if (i >= oct) break;
      v += a * vnoise(q);
      q = q * 2.02 + vec2(17.3, 9.1);
      a *= 0.5;
    }
    return v;
  }
  float turbulence(vec2 p, float fpp){
    float v = 0.0, a = 0.5, f = 1.0, norm = 0.0;
    vec2 pp = p;
    for (int i = 0; i < 5; i++){
      float w = 1.0 - smoothstep(0.35, 0.5, f * fpp);
      v    += a * w * abs(2.0 * vnoise(pp) - 1.0);
      norm += a * w;
      pp = pp * 2.0 + vec2(11.7, 3.3); a *= 0.5; f *= 2.0;
    }
    return v / max(norm, 1e-3);
  }
  float worleyF2F1(vec2 p){
    vec2 n = floor(p), f = fract(p);
    float f1 = 9.0, f2 = 9.0;
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++){
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash2(n + g);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < f1){ f2 = f1; f1 = d; } else if (d < f2){ f2 = d; }
    }
    return sqrt(f2) - sqrt(f1);
  }
  float foamTex(vec2 p, float fpp){
    float fine = turbulence(p, fpp);
    float mid  = turbulence(p * 0.35, fpp * 0.35);
    float micro = worleyF2F1(p * 4.5);
    float v = 0.45 * fine + 0.55 * mid;
    v *= 1.0 - uWorleyWeight * smoothstep(0.0, 0.5, micro);
    return clamp(v, 0.0, 1.0);
  }

  /* ================= 逐次1波モデル ================= */

  // 波ごとの強度。波の中では一定で、mod(idx, NW) でループ安全。
  float strAt(float idx, float along){
    float wid = mod(idx, uNW);
    float s = 0.55 + 0.45 * hash1(wid + 3.7);
    s *= 0.90 + 0.20 * fbm(vec2(along * 0.0018 + hash1(wid) * 7.0, 1.3), 2);
    return s;
  }
  // 静止時の汀線。データの 0 の線に、動かない細かいぎざぎざを足す。
  float shoreBase(float along){
    return (fbm(vec2(along * uJagFreq, 3.7), 2) - 0.5) * 2.0 * uJagAmp;
  }
  // 1周期に1回の駆け上がり。速く上がって完全に引く。ph=0 と ph>=drainEnd で厳密に 0。
  float swashShape(float ph){
    float rise = smoothstep(0.0, uRiseFrac, ph);
    float fall = 1.0 - smoothstep(uRiseFrac + 0.02, uDrainEnd, ph);
    return rise * fall;
  }
  // 現在の汀線 = 静止時 + この波の駆け上がり（陸側 = 正）
  float waterEdgeAt(float along, float t){
    float cyc = t / uP;
    return shoreBase(along) + uReach * strAt(floor(cyc), along) * swashShape(fract(cyc));
  }

  void main(){
    vec2 uv = vUv;

    // データ上の位置。画像は上端が北なので v を反転して読む。
    float dm = coastDist(vec2(uv.x, 1.0 - uv.y));   // 海が正、陸が負（m）

    // 岸に直交する座標。試作版と同じ向きに揃える（0 が汀線、正が陸側、負が沖）。
    float dwRaw = -dm;

    // 岸沿いの座標。ノイズの変化をこの向きに走らせる。
    vec2 pos = (uv - 0.5) * uSizeM;               // 面の中心を原点とする東西・南北（m）
    float along = dot(pos, uTangent);

    // 汀線をゆるく歪める（波の線がまっすぐ揃わないように）
    float w0 = TAU / uLoop;
    vec2 wp = pos * uWarpScale;
    vec2 drift = vec2(0.02 * cos(w0 * uTime), 0.016 * sin(2.0 * w0 * uTime)); // ほぼ静的
    vec2 q = vec2(fbm(wp + drift, 3), fbm(wp + vec2(5.2, 1.3) + drift, 3));
    vec2 r = vec2(fbm(wp + 4.0*q + vec2(1.7, 9.2) - drift, 3),
                  fbm(wp + 4.0*q + vec2(8.3, 2.8) - drift, 3));
    float disp = fbm(wp + 4.0*r, 3) - 0.5;
    disp = 0.24 * tanh(disp / 0.24);                       // 尖りの抑制
    float bend = uCoastAmp * (fbm(vec2(along * uCoastFreq, 11.3), 3) - 0.5);
    float dw = dwRaw + uWarpStrength * disp + bend;

    float cyc = uTime / uP;
    float wi  = floor(cyc);
    float ph  = fract(cyc);

    float sb = shoreBase(along);
    float we = waterEdgeAt(along, uTime);

    float grain = fbm(pos * 1.8, 3);

    // ---- 濡れた砂: 波ごとの到達線をその場に残し、その場で乾かす ----
    float wet = smoothstep(-uAA, uAA, we - dw);      // 今まさに水がある所は濡れている
    float window = float(WK) * uP;
    for (int k = 0; k < WK; k++){
      float idx = wi - float(k);
      float reachK = sb + uReach * strAt(idx, along);            // その波の最高到達線
      float age = max((ph + float(k) - PEAK_PH) * uP, 0.0);      // 到達からの経過秒
      float cover = smoothstep(-uAA, uAA, reachK - dw);          // 到達線は動かない
      float fadeOut = 1.0 - smoothstep(0.60 * window, 0.98 * window, age);
      // 今の波の到達線は、水が実際にそこへ来る前には存在しない
      float armK = (k == 0) ? smoothstep(PEAK_PH - 0.02, PEAK_PH + 0.03, ph) : 1.0;
      wet = max(wet, cover * exp(-age / uDryTime) * fadeOut * armK);
    }
    wet *= 0.82 + 0.18 * grain;

    // 水がある所（汀線より沖側）。海面の色そのものはエンジンが描くので使わない。
    float seaMask = smoothstep(we + uAA, we - uAA, dw);

    // ---- 打ち寄せてくる波の線（白い前縁） ----
    // Phi = cyc + travel。稜線は時間とともに travel が減る = 岸へ進み、
    // 自分の駆け上がりが始まる時に汀線へ到達する。
    float span = max(sb - uLineFar, 1.0);
    float travel = (sb - dw) / span;                 // 0 が汀線、1 が lineFar、>1 はさらに沖
    float Phi = cyc + travel;
    float nC = floor(Phi + 0.5);                     // 最も近い稜線（その線が運ぶ波）
    float s = nC - Phi;                              // >0 が前方（岸側）、<0 が後方
    float ahead = max(s, 0.0), behind = max(-s, 0.0);
    float band = exp(-pow(ahead / uLineWidth, 2.0) - pow(behind / (uLineWidth * 2.5), 2.0));
    float fadeIn = smoothstep(uDeepEnd, uDeepEnd + 60.0, dw);   // 沖ほど控えめ
    float waterGate = smoothstep(we + 0.7, we - 0.5, dw);       // 泡は水の中にいる
    // 岸から uLineKeep 本ぶんより沖の線は消す（画面に何本も並ぶと不自然になる）
    float keep = 1.0 - smoothstep(uLineKeep - 0.5, uLineKeep + 0.6, travel);
    float lineFoam = band * strAt(nC, along) * fadeIn * waterGate * keep;

    // ---- swash 先端の泡の弧 ----
    float arc = smoothstep(uEdgeWidth, 0.0, abs(dw - we))
              * (0.30 + 0.70 * swashShape(ph)) * strAt(wi, along);

    float dryGate = 1.0 - smoothstep(uDryStart - 1.5, uDryStart + 1.5, dw);
    float density = (lineFoam + arc) * dryGate;

    // ---- 泡のテクスチャ: 細かく柔らかい白泡を岸へ流す（ループ安全なクロスフェード） ----
    vec2 texBase = vec2(along, dw) * uTexScale;
    float t1 = mod(uTime, uLoop);
    float t2 = t1 - uLoop;
    float texv = mix(foamTex(texBase + vec2(0.0, uTexDrift * t1 * uTexScale), uFpp),
                     foamTex(texBase + vec2(0.0, uTexDrift * t2 * uTexScale), uFpp), t1 / uLoop);
    float fresh = clamp(density * 2.0, 0.0, 1.0);
    float holes = smoothstep(0.34, 0.66, texv);
    float foam = density * (0.25 + 0.75 * texv) * mix(holes, 1.0, fresh);
    float foamA = 1.0 - exp(-max(foam, 0.0) * uFoamAmount);

    /* ---- 下から順に重ねる。1) 濡れた砂  2) 白波
       海面はエンジンの内蔵水面が描いているので、ここでは触らない。 */
    vec3 pm = vec3(0.0);
    float a = 0.0;

    float aWet = clamp(wet * (1.0 - seaMask) * uWetStrength, 0.0, 1.0);
    pm = uSandWet * aWet + pm * (1.0 - aWet);
    a  = aWet + a * (1.0 - aWet);

    float aFoam = clamp(foamA, 0.0, 1.0);
    pm = uFoam * aFoam + pm * (1.0 - aFoam);
    a  = aFoam + a * (1.0 - aFoam);

    // 汀線から沖へ離れたら消す（海面はエンジンが描くので、この層は岸のまわりだけ）
    a *= 1.0 - smoothstep(-uBandOffshore, -uBandOffshore - uBandFade, dw);

    // データ範囲の縁で消す（継ぎ目を出さないため）
    a *= smoothstep(0.0, uEdgeFade, uv.x) * smoothstep(1.0, 1.0 - uEdgeFade, uv.x)
       * smoothstep(0.0, uEdgeFade, uv.y) * smoothstep(1.0, 1.0 - uEdgeFade, uv.y);

    vec3 col = pm / max(a, 1e-4);
    gl_FragColor = vec4(col * uGain, a * uAlpha);
  }
`;

/** sRGB の 16 進値をリニア色空間へ */
const toLin = (hex: number) => new Color().setHex(hex, SRGBColorSpace);

export class WaveLayer extends MeshDesc<
  WaveLayerConfig,
  WaveLayerUpdate,
  Mesh<PlaneGeometry, ShaderMaterial>
> {
  private cfg: WaveLayerConfig;
  private material?: ShaderMaterial;
  private mesh?: Mesh<PlaneGeometry, ShaderMaterial>;

  constructor(view: ThreeView, ctx: ViewContext, config: WaveLayerConfig) {
    super(view, ctx, config);
    this.cfg = config;
  }

  /** 半透明で重ねるので transparent パスに置く */
  protected getPassKey(): PassKey {
    return "transparent";
  }

  createMesh(): Mesh<PlaneGeometry, ShaderMaterial> {
    const K = WAVE_KNOBS;
    const coast = this.cfg.wave?.coast;
    if (!coast) throw new Error("WaveLayer requires wave.coast");
    const M = coast.meta;

    // 海岸線データがカバーする範囲そのままの水平面。東西・南北に軸を合わせる。
    const geometry = new PlaneGeometry(M.widthMeters, M.heightMeters, 1, 1);

    const bearing = degreeToRadian(K.coastTangentBearing);

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false, // 固定俯瞰の1カット。地形との前後関係で消えないように常に上へ重ねる
      depthWrite: false,
      uniforms: {
        uCoast: { value: coast.texture },
        uTexel: { value: new Vector2(1 / M.size, 1 / M.size) },
        uDistMin: { value: M.distMin },
        uDistMax: { value: M.distMax },
        uSizeM: { value: new Vector2(M.widthMeters, M.heightMeters) },
        uTangent: { value: new Vector2(Math.sin(bearing), Math.cos(bearing)) },

        uTime: { value: 0 },
        uLoop: { value: K.loopLength },
        uP: { value: K.loopLength / K.wavesPerLoop },
        uNW: { value: K.wavesPerLoop },

        uDeepEnd: { value: K.deepEnd },
        uDryStart: { value: K.dryStart },
        uLineFar: { value: K.lineFar },
        uReach: { value: K.reach },
        uLineKeep: { value: K.lineKeep },

        uRiseFrac: { value: K.riseFrac },
        uDrainEnd: { value: K.drainEnd },
        uDryTime: { value: K.dryTime },

        uJagAmp: { value: K.jagAmp },
        uJagFreq: { value: K.jagFreq },
        uLineWidth: { value: K.lineWidth },
        uEdgeWidth: { value: K.edgeWidth },
        uAA: { value: K.aa },

        uFoamAmount: { value: K.foamAmount },
        uTexScale: { value: K.texScale },
        uTexDrift: { value: K.texDrift },
        uWorleyWeight: { value: K.worleyWeight },
        uFpp: { value: K.fpp },

        uWarpStrength: { value: K.warpStrength },
        uWarpScale: { value: K.warpScale },
        uCoastAmp: { value: K.coastAmp },
        uCoastFreq: { value: K.coastFreq },

        uBandOffshore: { value: K.bandOffshore },
        uBandFade: { value: K.bandFade },
        uWetStrength: { value: K.wetStrength },
        uEdgeFade: { value: K.edgeFade },
        uGain: { value: K.gain },
        uAlpha: { value: K.alpha },

        uFoam: { value: toLin(K.colors.foam) },
        uSandWet: { value: toLin(K.colors.sandWet) },
      },
    });

    const mesh = new Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    this.mesh = mesh;
    return mesh;
  }

  /** 経過秒を渡す。60秒でループするので、これだけで絵が決まる（純関数）。 */
  setTime(seconds: number): void {
    if (!this.material) return;
    const loop = WAVE_KNOBS.loopLength;
    this.material.uniforms.uTime.value = ((seconds % loop) + loop) % loop;
  }

  /** 見ながら詰めるための実行時ノブ（URL クエリから差し替える用） */
  setUniform(name: string, value: number): void {
    const u = this.material?.uniforms[name];
    if (u) u.value = value;
  }

  onDestroy(): void {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
    super.onDestroy();
  }
}

/** 海岸線データの中心に置くための変換行列（東西・南北・上の向き） */
export function coastFrame(meta: CoastMeta, height = 0) {
  const b = meta.bounds;
  const position: Vector3 = geodeticToVector3({
    lat: degreeToRadian((b.north + b.south) / 2),
    lng: degreeToRadian((b.west + b.east) / 2),
    height,
  });
  return eastNorthUpToFixedFrame(position);
}

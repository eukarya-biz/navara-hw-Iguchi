/**
 * カメラの値を表示するパネル。
 *
 * カメラは常に操作できる（固定機能は持たない）。
 * 表示は「隠す」ボタン、または H キーで消せる（録画・スクショ用）。
 * `?ui=0` を付けて開くと最初から隠れた状態で始まる。
 */

export type Cam = {
  lng: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
};

/** 角度を -180〜180 に揃える（読み出しでは 0 が 359.99… になることがある） */
const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

export const normalizeCam = (c: Cam): Cam => ({
  lng: c.lng,
  lat: c.lat,
  height: c.height,
  heading: wrap(c.heading),
  pitch: wrap(c.pitch),
  roll: wrap(c.roll),
});

export function setupCameraPanel(opts: {
  /** 今のカメラを読む */
  read: () => Cam;
  /** 毎フレーム呼ばれるフックを登録する */
  onFrame: (cb: () => void) => void;
  /** 最初からパネルを隠すか */
  hiddenAtStart: boolean;
}): void {
  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed",
    "left:12px",
    "bottom:12px",
    "z-index:1000",
    "padding:10px 12px",
    "border-radius:6px",
    "background:rgba(18,20,24,.82)",
    "color:#e8eaed",
    "font:12px/1.7 ui-monospace,Menlo,Consolas,monospace",
    "backdrop-filter:blur(4px)",
    "user-select:text",
    "min-width:280px",
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "カメラ";
  title.style.cssText = "font-weight:600;margin-bottom:4px;letter-spacing:.04em";

  const values = document.createElement("div");
  values.style.cssText = "white-space:pre";

  const oneLine = document.createElement("div");
  oneLine.style.cssText =
    "margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.18);" +
    "color:#9aa4b2;white-space:pre-wrap;word-break:break-all";

  const btnHide = document.createElement("button");
  btnHide.textContent = "隠す (H)";
  btnHide.style.cssText = [
    "margin-top:8px",
    "padding:5px 10px",
    "border:1px solid rgba(255,255,255,.28)",
    "border-radius:4px",
    "background:rgba(255,255,255,.08)",
    "color:#e8eaed",
    "font:12px/1.4 inherit",
    "cursor:pointer",
  ].join(";");

  panel.append(title, values, oneLine, btnHide);
  document.body.appendChild(panel);

  const fmt = (c: Cam) =>
    [
      `経度   ${c.lng.toFixed(6)}`,
      `緯度   ${c.lat.toFixed(6)}`,
      `高度   ${c.height.toFixed(1)} m`,
      `方角   ${c.heading.toFixed(2)}°`,
      `傾き   ${c.pitch.toFixed(2)}°`,
      `回転   ${c.roll.toFixed(2)}°`,
    ].join("\n");

  const render = (c: Cam) => {
    values.textContent = fmt(c);
    oneLine.textContent =
      `lng: ${c.lng.toFixed(6)}, lat: ${c.lat.toFixed(6)}, ` +
      `height: ${c.height.toFixed(1)}, heading: ${c.heading.toFixed(2)}, ` +
      `pitch: ${c.pitch.toFixed(2)}, roll: ${c.roll.toFixed(2)}`;
  };

  let hidden = opts.hiddenAtStart;
  const applyHidden = () => {
    panel.style.display = hidden ? "none" : "";
  };
  btnHide.addEventListener("click", () => {
    hidden = true;
    applyHidden();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "h" || e.key === "H") {
      hidden = !hidden;
      applyHidden();
    }
  });
  applyHidden();

  // 表示の更新は 1 秒に数回で足りる
  let last = 0;
  opts.onFrame(() => {
    const now = performance.now();
    if (now - last < 200) return;
    last = now;
    if (hidden) return;
    try {
      render(normalizeCam(opts.read()));
    } catch {
      // カメラがまだ準備できていないフレームは飛ばす
    }
  });
}

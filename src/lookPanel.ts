/**
 * 見た目を画面上で調整するパネル。
 *
 * 海面（エンジンの水面マテリアル）・波（自作シェーダー）・光（太陽と露出）・
 * 後処理エフェクトの各項目をスライダーとスイッチで動かせる。
 * L キーで開閉。`?look=0` で最初から閉じた状態。
 *
 * 値を決めたら「今の値を出力」を押すと、そのままソースに書き写せる形で
 * パネル内に出る（開発用。提出時はパネルを隠して録画する）。
 */

type Num = {
  kind: "number";
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** 表示用の書式 */
  fmt?: (v: number) => string;
  set: (v: number) => void;
};
type Bool = {
  kind: "bool";
  label: string;
  value: boolean;
  /** 失敗したときはエラー文を返す（パネルに表示し、他の項目は触れる状態を保つ） */
  set: (v: boolean) => string | undefined | void;
};
type Col = {
  kind: "color";
  label: string;
  /** #rrggbb */
  value: string;
  set: (v: string) => void;
};
export type Control = Num | Bool | Col;
export type Section = { title: string; controls: Control[] };

export function setupLookPanel(sections: Section[], startOpen: boolean): void {
  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed",
    "right:12px",
    "top:12px",
    "z-index:1000",
    "width:320px",
    "max-height:calc(100vh - 24px)",
    "overflow:auto",
    "padding:10px 12px",
    "border-radius:6px",
    "background:rgba(18,20,24,.86)",
    "color:#e8eaed",
    "font:12px/1.6 ui-monospace,Menlo,Consolas,monospace",
    "backdrop-filter:blur(4px)",
  ].join(";");

  const head = document.createElement("div");
  head.textContent = "見た目の調整 (L で開閉)";
  head.style.cssText = "font-weight:600;margin-bottom:6px;letter-spacing:.04em";
  panel.appendChild(head);

  const out = document.createElement("pre");
  out.style.cssText =
    "margin:6px 0 0;padding:6px;border-radius:4px;background:rgba(0,0,0,.35);" +
    "color:#9aa4b2;white-space:pre-wrap;word-break:break-all;display:none";

  for (const sec of sections) {
    const box = document.createElement("div");
    box.style.cssText =
      "margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.16)";
    const t = document.createElement("div");
    t.textContent = sec.title;
    t.style.cssText = "color:#7ee0a0;margin-bottom:2px";
    box.appendChild(t);

    for (const c of sec.controls) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;margin:1px 0";
      const name = document.createElement("span");
      name.textContent = c.label;
      name.style.cssText = "width:8.5em;flex:none;overflow:hidden;text-overflow:ellipsis";
      row.appendChild(name);

      if (c.kind === "number") {
        const val = document.createElement("span");
        val.style.cssText = "width:4.2em;flex:none;text-align:right";
        const show = (v: number) => (val.textContent = c.fmt ? c.fmt(v) : String(v));
        show(c.value);
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(c.min);
        input.max = String(c.max);
        input.step = String(c.step);
        input.value = String(c.value);
        input.style.cssText = "flex:1;min-width:80px";
        input.addEventListener("input", () => {
          const v = parseFloat(input.value);
          show(v);
          c.value = v;
          c.set(v);
        });
        row.append(input, val);
      } else if (c.kind === "bool") {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = c.value;
        const err = document.createElement("span");
        err.style.cssText = "color:#ff8a8a;flex:1;min-width:0;overflow:hidden";
        input.addEventListener("change", () => {
          let msg: string | undefined | void;
          try {
            msg = c.set(input.checked);
          } catch (e) {
            msg = e instanceof Error ? e.message : String(e);
          }
          if (msg) {
            input.checked = false;
            err.textContent = String(msg).slice(0, 60);
          } else {
            c.value = input.checked;
            err.textContent = "";
          }
        });
        row.append(input, err);
      } else {
        const input = document.createElement("input");
        input.type = "color";
        input.value = c.value;
        input.style.cssText = "width:40px;height:20px;padding:0;border:0;background:none";
        const hex = document.createElement("span");
        hex.textContent = c.value;
        hex.style.cssText = "color:#9aa4b2";
        input.addEventListener("input", () => {
          c.value = input.value;
          hex.textContent = input.value;
          c.set(input.value);
        });
        row.append(input, hex);
      }
      box.appendChild(row);
    }
    panel.appendChild(box);
  }

  const btn = document.createElement("button");
  btn.textContent = "今の値を出力";
  btn.style.cssText =
    "margin-top:8px;padding:5px 10px;border:1px solid rgba(255,255,255,.28);" +
    "border-radius:4px;background:rgba(255,255,255,.08);color:#e8eaed;" +
    "font:12px/1.4 inherit;cursor:pointer";
  btn.addEventListener("click", () => {
    const lines: string[] = [];
    for (const sec of sections) {
      lines.push(`# ${sec.title}`);
      for (const c of sec.controls) {
        const v =
          c.kind === "number"
            ? c.fmt
              ? c.fmt(c.value)
              : String(c.value)
            : String(c.value);
        lines.push(`${c.label} = ${v}`);
      }
    }
    out.textContent = lines.join("\n");
    out.style.display = "";
  });
  panel.append(btn, out);
  document.body.appendChild(panel);

  let open = startOpen;
  const apply = () => (panel.style.display = open ? "" : "none");
  apply();
  window.addEventListener("keydown", (e) => {
    if (e.key === "l" || e.key === "L") {
      open = !open;
      apply();
    }
  });
}

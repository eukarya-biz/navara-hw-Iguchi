import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  /* GitHub Pages ではリポジトリ名のサブパス（/navara-hw-Iguchi/）で公開されるため、
     ビルド時だけその名前を base に渡す。渡さないとアセットを root から探して
     公開先で真っ白になる。開発時は root のままにしておく。 */
  base: command === "build" ? "/navara-hw-Iguchi/" : "/",

  build: {
    /* Navara は自分の大気・ノイズテクスチャを new URL("./assets/atmosphere", import.meta.url)
       で探す。つまり「読み込まれた JS ファイルの隣の assets/」を見る。既定どおり JS を
       dist/assets/ に出すと探す先が dist/assets/assets/ になって 404 になり、その失敗が
       捕まらないまま初期化が止まって画面が真っ白になる（dev では JS が
       node_modules/@navara/three/dist/ から配信されるため、その隣にある実物が読めていた）。
       JS を dist の直下に出し、public/assets/ にパッケージと同じ階層で実ファイルを置いて、
       ビルド後も同じ相対指定で解決できるようにする。 */
    assetsDir: ".",
  },
}));

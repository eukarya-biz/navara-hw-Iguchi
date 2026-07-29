import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  /* GitHub Pages ではリポジトリ名のサブパス（/navara-hw-Iguchi/）で公開されるため、
     ビルド時だけその名前を base に渡す。渡さないとアセットを root から探して
     公開先で真っ白になる。開発時は root のままにしておく。 */
  base: command === "build" ? "/navara-hw-Iguchi/" : "/",
}));

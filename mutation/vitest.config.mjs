// Mutation testing（mizchi/mutator）で、計算のテストを Vitest で動かすための設定。
// Vitest と mutator は mutation/ にだけ入れる（リポジトリの直下に package.json と node_modules を置かない）。
// root はリポジトリの直下。Vite のキャッシュも mutation/ の中に置く
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  cacheDir: fileURLToPath(new URL("./node_modules/.vite", import.meta.url)),
  test: { include: ["tests/*.test.mjs"] },
});

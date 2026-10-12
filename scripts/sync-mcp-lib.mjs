// 画面の計算の部品と、アプリの更新の一覧を、MCP サーバーのフォルダーへ写す。
// Edge Function は自分のフォルダーの中のファイルしか読み込めないので、同じ内容の写しを置く。
// app/ の側を変えたら、配備の前に実行する: node scripts/sync-mcp-lib.mjs
// 写しが古いままだと、tests/field-mcp.test.mjs が失敗する。
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SHARED = ["geometry.js", "schedule.js", "crops.js", "updates.json"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const APP = join(root, "app");
export const LIB = join(root, "supabase", "functions", "field-mcp", "lib");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(LIB, { recursive: true });
  for (const name of SHARED) {
    copyFileSync(join(APP, name), join(LIB, name));
    console.log(`写しました: ${name}`);
  }
}

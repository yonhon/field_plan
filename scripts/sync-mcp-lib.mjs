// 画面の計算の部品を、MCP サーバーのフォルダー（supabase/functions/field-mcp/lib/）へ写す。
// Edge Function は自分のフォルダーの中のファイルしか読み込めないので、同じ内容の写しを置く。
// 写しは git に入れない（.gitignore）。手で写す必要はなく、次の 2 か所が自動で写す:
//   - tests/field-mcp.test.mjs（サーバーのコードを読み込む前に写す）
//   - .github/workflows/deploy_mcp.yml（配備の前に写す）
// 手元から配備するときだけ、先に実行する: node scripts/sync-mcp-lib.mjs
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SHARED = ["geometry.js", "schedule.js", "crops.js", "logs.js", "rac.js", "html.js"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const APP = join(root, "app");
export const LIB = join(root, "supabase", "functions", "field-mcp", "lib");

export function syncMcpLib({ log = () => {} } = {}) {
  mkdirSync(LIB, { recursive: true });
  for (const name of SHARED) {
    copyFileSync(join(APP, name), join(LIB, name));
    log(`写しました: ${name}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncMcpLib({ log: console.log });
}

// どのコードのファイルも、1 行目に、何をするファイルかのコメントを持つことのテスト。実行: node --test "tests/*.test.mjs"
// ファイルごとの役目は、README の表ではなく、ファイルの先頭のコメントに書く（docs/development.md）。
import { test } from "./test-api.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 確かめるフォルダーと、そこで見る拡張子。下のフォルダーまでは見ない（MCP サーバーの lib/ は写しなので見ない）
const DIRS = [
  ["app", [".js"]],
  ["scripts", [".mjs", ".py"]],
  ["scripts/perf", [".mjs"]],
  ["supabase/functions/field-mcp", [".js", ".ts"]],
  ["supabase/functions/field-photos", [".ts"]],
  ["supabase/functions/field-weather", [".ts"]],
  ["tests", [".mjs"]],
  ["tests/e2e", [".mjs"]],
  ["mutation", [".mjs"]],
];

function codeFiles() {
  const files = [];
  for (const [dir, exts] of DIRS) {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) files.push(`${dir}/${entry.name}`);
    }
  }
  return files;
}

function startsWithComment(path, text) {
  const first = text.replace(/^﻿/, "").split("\n", 1)[0];
  if (path.endsWith(".py")) return /^(#|"""|''')/.test(first);
  return /^(\/\/|\/\*)/.test(first);
}

test("コードのファイルは、1 行目に何をするファイルかのコメントを持つ", () => {
  const files = codeFiles();
  assert.ok(files.length > 50, `確かめたファイルが少ない（${files.length}）`);
  const missing = files.filter((path) => !startsWithComment(path, readFileSync(join(ROOT, path), "utf8")));
  assert.deepEqual(missing, [], "先頭のコメントがないファイル");
});

test("先頭のコメントの確かめ: コメントで始まらないものを見つける", () => {
  assert.equal(startsWithComment("app/a.js", "import { x } from \"./x.js\";\n// 説明\n"), false);
  assert.equal(startsWithComment("app/a.js", "// 説明\nimport x;\n"), true);
  assert.equal(startsWithComment("app/a.js", "/* 説明 */\n"), true);
  assert.equal(startsWithComment("scripts/a.py", "\"\"\"説明\"\"\"\n"), true);
  assert.equal(startsWithComment("scripts/a.py", "# 説明\n"), true);
  assert.equal(startsWithComment("scripts/a.py", "import os\n"), false);
});

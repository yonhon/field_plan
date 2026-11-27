// どのコードのファイルも、1 行目に何をするファイルかのコメントを持つことと、
// docs/development.md の「画面の部分とファイル」の表が、あるファイルと関数を指していることのテスト。実行: node --test "tests/*.test.mjs"
// ファイルごとの役目は、README の表ではなく、ファイルの先頭のコメントに書く（docs/development.md）。
import { test } from "./test-api.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODE = /\.(js|mjs|ts|py|sql)$/;
// 外から持ってきたライブラリーは、手を入れずに置くので見ない
const SKIP = [/^app\/vendor\//];

// Git にあるコードのファイルを全部拾う。フォルダーや関数を足しても、ここを直さずに入る
function codeFiles() {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((path) => CODE.test(path) && !SKIP.some((re) => re.test(path)));
}

function startsWithComment(path, text) {
  const first = text.replace(/^﻿/, "").split("\n", 1)[0];
  if (path.endsWith(".py")) return /^(#|"""|''')/.test(first);
  if (path.endsWith(".sql")) return /^(--|\/\*)/.test(first);
  return /^(\/\/|\/\*)/.test(first);
}

test("コードのファイルは、1 行目に何をするファイルかのコメントを持つ", () => {
  const files = codeFiles();
  assert.ok(files.length > 50, `確かめたファイルが少ない（${files.length}）`);
  for (const dir of ["app/", "scripts/", "supabase/functions/", "sql/", "tests/", "mutation/"]) {
    assert.ok(files.some((path) => path.startsWith(dir)), `${dir} のファイルを拾えていない`);
  }
  const missing = files.filter((path) => !startsWithComment(path, readFileSync(join(ROOT, path), "utf8")));
  assert.deepEqual(missing, [], "先頭のコメントがないファイル");
});

test("先頭のコメントの確かめ: コメントで始まらないものを見つける", () => {
  assert.equal(startsWithComment("app/a.js", 'import { x } from "./x.js";\n// 説明\n'), false);
  assert.equal(startsWithComment("app/a.js", "// 説明\nimport x;\n"), true);
  assert.equal(startsWithComment("app/a.js", "/* 説明 */\n"), true);
  assert.equal(startsWithComment("scripts/a.py", '"""説明"""\n'), true);
  assert.equal(startsWithComment("scripts/a.py", "# 説明\n"), true);
  assert.equal(startsWithComment("scripts/a.py", "import os\n"), false);
  assert.equal(startsWithComment("sql/a.sql", "-- 説明\n"), true);
  assert.equal(startsWithComment("sql/a.sql", "create table x ();\n"), false);
});

// 表の 2 列目の `…` を読む。「`ファイル` の `名前`」は、そのファイルにある名前を指す
function tableRefs(markdown) {
  const start = markdown.indexOf("\n## 画面の部分とファイル");
  assert.ok(start >= 0, "「画面の部分とファイル」の節がない");
  const end = markdown.indexOf("\n## ", start + 1);
  const rows = markdown
    .slice(start, end < 0 ? undefined : end)
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| 画面の部分 |"));
  return rows.map((row) => {
    const cell = row.split("|")[2];
    const names = [...cell.matchAll(/`([^`]+)`(?: の `([^`]+)`)?/g)].map((m) => ({ file: m[1], symbol: m[2] }));
    return { row, names };
  });
}

function resolveFile(name) {
  return name.includes("/") ? join(ROOT, name) : join(ROOT, "app", name);
}

test("「画面の部分とファイル」の表は、あるファイルと、そのファイルにある名前を指す", () => {
  const refs = tableRefs(readFileSync(join(ROOT, "docs", "development.md"), "utf8"));
  assert.ok(refs.length >= 10, `表の行が少ない（${refs.length}）`);
  const wrong = [];
  for (const { row, names } of refs) {
    if (names.length === 0) wrong.push(`ファイルがない行: ${row}`);
    for (const { file, symbol } of names) {
      const path = resolveFile(file);
      if (!/\.(js|html|json|css)$/.test(file) && !file.endsWith("/")) {
        wrong.push(`ファイルでも関数でもない: ${file}`);
      } else if (!existsSync(path)) {
        wrong.push(`ないファイル: ${file}`);
      } else if (symbol && !new RegExp(`\\b${symbol}\\b`).test(readFileSync(path, "utf8"))) {
        wrong.push(`${file} にない名前: ${symbol}`);
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test("表の読み取り: ファイルと、ファイルの中の名前を分けて読む", () => {
  const md = [
    "## 画面の部分とファイル",
    "",
    "| 画面の部分 | ファイル |",
    "|---|---|",
    "| 台帳 | `schedule-view.js` の `renderTypes`（枠は `crops-view.js`） |",
    "| 中継 | `supabase/functions/field-photos/` |",
    "",
    "## テーブル",
    "| 外 | `other.js` |",
  ].join("\n");
  const refs = tableRefs(`\n${md}`);
  assert.deepEqual(
    refs.map((r) => r.names),
    [
      [
        { file: "schedule-view.js", symbol: "renderTypes" },
        { file: "crops-view.js", symbol: undefined },
      ],
      [{ file: "supabase/functions/field-photos/", symbol: undefined }],
    ],
  );
  assert.ok(existsSync(resolveFile("schedule-view.js")));
  assert.ok(!existsSync(resolveFile("no-such-file.js")));
});

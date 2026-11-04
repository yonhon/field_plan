// 画面の描き方のきまり（docs/implementation-rules.md の「画面を描く」）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

test("画面の中身は draw で入れ替える（innerHTML などを直接使わない）", () => {
  const found = [];
  for (const name of readdirSync(APP).filter((item) => item.endsWith(".js") && item !== "draw.js")) {
    readFileSync(join(APP, name), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/\.(innerHTML|outerHTML)\s*\+?=(?!=)|insertAdjacentHTML\s*\(/.test(line)) {
          found.push(`app/${name}:${i + 1}`);
        }
      });
  }
  assert.deepEqual(found, [], "innerHTML などで中身を入れ替えると、スクロールの位置とカーソルが失われる。draw（app/draw.js）を使う");
});

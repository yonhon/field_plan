// 版の印（scripts/build-version.mjs が作る app/version.json）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appFiles, buildVersion, differences } from "../scripts/build-version.mjs";

const FILES = ["./", "app.js", "styles.css"];

function appDir(contents) {
  const dir = mkdtempSync(join(tmpdir(), "field-plan-version-"));
  for (const [file, body] of Object.entries(contents)) {
    writeFileSync(join(dir, file === "./" ? "index.html" : file), body);
  }
  return dir;
}

test("版の印: ファイルごとの SHA-256 と、そこから作った版、画面に出す版（A番号-版の先頭 5 文字）", () => {
  const info = buildVersion({ appDir: appDir({ "./": "page", "app.js": "app", "styles.css": "css" }), files: FILES, no: 199 });
  assert.equal(info.files["app.js"], createHash("sha256").update("app").digest("hex"));
  assert.equal(info.files["./"], createHash("sha256").update("page").digest("hex"), "./ は index.html");
  assert.match(info.version, /^[0-9a-f]{12}$/);
  assert.equal(info.label, `A199-${info.version.slice(0, 5)}`);
  assert.equal(info.no, 199);
});

test("版の印: 中身が同じなら同じ版、1 文字でも違えば違う版", () => {
  const a = buildVersion({ appDir: appDir({ "./": "page", "app.js": "app", "styles.css": "css" }), files: FILES, no: 1 });
  const b = buildVersion({ appDir: appDir({ "./": "page", "app.js": "app", "styles.css": "css" }), files: FILES, no: 2 });
  const c = buildVersion({ appDir: appDir({ "./": "page", "app.js": "app!", "styles.css": "css" }), files: FILES, no: 1 });
  assert.equal(a.version, b.version);
  assert.notEqual(a.version, c.version);
});

test("版の印: 一覧にあるファイルがなければ、作らずに止める", () => {
  assert.throws(() => buildVersion({ appDir: appDir({ "./": "page", "app.js": "app" }), files: FILES, no: 1 }), /styles\.css がありません/);
});

test("版の印: 一式の一覧は app/sw.js の FILES で、どれも app/ にある", () => {
  const files = appFiles();
  assert.ok(files.includes("./") && files.includes("app.js") && files.includes("sw.js") === false);
  assert.doesNotThrow(() => buildVersion({ files, no: 1 }));
});

test("公開のあとの確かめ: 配っている中身が版の印と違うファイルを返す", async () => {
  const info = buildVersion({ appDir: appDir({ "./": "page", "app.js": "app", "styles.css": "css" }), files: FILES, no: 1 });
  const served = { "version.json": JSON.stringify(info), "": "page", "app.js": "app", "styles.css": "css" };
  const fetchImpl = async (url) => {
    const name = new URL(url).pathname.replace("/field_plan/", "");
    return name in served ? new Response(served[name]) : new Response("", { status: 404 });
  };
  assert.deepEqual(await differences("https://example.test/field_plan/", info, fetchImpl), []);
  served["app.js"] = "old app";
  assert.deepEqual(await differences("https://example.test/field_plan/", info, fetchImpl), ["app.js"]);
  delete served["version.json"];
  assert.deepEqual(await differences("https://example.test/field_plan/", info, fetchImpl), ["app.js", "version.json"]);
});

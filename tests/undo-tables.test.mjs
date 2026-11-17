// 元に戻す（DB の変更の記録で戻す）の、表の一覧の食い違いを見つける。表を足したときに、どこかに足し忘れると失敗する。
// 一覧は 5 か所にある:
//   sql/field.sql の変更の記録のトリガーを付ける表（write_audit_log）と、付けない表（最後の確かめの「対象にしない表」）
//   sql/field.sql の field.undo_op の表の順（v_order。親から子）
//   app/history.js の UNDO_APPLY（画面への当て方）と UNDO_NOT_APPLIED（当て方を決めていない表）
//   app/store.js の AUDIT_NAMES（このブラウザーの保存の変更の記録。undoOp が返す表の名前）
// 実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIELD_SQL as SQL } from "./load-field-sql.mjs";
import { UNDO_APPLY, UNDO_NOT_APPLIED } from "../app/history.js";
import { AUDIT_NAMES } from "../app/store.js";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "app");
const names = (text) => new Set([...text.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
const sorted = (set) => [...set].sort();

// 変更の記録のトリガーを付ける表
const audited = names(SQL.match(/foreach t in array array\[([\s\S]*?)\] loop\s*execute format\('drop trigger if exists write_audit_log/)?.[1] || "");
// 変更の記録の対象にしない表（field.sql の最後の確かめ）
const excluded = names(SQL.match(/and c\.relname not in \(([\s\S]*?)\)\s*and not exists \(select 1 from pg_trigger t where t\.tgrelid = c\.oid and t\.tgname = 'write_audit_log'\)/)?.[1] || "");
// field.undo_op の表の順
const undoOrder = names(SQL.match(/create or replace function field\.undo_op[\s\S]*?v_order constant text\[\] := array\[([\s\S]*?)\];/)?.[1] || "");

test("一覧を読み取れている", () => {
  assert.ok(audited.size > 10, "変更の記録のトリガーを付ける表の一覧が見つからない");
  assert.ok(excluded.size > 5, "変更の記録の対象にしない表の一覧が見つからない");
  assert.ok(undoOrder.size > 10, "field.undo_op の表の順（v_order）が見つからない");
});

test("field.undo_op の表の順（v_order）に、変更の記録の対象の表がすべてあり、ほかの表はない", () => {
  assert.deepEqual(sorted(undoOrder), sorted(audited));
});

test("変更の記録の対象の表は、どれも、画面への当て方（UNDO_APPLY）か、当て方を決めていない表（UNDO_NOT_APPLIED）のどちらか一方にある", () => {
  const applied = new Set(Object.keys(UNDO_APPLY));
  const notApplied = new Set(Object.keys(UNDO_NOT_APPLIED));
  assert.deepEqual(sorted([...applied].filter((table) => notApplied.has(table))), [], "両方にある表");
  assert.deepEqual(sorted(new Set([...applied, ...notApplied])), sorted(audited));
});

test("元に戻すの対象の書き込み（upsert、remove）で書く表は、どれも画面への当て方がある", () => {
  const written = new Set();
  for (const file of readdirSync(APP).filter((name) => name.endsWith(".js"))) {
    const text = readFileSync(join(APP, file), "utf8");
    for (const match of text.matchAll(/\.(?:upsert|remove)\(\s*"([a-z_]+)"/g)) {
      written.add(match[1]);
    }
  }
  // 図形の保存は、表を変数で選ぶ（app.js の TABLES）
  const tables = readFileSync(join(APP, "app.js"), "utf8").match(/const TABLES = \{([^}]*)\}/)?.[1];
  assert.ok(tables, "app.js の TABLES が見つからない");
  for (const match of tables.matchAll(/"([a-z_]+)"/g)) {
    written.add(match[1]);
  }
  assert.ok(written.size > 5, "upsert と remove の書き先を読み取れていない");
  assert.deepEqual(sorted([...written].filter((table) => !UNDO_APPLY[table])), []);
});

test("画面が DB に直接書く表は、どれも、変更の記録の対象か、対象にしない表の一覧にある", () => {
  const store = readFileSync(join(APP, "store.js"), "utf8");
  const supabase = store.slice(0, store.indexOf("export function createLocalStore"));
  const written = new Set();
  for (const match of supabase.matchAll(/\.from\("([a-z_]+)"\)((?:\s*\.\w+\([^()]*(?:\([^()]*\)[^()]*)*\))*)/g)) {
    if (/\.(?:upsert|insert|update|delete)\(/.test(match[2])) {
      written.add(match[1]);
    }
  }
  assert.ok(written.size > 5, "store.js の書き先を読み取れていない");
  assert.deepEqual(sorted([...written].filter((table) => !audited.has(table) && !excluded.has(table))), []);
});

test("このブラウザーの保存は、画面への当て方のある表をすべて、変更の記録に残す", () => {
  // 作業の記録の 3 つの表は、記録・対象・資材をまとめて logs として残す
  const expected = new Set(Object.entries(UNDO_APPLY).map(([table, kind]) => (kind === "logs" ? "logs" : table)));
  assert.deepEqual(sorted(new Set(Object.values(AUDIT_NAMES))), sorted(expected));
});

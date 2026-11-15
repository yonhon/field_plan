// 起動と、戻ってきたときの読み直しが読む表（DB の関数 field.load_field）が、すべて DB の操作の記録（field.audit_log）の対象になっていること。
// 画面は、操作の記録の最後の番号が前と同じなら読み直さない。対象でない表を読み直しに足すと、その表の変更を取りこぼす。
// 実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELD_SQL as SQL, loadFieldTables } from "./load-field-sql.mjs";

// 変更の印と版の表。中身ではないので、操作の記録の対象でなくてよい
const META = new Set(["app_compat", "audit_log"]);

test("起動と戻ってきたときの読み直しが読む表は、すべて操作の記録（audit_log）の対象", () => {
  const audited = SQL.match(/foreach t in array array\[([\s\S]*?)\] loop\s*execute format\('drop trigger if exists write_audit_log/)?.[1];
  assert.ok(audited, "audit_log のトリガーを付ける表の一覧が見つからない");
  const tables = new Set([...audited.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
  const all = loadFieldTables();
  assert.ok(all, "field.load_field が見つからない");
  const read = [...all].filter((table) => !META.has(table));
  assert.ok(read.length > 5, "load_field が読む表を読み取れていない");
  for (const table of read) {
    assert.ok(tables.has(table), `${table} は audit_log の対象でない（field.load_field が読む）`);
  }
});

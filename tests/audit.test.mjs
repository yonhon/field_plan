// 戻ってきたときの読み直し（app/app.js の fetchCurrent）が読む表が、すべて DB の操作の記録（field.audit_log）の対象になっていること。
// 画面は、操作の記録の最後の番号が前と同じなら読み直さない。対象でない表を読み直しに足すと、その表の変更を取りこぼす。
// 実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = readFileSync(join(ROOT, "app", "app.js"), "utf8");
const SQL = readFileSync(join(ROOT, "sql", "field.sql"), "utf8");

// 読み直しの読み込みと、それが読む表。読み込みを足したら、ここに足し、その表を audit_log の対象（field.sql）に入れる
const LOADERS = {
  "state.store.loadFields()": ["fields"],
  "state.store.loadWorkTypes()": ["work_types"],
  'state.store.listAll("crops")': ["crops"],
  'state.store.listAll("fertilizers")': ["fertilizers"],
  "state.store.loadPlans(state.field.id)": ["plans"],
  "loadTables(PLAN_TABLES, state.plan.id)": ["zones", "blocks", "beds", "plantings", "works"],
  "state.store.loadLogs(state.field.id)": ["work_logs", "work_log_targets", "work_log_inputs"],
};

test("戻ってきたときの読み直しが読む表は、すべて操作の記録（audit_log）の対象", () => {
  const body = APP.match(/async function fetchCurrent\(\) \{[\s\S]*?await Promise\.all\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(body, "fetchCurrent の読み込みが見つからない");
  const calls = body.split(",\n").map((line) => line.trim().replace(/,$/, "")).filter(Boolean);
  const unknown = calls.filter((call) => !LOADERS[call]);
  assert.deepEqual(unknown, [], "読み直しに読み込みを足したら、読む表をこのテストの LOADERS に足し、audit_log の対象か確かめる");
  const audited = SQL.match(/foreach t in array array\[([\s\S]*?)\] loop\s*execute format\('drop trigger if exists write_audit_log/)?.[1];
  assert.ok(audited, "audit_log のトリガーを付ける表の一覧が見つからない");
  const tables = new Set([...audited.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
  for (const call of calls) {
    for (const table of LOADERS[call]) {
      assert.ok(tables.has(table), `${table} は audit_log の対象でない（${call}）`);
    }
  }
});

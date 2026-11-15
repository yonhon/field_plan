// 起動、戻ってきたときの読み直し、圃場の切り替えで読む中身の 2 つの読み方が、同じ表を読むこと。
//   DB の関数 field.load_field（sql/field.sql）: ふだんの画面
//   composeLoadField（app/store.js）: ?local=1 の店と、DB の関数がないとき。通しテストはこちらしか通らない
// 片方だけに表を足すと、通しテストは通ったまま、本番でだけその表が読まれない。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIELD_SQL, loadFieldTables } from "./load-field-sql.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE = readFileSync(join(ROOT, "app", "store.js"), "utf8");

// composeLoadField の読み込みと、それが読む表。読み込みを足したら、ここに足す
const LOADERS = {
  "store.changeMark()": ["audit_log"],
  "store.minAppVersion()": ["app_compat"],
  "store.loadFields()": ["fields"],
  "store.loadWorkTypes()": ["work_types"],
  'store.listAll("crops")': ["crops"],
  'store.listAll("fertilizers")': ["fertilizers"],
  "store.loadPlans(field.id)": ["plans"],
  "store.list(table, plan.id)": ["zones", "blocks", "beds", "plantings", "works"],
  "store.loadLogs(field.id)": ["work_logs", "work_log_targets", "work_log_inputs"],
  "store.loadBackdrop(field.id)": ["backdrops"],
};

test("field.load_field と composeLoadField は、同じ表を読む", () => {
  const body = STORE.match(/export function composeLoadField\(store\) \{([\s\S]*?)\n\}\n/)?.[1];
  assert.ok(body, "composeLoadField が見つからない");
  const calls = [...new Set([...body.matchAll(/store\.[A-Za-z]+\([^()]*\)/g)].map((match) => match[0]))];
  const unknown = calls.filter((call) => !LOADERS[call]);
  assert.deepEqual(unknown, [], "composeLoadField に読み込みを足したら、読む表をこのテストの LOADERS に足し、field.load_field も直す");
  const composed = new Set(calls.flatMap((call) => LOADERS[call]));
  // field.load_field は、操作の記録を field.audit_last() で読む（表の名前は出てこない）
  const tables = loadFieldTables();
  assert.ok(tables, "field.load_field が見つからない");
  const sql = new Set([...tables, ...(/v_mark bigint := field\.audit_last\(\)/.test(FIELD_SQL) ? ["audit_log"] : [])]);
  assert.deepEqual([...composed].sort(), [...sql].sort());
});

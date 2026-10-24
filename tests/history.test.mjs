// 元に戻す（app/history.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsConfirm, removedRows } from "../app/history.js";

const rows = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` }));

function snap(planId, counts = {}) {
  const data = { planId, outline: [], viewDirs: null, workTypes: [] };
  for (const table of ["zones", "blocks", "beds", "plantings", "works", "fertilizers", "crops"]) {
    data[table] = rows(table, counts[table] || 0);
  }
  return JSON.stringify(data);
}

test("removedRows は、写しに合わせたときに消える行を表ごとに数える", () => {
  const current = snap("p", { zones: 7, blocks: 4, beds: 16, plantings: 15, works: 60 });
  assert.deepEqual(removedRows(current, snap("p")), { zones: 7, blocks: 4, beds: 16, plantings: 15, works: 60 });
  assert.deepEqual(removedRows(current, current), {});
  assert.deepEqual(removedRows(snap("p", { beds: 3 }), snap("p", { beds: 2 })), { beds: 1 });
});

test("needsConfirm は、ふだんの 1 回ぶんを超えて消えるときだけ確かめる", () => {
  assert.equal(needsConfirm({}), false);
  assert.equal(needsConfirm({ beds: 1 }), false);
  assert.equal(needsConfirm({ plantings: 1, works: 5 }), false);
  assert.equal(needsConfirm({ beds: 2 }), true);
  assert.equal(needsConfirm({ zones: 1 }), true);
  assert.equal(needsConfirm({ blocks: 1 }), true);
  assert.equal(needsConfirm({ works: 11 }), true);
  assert.equal(needsConfirm({ crops: 1 }), true);
});

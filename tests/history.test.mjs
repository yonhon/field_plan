// 元に戻す（app/history.js）が使う、このブラウザーの保存の戻し方（app/store.js の undoOp）のテスト。
// DB の関数 field.undo_op と同じ戻し方と返し方をすることを確かめる（DB の側は scripts/check_field_sql.py が確かめる）。
// 実行: node --test "tests/*.test.mjs"
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { CONFIRM_FROM } from "../app/history.js";
import { createLocalStore, currentOperation, inOrder, startOperation } from "../app/store.js";

const KEY = "field_plan_local";
const block = { id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [] };
const bed = (n) => ({ id: `bed${n}`, plan_id: "p1", block_id: "b1", seq: n, shape: [] });

beforeEach(() => {
  const items = new Map();
  globalThis.localStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key),
  };
  localStorage.setItem(KEY, JSON.stringify({ zones: [{ id: "z1", plan_id: "p1" }], blocks: [block], beds: [bed(1)] }));
});

const saved = () => JSON.parse(localStorage.getItem(KEY));
const tables = () => {
  const { audit, ...rest } = saved();
  return rest;
};

// 1 回の操作の書き込み。操作の ID を返す
async function operation(store, write) {
  startOperation();
  const op = currentOperation();
  await write();
  return op;
}

test("足した行と変えた行を戻すと、操作の前に戻り、戻した行の今の中身を返す", async () => {
  const store = inOrder(createLocalStore());
  const start = tables();
  const op = await operation(store, async () => {
    await store.upsert("beds", [bed(2)]);
    await store.upsert("blocks", [{ ...block, name: "B" }]);
  });
  startOperation();
  const result = await store.undoOp(op);
  assert.equal(result.status, "done");
  assert.deepEqual(tables(), start);
  const changes = Object.fromEntries(result.changes.map((item) => [`${item.table}:${item.id}`, item.row]));
  assert.deepEqual(changes, { "beds:bed2": null, "blocks:b1": block });
  assert.notEqual(result.op_id, op);
});

test("戻す処理の ID を戻すと、やり直しになる", async () => {
  const store = inOrder(createLocalStore());
  const op = await operation(store, () => store.upsert("beds", [{ ...bed(1), seq: 5 }]));
  const moved = tables();
  startOperation();
  const undone = await store.undoOp(op);
  startOperation();
  const redone = await store.undoOp(undone.op_id);
  assert.equal(redone.status, "done");
  assert.deepEqual(tables(), moved);
});

test("同じ行を続けて変えた 2 つの操作は、新しい順に戻せば、どちらも戻る。あとの操作が残っていれば、前の操作はぶつかる", async () => {
  const store = inOrder(createLocalStore());
  const start = tables();
  const first = await operation(store, () => store.upsert("beds", [bed(2)]));
  const second = await operation(store, () => store.upsert("beds", [{ ...bed(2), seq: 7 }]));
  startOperation();
  assert.equal((await store.undoOp(first)).status, "conflict", "あとの操作で変わったまま");
  startOperation();
  assert.equal((await store.undoOp(second)).status, "done");
  startOperation();
  assert.equal((await store.undoOp(first)).status, "done", "あとの操作を戻したので、前の操作のあとの中身に戻っている");
  assert.deepEqual(tables(), start);
});

test("消した親と、連鎖で消えた子を、まとめて戻す", async () => {
  const store = inOrder(createLocalStore());
  const start = tables();
  const op = await operation(store, () => store.remove("blocks", ["b1"]));
  assert.deepEqual(saved().beds, [], "子の畝も消える");
  startOperation();
  assert.equal((await store.undoOp(op)).status, "done");
  assert.deepEqual(tables(), start);
});

test("消える行が上限以上なら、戻さずに数を返す。上限なしなら戻す", async () => {
  const store = inOrder(createLocalStore());
  const start = tables();
  const op = await operation(store, () => store.upsert("beds", [bed(2), bed(3)]));
  const before = saved();
  startOperation();
  assert.deepEqual(await store.undoOp(op, CONFIRM_FROM), { status: "confirm", removed: { beds: 2 } });
  assert.deepEqual(saved(), before, "何も変わらない");
  startOperation();
  assert.equal((await store.undoOp(op)).status, "done");
  assert.deepEqual(tables(), start);
});

test("作業の記録は、記録・対象・資材の形で logs に返す", async () => {
  const store = inOrder(createLocalStore());
  const op = await operation(store, () => store.saveLog({ id: "log1", field_id: "f1", date: "2026-04-01", work_type: "plant", targets: [], inputs: [] }));
  startOperation();
  const result = await store.undoOp(op);
  assert.deepEqual(result.logs, [{ id: "log1", row: null }]);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(saved().workLogs, []);
});

test("記録のない操作の ID は、戻すものがないと返す", async () => {
  const store = inOrder(createLocalStore());
  assert.deepEqual(await store.undoOp(crypto.randomUUID()), { status: "empty" });
});

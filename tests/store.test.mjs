// ローカルの保存（app/store.js）のテスト。実行: node --test "tests/*.test.mjs"
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createLocalStore, inOrder } from "../app/store.js";

const bed = { id: "bed1", plan_id: "p1", block_id: "b1", seq: 1 };
const planting = { id: "pl1", plan_id: "p1", bed_id: "bed1", seq: 1 };

beforeEach(() => {
  const items = new Map();
  globalThis.localStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
  };
  localStorage.setItem("field_plan_local", JSON.stringify({ zones: [{ id: "z1", plan_id: "p1" }], blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1" }] }));
});

test("ふつうのローカルの保存は、親のない行も入る", async () => {
  const store = createLocalStore();
  await store.upsert("plantings", [planting]);
  assert.equal((await store.list("plantings", "p1")).length, 1);
});

test("strict では、親のない行を 23503 で断る", async () => {
  const store = createLocalStore({ strict: true });
  await assert.rejects(store.upsert("plantings", [planting]), { code: "23503" });
  assert.equal((await store.list("plantings", "p1")).length, 0);
});

test("strict では、親の保存を待てば入る", async () => {
  const store = createLocalStore({ strict: true });
  await store.upsert("beds", [bed]);
  await store.upsert("plantings", [planting]);
  assert.equal((await store.list("plantings", "p1")).length, 1);
});

test("strict では、同時に保存すると親が遅れて、子が断られる", async () => {
  const store = createLocalStore({ strict: true });
  const [parent, child] = await Promise.allSettled([store.upsert("beds", [bed]), store.upsert("plantings", [planting])]);
  assert.equal(parent.status, "fulfilled");
  assert.equal(child.reason?.code, "23503");
});

test("inOrder は、同時に呼んでも呼んだ順に保存する", async () => {
  const store = inOrder(createLocalStore({ strict: true }));
  const writes = [store.upsert("beds", [bed]), store.upsert("plantings", [planting])];
  assert.equal(store.writing(), true);
  await Promise.all(writes);
  assert.equal(store.writing(), false);
  assert.equal((await store.list("plantings", "p1")).length, 1);
});

test("inOrder は、前の書き込みが失敗しても次を送り、失敗はその呼び出しに返す", async () => {
  const store = inOrder(createLocalStore({ strict: true }));
  const failed = store.upsert("plantings", [planting]);
  const next = store.upsert("beds", [bed]);
  await assert.rejects(failed, { code: "23503" });
  await next;
  assert.equal((await store.list("beds", "p1")).length, 1);
  assert.equal(store.writing(), false);
});

test("strict でも、親を指さない行は入る", async () => {
  const store = createLocalStore({ strict: true });
  await store.upsert("works", [{ id: "w1", plan_id: "p1", block_id: "b1", planting_id: null, seq: 1 }]);
  assert.equal((await store.list("works", "p1")).length, 1);
});

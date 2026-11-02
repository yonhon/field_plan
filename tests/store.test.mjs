// ローカルの保存（app/store.js）のテスト。実行: node --test "tests/*.test.mjs"
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createLocalStore, currentOperation, duringOperation, fetchWithOperation, inOrder, startOperation } from "../app/store.js";

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

// 書き込みの中で送るリクエストの見出しを集める
async function sentHeaders(run) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    sent.push(new Headers(options.headers).get("x-op-id"));
    return { ok: true };
  };
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

const REST = "https://example.supabase.co/rest/v1/works";
const fakeStore = () => ({ upsert: (url) => fetchWithOperation(url, { method: "POST" }) });

test("書き込みには、呼んだ時点の操作の ID が付く。操作が変わっても、待っている書き込みの ID は変わらない", async () => {
  const store = inOrder(fakeStore());
  startOperation();
  const first = currentOperation();
  const sent = await sentHeaders(async () => {
    const writes = [store.upsert(REST)];
    startOperation();
    writes.push(store.upsert(REST));
    await Promise.all(writes);
  });
  assert.deepEqual(sent, [first, currentOperation()]);
  assert.notEqual(sent[0], sent[1]);
});

test("あとから送る保存は、duringOperation で元の操作の ID になる", async () => {
  const store = inOrder(fakeStore());
  const sent = await sentHeaders(async () => {
    await duringOperation("op-old", () => store.upsert(REST));
    await store.upsert(REST);
  });
  assert.equal(sent[0], "op-old");
  assert.equal(sent[1], currentOperation());
});

test("読み取り、認証、書き込みの外のリクエストには、操作の ID を付けない", async () => {
  const store = inOrder({
    upsert: async () => {
      await fetchWithOperation(REST);
      await fetchWithOperation("https://example.supabase.co/auth/v1/token", { method: "POST" });
    },
  });
  const sent = await sentHeaders(async () => {
    await store.upsert();
    await fetchWithOperation(REST, { method: "POST" });
  });
  assert.deepEqual(sent, [null, null, null]);
});

test("inOrder は、持っていない書き込みの関数を足さない", () => {
  const store = inOrder({ upsert: async () => {} });
  assert.equal(store.saveLog, undefined);
});

test("strict でも、親を指さない行は入る", async () => {
  const store = createLocalStore({ strict: true });
  await store.upsert("works", [{ id: "w1", plan_id: "p1", block_id: "b1", planting_id: null, seq: 1 }]);
  assert.equal((await store.list("works", "p1")).length, 1);
});

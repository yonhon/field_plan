// 起動と圃場の切り替えで、前に開いていた圃場とプランを開くことを、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 起動では、圃場の一覧を待たずに、覚えていた圃場とプランの中身を読み始める。覚えていたものが消えていても開けることを確かめる
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const zone = (id, planId) => ({ id, plan_id: planId, kind: "tillable", name: "", shape: AREA, created_at: AT });

// 圃場 2 つ。圃場 1 はプラン 2 つ、圃場 2 はプラン 1 つ。プランごとに区域が 1 つ
const seed = () => ({
  fields: [
    { id: "f1", name: "一の圃場", outline: AREA, note: "", created_at: AT },
    { id: "f2", name: "二の圃場", outline: AREA, note: "", created_at: "2026-01-02T00:00:00Z" },
  ],
  plans: [
    { id: "p1", field_id: "f1", name: "一のプランA" },
    { id: "p2", field_id: "f1", name: "一のプランB" },
    { id: "p3", field_id: "f2", name: "二のプラン" },
  ],
  zones: [zone("z1", "p1"), zone("z2", "p2"), zone("z3", "p3")],
  blocks: [],
  beds: [],
  plantings: [],
  works: [],
  crops: [],
});

const options = { skip: findChrome() ? false : "Chrome が見つかりません" };
let page;

before(async () => {
  if (!options.skip) {
    page = await openBrowser();
  }
});

after(async () => {
  await page?.close();
});

const opened = () =>
  page.run(`({
    field: document.getElementById("fieldSelect").value,
    plan: document.getElementById("planSelect").value,
    planName: document.getElementById("schedulePlanName").textContent,
  })`);

test("起動: 前に開いていた圃場とプランを開き、中身もそのプランのもの", options, async () => {
  await page.loadApp(seed(), {
    field_plan_current_field: "f1",
    field_plan_prefs: JSON.stringify({ f1: { plan: "p2" } }),
  });
  assert.deepEqual(await opened(), { field: "f1", plan: "p2", planName: "一のプランB" });
  const zones = await page.run(`[...new Set([...document.querySelectorAll("[data-shape]")].map((shape) => shape.dataset.shape))].filter((id) => id.startsWith("z")).join()`);
  assert.equal(zones, "z2");
  assert.deepEqual(page.errors, []);
});

test("起動: 覚えていたプランが消えていれば、その圃場の先頭のプランを開く", options, async () => {
  await page.loadApp(seed(), {
    field_plan_current_field: "f1",
    field_plan_prefs: JSON.stringify({ f1: { plan: "gone" } }),
  });
  assert.deepEqual(await opened(), { field: "f1", plan: "p1", planName: "一のプランA" });
  assert.deepEqual(page.errors, []);
});

test("起動: 覚えていた圃場が消えていれば、先頭の圃場を開く", options, async () => {
  await page.loadApp(seed(), { field_plan_current_field: "gone" });
  assert.deepEqual(await opened(), { field: "f1", plan: "p1", planName: "一のプランA" });
  assert.deepEqual(page.errors, []);
});

test("圃場の切り替え: 切り替えた圃場のプランを開き、戻ると前に開いていたプランを開く", options, async () => {
  await page.loadApp(seed(), {
    field_plan_current_field: "f1",
    field_plan_prefs: JSON.stringify({ f1: { plan: "p2" } }),
  });
  await page.setValue("#fieldSelect", "f2");
  await page.waitFor(`document.getElementById("planSelect").value === "p3"`, "圃場 2 のプランを開く");
  assert.deepEqual(await opened(), { field: "f2", plan: "p3", planName: "二のプラン" });
  await page.setValue("#fieldSelect", "f1");
  await page.waitFor(`document.getElementById("planSelect").value === "p2"`, "圃場 1 の前のプランを開く");
  assert.deepEqual(page.errors, []);
});

test("起動: DB がこの版より新しい画面を求めていれば、画面を出さず、DB に書かない", options, async () => {
  const data = { ...seed(), fields: [], plans: [], zones: [], app_compat: { min_version: 999 } };
  await page.loadApp(data, {}, "fatalError");
  assert.equal(await page.run(`document.getElementById("appView").hidden`), true);
  assert.match(await page.run(`document.getElementById("fatalError").textContent`), /新しい版が要ります/);
  assert.deepEqual((await page.saved()).fields, [], "圃場がなくても、作らない");
  assert.deepEqual(page.errors, []);
});

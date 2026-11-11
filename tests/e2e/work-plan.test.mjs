// 日程の画面の「作業の計画」の表を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const work = (id, type, seq, start) => ({ id, plan_id: "p1", block_id: null, planting_id: "pl1", work_type: type, seq, plan_start: start, plan_end: start, note: "" });

// 区画 1 つ、畝 1 本。作付には、工程の作業 2 件と、管理作業（防除）の計画 1 件
const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", active_plan_id: "p1", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: [{ id: "bed1", plan_id: "p1", block_id: "b1", seq: 1, shape: [[3, 2], [4, 2], [4, 18], [3, 18]], start_date: null, removed_on: null }],
  plantings: [{ id: "pl1", plan_id: "p1", bed_id: "bed1", seq: 1, crop_id: null, crop_name: "試験菜" }],
  works: [work("w1", "plant", 1, "2026-11-01"), work("w2", "harvest", 2, "2026-12-01"), work("m1", "spray", 3, "2026-11-15")],
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

const savedTypes = () => page.run(`JSON.parse(localStorage.getItem("field_plan_local")).works.filter((work) => work.planting_id === "pl1").map((work) => work.work_type).sort().join(",")`);

// 表で工程の作業を足す・消すと、作付の作業をまとめて入れ替えて保存する。表に出ていない管理作業の計画は、消さずに残す
test("作業の計画: 工程の作業を足しても消しても、管理作業の計画は残る", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="schedule"]');
  await page.run(`(() => { const select = document.getElementById("scheduleTarget"); select.value = "bed1"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.waitFor(`document.querySelectorAll("#editorSections tr[data-id]").length === 2`, "工程の作業 2 件の表");

  await page.click('#editorSections [data-action="add-work"]');
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).works.filter((work) => work.planting_id === "pl1").length === 4`, "作業を足して保存");
  assert.match(await savedTypes(), /spray/);

  await page.click('#editorSections tr[data-id="w2"] [data-action="delete"]');
  await page.waitFor(`!JSON.parse(localStorage.getItem("field_plan_local")).works.some((work) => work.id === "w2")`, "作業を消して保存");
  assert.ok(await page.run(`JSON.parse(localStorage.getItem("field_plan_local")).works.some((work) => work.id === "m1")`), "防除の計画が残る");
  assert.deepEqual(page.errors, []);
});

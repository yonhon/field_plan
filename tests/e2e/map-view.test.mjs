// 圃場図の、作図の道具が出ていない幅（スマホ、タブレット）での操作と、新しい版へ読み込み直すときの保存を、Chrome で通して確かめる。
// 実行: node --test "tests/e2e/*.test.mjs"
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const BLOCK = [[1, 1], [39, 1], [39, 19], [1, 19]];
const BED = [[3, 2], [4, 2], [4, 18], [3, 18]];
// 区画の中で、畝のない所
const INSIDE = [30, 10];

const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: BLOCK, start_date: null, end_date: null, created_at: AT }],
  beds: [{ id: "bed1", plan_id: "p1", block_id: "b1", seq: 1, shape: BED, start_date: null, removed_on: null }],
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

afterEach(async () => {
  await page?.viewport();
});

after(async () => {
  await page?.close();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const savedX = async () => {
  const data = await page.saved();
  return { block: data.blocks.find((item) => item.id === "b1").shape[0][0], bed: data.beds.find((item) => item.id === "bed1").shape[0][0] };
};

async function openMap() {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="map"]');
  await page.waitFor(`Boolean(document.querySelector('#map [data-shape="b1"]'))`, "圃場図に区画が出る");
}

// 区画を選んでから、区画の中をなぞる
async function selectAndDrag() {
  await page.clickMap(INSIDE);
  await page.waitFor(`document.querySelector('#map [data-shape="b1"]').classList.contains("is-selected")`, "区画を選ぶ");
  await page.dragMap(INSIDE, 80);
}

test("作図の道具が出ていない幅では、選んだ区画をなぞっても、区画は動かない", options, async () => {
  await page.viewport(390);
  await openMap();
  assert.equal(await page.run(`getComputedStyle(document.querySelector("#appView .toolbar")).display`), "none");
  const view = await page.run(`document.getElementById("map").getAttribute("viewBox")`);
  await selectAndDrag();
  // 保存は少し遅れて送るので、送るはずの時間を待ってから見る
  await sleep(900);
  assert.deepEqual(await savedX(), { block: BLOCK[0][0], bed: BED[0][0] });
  // 図は動く
  assert.notEqual(await page.run(`document.getElementById("map").getAttribute("viewBox")`), view);
});

test("作図の道具が出ている幅では、選んだ区画をなぞると、区画と畝が動く", options, async () => {
  await openMap();
  await selectAndDrag();
  await page.waitFor(`(() => { const data = JSON.parse(localStorage.getItem("field_plan_local")); return data.beds[0].shape[0][0] !== ${BED[0][0]}; })()`, "畝が動いて保存される");
  const moved = await savedX();
  assert.notEqual(moved.block, BLOCK[0][0]);
  assert.ok(Math.abs(moved.block - BLOCK[0][0] - (moved.bed - BED[0][0])) < 1e-9, "区画と畝が同じだけ動く");
});

test("「読み込み直す」は、送り残しの保存を送り終えてから読み込み直す", options, async () => {
  await openMap();
  await selectAndDrag();
  // 保存を送る前（600 ms 以内）に、新しい版のお知らせの「読み込み直す」を押す
  await page.run(`window.beforeReload = true; document.getElementById("updateToast").hidden = false`);
  await page.click("#updateBtn");
  await page.waitFor(`!window.beforeReload && document.getElementById("viewTabs")?.hidden === false`, "読み込み直す");
  const moved = await savedX();
  assert.notEqual(moved.block, BLOCK[0][0]);
  assert.ok(Math.abs(moved.block - BLOCK[0][0] - (moved.bed - BED[0][0])) < 1e-9, "区画と畝が同じだけ動いて保存される");
});

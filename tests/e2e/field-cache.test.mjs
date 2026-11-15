// 起動のとき、前回 DB から読んだ中身（端末の IndexedDB、app/field-cache.js）を使うことを、Chrome で通して確かめる。
// DB の変更の印が取っておいたときと同じなら中身を読まずに使い、違えば読み直す。実行: node --test "tests/e2e/*.test.mjs"
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const KEY = "field_plan_local";

const bed = (seq) => ({
  id: `bed${seq}`,
  plan_id: "p1",
  block_id: "b1",
  seq,
  shape: [[seq * 3, 2], [seq * 3 + 1, 2], [seq * 3 + 1, 18], [seq * 3, 18]],
  start_date: null,
  removed_on: null,
});

// 圃場 1 つ、区画 1 つ、畝 count 本
const seed = (count) => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", active_plan_id: "p1", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: Array.from({ length: count }, (_, index) => bed(index + 1)),
  plantings: [],
  works: [],
  crops: [{ id: "c1", name: "試験菜", mulch: false, bed_width_cm: 100, aisle_width_cm: 60 }],
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

beforeEach(() => {
  page?.errors.splice(0);
});

// 起動と、戻ってきたときの読み直しで、圃場を読んだ回数（ローカルの保存が数える）
const reads = () => page.run('Number(localStorage.getItem("field_plan_local_reads") || 0)');
const shownBeds = () => page.run(`[...document.querySelectorAll("#strip .strip-bed")].map((box) => box.dataset.bed).join()`);
// 取っておいた中身が書かれるまで待つ（起動のあと、裏で書く）
const cachedBeds = () =>
  page.run(`new Promise((resolve) => {
    const request = indexedDB.open("field_plan", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("cache");
    request.onsuccess = () => {
      const get = request.result.transaction("cache").objectStore("cache").get("field");
      get.onsuccess = () => { resolve(get.result ? get.result.loaded.tables.beds.map((row) => row.id).join() : null); request.result.close(); };
    };
  })`);

// 保存を消さずに、画面を開き直す
async function reopen() {
  await page.run("location.reload()");
  await page.waitFor(`document.getElementById("viewTabs")?.hidden === false`, "アプリの起動");
  await page.click('.tab-btn[data-view="schedule"]');
}

async function openStrip(count) {
  await page.loadApp(seed(count));
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === ${count}`, `図に畝が ${count} 本出る`);
  await waitCached(Array.from({ length: count }, (_, index) => `bed${index + 1}`).join());
}

// 取っておいた中身が expected（畝の ID を , でつないだもの）になるまで待つ
async function waitCached(expected) {
  for (let i = 0; i < 50; i += 1) {
    if ((await cachedBeds()) === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await cachedBeds(), expected, "取っておいた中身");
}

test("起動: DB が前回から変わっていなければ、取っておいた中身で出し、中身を読まない", options, async () => {
  await openStrip(2);
  assert.equal(await cachedBeds(), "bed1,bed2", "起動のときに読んだ中身を取っておく");
  const before = await reads();
  await reopen();
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === 2`, "取っておいた中身で出る");
  assert.equal(await shownBeds(), "bed1,bed2");
  assert.equal(await reads(), before, "中身は読まない");
  assert.deepEqual(page.errors, []);
});

test("起動: 前回からほかの端末で変わっていれば、読み直して最新の中身を出し、取っておく中身も新しくする", options, async () => {
  await openStrip(2);
  const before = await reads();
  await page.run(`(() => {
    const data = JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}));
    data.beds.push(${JSON.stringify(bed(3))});
    localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(data));
  })()`);
  await reopen();
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === 3`, "最新の中身で出る");
  assert.equal(await reads(), before + 1, "中身を読む");
  await waitCached("bed1,bed2,bed3");
  assert.deepEqual(page.errors, []);
});

test("起動: 取っておいた中身がアプリの別の版のものなら、使わずに読む", options, async () => {
  await openStrip(2);
  await page.run(`new Promise((resolve) => {
    const request = indexedDB.open("field_plan", 1);
    request.onsuccess = () => {
      const store = request.result.transaction("cache", "readwrite").objectStore("cache");
      const get = store.get("field");
      get.onsuccess = () => {
        const put = store.put({ ...get.result, version: -1 }, "field");
        put.onsuccess = () => { request.result.close(); resolve(); };
      };
    };
  })`);
  const before = await reads();
  await reopen();
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === 2`, "畝が出る");
  assert.equal(await reads(), before + 1, "取っておいた中身は使わず、中身を読む");
  assert.deepEqual(page.errors, []);
});

test("起動: 画面で直したあとに開き直すと、読み直して DB の中身を出す（画面の中身は取っておかない）", options, async () => {
  await openStrip(3);
  await page.click('.strip-bed[data-bed="bed3"]');
  await page.waitFor(`document.querySelector('.strip-bed[data-bed="bed3"]').classList.contains("is-selected")`, "bed3 を選ぶ");
  await page.click("#stripDeleteBtn");
  await page.click('dialog.notice [data-action="delete"]');
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "保存の完了");
  const before = await reads();
  await reopen();
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === 2`, "直したあとの中身で出る");
  assert.equal(await reads(), before + 1, "DB が変わったので、中身を読む");
  assert.deepEqual(page.errors, []);
});

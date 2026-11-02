// 区画と畝の図の主な操作を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 保存は ?local=1&strict=1 なので、保存の順序を誤ると、DB と同じように失敗する
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];

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
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: Array.from({ length: count }, (_, index) => bed(index + 1)),
  plantings: [],
  works: [],
  crops: [{ id: "c1", name: "試験菜", mulch: false, bed_width_cm: 100, aisle_width_cm: 60 }],
});

const CONFIRM = 'dialog.notice [data-action="delete"]';
const CANCEL = 'dialog.notice [data-action="cancel"]';
const openDialog = 'document.querySelector("dialog[open]")';

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

const shownBeds = () => page.run(`[...document.querySelectorAll("#strip .strip-bed")].map((box) => box.dataset.bed).join()`);
const labels = () => page.run(`[...document.querySelectorAll("#strip .strip-bed-label")].map((label) => label.textContent).join("/")`);
const waitBeds = (ids) => page.waitFor(`[...document.querySelectorAll("#strip .strip-bed")].map((box) => box.dataset.bed).join() === ${JSON.stringify(ids)}`, `図の畝が ${ids} になる`);
// 閉じた窓は、少し遅れて取り除かれる。残っているあいだに次の窓を開くと、古いボタンを押してしまう
const waitNoDialog = () => page.waitFor(`!document.querySelector("dialog.notice")`, "窓が閉じる");

async function openStrip(count) {
  await page.loadApp(seed(count));
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === ${count}`, `図に畝が ${count} 本出る`);
}

async function chooseBed(id) {
  await page.click(`.strip-bed[data-bed="${id}"]`);
  await page.waitFor(`document.querySelector('.strip-bed[data-bed="${id}"]').classList.contains("is-selected")`, `${id} を選ぶ`);
}

async function chooseCrop(selector) {
  await page.setValue(selector, "c1");
}

beforeEach(() => {
  page?.errors.splice(0);
});

test("選んだ畝を完全に削除: キャンセルなら残り、削除すると図からすぐ消える", options, async () => {
  await openStrip(3);
  await chooseBed("bed1");

  await page.click("#stripDeleteBtn");
  await page.click(CANCEL);
  await waitNoDialog();
  assert.equal(await shownBeds(), "bed1,bed2,bed3");
  assert.equal((await page.saved()).beds.length, 3);

  await page.click("#stripDeleteBtn");
  await page.click(CONFIRM);
  await waitBeds("bed2,bed3");
  assert.equal(await labels(), "1/2", "番号は左から振り直す");
  assert.equal(await page.run(`document.getElementById("stripDeleteBtn").disabled`), true);
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).beds.length === 2`, "削除の保存");
  assert.deepEqual(page.errors, []);
});

test("選んだ畝を表示日でなくす: 図からすぐ消える", options, async () => {
  await openStrip(3);
  await chooseBed("bed2");
  await page.click("#stripRemoveBtn");
  await page.click(CONFIRM);
  await waitBeds("bed1,bed3");
  assert.deepEqual(page.errors, []);
});

test("区画の畝をすべて表示日でなくす: 図からすぐ消える", options, async () => {
  await openStrip(2);
  await page.click("#stripRemoveAllBtn");
  await page.click(CONFIRM);
  await waitBeds("");
  assert.deepEqual(page.errors, []);
});

test("品目を選んで右端に足す: 畝と作付と作業が保存される", options, async () => {
  await openStrip(2);
  await chooseCrop("#stripCrop");
  await page.setValue("#stripCount", "2");
  await page.click("#stripAddBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).works.length > 0 && document.getElementById("saveStatus").textContent === "保存しました"`, "作付と作業の保存");
  const data = await page.saved();
  assert.equal(data.beds.length, 4);
  assert.deepEqual(data.plantings.map((planting) => planting.crop_name), ["試験菜", "試験菜"]);
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed-label").length === 4`, "図に 4 本");
  assert.equal(await labels(), "1/2/3 試験菜/4 試験菜");
  assert.deepEqual(page.errors, []);
});

test("品目を選んで図の＋で足す: 畝と作付が保存される", options, async () => {
  await openStrip(2);
  await chooseCrop("#stripCrop");
  await page.click('.strip-insert[data-insert="1"]');
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).plantings.length === 1`, "作付の保存");
  const data = await page.saved();
  assert.equal(data.beds.length, 3);
  assert.equal(data.plantings[0].crop_name, "試験菜");
  await page.waitFor(`document.querySelector("#strip").textContent.includes("2 試験菜")`, "足した畝が左から 2 本目になる");
  assert.deepEqual(page.errors, []);
});

test("品目を決めずに足す: 畝だけが保存される", options, async () => {
  await openStrip(1);
  await page.click("#stripAddBtn");
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === 2`, "図に 2 本");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).beds.length === 2`, "畝の保存");
  assert.equal((await page.saved()).plantings.length, 0);
  assert.deepEqual(page.errors, []);
});

test("畝に作付を追加する: 作付と作業が保存される", options, async () => {
  await openStrip(1);
  await chooseBed("bed1");
  await chooseCrop("#newCropSelect");
  await page.click("#addPlantingBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).works.length > 0`, "作付と作業の保存");
  assert.equal((await page.saved()).plantings[0].crop_name, "試験菜");
  assert.deepEqual(page.errors, []);
});

test("作付を保存できないとき: 窓で知らせ、ほかの保存が終わっても消えない", options, async () => {
  await openStrip(1);
  await page.run(`(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "field_plan_local" && JSON.parse(value).plantings.length) {
        throw new Error("作付の保存の失敗");
      }
      return setItem.call(this, key, value);
    };
  })()`);
  await chooseCrop("#stripCrop");
  await page.click("#stripAddBtn");
  await page.waitFor(`${openDialog}?.textContent.includes("作付の保存の失敗")`, "失敗の窓");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).beds.length === 2`, "畝の保存");
  assert.match(await page.run(`document.getElementById("saveStatus").textContent`), /保存に失敗しました/);
});

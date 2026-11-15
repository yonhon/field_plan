// 日程の操作（工程表の帯をずらす、畝の図で品目を入れた畝を足す）が、保存の返事を待たずに描き、
// 返事が来るまでは次の書き換えを止め、保存に失敗したら画面を保存されている内容に戻すことを、Chrome で通して確かめる。
// 保存の遅れと失敗は、ローカルの保存の試験の設定（field_plan_local_test）で作る。実行: node --test "tests/e2e/*.test.mjs"
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
// 工程表は今日からの期間を描くので、作業の日は今日から数える
const day = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const START = day(10);

// 区画 1 つ、畝 1 本（作付なし）。区画に日付の入った耕うんの作業が 1 つ
const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", active_plan_id: "p1", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: [{ id: "bed1", plan_id: "p1", block_id: "b1", seq: 1, shape: [[3, 2], [4, 2], [4, 18], [3, 18]], start_date: null, removed_on: null }],
  plantings: [],
  works: [{ id: "w1", plan_id: "p1", block_id: "b1", planting_id: null, work_type: "rotary", seq: 1, plan_start: START, plan_end: day(12), note: "", cancelled_on: null, detail: {} }],
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

const BAR = '#gantt .gantt-bar[data-id="w1"]';
const barX = () => page.run(`document.querySelector(${JSON.stringify(BAR)}).getBoundingClientRect().x`);
const savedStart = async () => (await page.saved()).works.find((work) => work.id === "w1").plan_start;
const status = () => page.run('document.getElementById("saveStatus").textContent');
const slowSaves = (control) => page.run(`localStorage.setItem("field_plan_local_test", ${JSON.stringify(JSON.stringify(control))})`);
const SAVING = 'document.body.classList.contains("schedule-saving")';

async function openSchedule() {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(BAR)}))`, "工程表に帯が出る");
}

test("工程表: 帯をずらすと、保存の返事を待たずに描き、返事までは次の書き換えを止める", options, async () => {
  await openSchedule();
  const before = await barX();
  await slowSaves({ delay: 1500 });
  await page.drag(BAR, 60);

  // 返事の前: 帯はずらした先に描いてあり、保存はまだ
  await page.waitFor('document.getElementById("saveStatus").textContent === "保存中…"', "保存の返事を待つ");
  const moved = await barX();
  assert.ok(moved - before > 20, `帯がずらした先に出る（${before} → ${moved}）`);
  assert.equal(await savedStart(), START, "まだ保存していない");
  assert.equal(await page.run(SAVING), true, "書き換えの操作を止めている");

  // 返事の前に、帯をもう一度ずらそうとしても動かず、知らせる
  await page.drag(BAR, 60);
  assert.equal(await barX(), moved, "待っているあいだは動かない");
  assert.match(await status(), /保存が終わってから操作してください/);

  // 返事のあと: 保存され、帯は同じ位置のまま（描き直して跳ばない）
  await page.waitFor(`!${SAVING}`, "保存の返事");
  assert.notEqual(await savedStart(), START, "ずらした日で保存した");
  assert.equal(await barX(), moved, "返事のあとも同じ位置");
  assert.equal(await status(), "保存しました");
  assert.deepEqual(page.errors, []);
});

test("工程表: 保存に失敗したら知らせ、画面を保存されている内容に戻す", options, async () => {
  await openSchedule();
  const before = await barX();
  await slowSaves({ delay: 300, fail: true });
  await page.drag(BAR, 60);
  await page.waitFor('document.getElementById("saveStatus").textContent === "保存中…"', "保存の返事を待つ");
  assert.ok((await barX()) - before > 20, "失敗の返事の前は、ずらした先に出る");

  await page.waitFor(`document.querySelector("dialog.notice[open] .notice-text")?.textContent.includes("保存できませんでした。画面を、保存されている内容に戻します。")`, "失敗の知らせ");
  await page.waitFor(`!${SAVING}`, "読み直しを終える");
  assert.equal(await savedStart(), START, "保存されていない");
  assert.equal(await barX(), before, "帯は元の位置に戻る");
  await slowSaves({});
  await page.click('dialog.notice [data-action="close"]');
  assert.deepEqual(page.errors, []);
});

test("畝の図: 品目を選んで畝を足すと、保存の返事を待たずに作付と作業を描く", options, async () => {
  await openSchedule();
  await page.setValue("#stripCrop", "c1");
  await slowSaves({ delay: 400 });
  await page.click("#stripAddBtn");

  // 返事の前: 足した畝の行に、ひな形の作業の帯が出ている。作業はまだ保存していない
  await page.waitFor('document.getElementById("saveStatus").textContent === "保存中…"', "保存の返事を待つ");
  const newRowBars = `[...document.querySelectorAll("#gantt .gantt-row[data-bed]")].filter((row) => row.dataset.bed !== "bed1").reduce((sum, row) => sum + row.querySelectorAll(".gantt-bar").length, 0)`;
  assert.ok((await page.run(newRowBars)) > 0, "足した畝の帯が出る");
  assert.deepEqual((await page.saved()).works.map((work) => work.id), ["w1"], "作業はまだ保存していない");

  await page.waitFor(`!${SAVING} && document.getElementById("saveStatus").textContent === "保存しました"`, "保存の返事");
  const data = await page.saved();
  assert.deepEqual(data.plantings.map((planting) => planting.crop_name), ["試験菜"]);
  assert.ok(data.works.length > 1, "ひな形の作業を保存した");
  assert.deepEqual(page.errors, []);
});

// 「作業を入力する」の窓の「工程の計画」のタブを、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 直すのは書きかけで、「保存する」でまとめて保存する。書きかけのままタブを替えたり閉じたりすると、捨ててよいかを確かめる
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const bed = (seq) => ({ id: `bed${seq}`, plan_id: "p1", block_id: "b1", seq, shape: [[seq * 3, 2], [seq * 3 + 1, 2], [seq * 3 + 1, 18], [seq * 3, 18]], start_date: null, removed_on: null });
const work = (id, owner, type, seq, start, end) => ({ id, plan_id: "p1", block_id: null, planting_id: null, ...owner, work_type: type, seq, plan_start: start, plan_end: end, note: "" });

// 区画 1 つに、区画の作業 2 件と、畝 2 本（畝 1 だけ作付と作業がある）
const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", active_plan_id: "p1", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: [bed(1), bed(2)],
  plantings: [{ id: "pl1", plan_id: "p1", bed_id: "bed1", seq: 1, crop_id: "c1", crop_name: "試験菜" }],
  works: [
    work("w1", { block_id: "b1" }, "rotary", 1, "2026-10-01", "2026-10-01"),
    work("w2", { block_id: "b1" }, "subsoil", 2, "2026-10-05", "2026-10-05"),
    work("w3", { planting_id: "pl1" }, "ridge", 1, "2026-11-01", "2026-11-02"),
  ],
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

const DIALOG = "dialog.log-dialog[open]";
const savedWork = (id) => page.run(`JSON.parse(localStorage.getItem("field_plan_local")).works.find((work) => work.id === "${id}") || null`);
const setValue = (selector, value) =>
  page.run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
const openFromBlock = async () => {
  await page.click('#blockHead [data-act="record"]');
  await page.waitFor(`Boolean(document.querySelector("${DIALOG} .pe-card"))`, "工程の計画のタブ");
};

test("工程の計画: 区画の頭から開き、日付を直して、保存するで保存する。タブを替えるときは確かめる", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="schedule"]');
  await openFromBlock();
  assert.deepEqual(
    await page.run(`[...document.querySelectorAll('${DIALOG} [data-act="kind"]')].map((el) => el.textContent + (el.classList.contains("is-on") ? "*" : ""))`),
    ["工程の計画*", "管理作業の計画", "実績"]
  );
  assert.equal(await page.run(`document.querySelectorAll("${DIALOG} .pe-card").length`), 2);

  // 開始日を動かすと、日数を保って終了日も動く。保存するまでは、DB は変わらない
  await setValue(`${DIALOG} .pe-card[data-id="w2"] [data-pe="plan_start"]`, "2026-10-08");
  await page.waitFor(`document.querySelector('${DIALOG} .pe-card[data-id="w2"] [data-pe="plan_end"]').value === "2026-10-08"`, "終了日も動く");
  assert.equal((await savedWork("w2")).plan_start, "2026-10-05");

  // 書きかけのまま実績のタブを押すと、捨ててよいかを確かめる。「入力を続ける」なら、そのまま
  await page.click(`${DIALOG} [data-act="kind"][data-kind="actual"]`);
  await page.waitFor(`document.querySelector('dialog.notice[open] [data-action="delete"]')?.textContent === "捨てて切り替える"`, "捨ててよいかの確かめ");
  await page.click('dialog.notice [data-action="cancel"]');
  await page.waitFor(`!document.querySelector("dialog.notice[open]")`, "確かめを閉じる");
  assert.equal(await page.run(`document.querySelector('${DIALOG} [data-act="kind"].is-on').dataset.kind`), "process");

  await page.click(`${DIALOG} [data-act="save"]`);
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "保存して閉じる");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).works.find((work) => work.id === "w2").plan_start === "2026-10-08"`, "保存される");
  assert.equal((await savedWork("w2")).plan_end, "2026-10-08");
  assert.deepEqual(page.errors, []);
});

test("工程の計画: 畝を選んで作業を足し、キャンセルで捨てる。作付のない畝に作付を足して保存する", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="schedule"]');
  await openFromBlock();

  // 畝 1 に作業を足して、キャンセル（捨てて閉じる）。DB は変わらない
  await setValue(`${DIALOG} [data-pe="target"]`, "bed:bed1");
  await page.waitFor(`document.querySelectorAll("${DIALOG} .pe-planting .pe-card").length === 1`, "畝 1 の作業");
  await page.click(`${DIALOG} .pe-planting [data-pe-act="add-work"]`);
  await page.waitFor(`document.querySelectorAll("${DIALOG} .pe-planting .pe-card").length === 2`, "作業が増える");
  await page.click(`${DIALOG} .log-foot [data-act="close"]`);
  await page.click('dialog.notice [data-action="delete"]');
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "捨てて閉じる");
  assert.equal(await page.run(`JSON.parse(localStorage.getItem("field_plan_local")).works.filter((work) => work.planting_id === "pl1").length`), 1);

  // 畝 2（作付なし）に、試験菜の作付を足して保存する。ひな形の作業が入る
  await openFromBlock();
  await setValue(`${DIALOG} [data-pe="target"]`, "bed:bed2");
  await page.waitFor(`Boolean(document.querySelector('${DIALOG} [data-pe="add-crop"]'))`, "作付を足す欄");
  await setValue(`${DIALOG} [data-pe="add-crop"]`, "c1");
  await page.click(`${DIALOG} [data-pe-act="add-planting"]`);
  await page.waitFor(`document.querySelectorAll("${DIALOG} .pe-planting").length === 1`, "作付ができる");
  const cards = await page.run(`document.querySelectorAll("${DIALOG} .pe-planting .pe-card").length`);
  assert.ok(cards > 3, `ひな形の作業: ${cards} 件`);
  await page.click(`${DIALOG} [data-act="save"]`);
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "保存して閉じる");
  await page.waitFor(
    `(() => { const data = JSON.parse(localStorage.getItem("field_plan_local")); const planting = data.plantings.find((item) => item.bed_id === "bed2"); return Boolean(planting) && data.works.filter((work) => work.planting_id === planting.id).length === ${cards}; })()`,
    "作付と作業が保存される"
  );
  assert.deepEqual(page.errors, []);
});

test("工程の計画: 何も変えずに閉じるときは確かめない。実際に使うプランがなければ、工程の計画のタブだけ", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="schedule"]');
  await openFromBlock();
  await page.click(`${DIALOG} .log-head [data-act="close"]`);
  await page.waitFor(`!document.querySelector("dialog[open]")`, "確かめずに閉じる");

  const data = seed();
  data.fields[0].active_plan_id = null;
  await page.loadApp(data);
  await page.click("#logAddBtn");
  await page.waitFor(`Boolean(document.querySelector("${DIALOG} .pe"))`, "工程の計画のタブで開く");
  assert.deepEqual(await page.run(`[...document.querySelectorAll('${DIALOG} [data-act="kind"]')].map((el) => el.disabled)`), [false, true, true]);
  await page.click(`${DIALOG} .log-head [data-act="close"]`);
  await page.waitFor(`history.state?.fieldPlanDialog !== true`, "積んだ履歴が取り消される");
  assert.deepEqual(page.errors, []);
});

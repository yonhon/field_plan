// 作業の入力の窓で、農薬を選ぶたびに窓の中がいちばん上へ戻らないことを、Chrome で通して確かめる。
// 実行: node --test "tests/e2e/*.test.mjs"
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const BEDS = 12;

const bed = (seq) => ({
  id: `bed${seq}`,
  plan_id: "p1",
  block_id: "b1",
  seq,
  shape: [[seq * 3, 2], [seq * 3 + 1, 2], [seq * 3 + 1, 18], [seq * 3, 18]],
  start_date: null,
  removed_on: null,
});

// 区画 1 つに、試験菜を植えた畝。農薬の使用基準は、ブラウザーの保存に入れた 1 剤だけ（使い方が 2 つ）
const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", active_plan_id: "p1", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: Array.from({ length: BEDS }, (_, index) => bed(index + 1)),
  plantings: Array.from({ length: BEDS }, (_, index) => ({ id: `pl${index + 1}`, plan_id: "p1", bed_id: `bed${index + 1}`, seq: 1, crop_id: "c1", crop_name: "試験菜" })),
  works: [],
  crops: [{ id: "c1", name: "試験菜", mulch: false, bed_width_cm: 100, aisle_width_cm: 60 }],
  famic: {
    products: [{ reg_no: 90001, ord: 1, name: "試験乳剤", name_search: "試験乳剤", kind: "殺虫剤", use_type: "殺虫剤", formulation: "乳剤", ingredient: "試験成分", count_ingredient: "試験成分" }],
    uses: ["アブラムシ類", "ハダニ類"].map((target, index) => ({
      id: index + 1,
      reg_no: 90001,
      crop: "試験菜",
      target,
      method: "散布",
      dilution_text: "1000倍",
      dilution_min: 1000,
      dilution_max: 1000,
      liquid_text: "100～300L/10a",
      timing_text: "収穫7日前まで",
      times_text: "3回以内",
    })),
  },
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

const BODY = 'document.querySelector("dialog.log-dialog[open] .log-body")';
const scrollTop = () => page.run(`${BODY}.scrollTop`);
// 要素の、窓の中の見えている所での高さ
const topOf = (selector) => page.run(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top - ${BODY}.getBoundingClientRect().top`);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 2, `${label}: ${actual} と ${expected}`);

test("防除の入力: 農薬・作物名・使い方を選んでも、窓の中の位置が変わらない", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="schedule"]');
  await page.click("#logAddBtn");
  // 窓は計画で開く。計画、実績の順に並ぶ
  assert.deepEqual(await page.run(`[...document.querySelectorAll('dialog.log-dialog [data-act="kind"]')].map((el) => el.textContent + (el.classList.contains("is-on") ? "*" : ""))`), ["計画*", "実績"]);
  await page.click('dialog.log-dialog [data-act="kind"][data-kind="actual"]');
  await page.click('dialog.log-dialog [data-act="type"][data-code="spray"]');
  await page.click('dialog.log-dialog [data-act="group"]');
  // 2 剤目を足すと、足した行まで送られ、その名前の欄に入れられる
  await page.click('dialog.log-dialog [data-act="addInput"]');
  await page.waitFor(`document.querySelectorAll("dialog.log-dialog .log-input").length === 2`, "2 剤目の行");
  const NAME = 'dialog.log-dialog [data-in="1"][data-k="name"]';
  assert.equal(await page.run(`document.activeElement === document.querySelector(${JSON.stringify(NAME)})`), true);
  assert.ok((await scrollTop()) > 0, "窓の中が下へ送られている");

  // 名前で探して、結果から選ぶ（使用基準を読んでから描き直す）
  await page.run(`(() => {
    const el = document.querySelector(${JSON.stringify(NAME)});
    el.value = "試験";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const RESULT = 'dialog.log-dialog [data-results="1"] [data-act="famic-pick"]';
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(RESULT)}))`, "検索の結果");
  await page.run(`document.querySelector(${JSON.stringify(RESULT)}).scrollIntoView({ block: "center" })`);
  const ROW = 'dialog.log-dialog [data-results="1"]';
  const before = { top: await topOf(ROW), scroll: await scrollTop() };
  assert.ok(before.scroll > 0);
  await page.click(RESULT);
  const CROP = 'dialog.log-dialog [data-act="famic-crop"][data-i="1"]';
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(CROP)}))`, "作物名の選び");
  near(await topOf(ROW), before.top, "農薬を選んだあとの、結果の欄の高さ");

  // 作物名を選ぶ（使い方が 2 つあるので、使い方の選びが出る）
  const cropTop = await topOf(CROP);
  await page.click(CROP);
  const USE = 'dialog.log-dialog select[data-in="1"][data-k="use_key"]';
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(USE)}))`, "使い方の選び");
  const useTop = await topOf(USE);
  assert.ok(Math.abs(useTop - cropTop) < 80, `作物名を選んだあとも、その近くが見えている: ${useTop} と ${cropTop}`);

  // 使い方を選ぶ。描き直したあとも、同じ選びが同じ高さにあり、そこに入っている
  await page.run(`document.querySelector(${JSON.stringify(USE)}).focus()`);
  await page.setValue(USE, "アブラムシ類|散布");
  await page.waitFor(`document.querySelector(${JSON.stringify(USE)}).value === "アブラムシ類|散布"`, "使い方を選んだ");
  near(await topOf(USE), useTop, "使い方を選んだあとの高さ");
  assert.equal(await page.run(`document.activeElement === document.querySelector(${JSON.stringify(USE)})`), true);
  assert.deepEqual(page.errors, []);
});

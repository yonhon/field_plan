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
    rac: [{ ingredient: "試験成分", committee: "IRAC", code: "4A" }],
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

// 農薬名の後ろには、作用機構分類（RAC コード）のアイコンを付ける
test("農薬名の後ろのアイコン: 実績の一覧、検索の結果、選んだ農薬", options, async () => {
  const data = seed();
  data.workLogs = [{
    id: "log1", field_id: "f1", date: "2026-01-05", end_date: null, work_type: "spray", finishes: false, spec: {}, note: "", created_at: AT,
    inputs: [
      { id: "i1", log_id: "log1", seq: 0, kind: "pesticide", name: "試験乳剤", reg_no: "90001", dilution: 1000, method: "散布", amount: null, unit: "mL" },
      { id: "i2", log_id: "log1", seq: 1, kind: "pesticide", name: "手で入れた農薬", reg_no: null, dilution: null, method: "散布", amount: null, unit: "mL" },
    ],
    targets: [{ id: "t1", log_id: "log1", planting_id: "pl1", bed_id: "bed1", block_id: null, work_id: null, label: "", crop_name: "試験菜", area_m2: null, spray_l: null }],
  }];
  await page.loadApp(data);
  await page.click('.tab-btn[data-view="schedule"]');
  // 実績の一覧: 登録番号のある農薬は、その分類。名前だけで入れた農薬は「−」
  const LOGGED = '#logList svg[data-rac="IRAC:4A"]';
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(LOGGED)}))`, "実績の一覧のアイコン");
  assert.match(await page.run(`document.querySelector(${JSON.stringify(LOGGED)}).closest(".pesticide-name").textContent`), /^試験乳剤/);
  assert.equal(await page.run(`document.querySelectorAll('#logList svg[data-rac="IRAC:-"]').length`), 1);

  // 指すと説明が出て、離れると消える
  const POP = "#racPopover";
  const OPEN = `document.querySelector("${POP}")?.matches(":popover-open")`;
  const pointer = (type, selector) =>
    page.run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new PointerEvent("${type}", { pointerType: "mouse", bubbles: true }))`);
  await pointer("pointerover", LOGGED);
  await page.waitFor(OPEN, "指したときの説明");
  const text = await page.run(`document.querySelector("${POP}").textContent`);
  assert.match(text, /IRAC 4A/);
  assert.match(text, /主要グループと一次作用部位：ニコチン性アセチルコリン受容体（nAChR）競合的モジュレーター（神経作用）/);
  assert.match(text, /有効成分：試験成分/);
  await pointer("pointerout", LOGGED);
  await page.waitFor(`!(${OPEN})`, "離れたら消える");
  // クリックすると出したままになり、実績の窓は開かない。外をクリックすると消える
  await page.click(LOGGED);
  await page.waitFor(OPEN, "クリックしたときの説明");
  await pointer("pointerout", LOGGED);
  assert.equal(await page.run(OPEN), true, "クリックしたものは、離れても消えない");
  assert.equal(await page.run(`Boolean(document.querySelector("dialog.log-dialog[open]"))`), false, "実績の窓は開かない");
  await page.click("#logTitle");
  await page.waitFor(`!(${OPEN})`, "外をクリックすると消える");

  await page.click("#logAddBtn");
  await page.click('dialog.log-dialog [data-act="kind"][data-kind="actual"]');
  await page.click('dialog.log-dialog [data-act="type"][data-code="spray"]');
  await page.click('dialog.log-dialog [data-act="group"]');
  const NAME = 'dialog.log-dialog [data-in="0"][data-k="name"]';
  await page.run(`(() => {
    const el = document.querySelector(${JSON.stringify(NAME)});
    el.value = "試験";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  // 検索の結果
  const RESULT = 'dialog.log-dialog [data-results="0"] [data-act="famic-pick"]';
  const ICON = `${RESULT} svg[data-rac="IRAC:4A"]`;
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(ICON)}))`, "検索の結果のアイコン");
  assert.match(await page.run(`document.querySelector(${JSON.stringify(ICON)}).getAttribute("aria-label")`), /IRAC 4A（試験成分）/);
  // 窓の中でアイコンを押すと、説明が窓の中に出る。農薬は選ばない
  await page.click(ICON);
  await page.waitFor(OPEN, "窓の中の説明");
  assert.equal(await page.run(`Boolean(document.querySelector("dialog.log-dialog #racPopover"))`), true);
  assert.equal(await page.run(`Boolean(document.querySelector(".famic-picked"))`), false);
  // Esc は説明だけを閉じ、入力の窓は閉じない（入れかけの内容を捨てない）
  await page.press("Escape", "Escape", 27);
  await page.waitFor(`!(${OPEN})`, "Esc で説明を閉じる");
  assert.equal(await page.run(`Boolean(document.querySelector("dialog.log-dialog[open]"))`), true, "入力の窓は開いたまま");
  // 選んだ農薬の行
  await page.click(RESULT);
  const PICKED = 'dialog.log-dialog .famic-picked svg[data-rac="IRAC:4A"]';
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(PICKED)}))`, "選んだ農薬のアイコン");
  assert.deepEqual(page.errors, []);
});

// iPad の Chrome で、戻るを押すとページを離れ（新しいタブへ戻る）、画面を切り替えたあとでは窓が出たままになっていた。
// 窓を開いたら履歴を 1 つ積み、戻るでは窓だけを閉じる。ボタンで閉じたら、積んだ履歴を取り消す
test("入力の窓: 戻るで窓だけが閉じ、ボタンで閉じると履歴が元に戻る", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="schedule"]');
  const length = await page.run("history.length");
  const isOpen = 'Boolean(document.querySelector("dialog.log-dialog[open]"))';

  // 開いたら、入力の位置は見出し（閉じるボタンではない）
  await page.click("#logAddBtn");
  await page.waitFor(isOpen, "窓が開く");
  assert.equal(await page.run("document.activeElement.id"), "logDialogTitle");
  assert.equal(await page.run("history.length"), length + 1);

  // 戻る: 窓が閉じ、画面は日程のまま
  await page.run("history.back()");
  await page.waitFor(`!${isOpen}`, "戻るで窓が閉じる");
  await page.run("new Promise((resolve) => setTimeout(resolve, 200))");
  assert.equal(await page.run("location.hash"), "#schedule");
  assert.equal(await page.run('document.querySelector(".tab-btn.is-active").dataset.view'), "schedule");

  // もう一度開いて、閉じるボタンで閉じる: 積んだ履歴を取り消し、そのあとの戻るは前の画面（圃場図）へ
  await page.click("#logAddBtn");
  await page.waitFor(isOpen, "窓がもう一度開く");
  await page.click('dialog.log-dialog .log-head [data-act="close"]');
  await page.waitFor(`!${isOpen}`, "閉じるで窓が閉じる");
  await page.waitFor(`history.state?.fieldPlanDialog !== true`, "積んだ履歴が取り消される");
  await page.run("new Promise((resolve) => setTimeout(resolve, 200))");
  assert.equal(await page.run('document.querySelector(".tab-btn.is-active").dataset.view'), "schedule");
  await page.run("history.back()");
  await page.waitFor(`document.querySelector(".tab-btn.is-active").dataset.view === "map"`, "戻るで圃場図へ");
  assert.deepEqual(page.errors, []);
});

test("1 穴あたりの量: 選んだ畝の穴の数を掛けた量で記録し、1 穴の量も残す", options, async () => {
  const data = seed();
  // 畝は 16 m。株間 20 cm・2 条なら 80 株 × 2 条 = 160 穴。12 本で 1,920 穴
  Object.assign(data.crops[0], { plant_gap_cm: 20, row_count: 2 });
  data.fertilizers = [{ id: "fe1", name: "試験の肥料", n_pct: 10, p_pct: 10, k_pct: 10 }];
  await page.loadApp(data);
  await page.click('.tab-btn[data-view="schedule"]');
  await page.click("#logAddBtn");
  await page.click('dialog.log-dialog [data-act="kind"][data-kind="actual"]');
  await page.click('dialog.log-dialog [data-act="type"][data-code="topdress"]');
  await page.click('dialog.log-dialog [data-act="group"]');
  await page.setValue('dialog.log-dialog select[data-in="0"][data-k="fertilizer_id"]', "fe1");
  await page.setValue('dialog.log-dialog select[data-in="0"][data-k="unit"]', "g");
  const PER_HOLE = 'dialog.log-dialog [data-in="0"][data-k="per_hole"]';
  const AMOUNT = 'dialog.log-dialog [data-in="0"][data-k="amount"]';
  await page.run(`(() => {
    const el = document.querySelector(${JSON.stringify(PER_HOLE)});
    el.value = "2";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.waitFor(`document.querySelector(${JSON.stringify(AMOUNT)}).disabled`, "量の欄が計算の欄になる");
  assert.equal(await page.run(`document.querySelector(${JSON.stringify(AMOUNT)}).value`), "3840");
  assert.equal(await page.run(`document.querySelector('dialog.log-dialog [data-hole="0"]').textContent`), "1 穴 2 g × 1,920 穴 = 3,840 g（3.84 kg）");
  await page.click('dialog.log-dialog [data-act="save"]');
  await page.waitFor(`!document.querySelector("dialog.log-dialog[open]")`, "窓が閉じる");
  const input = (await page.saved()).workLogs[0].inputs[0];
  assert.deepEqual([input.name, input.amount, input.unit, input.per_hole], ["試験の肥料", 3840, "g", 2]);

  // 区画で選ぶときは、1 穴あたりの欄を出さない
  await page.click("#logAddBtn");
  await page.click('dialog.log-dialog [data-act="kind"][data-kind="actual"]');
  await page.click('dialog.log-dialog [data-act="type"][data-code="topdress"]');
  assert.equal(await page.run(`Boolean(document.querySelector(${JSON.stringify(PER_HOLE)}))`), true);
  await page.click('dialog.log-dialog [data-act="mode"][data-mode="blocks"]');
  assert.equal(await page.run(`Boolean(document.querySelector(${JSON.stringify(PER_HOLE)}))`), false);
  assert.deepEqual(page.errors, []);
});

test("1 穴あたりの量: 苗数が分からない畝があれば、保存せずに知らせる", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="schedule"]');
  await page.click("#logAddBtn");
  await page.click('dialog.log-dialog [data-act="type"][data-code="topdress"]');
  await page.click('dialog.log-dialog [data-act="group"]');
  await page.run(`(() => {
    const el = document.querySelector('dialog.log-dialog [data-in="0"][data-k="per_hole"]');
    el.value = "2";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.click('dialog.log-dialog [data-act="save"]');
  assert.match(await page.run(`document.getElementById("logError").textContent`), /苗数が分からない畝: A 畝1 試験菜/);
  assert.equal(await page.run(`Boolean(document.querySelector("dialog.log-dialog[open]"))`), true);
  assert.deepEqual((await page.saved()).works, []);
  assert.deepEqual(page.errors, []);
});

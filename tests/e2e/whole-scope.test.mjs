// 日程の「全体」と、工程表のない圃場図（図の右に「配置と面積」、右下の「＋ 入力する」は図で選んだ区画・畝が相手）を、
// Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
// この端末の日付（toISOString の日付は UTC なので、日本時間の 0 時から 9 時は前の日になる）
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

// 区画 A と B に、畝を 1 本ずつ。どちらの畝にも試験菜を植え、今日にかかる作業を 1 つずつ入れる
const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", active_plan_id: "p1", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [
    { id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [19, 1], [19, 19], [1, 19]], start_date: null, end_date: null, created_at: AT },
    { id: "b2", plan_id: "p1", zone_id: "z1", name: "B", shape: [[21, 1], [39, 1], [39, 19], [21, 19]], start_date: null, end_date: null, created_at: AT },
  ],
  beds: [
    { id: "bed1", plan_id: "p1", block_id: "b1", seq: 1, shape: [[3, 2], [4, 2], [4, 18], [3, 18]], start_date: null, removed_on: null },
    { id: "bed2", plan_id: "p1", block_id: "b2", seq: 1, shape: [[23, 2], [24, 2], [24, 18], [23, 18]], start_date: null, removed_on: null },
  ],
  plantings: [
    { id: "pl1", plan_id: "p1", bed_id: "bed1", seq: 1, crop_id: "c1", crop_name: "試験菜" },
    { id: "pl2", plan_id: "p1", bed_id: "bed2", seq: 1, crop_id: "c1", crop_name: "試験菜" },
  ],
  works: ["pl1", "pl2"].map((planting, index) => ({ id: `w${index + 1}`, plan_id: "p1", planting_id: planting, block_id: null, seq: 1, work_type: "harvest", plan_start: today, plan_end: today })),
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

const ganttRows = () => page.run(`[...document.querySelectorAll("#gantt .gantt-row")].map((row) => row.dataset.name).join("/")`);
const shown = (id) => page.run(`document.getElementById(${JSON.stringify(id)}).offsetParent !== null`);
const DIALOG = "dialog.log-dialog[open]";

test("日程の「全体」: 工程表にすべての区画を描き、頭の面積・畝の行で苗・肥料・収量の集計を出し入れする。区画と畝の図と区画の計画は出さない。URL で開き直せる", options, async () => {
  await page.viewport(1280, 800);
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="map"]');
  assert.equal(await page.run(`Boolean(document.querySelector("#appView #ganttPanel"))`), false, "圃場図には工程表がない");

  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`document.getElementById("schedulePicker").value === "block:b1"`, "初めは先頭の区画");
  assert.equal(await page.run(`document.getElementById("schedulePicker").options[0].textContent`), "全体", "欄の先頭は全体");
  assert.equal(await ganttRows(), "A/A 畝1", "区画では、その区画だけ");

  await page.setValue("#schedulePicker", "all");
  await page.waitFor(`location.hash === "#schedule/all"`, "URL が全体になる");
  assert.equal(await ganttRows(), "A/A 畝1/B/B 畝1", "全体では、すべての区画と畝");
  // 頭の面積・畝の本数（区画 A と B の 18×18 m）。押すと苗・肥料・収量の集計を出し、もう一度押すとしまう
  assert.equal(await page.run(`document.querySelector('#blockHead [data-act="summary"]').textContent`), "区画 648.0 ㎡・畝 2 本 ▸");
  assert.equal(await shown("blockSummary"), false, "初めは集計を出さない");
  await page.click('#blockHead [data-act="summary"]');
  assert.equal(await shown("blockSummary"), true, "押すと苗・肥料・収量の集計を出す");
  assert.equal(await page.run(`document.getElementById("summaryTitle").textContent`), "苗・肥料・収量の集計（全体）");
  assert.equal(await page.run(`document.querySelector("#cropSummary td:nth-child(2)").textContent`), "2", "2 つの区画の作付を合わせる");
  assert.equal(await shown("stripPanel"), false, "区画と畝の図は出さない");
  assert.equal(await shown("blockRecord"), false, "区画の作業の計画と実績は出さない");
  assert.equal(await page.run(`document.querySelector("#blockHead h2").textContent`), "全体");
  await page.click('#blockHead [data-act="summary"]');
  assert.equal(await shown("blockSummary"), false, "もう一度押すとしまう");

  // 全体の頭の入力のボタンは、相手を決めずに窓を開く
  await page.click('#blockHead [data-whole="record"]');
  await page.waitFor(`Boolean(document.querySelector("${DIALOG}"))`, "入力の窓");
  assert.equal(await page.run(`document.querySelectorAll("${DIALOG} .log-chip.is-on, ${DIALOG} [data-act='block']:checked").length`), 0, "対象は空");
  await page.click(`${DIALOG} .log-head [data-act="close"]`);
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "窓が閉じる");
  // 窓のために積んだ履歴の取り消しを待つ（待たずに進むと、取り消しの戻るが次の操作のあとに効く）
  await page.waitFor(`history.state?.fieldPlanDialog !== true`, "積んだ履歴が取り消される");

  // 工程表の区画の名前を押すと、その区画を開く。戻ると全体に戻る
  await page.click('#gantt .gantt-link[data-detail="block"][data-id="b2"]');
  await page.waitFor(`location.hash === "#schedule/block/b2" && document.getElementById("schedulePicker").value === "block:b2"`, "区画 B を開く");
  assert.equal(await shown("stripPanel"), true, "区画では区画と畝の図を出す");
  assert.equal(await page.run(`document.getElementById("summaryTitle").textContent`), "苗・肥料・収量の集計（この区画）");
  await page.run("history.back()");
  await page.waitFor(`location.hash === "#schedule/all" && document.getElementById("schedulePicker").value === "all"`, "戻ると全体");

  // 開き直しても全体を開く（覚えた場所も全体）
  await page.click('.tab-btn[data-view="map"]');
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`document.getElementById("schedulePicker").value === "all"`, "タブを戻っても全体");
  assert.deepEqual(page.errors, []);
});

test("圃場図: 配置と面積の欄は図と同じ高さ。「＋ 入力する」は図で選んだ区画・畝を対象に入れ、何も選んでいなければ空で開く", options, async () => {
  await page.viewport(1280, 800);
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="map"]');
  await page.waitFor(`Boolean(document.querySelector('#shapeTree [data-shape="b2"]'))`, "木に区画が出る");
  const targets = async () => {
    await page.click("#logAddBtn");
    await page.waitFor(`Boolean(document.querySelector("${DIALOG}"))`, "入力の窓");
    const result = await page.run(
      `[...document.querySelectorAll("${DIALOG} .log-chip.is-on")].map((chip) => "bed:" + chip.dataset.id).concat([...document.querySelectorAll("${DIALOG} [data-act='block']:checked")].map((box) => "block:" + box.dataset.id)).join()`
    );
    await page.click(`${DIALOG} .log-head [data-act="close"]`);
    await page.waitFor(`!document.querySelector("${DIALOG}")`, "窓が閉じる");
    await page.waitFor(`history.state?.fieldPlanDialog !== true`, "積んだ履歴が取り消される");
    return result;
  };
  // 配置と面積の欄は、中身が少なくても図と同じ高さ
  const height = (selector) => page.run(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().height`);
  assert.ok(Math.abs((await height("#appView .area-panel")) - (await height("#appView .map-frame"))) < 1, "欄と図の高さがそろう");
  // 図と欄は、画面の下まで使う（下の余白は、圃場図の画面の内側の余白だけ）
  const gap = await page.run(`innerHeight - document.getElementById("mapRow").getBoundingClientRect().bottom`);
  assert.ok(gap >= 0 && gap <= 13, `図の下の余白（${gap}px）`);
  assert.equal(await targets(), "", "何も選んでいない");
  await page.click('#shapeTree [data-shape="b2"]');
  assert.equal(await targets(), "block:b2", "区画を選んでいる");
  await page.click('#shapeTree [data-toggle="b1"]');
  await page.click('#shapeTree [data-shape="bed1"]');
  assert.equal(await targets(), "bed:bed1", "畝を選んでいる（今日の作付）");
  assert.deepEqual(page.errors, []);
});

test("スマホの幅: 図を幅いっぱいに出し、その下に配置と面積の合計と木をまとめて出す", options, async () => {
  await page.viewport(390);
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="map"]');
  await page.waitFor(`Boolean(document.querySelector('#map [data-shape="b1"]'))`, "圃場図に区画が出る");
  const box = (selector) => page.run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; })()`);
  const row = await box("#mapRow");
  const frame = await box("#appView .map-frame");
  const panel = await box("#appView .area-panel");
  const sum = await box("#appView .area-sum");
  const tree = await box("#shapeTree");
  assert.ok(Math.abs(frame.width - row.width) < 1, `図は幅いっぱい（行 ${row.width}、図 ${frame.width}）`);
  assert.ok(panel.top >= frame.bottom, `配置と面積は図の下（図 ${frame.bottom}、欄 ${panel.top}）`);
  assert.ok(sum.bottom <= tree.top + 1 && tree.bottom <= panel.bottom + 1, "合計と木は同じ欄の中");
  assert.equal(await page.run(`document.documentElement.scrollWidth <= innerWidth`), true, "横にはみ出さない");
  assert.ok((await page.run(`[...document.querySelectorAll("#shapeTree > li")].filter((li) => li.offsetParent !== null).length`)) > 1, "木の行を初めから出す");

  await page.clickMap([10, 10]); // 区画 A の中（畝のない所）
  await page.waitFor(`document.getElementById("selectionPanel").offsetParent !== null`, "選んだ区画の内容を出す");
  await page.viewport(null);
  assert.deepEqual(page.errors, []);
});

test("今週やること: 完了した行の「計画に戻す」で、実績を消して完了と修正のボタンに戻る", options, async () => {
  await page.viewport(1280, 800);
  const data = seed();
  // 2 本の畝の収穫を、まとめて完了にした実績
  data.workLogs = [{
    id: "l1", field_id: "f1", date: today, end_date: null, work_type: "harvest", finishes: true, spec: {}, note: "", created_at: AT,
    targets: ["1", "2"].map((n) => ({ id: `t${n}`, log_id: "l1", planting_id: `pl${n}`, bed_id: `bed${n}`, block_id: null, work_id: `w${n}`, label: `畝${n}`, crop_name: "試験菜", area_m2: null, spray_l: null })),
    inputs: [],
  }];
  await page.loadApp(data);
  await page.openView("today");
  await page.click('.wt-tab[data-wtab="week"]');
  await page.waitFor(`Boolean(document.querySelector('#weekList li.is-done [data-week="revert"]'))`, "完了した行に計画に戻すのボタン");
  await page.click('#weekList [data-week="revert"]');
  await page.waitFor(`document.querySelector("dialog.notice[open] .notice-text")?.textContent.includes("未完了に戻します")`, "確かめの窓");
  assert.equal(await page.run(`document.querySelector("dialog.notice[open] .notice-target").textContent`), "収穫（畝1、畝2）");
  assert.equal(await page.run(`document.querySelector('dialog.notice[open] [data-action="delete"]').textContent`), "計画に戻す");
  await page.click('dialog.notice[open] [data-action="delete"]');
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).workLogs.length === 0`, "実績が消える");
  await page.waitFor(`Boolean(document.querySelector('#weekList [data-week="done"]'))`, "完了のボタンに戻る");
  assert.equal(await page.run(`Boolean(document.querySelector("#weekList li.is-done"))`), false);
  assert.deepEqual(page.errors, []);
});

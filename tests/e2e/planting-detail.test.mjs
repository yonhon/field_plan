// 圃場図の品目名から作付の詳細を開くことと、定植の仕様が品目の設定値と違うときの添え書きを、Chrome で通して確かめる。
// 実行: node --test "tests/e2e/*.test.mjs"
import { after, before, test } from "node:test";
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

// 品目の設定値は株間 15cm・条間 15cm・4 条。
// 畝1 は、計画に株間 30cm を入れ、30cm で植えた（計画の欄にも実績の欄にも添え書きが出る）。
// 畝2 は、品目の設定値のまま計画し、そのとおりに植えた（どちらにも出ない）
const plantLog = (id, planting, bedId, workId, spec) => ({
  id,
  field_id: "f1",
  date: "2026-10-15",
  end_date: null,
  work_type: "plant",
  finishes: true,
  spec,
  note: "",
  created_at: AT,
  targets: [{ id: `${id}t`, log_id: id, planting_id: planting, bed_id: bedId, block_id: null, work_id: workId, label: "", crop_name: "試験菜", area_m2: null }],
  inputs: [],
});

const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", active_plan_id: "p1", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: [bed(1), bed(2)],
  plantings: [
    { id: "pl1", plan_id: "p1", bed_id: "bed1", seq: 1, crop_id: "c1", crop_name: "試験菜", plant_gap_cm: 30 },
    { id: "pl2", plan_id: "p1", bed_id: "bed2", seq: 1, crop_id: "c1", crop_name: "試験菜" },
  ],
  works: ["pl1", "pl2"].map((planting) => ({
    id: `w-${planting}`,
    plan_id: "p1",
    block_id: null,
    planting_id: planting,
    work_type: "plant",
    seq: 1,
    plan_start: "2026-10-15",
    plan_end: "2026-10-15",
    note: "",
  })),
  workLogs: [
    plantLog("l1", "pl1", "bed1", "w-pl1", { plant_gap_cm: 30, row_gap_cm: 15, row_count: 4 }),
    plantLog("l2", "pl2", "bed2", "w-pl2", { plant_gap_cm: 15, row_gap_cm: 15, row_count: 4 }),
  ],
  crops: [{ id: "c1", name: "試験菜", mulch: false, bed_width_cm: 100, aisle_width_cm: 60, plant_gap_cm: 15, row_gap_cm: 15, row_count: 4, staggered: false }],
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

const notes = () => page.run(`[...document.querySelectorAll("#plantingBody .detail-crop-diff")].map((line) => line.textContent)`);

// 圃場図の、畝の文字の index 文字目の中心（圃場の座標）。index を省くと、品目名のまん中の文字
const charPoint = (selector, index = null) =>
  page.run(`(() => {
    const text = document.querySelector(${JSON.stringify(selector)});
    const start = Number(text.dataset.name || 0);
    const i = ${index} ?? Math.floor((start + text.getNumberOfChars()) / 2);
    const box = text.getExtentOfChar(i);
    const p = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(text.getScreenCTM());
    const world = new DOMPoint(p.x, p.y).matrixTransform(document.getElementById("map").getScreenCTM().inverse());
    return [world.x, -world.y];
  })()`);

async function openFromMap(planting) {
  await page.click('.tab-btn[data-view="map"]');
  const selector = `#map text[data-detail="${planting}"]`;
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, "品目名のある文字");
  await page.clickMap(await charPoint(selector));
  await page.waitFor(`location.hash === "#detail/planting/${planting}" && !document.getElementById("plantingView").hidden`, "作付の詳細が開く");
}

test("圃場図の品目名を押すと、その作付の詳細が開く", options, async () => {
  await page.loadApp(seed());
  await openFromMap("pl1");
  assert.match(await page.run(`document.querySelector("#plantingBody .detail-title h2").textContent`), /^A 畝1 試験菜/);
  // 日程のタブが選ばれた形になる
  assert.equal(await page.run(`document.querySelector(".tab-btn.is-active").dataset.view`), "schedule");
});

test("畝の番号の所を押すと、作付の詳細には移らず、畝を選ぶ", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="map"]');
  await page.waitFor(`Boolean(document.querySelector('#map text[data-detail="pl1"]'))`, "品目名のある文字");
  // 番号（1 文字目）の位置を、本物のマウスの操作で押す
  await page.clickMap(await charPoint('#map text[data-detail="pl1"]', 0));
  await page.waitFor(`document.querySelector('#map polygon[data-shape="bed1"]').classList.contains("is-selected")`, "畝を選ぶ");
  assert.equal(await page.run(`location.hash`), "#map");
});

test("圃場図で畝を選ぶと「作付の詳細を開く」、区画を選ぶと「日程で開く」が出る", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="map"]');
  // 畝1 の、文字のない所を押す
  await page.clickMap([3.5, 4]);
  await page.waitFor(`document.getElementById("selectionTitle").textContent === "選択中: A 畝1"`, "畝を選ぶ");
  assert.equal(await page.run(`document.getElementById("bedFields").textContent.includes("日程の「区画と畝」で行います")`), false);
  assert.equal(await page.run(`document.getElementById("openScheduleBtn").textContent`), "作付の詳細を開く");
  await page.click("#openScheduleBtn");
  await page.waitFor(`location.hash === "#detail/planting/pl1" && !document.getElementById("plantingView").hidden`, "作付の詳細が開く");

  // 区画は、これまでどおり日程の画面で開く
  await page.click('.tab-btn[data-view="map"]');
  await page.clickMap([30, 10]);
  await page.waitFor(`document.getElementById("selectionTitle").textContent === "選択中: A"`, "区画を選ぶ");
  assert.equal(await page.run(`document.getElementById("openScheduleBtn").textContent`), "日程で開く");
  await page.click("#openScheduleBtn");
  // URL には、開いた区画が付く
  await page.waitFor(`location.hash === "#schedule/block/b1" && !document.getElementById("scheduleView").hidden`, "日程が開く");
  assert.equal(await page.run(`document.getElementById("schedulePicker").value`), "block:b1");

  // 区画・畝の欄で畝を選ぶと、その畝の作付の詳細を開き、欄も詳細の上に移る。区画を選ぶと、日程の画面に戻る
  const pick = (value) =>
    page.run(`(() => { const s = document.getElementById("schedulePicker"); s.value = "${value}"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await pick("bed:bed2");
  await page.waitFor(`location.hash === "#detail/planting/pl2" && !document.getElementById("plantingView").hidden`, "畝2 の作付の詳細");
  assert.equal(await page.run(`document.getElementById("pickerPanel").parentElement.id`), "pickerSlotPlanting");
  assert.equal(await page.run(`document.getElementById("schedulePicker").value`), "bed:bed2");
  await pick("block:b1");
  await page.waitFor(`location.hash === "#schedule/block/b1" && !document.getElementById("scheduleView").hidden`, "区画の日程に戻る");
  assert.equal(await page.run(`document.getElementById("pickerPanel").parentElement.id`), "pickerSlotSchedule");
  assert.deepEqual(page.errors, []);
});

test("定植の仕様が品目の設定値と違えば、計画と実績の欄に添え書きが出る", options, async () => {
  await page.loadApp(seed());
  await openFromMap("pl1");
  // 「計画」の表示では、計画の欄の添え書きだけ
  await page.click('#plantingBody [data-gantt-mode="plan"]');
  await page.waitFor(`document.querySelectorAll("#plantingBody .detail-crop-diff").length === 1`, "添え書きが 1 つ出る");
  assert.deepEqual(await notes(), ["株間の計画値30cmに対し、品目の設定値は15cmです。"]);
  // 「計画と実績」の表示では、計画どおりに植えていても、実績の欄にも出す
  await page.click('#plantingBody [data-gantt-mode="both"]');
  await page.waitFor(`document.querySelectorAll("#plantingBody .detail-crop-diff").length === 2`, "添え書きが 2 つ出る");
  assert.deepEqual(await notes(), ["株間の計画値30cmに対し、品目の設定値は15cmです。", "株間の実績値30cmに対し、品目の設定値は15cmです。"]);
  // 仕様の差は「計画との差」の欄には出さない（並べ直すものもないので、欄ごと出ない）
  assert.equal(await page.run(`Boolean(document.querySelector("#plantingBody .detail-diff"))`), false);

  // 品目の設定値どおりに計画し、植えた作付には出ない
  await openFromMap("pl2");
  assert.deepEqual(await notes(), []);
});

test("作付の詳細から別のタブに移って日程のタブに戻ると、その作付の詳細を開く。次に開いたときも同じ", options, async () => {
  await page.loadApp(seed());
  await openFromMap("pl2");
  const detailOf = (planting) => `location.hash === "#detail/planting/${planting}" && !document.getElementById("plantingView").hidden`;

  for (const view of ["map", "master"]) {
    await page.openView(view);
    await page.waitFor(`document.getElementById("plantingView").hidden`, `${view} に移る`);
    await page.click('.tab-btn[data-view="schedule"]');
    await page.waitFor(detailOf("pl2"), `${view} から戻ると、作付の詳細`);
  }

  await page.loadApp(seed(), { field_plan_prefs: await page.run(`localStorage.getItem("field_plan_prefs")`) });
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(detailOf("pl2"), "次に開いたときも、作付の詳細");

  // 作付の詳細で日程のタブを押すと、これまでどおり日程の画面。そのあとは、日程の画面に戻る
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`!document.getElementById("scheduleView").hidden && location.hash === "#schedule/block/b1"`, "日程の画面");
  await page.click('.tab-btn[data-view="map"]');
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`!document.getElementById("scheduleView").hidden && document.querySelector('.strip-bed[data-bed="bed2"]')?.classList.contains("is-selected")`, "日程の画面で、畝2 を選んだまま");
  assert.deepEqual(page.errors, []);
});

// 防除の記録。standard は記録した時点の使用基準の写し。totals と total_max は成分の順
const sprayLog = (id, date, inputs) => ({ ...plantLog(id, "pl2", "bed2", null, {}), date, work_type: "spray", finishes: false, inputs });
const sprayInput = (seq, regNo, name, ingredients, totals, totalMax, timesMax) => ({
  id: `${regNo}-${seq}`,
  seq,
  kind: "pesticide",
  reg_no: regNo,
  name,
  dilution: 1000,
  method: "散布",
  standard: { reg_no: regNo, product: name, ingredients, rows: [{ crop_name: "試験菜", crop: "試験菜", totals, total_max: totalMax, times_max: timesMax, preharvest_days: 1 }] },
});

test("農薬の使用回数: 最初に使った順に、成分の下にその成分を含む本剤を出す。条件は添え書き、黄色い枠は上限に達したものだけ", options, async () => {
  const data = seed();
  data.famic = { products: [], uses: [] };
  // DB と同じく、新しい記録が先
  data.workLogs.push(
    sprayLog("s2", "2026-10-25", [
      sprayInput(1, 2002, "乙水和剤", ["成分B", "成分A"], ["2回以内", "4回以内(粒剤は3回以内)"], [2, 4], 3),
      { id: "x-1", seq: 2, kind: "pesticide", reg_no: 3003, name: "写しのない剤", standard: null },
    ]),
    sprayLog("s1", "2026-10-20", [sprayInput(1, 1001, "甲粒剤", ["成分A", ""], ["4回以内(粒剤は3回以内)", ""], [4, null], 1)])
  );
  await page.loadApp(data);
  await openFromMap("pl2");
  await page.waitFor(`Boolean(document.querySelector(".usage-table"))`, "使用回数の表");
  // 名前の後ろの作用機構分類のアイコンは除いて読む
  const rows = await page.run(`[...document.querySelectorAll(".usage-table tbody tr")].map((row) => row.className + "|" + (() => { const cell = row.cells[0].cloneNode(true); cell.querySelectorAll("svg").forEach((icon) => icon.remove()); return cell.textContent.trim(); })() + "|" + row.cells[1].textContent + "/" + row.cells[2].textContent)`);
  assert.deepEqual(rows, [
    "usage-ingredient|成分A条件: 4回以内(粒剤は3回以内)|2/4",
    "usage-product|本剤 甲粒剤|1/1",
    "usage-product|本剤 乙水和剤|1/3",
    "usage-ingredient|成分B|1/2",
    "usage-product|本剤 乙水和剤|1/3",
    "usage-product usage-alone|本剤 写しのない剤|1/-",
  ]);
  const notes = await page.run(`[...document.querySelectorAll("#plantingView .famic-warnings li")].map((item) => item.textContent)`);
  assert.deepEqual(notes, ["本剤 甲粒剤は上限に達しています。"], "条件は黄色い枠に出さない");
  assert.deepEqual(page.errors, []);
});

// 元に戻すは、その操作をした作付の詳細に移り、戻した計画の作業の日付の欄を光らせる
test("作付の詳細で計画の日付を直し、別の画面で元に戻すと、作付の詳細に戻って、計画の日付の欄が光る", options, async () => {
  await page.loadApp(seed());
  await openFromMap("pl1");
  await page.waitFor(`location.hash === "#detail/planting/pl1" && !document.getElementById("plantingView").hidden`, "作付の詳細が開く");
  await page.click('[data-plan-edit="w-pl1"]');
  await page.waitFor(`Boolean(document.querySelector("dialog.plan-edit[open]"))`, "計画を直す窓");
  await page.run(`(() => { const input = document.querySelector('dialog.plan-edit [data-k="start"]'); input.value = "2026-10-20"; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.click('dialog.plan-edit [data-action="save"]');
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).works.find((work) => work.id === "w-pl1").plan_start === "2026-10-20"`, "計画の保存");
  await page.click('.tab-btn[data-view="map"]');
  await page.waitFor(`!document.getElementById("appView").hidden`, "圃場図");

  await page.click("#undoBtn");
  await page.waitFor(`location.hash === "#detail/planting/pl1" && !document.getElementById("plantingView").hidden`, "作付の詳細に戻る");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).works.find((work) => work.id === "w-pl1").plan_start === "2026-10-15"`, "計画が戻る");
  await page.waitFor(`document.querySelector('td.detail-plan[data-plan="w-pl1"]')?.classList.contains("undo-flash")`, "計画の日付の欄が光る");
  assert.deepEqual(page.errors, []);
});

const savedLogs = () => page.run(`JSON.parse(localStorage.getItem("field_plan_local")).workLogs`);

test("作付の詳細の「計画に戻す」: つながった実績を消して未完了に戻し、元に戻すで実績が戻る", options, async () => {
  await page.loadApp(seed());
  await openFromMap("pl1");
  await page.click('#plantingBody [data-gantt-mode="both"]');
  await page.click('#plantingBody [data-revert="w-pl1"]');
  await page.waitFor(`document.querySelector("dialog.notice[open] .notice-text")?.textContent.includes("未完了に戻します")`, "確かめの窓");
  await page.click('dialog.notice[open] [data-action="delete"]');
  await page.waitFor(`!JSON.parse(localStorage.getItem("field_plan_local")).workLogs.some((log) => log.id === "l1")`, "実績が消える");
  assert.deepEqual((await savedLogs()).map((log) => log.id), ["l2"], "ほかの作付の実績は残る");
  await page.waitFor(`!document.querySelector('#plantingBody [data-revert="w-pl1"]')`, "計画に戻すのボタンが消える");
  assert.equal(await page.run(`Boolean(document.querySelector("#plantingBody .detail-badge.is-missing"))`), true, "予定日を過ぎた未実施の計画に戻る");

  await page.click("#undoBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).workLogs.some((log) => log.id === "l1")`, "元に戻すで実績が戻る");
  await page.waitFor(`Boolean(document.querySelector('#plantingBody [data-revert="w-pl1"]'))`, "完了の表示に戻る");
  assert.deepEqual(page.errors, []);
});

test("「計画に戻す」: 実績がほかの畝にも付いていれば範囲を尋ね、この畝だけなら実績からその畝を外す", options, async () => {
  const data = seed();
  // 2 本の畝をまとめて完了にした実績 1 件
  data.workLogs = [{ ...data.workLogs[0], targets: [data.workLogs[0].targets[0], { ...data.workLogs[1].targets[0], id: "l1t2", log_id: "l1" }] }];
  await page.loadApp(data);
  await openFromMap("pl1");
  await page.click('#plantingBody [data-gantt-mode="both"]');
  await page.click('#plantingBody [data-revert="w-pl1"]');
  await page.waitFor(`document.querySelector("dialog.notice[open] .notice-text")?.textContent.includes("ほかの 1 か所")`, "範囲を尋ねる");
  assert.equal(await page.run(`document.querySelector('dialog.notice[open] [data-scope="all"]').textContent`), "実績ごと消して計画に戻す（2 か所）");
  await page.click('dialog.notice[open] [data-scope="one"]');
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).workLogs[0]?.targets.length === 1`, "その畝だけ外す");
  const [log] = await savedLogs();
  assert.equal(log.id, "l1", "実績は残す");
  assert.deepEqual(log.targets.map((target) => target.work_id), ["w-pl2"], "ほかの畝の計画は完了のまま");
  assert.deepEqual(page.errors, []);
});

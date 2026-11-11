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

async function openFromMap(planting) {
  await page.click('.tab-btn[data-view="map"]');
  await page.click(`#map .map-link[data-detail="${planting}"]`);
  await page.waitFor(`location.hash === "#detail/planting/${planting}" && !document.getElementById("plantingView").hidden`, "作付の詳細が開く");
}

test("圃場図の品目名を押すと、その作付の詳細が開く", options, async () => {
  await page.loadApp(seed());
  await openFromMap("pl1");
  assert.match(await page.run(`document.querySelector("#plantingBody .detail-title h2").textContent`), /^A 畝1 試験菜/);
  // 日程のタブが選ばれた形になる
  assert.equal(await page.run(`document.querySelector(".tab-btn.is-active").dataset.view`), "schedule");
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

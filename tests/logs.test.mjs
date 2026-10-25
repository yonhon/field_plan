// 作業の記録の計算（app/logs.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bedAreas,
  matchWork,
  plantingOnDate,
  productAmount,
  splitByArea,
  targetChoices,
  targetSummary,
  workActuals,
} from "../app/logs.js";

const near = (actual, expected, digits = 6) => assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} != ${expected}`);
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// 10 m × 6 m の区画に、長さ 8 m・幅 0.7 m の畝を 3 本（隙間 0.6 m）
const block = { id: "k1", name: "区画A", shape: rect(0, 0, 10, 6), start_date: null, end_date: null };
const beds = [
  { id: "b1", block_id: "k1", seq: 1, shape: rect(1, 1, 9, 1.7), start_date: null, removed_on: null },
  { id: "b2", block_id: "k1", seq: 2, shape: rect(1, 2.3, 9, 3.0), start_date: null, removed_on: null },
  { id: "b3", block_id: "k1", seq: 3, shape: rect(1, 3.6, 9, 4.3), start_date: null, removed_on: "2026-05-01" },
];

test("畝＋通路の面積は、両隣との隙間を半分ずつ持ち、端の畝は区画の端までを持つ", () => {
  const areas = bedAreas(block, beds);
  near(areas.get("b1"), 8 * (1.0 + 0.7 + 0.3)); // 区画の端まで 1.0 m、隣まで 0.6 m の半分
  near(areas.get("b2"), 8 * (0.3 + 0.7 + 0.3));
  near(areas.get("b3"), 8 * (0.3 + 0.7 + 1.7)); // 区画の端まで 1.7 m
  // 足すと、畝の長さ × 区画の幅になる
  near([...areas.values()].reduce((sum, area) => sum + area, 0), 8 * 6);
  // 畝の並びの順は問わない
  near(bedAreas(block, [...beds].reverse()).get("b2"), 8 * 1.3);
  assert.equal(bedAreas(block, []).size, 0);
});

const plantings = [
  { id: "p1", bed_id: "b1", seq: 1, crop_name: "レタス", crop_id: "c1", mulch: null },
  { id: "p2", bed_id: "b1", seq: 2, crop_name: "ニンジン", crop_id: null, mulch: false },
  { id: "p3", bed_id: "b2", seq: 1, crop_name: "レタス", crop_id: "c1", mulch: false },
  { id: "p4", bed_id: "b3", seq: 1, crop_name: "レタス", crop_id: "c1", mulch: null },
];
const crops = [{ id: "c1", name: "レタス", mulch: true }];
const works = [
  { id: "w1", planting_id: "p1", work_type: "ridge", seq: 1, plan_start: "2026-03-01", plan_end: "2026-03-02" },
  { id: "w2", planting_id: "p1", work_type: "plant", seq: 2, plan_start: "2026-03-10", plan_end: "2026-03-12" },
  { id: "w3", planting_id: "p1", work_type: "harvest", seq: 3, plan_start: "2026-04-20", plan_end: "2026-04-30" },
  { id: "w4", planting_id: "p2", work_type: "plant", seq: 1, plan_start: "2026-05-10", plan_end: "2026-05-10" },
  { id: "w5", planting_id: "p3", work_type: "plant", seq: 1, plan_start: "2026-03-10", plan_end: "2026-03-12" },
  { id: "w6", planting_id: "p3", work_type: "plant", seq: 2, plan_start: "2026-03-20", plan_end: "2026-03-20" },
  { id: "w7", block_id: "k1", work_type: "rotary", seq: 1, plan_start: "2026-02-20", plan_end: "2026-02-20" },
];

test("その日の作付は、いまの作付か次に来る作付で、収穫を終えた作付は選ばない", () => {
  const onBed1 = plantings.filter((item) => item.bed_id === "b1");
  assert.equal(plantingOnDate(onBed1, works, "2026-02-01").id, "p1"); // まだ始まっていなくても、次に来る作付
  assert.equal(plantingOnDate(onBed1, works, "2026-04-30").id, "p1");
  assert.equal(plantingOnDate(onBed1, works, "2026-05-01").id, "p2");
  assert.equal(plantingOnDate(onBed1, works, "2026-06-01"), null);
  // 作業に日付のない作付は、いつでも選ぶ
  assert.equal(plantingOnDate([{ id: "x", seq: 1 }], [], "2030-01-01").id, "x");
});

test("対象は品目ごとにまとめ、マルチの有無で分ける。その日にない畝は出さない", () => {
  const data = { blocks: [block], beds, plantings, works, crops };
  const choices = targetChoices(data, "2026-03-15");
  // 畝1・畝3 のレタスは品目の設定でマルチあり、畝2 のレタスは作付でマルチなし
  assert.deepEqual(
    choices.crops.map((group) => [group.name, group.mulch, group.items.map((item) => item.bed_id)]),
    [
      ["レタス", false, ["b2"]],
      ["レタス", true, ["b1", "b3"]],
    ]
  );
  const item = choices.crops[1].items[0];
  assert.equal(item.label, "区画A 畝1 レタス");
  assert.equal(item.planting_id, "p1");
  near(item.area_m2, 16);
  assert.deepEqual(choices.blocks.map((item) => [item.block_id, item.label, item.area_m2]), [["k1", "区画A", 60]]);
  // 畝3 は 5/1 でなくなる。5/1 には畝1 がニンジンになる
  const may = targetChoices(data, "2026-05-01");
  assert.deepEqual(
    may.crops.map((group) => [group.name, group.items.map((item) => item.bed_id)]),
    [["ニンジン", ["b1"]]]
  );
});

const log = (id, date, workId, finishes = false) => ({ id, date, finishes, targets: [{ work_id: workId }, { work_id: null }] });

test("計画の作業の実績は、最初の記録の日と、終わりの印の付いた記録の日", () => {
  const actuals = workActuals([log("l1", "2026-03-11", "w2", true), log("l2", "2026-03-10", "w2"), log("l3", "2026-03-13", "w5")]);
  assert.deepEqual(actuals.get("w2"), { start: "2026-03-10", end: "2026-03-11" });
  assert.deepEqual(actuals.get("w5"), { start: "2026-03-13", end: null });
  assert.equal(actuals.has("w1"), false);
});

test("記録につなぐのは、同じ種類で、取りやめておらず、まだ終わっていない最初の作業", () => {
  const none = new Map();
  assert.equal(matchWork(works, { planting_id: "p3" }, "plant", none).id, "w5");
  // 1 つ目が終わっていれば 2 つ目
  assert.equal(matchWork(works, { planting_id: "p3" }, "plant", workActuals([log("l1", "2026-03-11", "w5", true)])).id, "w6");
  // 始めただけ（終わりの印がない）なら、まだ 1 つ目
  assert.equal(matchWork(works, { planting_id: "p3" }, "plant", workActuals([log("l1", "2026-03-11", "w5")])).id, "w5");
  // 取りやめた作業は選ばない
  const cancelled = works.map((work) => (work.id === "w5" ? { ...work, cancelled_on: "2026-03-01" } : work));
  assert.equal(matchWork(cancelled, { planting_id: "p3" }, "plant", none).id, "w6");
  assert.equal(matchWork(works, { block_id: "k1" }, "rotary", none).id, "w7");
  assert.equal(matchWork(works, { planting_id: "p3" }, "water", none), null);
});

test("品目ごとの液の量を面積の比で分け、希釈倍率から製品の量を出す", () => {
  const parts = splitByArea([{ area_m2: 10 }, { area_m2: 30 }], 8);
  near(parts[0], 2);
  near(parts[1], 6);
  assert.deepEqual(splitByArea([{}, {}], 3), [1.5, 1.5]);
  assert.deepEqual(splitByArea([{ area_m2: 1 }], 0), [null]);
  near(productAmount(10.5, 2000), 5.25);
  assert.equal(productAmount(10, null), null);
});

test("対象を品目ごとの本数で短く表す", () => {
  assert.equal(
    targetSummary([
      { bed_id: "b1", crop_name: "レタス" },
      { bed_id: "b2", crop_name: "レタス" },
      { bed_id: null, planting_id: null, crop_name: "ニンジン" },
      { block_id: "k1", crop_name: "", label: "区画A" },
    ]),
    "レタス 2 本、ニンジン、区画A"
  );
});

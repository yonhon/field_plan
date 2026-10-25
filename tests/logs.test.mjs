// 作業の記録の計算（app/logs.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bedAreas,
  compressedAxis,
  dayGap,
  defaultDilution,
  firstHarvestDay,
  lateWorks,
  matchWork,
  pesticideCounts,
  sprayWarnings,
  usageTable,
  shiftAfterActual,
  specDiff,
  layoutBars,
  stackLanes,
  withActualDates,
  workStatus,
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

test("作業の状態と、遅れている作業", () => {
  const actuals = workActuals([log("l1", "2026-03-10", "w1", true), log("l2", "2026-03-11", "w5")]);
  const today = "2026-03-15";
  assert.equal(workStatus(works[0], actuals, today), "done");
  assert.equal(workStatus(works[4], actuals, today), "late"); // 始めたが、予定の終了日を過ぎた
  assert.equal(workStatus(works[3], actuals, today), "planned");
  assert.equal(workStatus({ ...works[4], cancelled_on: "2026-03-12" }, actuals, today), "cancelled");
  assert.equal(workStatus({ id: "x", plan_end: "2026-03-20" }, workActuals([log("l3", "2026-03-14", "x")]), today), "started");
  // 遅れているのは、予定の終了日を過ぎて終わっていない作業。終了日の早い順、同じ日なら順番の順
  assert.deepEqual(lateWorks(works, actuals, today).map((work) => work.id), ["w7", "w5", "w2"]);
});

test("計画と実績のずれは、終了日どうしで比べる", () => {
  const work = { plan_end: "2026-03-12" };
  assert.equal(dayGap(work, { start: "2026-03-10", end: "2026-03-12" }), "予定どおり");
  assert.equal(dayGap(work, { start: "2026-03-10", end: "2026-03-14" }), "2 日遅れ");
  assert.equal(dayGap(work, { start: "2026-03-10", end: "2026-03-11" }), "1 日早い");
  assert.equal(dayGap(work, { start: "2026-03-10", end: null }), "");
});

test("実績のある作業は、実績の日に置き換える", () => {
  const actuals = workActuals([log("l1", "2026-03-11", "w2", true), log("l2", "2026-03-13", "w5")]);
  const moved = withActualDates(works, actuals);
  assert.deepEqual([moved[1].plan_start, moved[1].plan_end], ["2026-03-11", "2026-03-11"]);
  // 始めただけなら、開始日だけ。予定の終了日が開始日より前なら、開始日にそろえる
  assert.deepEqual([moved[4].plan_start, moved[4].plan_end], ["2026-03-13", "2026-03-13"]);
  assert.equal(moved[0], works[0]);
});

test("実績に合わせて、終わっていない後ろの作業を、遅れた日数だけずらす", () => {
  const own = works.filter((work) => work.planting_id === "p1");
  // 定植が 3/14 に終わった（予定は 3/12）。収穫を 2 日後ろへずらし、間隔と日数はそのまま
  const actuals = workActuals([log("l1", "2026-03-02", "w1", true), log("l2", "2026-03-14", "w2", true)]);
  const shift = shiftAfterActual(own, actuals);
  assert.equal(shift.days, 2);
  assert.deepEqual(shift.works.map((work) => [work.id, work.plan_start, work.plan_end]), [["w3", "2026-04-22", "2026-05-02"]]);
  // 早く終われば前へ。予定どおりなら、ずらす作業はない
  assert.equal(shiftAfterActual(own, workActuals([log("l3", "2026-03-11", "w2", true)])).days, -1);
  assert.deepEqual(shiftAfterActual(own, workActuals([log("l4", "2026-03-12", "w2", true)])).works, []);
  // 終わった作業がなければ、ずらせない
  assert.equal(shiftAfterActual(own, new Map()), null);
});

test("定植の仕様の、計画との差", () => {
  const diff = specDiff({ plant_gap_cm: 30, row_gap_cm: 20, staggered: true }, { plant_gap_cm: 25, row_gap_cm: 20, row_count: 3, staggered: false });
  assert.deepEqual(diff.map((item) => [item.key, item.planned, item.actual]), [["plant_gap_cm", 25, 30], ["staggered", false, true]]);
  assert.deepEqual(specDiff({}, { plant_gap_cm: 25 }), []);
});

test("作業のない期間を詰めた時間の軸", () => {
  // 3/1〜3/2 と 3/20 の作業。前後 1 日を残し、間の 15 日（3/4〜3/18）を 2 日ぶんに詰める
  const axis = compressedAxis([["2026-03-01", "2026-03-02"], ["2026-03-20", "2026-03-20"]]);
  assert.equal(axis.first, "2026-02-28");
  assert.equal(axis.last, "2026-03-21");
  assert.deepEqual(axis.breaks.map((item) => [item.x, item.width, item.days, item.start]), [[4, 2, 15, "2026-03-04"]]);
  assert.equal(axis.x("2026-03-01"), 1);
  assert.equal(axis.x("2026-03-19"), 6);
  assert.equal(axis.x("2026-03-20"), 7);
  assert.equal(axis.total, 9);
  assert.deepEqual(axis.ticks.map((tick) => [tick.x, tick.day]), [[0, "2026-03-01"], [6, "2026-03-20"]]);
  // 2 日以下の空きは詰めない
  assert.equal(compressedAxis([["2026-03-01", "2026-03-01"], ["2026-03-05", "2026-03-05"]]).breaks.length, 0);
  assert.equal(compressedAxis([]), null);
});

// 防除の記録。standard は記録した時点の使用基準の写し
const useRow = {
  crop_name: "レタス",
  crop: "レタス",
  dilution_min: 1000,
  dilution_max: 2000,
  liquid_min: 100,
  liquid_max: 300,
  preharvest_days: 7,
  times_max: 3,
  total_max: [3, 2],
  totals: ["3回以内", "2回以内(定植後は1回以内)"],
};
const pesticide = (regNo, ingredients) => ({ kind: "pesticide", reg_no: regNo, name: `剤${regNo}`, standard: { product: `剤${regNo}`, ingredients, rows: [useRow] } });
const spray = (id, date, plantingIds, inputs) => ({ id, date, work_type: "spray", targets: plantingIds.map((plantingId) => ({ planting_id: plantingId })), inputs });

test("農薬の使用回数は、作付ごとに、登録番号と有効成分で数える", () => {
  const logs = [
    spray("s1", "2026-03-01", ["p1", "p3"], [pesticide(100, ["成分A", "成分B"])]),
    spray("s2", "2026-03-10", ["p1"], [pesticide(200, ["成分A", ""])]),
    // 1 件の記録で、同じ成分を含む剤が 2 つあっても 1 回
    spray("s3", "2026-03-12", ["p1"], [pesticide(100, ["成分A", "成分B"]), pesticide(200, ["成分A", ""])]),
  ];
  const counts = pesticideCounts(logs, "p1");
  assert.deepEqual([...counts.products.entries()], [["100", 2], ["200", 2]]);
  assert.deepEqual([...counts.ingredients.entries()], [["成分A", 3], ["成分B", 2]]);
  assert.equal(pesticideCounts(logs, "p3").ingredients.get("成分A"), 1);
  assert.equal(pesticideCounts(logs, "p1", "s3").ingredients.get("成分A"), 2);
  const table = usageTable(logs, "p1", "レタス");
  assert.deepEqual(
    table.ingredients.map((item) => [item.name, item.count, item.max, Boolean(item.condition)]),
    [["成分A", 3, 3, false], ["成分B", 2, 2, true]]
  );
  assert.deepEqual(table.products.map((item) => [item.reg_no, item.count, item.max]), [["100", 2, 3], ["200", 2, 3]]);
  // 最後の防除（3/12）と、収穫 7 日前まで
  assert.equal(firstHarvestDay(logs, "p1", "レタス"), "2026-03-19");
  assert.equal(firstHarvestDay(logs, "p2", "レタス"), null);
});

test("防除の指摘", () => {
  const none = { products: new Map(), ingredients: new Map() };
  const used = { products: new Map([["100", 3]]), ingredients: new Map([["成分A", 3], ["成分B", 1]]) };
  const base = { date: "2026-03-20", regNo: 100, ingredients: ["成分A", "成分B"] };
  const group = (extra) => ({ name: "レタス", area: 100, liters: 2, row: useRow, plantings: [{ id: "p1", harvestStart: "2026-04-01" }], ...extra });
  // 基準どおり（2000 倍、100 ㎡ に 20 L は 10 a あたり 200 L）。総使用回数の条件だけを知らせる
  assert.deepEqual(sprayWarnings({ ...base, dilution: 2000, groups: [group({ liters: 20 })], countsOf: () => none }), [
    "レタス: 成分B の総使用回数には条件があります。確かめてください: 2回以内(定植後は1回以内)",
  ]);
  const warnings = sprayWarnings({ ...base, dilution: 800, groups: [group({ plantings: [{ id: "p1", harvestStart: "2026-03-25" }] })], countsOf: () => used });
  assert.ok(warnings.some((text) => text.includes("基準（1000 倍以上）より濃く")));
  assert.ok(warnings.some((text) => text.includes("10 a あたり 20 L")));
  assert.ok(warnings.some((text) => text.includes("本剤の使用回数が、この防除で 4 回")));
  assert.ok(warnings.some((text) => text.includes("成分A を含む農薬の使用回数が、この防除で 4 回")));
  assert.ok(!warnings.some((text) => text.includes("成分B を含む農薬の使用回数")));
  assert.ok(warnings.some((text) => text.includes("収穫の開始（03/25）まで 5 日")));
  assert.deepEqual(sprayWarnings({ ...base, dilution: 2000, groups: [group({ row: null })], countsOf: () => none }), [
    "レタス: この品目には使用基準がありません（この品目には使えない農薬の可能性があります）",
  ]);
});

test("初めの希釈倍率は、下限のうちいちばん大きいもの", () => {
  assert.equal(defaultDilution([{ dilution_min: 1000 }, { dilution_min: 2000 }, null]), 2000);
  assert.equal(defaultDilution([{ dilution_min: null }]), null);
});

test("日が重なる帯を、重なりのまとまりごとに上下の段に分ける", () => {
  const lanes = stackLanes([
    { start: "2026-03-01", end: "2026-03-02" }, // 畝立て
    { start: "2026-03-02", end: "2026-03-02" }, // 同じ日のマルチ張り
    { start: "2026-03-05", end: "2026-03-05" }, // 重ならない定植
    { start: "2026-03-10", end: "2026-03-20" }, // 収穫
    { start: "2026-03-12", end: "2026-03-12" }, // 収穫中の防除
    { start: "2026-03-15", end: "2026-03-15" }, // 収穫中の防除（上の段が空いている）
  ]);
  assert.deepEqual(lanes, [
    { lane: 0, lanes: 2 },
    { lane: 1, lanes: 2 },
    { lane: 0, lanes: 1 },
    { lane: 0, lanes: 2 },
    { lane: 1, lanes: 2 },
    { lane: 1, lanes: 2 },
  ]);
  assert.deepEqual(stackLanes([]), []);
});

test("工程表の帯の置き方。上下に分けるのは、1 日の作業どうしが同じ日に重なるときだけ", () => {
  const brief = (bars) => bars.map((bar) => [bar.item, bar.start.slice(5), bar.end.slice(5), bar.lane, bar.lanes, bar.cutStart, bar.cutEnd]);
  // 1 日のマルチ張り（6/1）と、同じ日に始まる 5 日の定植（6/1〜6/5）: 6/1 はマルチ張り、定植は 6/2〜6/5 を普通の高さで
  assert.deepEqual(brief(layoutBars([{ start: "2027-06-01", end: "2027-06-01" }, { start: "2027-06-01", end: "2027-06-05" }])), [
    [0, "06-01", "06-01", 0, 1, false, false],
    [1, "06-02", "06-05", 0, 1, true, false],
  ]);
  // 同じ日に 1 日の作業が 2 つ（畝立てとマルチ張り）なら、その日の中だけ上下に分ける
  assert.deepEqual(brief(layoutBars([{ start: "2027-06-01", end: "2027-06-01" }, { start: "2027-06-01", end: "2027-06-01" }, { start: "2027-06-02", end: "2027-06-04" }])), [
    [0, "06-01", "06-01", 0, 2, false, false],
    [1, "06-01", "06-01", 1, 2, false, false],
    [2, "06-02", "06-04", 0, 1, false, false],
  ]);
  // 収穫（6/10〜6/20）の途中の 1 日の防除（6/15）: 収穫の帯は防除の日の前後に分かれる
  assert.deepEqual(brief(layoutBars([{ start: "2027-06-10", end: "2027-06-20" }, { start: "2027-06-15", end: "2027-06-15" }])), [
    [0, "06-10", "06-14", 0, 1, false, true],
    [0, "06-16", "06-20", 0, 1, true, false],
    [1, "06-15", "06-15", 0, 1, false, false],
  ]);
  // 何日かの作業どうしが重なるときは、行の全部を上下に分ける（どの帯も隠れないように）
  assert.deepEqual(brief(layoutBars([{ start: "2027-06-01", end: "2027-06-03" }, { start: "2027-06-03", end: "2027-06-05" }])), [
    [0, "06-01", "06-03", 0, 2, false, false],
    [1, "06-03", "06-05", 1, 2, false, false],
  ]);
  // 2 日の作業の両日に 1 日の作業があって、全部の日が埋まるときも、上下に分ける
  assert.equal(layoutBars([{ start: "2027-06-01", end: "2027-06-02" }, { start: "2027-06-01", end: "2027-06-01" }, { start: "2027-06-02", end: "2027-06-02" }]).every((bar) => bar.start === "2027-06-01" || bar.lanes >= 1), true);
  assert.equal(layoutBars([{ start: "2027-06-01", end: "2027-06-02" }, { start: "2027-06-01", end: "2027-06-01" }, { start: "2027-06-02", end: "2027-06-02" }]).length, 3);
  assert.deepEqual(layoutBars([]), []);
});

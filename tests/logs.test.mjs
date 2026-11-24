// 作業の記録の計算（app/logs.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "./test-api.mjs";
import assert from "node:assert/strict";
import {
  areaStandard,
  bedAreas,
  compressedAxis,
  dayGap,
  defaultDilution,
  firstHarvestDay,
  formatAmount,
  inputText,
  parseUsage,
  usageRange,
  usageWarnings,
  lateWorks,
  logEnd,
  matchWork,
  pesticideCounts,
  previousChoice,
  sprayCounts,
  sprayWarnings,
  standardChoice,
  usageTable,
  shiftAfterActual,
  cropDiffText,
  specDiff,
  SPEC_FIELDS,
  blockPlantings,
  reareaTargets,
  specText,
  withBlockShares,
  layoutBars,
  stackLanes,
  withActualDates,
  workStatus,
  plantingOnDate,
  productAmount,
  splitByArea,
  targetChoices,
  isBlockTarget,
  targetSummary,
  toBaseAmount,
  workActuals,
} from "../app/logs.js";
import { useKeys } from "../app/pesticide.js";

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

test("区画の作業・記録を分ける作付: その日に畝にある作付（次の作付が始まるまで）、なければ次に入る作付。重みは、選んだ畝の畝＋通路の面積", () => {
  const plantingsOn = blockPlantings({ blocks: [block], beds, plantings, works });
  const ids = (date) => plantingsOn("k1", date).map((item) => [item.planting.id, item.bed.id, Math.round(item.weight * 10) / 10]);
  // 4/1: 畝1 は p1。畝2 の p3 は、作付の作業（3/20 まで）のあとも、次の作付がないので畝にある（区画で収穫する作付など）。
  // 畝3 の p4 は日付がなく、ずっとある扱い。3 本で区画を分ける
  assert.deepEqual(ids("2026-04-01"), [["p1", "b1", 16], ["p3", "b2", 10.4], ["p4", "b3", 21.6]]);
  // 畝立ての前（2/20）は、次に入る作付
  assert.deepEqual(ids("2026-02-20").map((item) => item[0]), ["p1", "p3", "p4"]);
  // 5/10 は畝3 がもうない。畝1 は p2（5/10 から）。5/9 までは、収穫を終えた p1 のまま
  assert.deepEqual(ids("2026-05-10").map((item) => item[0]), ["p2", "p3"]);
  assert.deepEqual(ids("2026-05-09").map((item) => item[0]), ["p1", "p3"]);
  // 作付が始まる日は、作付の記録も見る（p2 の 4/25 の記録で、4/25 から畝1 は p2）
  const withLog = blockPlantings({ blocks: [block], beds, plantings, works, logs: [{ date: "2026-04-25", targets: [{ planting_id: "p2" }] }] });
  assert.deepEqual(withLog("k1", "2026-04-25").map((item) => item.planting.id), ["p2", "p3", "p4"]);
  // 区画も日付もなければ空
  assert.deepEqual(plantingsOn("nothing", "2026-04-01"), []);
  assert.deepEqual(plantingsOn("k1", null), []);
  // 畝がまだない日は、あとでできる畝で分ける
  const later = beds.map((bed) => ({ ...bed, start_date: "2026-06-01", removed_on: null }));
  assert.deepEqual(blockPlantings({ blocks: [block], beds: later, plantings, works })("k1", "2026-02-01").map((item) => item.bed.id), ["b1", "b2", "b3"]);
});

test("区画の作業と、区画を対象にした記録を、その日に区画にある作付にも付ける", () => {
  const harvest = { id: "wh", block_id: "k1", planting_id: null, work_type: "harvest", seq: 9, plan_start: "2026-04-01", plan_end: "2026-04-03" };
  const undated = { id: "wu", block_id: "k1", planting_id: null, work_type: "harvest", seq: 10, plan_start: null, plan_end: null };
  const spray = { id: "L1", date: "2026-04-01", work_type: "spray", targets: [{ block_id: "k1", bed_id: null, planting_id: null, crop_name: "", label: "区画A", area_m2: 48 }], inputs: [{ kind: "pesticide", reg_no: 100, name: "試験乳剤" }] };
  const mixed = { id: "L2", date: "2026-04-01", work_type: "spray", targets: [{ planting_id: "p1", bed_id: "b1", block_id: "k1", crop_name: "レタス", area_m2: 20 }, { ...spray.targets[0], area_m2: null }] };
  // 畝を消した記録の対象（品目の名前が残る）は、区画の対象ではない
  const orphan = { id: "L3", date: "2026-04-01", work_type: "spray", targets: [{ block_id: "k1", bed_id: null, planting_id: null, crop_name: "レタス", label: "区画A 畝9 レタス", area_m2: 5 }] };
  const plain = { id: "L4", date: "2026-04-01", work_type: "spray", targets: [{ planting_id: "p1" }] };
  const shared = withBlockShares({ blocks: [block], beds, plantings, works: [...works, harvest, undated], logs: [spray, mixed, orphan, plain] });
  // 区画の収穫は、4/1 に区画にある p1、p3、p4 の収穫にもなる。区画のロータリー（2/20）は、次に入る p1、p3、p4 に
  const copies = shared.works.filter((work) => work.from_block);
  assert.deepEqual(copies.map((work) => [work.id, work.planting_id, work.block_id]), [
    ["w7", "p1", null],
    ["w7", "p3", null],
    ["w7", "p4", null],
    ["wh", "p1", null],
    ["wh", "p3", null],
    ["wh", "p4", null],
  ]);
  assert.equal(shared.works.length, works.length + 2 + copies.length);
  // 区画の防除の記録は、区画の対象を残したまま、p1、p3、p4 の対象を足す。面積は区画の 48 ㎡ を畝＋通路の面積の比で分ける
  const added = shared.logs[0].targets.slice(1);
  assert.equal(shared.logs[0].targets[0], spray.targets[0]);
  assert.deepEqual(added.map((target) => [target.planting_id, target.bed_id, target.label, target.crop_name, target.from_block]), [
    ["p1", "b1", "区画A 畝1 レタス", "レタス", true],
    ["p3", "b2", "区画A 畝2 レタス", "レタス", true],
    ["p4", "b3", "区画A 畝3 レタス", "レタス", true],
  ]);
  near(added[0].area_m2, 16);
  near(added[1].area_m2, 10.4);
  near(added[2].area_m2, 21.6);
  assert.deepEqual([added[0].spray_l, added[0].harvest_kg], [null, null]);
  // もう p1 を対象にしている記録には、p3 と p4 だけを足す（区画の面積が空なら、面積も空）
  assert.deepEqual(shared.logs[1].targets.slice(2).map((target) => [target.planting_id, target.area_m2]), [["p3", null], ["p4", null]]);
  // 品目の名前のある対象と、区画の対象のない記録は、そのまま
  assert.equal(shared.logs[2], orphan);
  assert.equal(shared.logs[3], plain);
  // 区画の防除も、p4 の使用回数に数える（元の記録だけなら数えない）
  assert.equal(pesticideCounts([spray], "p4").products.size, 0);
  assert.equal(pesticideCounts(shared.logs, "p4").products.get("100"), 1);
  // 足した写しは、作付ごとの計算にだけ使う。元の記録と作業は変えない
  assert.equal(spray.targets.length, 1);
  assert.equal(harvest.planting_id, null);
});

test("区画の作業・記録を分ける作付: ほかの区画、畝の並び、日付のない作付", () => {

  // 区画 k2（もう 1 つの区画）には、日付のない作付が 2 つ（並びが逆）ある畝と、なくなった畝と、あとでできる畝
  const k2 = { id: "k2", name: "区画B", shape: rect(0, 10, 10, 16), start_date: null, end_date: null };
  const k2Beds = [
    { id: "c1", block_id: "k2", seq: 1, shape: rect(1, 11, 9, 11.7), start_date: "2025-01-01", removed_on: "2026-01-01" },
    { id: "c2", block_id: "k2", seq: 2, shape: rect(1, 13, 9, 13.7), start_date: "2026-09-01", removed_on: null },
  ];
  const k2Plantings = [
    { id: "q0", bed_id: "c1", seq: 1, crop_name: "カブ" }, // なくなった畝の作付（日付なし）は、あとでできる畝で分けるときに入れない
    { id: "q2", bed_id: "c2", seq: 2, crop_name: "" },
    { id: "q1", bed_id: "c2", seq: 1, crop_name: "カブ" },
  ];
  const data = { blocks: [block, k2], beds: [...beds, ...k2Beds], plantings: [...plantings, ...k2Plantings], works };
  const plantingsOn = blockPlantings(data);
  // 6/1 は k2 にある畝がない（畝1 はもうない）。あとでできる畝2 だけで、作付は日付がないのでどちらも始まっている扱いの、並びのあとの q2。面積は k2 の形で求める
  const k2On = plantingsOn("k2", "2026-06-01");
  assert.deepEqual(k2On.map((item) => [item.planting.id, item.bed.id]), [["q2", "c2"]]);
  near(k2On[0].weight, 8 * 6);
  // 区画 k1 の作付には、k2 の畝が入らない
  assert.deepEqual(plantingsOn("k1", "2026-02-20").map((item) => item.bed.id), ["b1", "b2", "b3"]);
  // 日付がなければ、日付のない作付があっても空
  assert.deepEqual(plantingsOn("k2", null), []);

  // 写しの細かいところ
  const shared = withBlockShares({
    ...data,
    works: [
      ...works,
      { id: "wk", block_id: "k2", planting_id: null, work_type: "harvest", plan_start: "2026-06-01", plan_end: "2026-06-02" },
      // 作付の作業は、区画が入っていても写さない
      { id: "wp", block_id: "k2", planting_id: "q2", work_type: "harvest", plan_start: "2026-06-01", plan_end: "2026-06-02" },
      { id: "wn", block_id: "k2", planting_id: null, work_type: "harvest", plan_start: null, plan_end: null },
    ],
    logs: [
      // 品目のない作付の対象の名前と品目、面積の入っていない区画の対象
      { id: "La", date: "2026-06-01", targets: [{ block_id: "k2", label: "区画B" }] },
      { id: "Lb", date: "2026-06-01" },
    ],
  });
  assert.deepEqual(
    shared.works.filter((work) => work.from_block).map((work) => [work.id, work.planting_id]),
    [["w7", "p1"], ["w7", "p3"], ["w7", "p4"], ["wk", "q2"]]
  );
  assert.deepEqual(shared.logs[0].targets[1], {
    block_id: "k2",
    bed_id: "c2",
    planting_id: "q2",
    crop_name: "",
    label: "区画B 畝2",
    area_m2: null,
    spray_l: null,
    harvest_kg: null,
    from_block: true,
  });
  assert.equal(shared.logs[1].targets, undefined);
  // 作業も記録もなければ空
  assert.deepEqual(withBlockShares({ blocks: [block], beds, plantings }), { works: [], logs: [] });
  // 畝の面積が 0（大きさのない畝）なら、面積は分けられない（空）
  const flat = { blocks: [block], beds: [{ id: "f1", block_id: "k1", seq: 1, shape: rect(1, 1, 1, 1), start_date: null, removed_on: null }], plantings: [{ id: "pf", bed_id: "f1", seq: 1 }] };
  assert.equal(withBlockShares({ ...flat, logs: [{ date: "2026-01-01", targets: [{ block_id: "k1", label: "区画A", area_m2: 10 }] }] }).logs[0].targets[1].area_m2, null);
  // 作付の並びが日付の順でなくても、その日に畝にある作付を選ぶ（並びの先の作付は、まだ始まっていない）
  const swapped = blockPlantings({
    ...flat,
    plantings: [{ id: "late", bed_id: "f1", seq: 1 }, { id: "now", bed_id: "f1", seq: 2 }],
    works: [
      { id: "x1", planting_id: "late", work_type: "plant", plan_start: "2026-06-01", plan_end: "2026-06-30" },
      { id: "x2", planting_id: "now", work_type: "plant", plan_start: "2026-03-01", plan_end: "2026-03-30" },
    ],
  });
  assert.deepEqual(swapped("k1", "2026-03-15").map((item) => item.planting.id), ["now"]);
  // 日付がなければ、ずっとある畝の日付のない作付があっても空
  assert.deepEqual(blockPlantings({ ...flat, works: [] })("k1", null), []);
  assert.equal(blockPlantings({ ...flat, works: [] })("k1", "2026-01-01").length, 1);
});

test("畝を最初からなかったことにしたあと、記録の畝の面積を、記録の日に区画にある畝で求め直す", () => {
  // 畝2 を消したあと。3/15 は畝1 と畝3 で区画を分ける（畝1: 端まで 1.0 m と、畝3 までの隙間 1.9 m の半分。畝3: 半分と端まで 1.7 m）
  const rest = beds.filter((bed) => bed.id !== "b2");
  const log = {
    id: "L",
    date: "2026-03-15",
    targets: [
      { bed_id: "b1", planting_id: "p1", block_id: "k1", area_m2: 16 },
      { bed_id: "b3", planting_id: "p4", block_id: "k1", area_m2: 21.6 },
      { bed_id: null, planting_id: null, block_id: "k1", area_m2: 48 }, // 区画の対象は、そのまま
      { bed_id: "gone", planting_id: null, block_id: "k1", area_m2: 5 }, // 畝の並びにない畝も、そのまま
    ],
  };
  const result = reareaTargets(log, [block], rest);
  assert.deepEqual(result.targets.map((target) => target.area_m2), [21.2, 26.8, 48, 5]);
  assert.equal(result.targets[2], log.targets[2]);
  assert.equal(log.targets[0].area_m2, 16); // 元の記録は変えない
  // 6/1 は畝3 がもうない（5/1 でなくした）。畝1 だけで区画を分ける
  assert.deepEqual(reareaTargets({ ...log, date: "2026-06-01", targets: log.targets.slice(0, 1) }, [block], rest).targets[0].area_m2, 48);
  // 小数 2 桁に丸める（区画の幅を 6.001 m にすると、畝1 は 21.2032…）
  const wide = { ...block, shape: rect(0, 0, 10, 6.001) };
  assert.equal(reareaTargets(log, [wide], rest).targets[0].area_m2, 21.2);
  assert.equal(reareaTargets(log, [wide], rest).targets[1].area_m2, 26.81);
  // ほかの区画の畝は、その区画の形と、その区画の畝だけで求める（区画B に畝が 1 本なら、区画の幅 6 m × 長さ 8 m）
  const k2 = { id: "k2", name: "区画B", shape: rect(0, 10, 10, 16), start_date: null, end_date: null };
  const c2 = { id: "c2", block_id: "k2", seq: 1, shape: rect(1, 13, 9, 13.7), start_date: null, removed_on: null };
  const both = reareaTargets({ ...log, targets: [log.targets[0], { bed_id: "c2", block_id: "k2", area_m2: 1 }] }, [block, k2], [...rest, c2]);
  assert.deepEqual(both.targets.map((target) => target.area_m2), [21.2, 48]);
  // 区画が見つからない畝と、対象のない記録
  assert.deepEqual(reareaTargets(log, [], rest).targets.map((target) => target.area_m2), [16, 21.6, 48, 5]);
  assert.deepEqual(reareaTargets({ id: "E", date: "2026-03-15" }, [block], rest), { id: "E", date: "2026-03-15", targets: [] });
});

test("その日の作付は、その日までに始まった作付のうちいちばん新しいもの。始まった日は、記録があれば記録の日", () => {
  const onBed1 = plantings.filter((item) => item.bed_id === "b1");
  assert.equal(plantingOnDate(onBed1, works, "2026-02-01").id, "p1"); // まだ始まっていなくても、次に来る作付
  assert.equal(plantingOnDate(onBed1, works, "2026-04-30").id, "p1");
  // 収穫を終えたあとも、次の作付（5/10 から）が始まるまでは前の作付（残渣処理などの記録のため）
  assert.equal(plantingOnDate(onBed1, works, "2026-05-01").id, "p1");
  assert.equal(plantingOnDate(onBed1, works, "2026-05-10").id, "p2");
  // 次の作付がなければ、最後の作付のまま（計画に収穫がない、作りかけの作付も）
  assert.equal(plantingOnDate(onBed1, works, "2026-12-01").id, "p2");
  // 計画と実績の両方があれば実績を優先する。p2 の最初の記録が 4/25 なら、4/25 から p2
  const early = [{ date: "2026-04-25", targets: [{ planting_id: "p2" }] }];
  assert.equal(plantingOnDate(onBed1, works, "2026-04-25", early).id, "p2");
  assert.equal(plantingOnDate(onBed1, works, "2026-04-24", early).id, "p1");
  // 作業に日付のない作付は、始まっている扱い
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
  // 畝3 は 5/1 でなくなる。5/10 には畝1 がニンジンになる。畝2 は次の作付がないので、レタスのまま
  const may = targetChoices(data, "2026-05-10");
  assert.deepEqual(
    may.crops.map((group) => [group.name, group.items.map((item) => item.bed_id)]),
    [
      ["ニンジン", ["b1"]],
      ["レタス", ["b2"]],
    ]
  );
});

const log = (id, date, workId, finishes = false) => ({ id, date, finishes, targets: [{ work_id: workId }, { work_id: null }] });

test("計画の作業の実績は、最初の記録の日と、終わりの印の付いた記録の日", () => {
  const actuals = workActuals([log("l1", "2026-03-11", "w2", true), log("l2", "2026-03-10", "w2"), log("l3", "2026-03-13", "w5")]);
  assert.deepEqual(actuals.get("w2"), { start: "2026-03-10", end: "2026-03-11", last: "2026-03-11" });
  assert.deepEqual(actuals.get("w5"), { start: "2026-03-13", end: null, last: "2026-03-13" });
  assert.equal(actuals.has("w1"), false);
});

test("何日かにわたる記録は、1 件で始めた日と終えた日を持つ", () => {
  // 3/10〜3/12 の 1 件で終えた作業
  const done = workActuals([{ ...log("l1", "2026-03-10", "w2", true), end_date: "2026-03-12" }]);
  assert.deepEqual(done.get("w2"), { start: "2026-03-10", end: "2026-03-12", last: "2026-03-12" });
  // 作業中（3/13 に始めて 3/15 まで進んだ。まだ終わっていない）
  const going = workActuals([{ ...log("l2", "2026-03-13", "w5"), end_date: "2026-03-15" }]);
  assert.deepEqual(going.get("w5"), { start: "2026-03-13", end: null, last: "2026-03-15" });
  // 工程の無理を見るときは、計画の終了日か、進んだ日の遅いほうまで続くとみなす
  const [moved] = withActualDates([{ id: "w5", plan_start: "2026-03-12", plan_end: "2026-03-14" }], going);
  assert.deepEqual([moved.plan_start, moved.plan_end], ["2026-03-13", "2026-03-15"]);
  // 終えた日が空、または始めた日と同じなら 1 日の作業
  assert.equal(logEnd({ date: "2026-03-10", end_date: null }), "2026-03-10");
  assert.equal(logEnd({ date: "2026-03-10", end_date: "2026-03-10" }), "2026-03-10");
  assert.equal(logEnd({ date: "2026-03-10", end_date: "2026-03-12" }), "2026-03-12");
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

test("区画の記録の対象か: 畝を消して畝と作付の ID だけが空になった対象は、区画の対象にしない", () => {
  assert.equal(isBlockTarget({ block_id: "k1", bed_id: null, planting_id: null, crop_name: "", label: "区画A" }), true);
  assert.equal(isBlockTarget({ block_id: "k1", bed_id: "b1", planting_id: "p1", crop_name: "レタス" }), false);
  assert.equal(isBlockTarget({ block_id: "k1", bed_id: null, planting_id: null, crop_name: "レタス", label: "区画A 畝3 レタス" }), false);
  assert.equal(isBlockTarget({ block_id: "k1", bed_id: "b1", planting_id: null, crop_name: "" }), false);
  assert.equal(isBlockTarget({ block_id: null, bed_id: null, planting_id: null, crop_name: "" }), false);
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

test("定植の仕様と、品目の設定値との違いの文", () => {
  const crop = { plant_gap_cm: 15, row_gap_cm: 15, row_count: 4, staggered: false };
  assert.equal(cropDiffText({ plant_gap_cm: 20, row_gap_cm: 20, row_count: 3 }, crop, "実績"), "株間、条間、条数の実績値20cm、20cm、3条に対し、品目の設定値は15cm、15cm、4条です。");
  assert.equal(cropDiffText({ plant_gap_cm: 30, staggered: true }, crop, "計画"), "株間、千鳥の計画値30cm、千鳥に対し、品目の設定値は15cm、千鳥なしです。");
  // 品目に値がない項目は「なし」
  assert.equal(cropDiffText({ plant_gap_cm: 20 }, { ...crop, plant_gap_cm: null }, "実績"), "株間の実績値20cmに対し、品目の設定値はなしです。");
  // 同じなら空。仕様がなくても空
  assert.equal(cropDiffText({ plant_gap_cm: 15, row_count: 4 }, crop, "実績"), "");
  assert.equal(cropDiffText({}, crop, "実績"), "");
  assert.equal(cropDiffText(null, crop, "実績"), "");
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
  assert.deepEqual(table.products.map((item) => [item.reg_no, item.count, item.max, item.ingredients]), [["100", 2, 3, ["成分A", "成分B"]], ["200", 2, 3, ["成分A"]]]);
  // 最後の防除（3/12）と、収穫 7 日前まで
  assert.equal(firstHarvestDay(logs, "p1", "レタス"), "2026-03-19");
  assert.equal(firstHarvestDay(logs, "p2", "レタス"), null);
  // 使用基準の写しがない記録は、本剤の名前を記録に入れた名前で出す。上限は空
  const plain = usageTable([spray("s4", "2026-03-01", ["p1"], [{ kind: "pesticide", reg_no: "300", name: "粒剤 5", standard: null }])], "p1", "レタス");
  assert.deepEqual(plain.products, [{ reg_no: "300", count: 1, name: "粒剤 5", max: null, ingredients: [] }]);
});

test("農薬の使用回数の表は、最初に使った順に並べる。記録の並び（新しい順）に左右されない", () => {
  // 記録は DB から新しい順に届く
  const logs = [
    spray("s2", "2026-03-10", ["p1"], [pesticide(200, ["成分C", ""]), pesticide(300, ["成分B", ""])]),
    spray("s1", "2026-03-01", ["p1"], [pesticide(100, ["成分A", ""])]),
  ];
  const table = usageTable(logs, "p1", "レタス");
  assert.deepEqual(table.ingredients.map((item) => item.name), ["成分A", "成分C", "成分B"], "古い日から、同じ日は記録の資材の順");
  assert.deepEqual(table.products.map((item) => item.reg_no), ["100", "200", "300"]);
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
  // 作物名をまだ選んでいない品目は、何も言わない（当てはめの正誤は判定しない）
  assert.deepEqual(sprayWarnings({ ...base, dilution: 2000, groups: [group({ row: null })], countsOf: () => none }), []);
});

test("作物名と使い方の選択: 写しから読む、前回の選択を入れる", () => {
  // 品目ごとに選んだ写し（品目の名前で探す）と、区画で選んだ写し（まとまりの名前で探す）
  const perGroup = { rows: [{ crop_name: "リーフレタス", group: "リーフレタス（マルチ）", crop: "非結球レタス", target: "アブラムシ類", method: "散布" }] };
  assert.deepEqual(standardChoice(perGroup, { cropName: "リーフレタス" }), { crop: "非結球レタス", use_key: "アブラムシ類|散布" });
  assert.equal(standardChoice(perGroup, { cropName: "キャベツ" }), null);
  const block = { rows: [{ crop_name: "", group: "区画1", crop: "野菜類", target: "一年生雑草", method: "全面土壌散布" }] };
  assert.deepEqual(standardChoice(block, { groupName: "区画1" }), { crop: "野菜類", use_key: "一年生雑草|全面土壌散布" });
  // 品目ごとに選ぶ前の写し（使い方を一番上に持つ）
  const old = { target: "ネキリムシ類", method: "土壌混和", rows: [{ crop_name: "リーフレタス", crop: "レタス" }] };
  assert.deepEqual(standardChoice(old, { cropName: "リーフレタス" }), { crop: "レタス", use_key: "ネキリムシ類|土壌混和" });
  assert.equal(standardChoice(null, { cropName: "リーフレタス" }), null);
  // 適用病害虫が空の登録（展着剤の「添加」など）は、空のまま選んだものとして読む
  const adjuvant = { rows: [{ crop_name: "大根", group: "大根（マルチ）", crop: "野菜類", target: "", method: "添加" }] };
  assert.deepEqual(standardChoice(adjuvant, { cropName: "大根" }), { crop: "野菜類", use_key: "|添加" });
  // 適用病害虫を写していない写しは、選んでいないものとして読む
  const noTarget = { rows: [{ crop_name: "大根", crop: "野菜類", method: "添加" }] };
  assert.deepEqual(standardChoice(noTarget, { cropName: "大根" }), { crop: "野菜類", use_key: "" });

  // この農薬（100）の使用基準の行
  const rows = [
    { crop: "非結球レタス", target: "アブラムシ類", method: "散布" },
    { crop: "非結球レタス", target: "ヨトウムシ", method: "散布" },
    { crop: "レタス", target: "アブラムシ類", method: "散布" },
    { crop: "野菜類(いちごを除く)", target: "ハダニ類", method: "散布" },
  ];
  const input = (regNo, crop, target) => ({ kind: "pesticide", reg_no: regNo, standard: { rows: [{ crop_name: "リーフレタス", crop, target, method: "散布" }] } });
  const log = (id, date, inputs) => ({ id, date, inputs });
  const where = { regNo: 100, cropName: "リーフレタス" };
  // 1. 同じ農薬の、いちばん新しい記録の選択（ほかの農薬の記録が新しくても）
  const logs = [
    log("a", "2026-09-01", [input(100, "レタス", "アブラムシ類")]),
    log("b", "2026-10-01", [input(100, "非結球レタス", "ヨトウムシ")]),
    log("c", "2026-10-10", [input(200, "野菜類(いちごを除く)", "ハダニ類")]),
  ];
  assert.deepEqual(previousChoice(logs, where, rows), { crop: "非結球レタス", use_key: "ヨトウムシ|散布" });
  // 直している記録の選択は使わない
  assert.deepEqual(previousChoice(logs, { ...where, excludeLogId: "b" }, rows), { crop: "レタス", use_key: "アブラムシ類|散布" });
  // 2. 同じ農薬の記録がなければ、その品目でいちばん新しく選んだ作物名（この農薬にあるときだけ。使い方は 1 つならそれ）
  assert.deepEqual(previousChoice([logs[2]], where, rows), { crop: "野菜類(いちごを除く)", use_key: "ハダニ類|散布" });
  assert.deepEqual(previousChoice([log("d", "2026-10-11", [input(300, "非結球レタス", "ナメクジ類")])], where, rows), { crop: "非結球レタス", use_key: "" });
  // この農薬にない作物名や、ほかの品目の選択は使わない
  assert.equal(previousChoice([log("e", "2026-10-12", [input(300, "だいこん", "アブラムシ類")])], where, rows), null);
  assert.equal(previousChoice(logs, { regNo: 100, cropName: "キャベツ" }, rows), null);
  // 適用病害虫が空の登録も、前回の選択を入れる
  const adjuvantRows = [{ crop: "野菜類", target: "", method: "添加" }];
  const adjuvantLog = log("f", "2026-11-04", [{ kind: "pesticide", reg_no: 400, standard: { rows: [{ crop_name: "リーフレタス", crop: "野菜類", target: "", method: "添加" }] } }]);
  assert.deepEqual(previousChoice([adjuvantLog], { regNo: 400, cropName: "リーフレタス" }, adjuvantRows), { crop: "野菜類", use_key: "|添加" });
});

test("使い方・適用病害虫の選択肢: 適用病害虫が空の登録は、指定なしと書く", () => {
  const input = {
    _uses: {
      rows: [
        { crop: "野菜類", target: "", method: "添加" },
        { crop: "野菜類", target: "アブラムシ類", method: "散布" },
        { crop: "だいこん", target: "アブラムシ類", method: "散布" },
      ],
    },
  };
  assert.deepEqual(useKeys(input, "野菜類"), [
    { key: "アブラムシ類|散布", label: "アブラムシ類／散布", method: "散布" },
    { key: "|添加", label: "添加（適用病害虫の指定なし）", method: "添加" },
  ]);
});

test("面積あたりの使用量（粒剤など）を読み、基準と比べる", () => {
  assert.deepEqual(parseUsage("6kg/10a"), { min: 6, max: 6, unit: "g" }); // 6 kg / 1000 ㎡ = 6 g/㎡
  assert.deepEqual(parseUsage("4～6kg/10a"), { min: 4, max: 6, unit: "g" });
  assert.deepEqual(parseUsage("500mL/10a"), { min: 0.5, max: 0.5, unit: "mL" });
  assert.deepEqual(parseUsage("1~2g/m2"), { min: 1, max: 2, unit: "g" });
  assert.deepEqual(parseUsage("原液として3リットル/10a"), { min: 3, max: 3, unit: "mL" });
  assert.deepEqual(parseUsage("100mL/10a(少量散布)"), { min: 0.1, max: 0.1, unit: "mL" });
  assert.deepEqual(parseUsage("3~6kg/10a(3~6g/株)"), { min: 3, max: 6, unit: "g" });
  for (const text of ["1000倍", "2g/株", "<圃場>1穴当り1mL", "原液", "", null]) {
    assert.equal(parseUsage(text), null, text);
  }
  // リーフレタス 2 畝（36.8 ㎡ ずつ）に 6kg/10a → 441.6 g。912 g は超える
  const row = { dilution_text: "6kg/10a" };
  const groups = [{ area: 36.8, row }, { area: 36.8, row }];
  const range = usageRange(groups);
  assert.deepEqual([range.min.toFixed(1), range.max.toFixed(1), range.unit], ["441.6", "441.6", "g"]);
  assert.deepEqual(usageWarnings({ amount: 912, unit: "g", groups }), ["使用量 912 g は、この面積の基準（441.6 g）を超えます"]);
  assert.deepEqual(usageWarnings({ amount: 0.44, unit: "kg", groups }), []);
  assert.deepEqual(usageWarnings({ amount: 700, unit: "g", groups: [{ area: 100, row: { dilution_text: "4~6kg/10a" } }] }), [
    "使用量 700 g は、この面積の基準（400 g〜600 g）を超えます",
  ]);
  // 少なく使う分には言わない
  assert.deepEqual(usageWarnings({ amount: 100, unit: "g", groups: [{ area: 100, row: { dilution_text: "4~6kg/10a" } }] }), []);
  // 面積あたりでない基準や、g と mL の違いは比べない
  assert.deepEqual(usageWarnings({ amount: 912, unit: "mL", groups }), []);
  assert.equal(usageRange([{ area: 36.8, row }, { area: 10, row: { dilution_text: "1000倍" } }]), null);
  assert.equal(formatAmount(1234, "g"), "1.2 kg");
});

test("初めの希釈倍率は、下限のうちいちばん大きいもの", () => {
  assert.equal(defaultDilution([{ dilution_min: 1000 }, { dilution_min: 2000 }, null]), 2000);
  assert.equal(defaultDilution([{ dilution_min: null }]), null);
});

// 以下は、Mutation testing（stryker.config.json）で、テストが気づかなかった書き換えを確かめる

test("防除の指摘の境目: 基準ちょうどは言わない。超えたら言う", () => {
  const none = { products: new Map(), ingredients: new Map() };
  const base = { date: "2026-03-20", regNo: 100, ingredients: ["成分A", "成分B"], countsOf: () => none };
  const group = (extra) => ({ name: "レタス", area: 100, liters: 0, row: useRow, plantings: [{ id: "p1", harvestStart: "2026-04-10" }], ...extra });
  const about = (word, list) => list.filter((text) => text.includes(word));
  // 希釈倍率。下限（1000 倍）ちょうどは基準の中
  assert.deepEqual(about("希釈倍率", sprayWarnings({ ...base, dilution: 1000, groups: [group()] })), []);
  assert.deepEqual(about("希釈倍率", sprayWarnings({ ...base, dilution: 999, groups: [group()] })), ["レタス: 希釈倍率 999 倍は、基準（1000 倍以上）より濃くなります"]);
  // 希釈倍率を入れていない、または、基準に希釈倍率がない（粒剤など）ときは比べない
  assert.deepEqual(about("希釈倍率", sprayWarnings({ ...base, dilution: null, groups: [group()] })), []);
  assert.deepEqual(about("希釈倍率", sprayWarnings({ ...base, dilution: 0, groups: [group()] })), []);
  assert.deepEqual(about("希釈倍率", sprayWarnings({ ...base, dilution: 500, groups: [group({ row: { ...useRow, dilution_min: null } })] })), []);
  // 散布液量。100 ㎡ に 10 L は 10 a あたり 100 L（下限ちょうど）、30 L は 300 L（上限ちょうど）
  const liquid = (extra) => about("散布液量", sprayWarnings({ ...base, dilution: 2000, groups: [group(extra)] }));
  assert.deepEqual(liquid({ liters: 10 }), []);
  assert.deepEqual(liquid({ liters: 30 }), []);
  assert.deepEqual(liquid({ liters: 31 }), ["レタス: 散布液量が 10 a あたり 310 L で、基準（100〜300 L）の外です"]);
  assert.deepEqual(liquid({ liters: 9.9 }), ["レタス: 散布液量が 10 a あたり 99 L で、基準（100〜300 L）の外です"]);
  // 面積がない、散布液量の基準がない（粒剤など）ときは比べない
  assert.deepEqual(liquid({ liters: 5, area: 0 }), []);
  assert.deepEqual(liquid({ liters: 5, row: { ...useRow, liquid_min: null, liquid_max: null } }), []);
  // 使用時期。収穫の開始まで 7 日（収穫 7 日前まで）ちょうどは満たす
  const harvest = (start) => about("使用時期", sprayWarnings({ ...base, dilution: 2000, groups: [group({ plantings: [{ id: "p1", harvestStart: start }] })] }));
  assert.deepEqual(harvest("2026-03-27"), []);
  assert.deepEqual(harvest("2026-03-26"), ["レタス: 収穫の開始（03/26）まで 6 日で、使用時期（収穫 7 日前まで）を満たしません"]);
  assert.deepEqual(harvest(null), []);
});

test("防除の指摘: まとまりに作付が 2 つ以上あれば、回数はいちばん多い作付、収穫はいちばん早い作付で言う", () => {
  const counts = {
    p1: { products: new Map([["100", 1]]), ingredients: new Map([["成分A", 1]]) },
    p2: { products: new Map([["100", 3]]), ingredients: new Map([["成分A", 3], ["成分B", 2]]) },
    p3: { products: new Map(), ingredients: new Map() },
  };
  const plantings = [
    { id: "p3", harvestStart: null },
    { id: "p2", harvestStart: "2026-04-10" },
    { id: "p1", harvestStart: "2026-03-24" },
  ];
  const warnings = sprayWarnings({
    date: "2026-03-20",
    dilution: 2000,
    regNo: 100,
    ingredients: ["成分A", "成分B"],
    groups: [{ name: "レタス", area: 100, liters: 0, row: useRow, plantings }],
    countsOf: (id) => counts[id],
  });
  assert.ok(warnings.includes("レタス: 本剤の使用回数が、この防除で 4 回になり、上限（3 回）を超えます"));
  assert.ok(warnings.includes("レタス: 成分A を含む農薬の使用回数が、この防除で 4 回になり、上限（3 回）を超えます"));
  assert.ok(warnings.includes("レタス: 成分B を含む農薬の使用回数が、この防除で 3 回になり、上限（2 回）を超えます"));
  assert.ok(warnings.includes("レタス: 収穫の開始（03/24）まで 4 日で、使用時期（収穫 7 日前まで）を満たしません"));
});

test("この防除が何回目か: 作付ごとの回数のうち、いちばん多いものに 1 を足す。作付がなければ 1 回目", () => {
  const counts = {
    p1: { products: new Map([["100", 1]]), ingredients: new Map([["成分A", 1]]) },
    p2: { products: new Map([["100", 3]]), ingredients: new Map([["成分A", 3], ["成分B", 2]]) },
  };
  const countsOf = (id) => counts[id];
  assert.deepEqual(sprayCounts({ regNo: 100, ingredients: ["成分A", "", "成分B"], plantingIds: ["p1", "p2"], countsOf }), { product: 4, ingredients: [4, null, 3] });
  assert.deepEqual(sprayCounts({ regNo: "100", ingredients: ["成分A"], plantingIds: ["p1"], countsOf }), { product: 2, ingredients: [2] });
  assert.deepEqual(sprayCounts({ regNo: 200, ingredients: ["成分C"], plantingIds: ["p2"], countsOf }), { product: 1, ingredients: [1] });
  assert.deepEqual(sprayCounts({ regNo: 100, ingredients: ["成分A", ""], plantingIds: [], countsOf }), { product: 1, ingredients: [1, null] });
  assert.deepEqual(sprayCounts({ regNo: 100, plantingIds: ["p1"], countsOf }), { product: 2, ingredients: [] });
  // 作付のないまとまりは 1 回目なので、回数の上限は超えない。総使用回数の条件は知らせる
  assert.deepEqual(
    sprayWarnings({ date: "2026-03-20", dilution: 2000, regNo: 100, ingredients: ["成分A", "成分B"], groups: [{ name: "区画1", area: 100, liters: 0, row: useRow, plantings: [] }], countsOf }),
    ["区画1: 成分B の総使用回数には条件があります。確かめてください: 2回以内(定植後は1回以内)"]
  );
});

test("まとまりの面積の基準の量: 散布液量の基準があれば基準散布量（L）、なければ面積あたりの使用量", () => {
  assert.deepEqual(areaStandard(useRow, 100), { kind: "liquid", min: 10, max: 30, unit: "L" });
  assert.deepEqual(areaStandard({ ...useRow, liquid_min: 0, liquid_max: 50 }, 100), { kind: "liquid", min: 0, max: 5, unit: "L" });
  assert.deepEqual(areaStandard({ dilution_text: "4~6kg/10a", liquid_min: null }, 50), { kind: "usage", min: 200, max: 300, unit: "g" });
  assert.deepEqual(areaStandard({ dilution_text: "500mL/10a" }, 100), { kind: "usage", min: 50, max: 50, unit: "mL" });
  assert.equal(areaStandard({ dilution_text: "1000倍", liquid_min: null }, 100), null);
  assert.equal(areaStandard(useRow, 0), null);
  assert.equal(areaStandard(null, 100), null);
});

// 以下は、農薬の計算の関数（`// mutator-critical`）で、テストが気づかなかった書き換えを確かめる

test("農薬の使用回数の表: 写しにその作物の行がない記録、上限の欄がない古い写し、行も成分もない写しも読む", () => {
  const input = (standard, extra = {}) => ({ kind: "pesticide", reg_no: "100", name: "剤100", standard, ...extra });
  // 写しに、レタスの行がない（ほかの品目で選んだ）。上限はわからない
  const other = usageTable([spray("s1", "2026-03-01", ["p1"], [input({ product: "剤100", ingredients: ["成分A", "成分B"], rows: [{ ...useRow, crop_name: "キャベツ" }] })])], "p1", "レタス");
  assert.deepEqual(other.products, [{ reg_no: "100", count: 1, name: "剤100", max: null, ingredients: ["成分A", "成分B"] }]);
  assert.deepEqual(other.ingredients, [
    { name: "成分A", count: 1, max: null, condition: "" },
    { name: "成分B", count: 1, max: null, condition: "" },
  ]);
  // 有効成分ごとの上限と条件の欄がない、古い写し
  const old = usageTable([spray("s1", "2026-03-01", ["p1"], [input({ product: "剤100", ingredients: ["成分A"], rows: [{ crop_name: "レタス", crop: "レタス", times_max: 2 }] })])], "p1", "レタス");
  assert.deepEqual(old.products[0].max, 2);
  assert.deepEqual(old.ingredients, [{ name: "成分A", count: 1, max: null, condition: "" }]);
  // 行のない写し、有効成分のない写し
  assert.equal(usageTable([spray("s1", "2026-03-01", ["p1"], [input({ product: "剤100", ingredients: ["成分A"] })])], "p1", "レタス").products[0].max, null);
  const bare = usageTable([spray("s1", "2026-03-01", ["p1"], [input({ product: "剤100", rows: [useRow] })])], "p1", "レタス");
  assert.deepEqual(bare.products, [{ reg_no: "100", count: 1, name: "剤100", max: 3, ingredients: [] }]);
  assert.deepEqual(bare.ingredients, []);
  assert.deepEqual([...pesticideCounts([spray("s1", "2026-03-01", ["p1"], [input({ product: "剤100", rows: [useRow] })])], "p1").ingredients.entries()], []);
});

test("農薬の使用回数の表: 上限は、いちばん新しい写しの、その作物の行。肥料と、登録番号のない農薬の写しは使わない", () => {
  const input = (rows, extra = {}) => ({ kind: "pesticide", reg_no: "100", name: "剤100", standard: { product: "剤100", ingredients: ["成分A"], rows }, ...extra });
  const logs = [
    spray("s1", "2026-03-01", ["p1"], [input([useRow])]),
    // 新しい写しには、キャベツの行が先にある
    spray("s2", "2026-03-05", ["p1"], [input([{ ...useRow, crop_name: "キャベツ", times_max: 1, total_max: [1] }, { ...useRow, times_max: 5, total_max: [4] }])]),
  ];
  const table = usageTable(logs, "p1", "レタス");
  assert.equal(table.products[0].max, 5);
  assert.equal(table.ingredients[0].max, 4);
  // さらに新しい記録の、肥料と、登録番号のない農薬（名前を手で入れた）の写しは、上限に使わない
  const noisy = [
    ...logs,
    spray("s3", "2026-03-09", ["p1"], [
      input([{ ...useRow, times_max: 9, total_max: [9] }], { kind: "fertilizer", name: "肥料" }),
      input([{ ...useRow, times_max: 9, total_max: [9] }], { reg_no: null, name: "手で入れた農薬" }),
    ]),
  ];
  const kept = usageTable(noisy, "p1", "レタス");
  assert.deepEqual(kept.products.map((item) => [item.reg_no, item.count, item.max]), [["100", 2, 5]]);
  assert.deepEqual(kept.ingredients.map((item) => [item.name, item.count, item.max]), [["成分A", 2, 4]]);
});

test("収穫してよい最初の日: 写しのない記録、行のない写し、その作物の行のない写しは使わない", () => {
  const logs = [
    spray("a", "2026-03-10", ["p1"], [{ kind: "pesticide", reg_no: "700", name: "手で入れた農薬" }]),
    spray("b", "2026-03-11", ["p1"], [{ kind: "pesticide", reg_no: "701", standard: { product: "剤701" } }]),
    spray("c", "2026-03-12", ["p1"], [{ kind: "pesticide", reg_no: "702", standard: { rows: [{ ...useRow, crop_name: "キャベツ" }] } }]),
  ];
  assert.equal(firstHarvestDay(logs, "p1", "レタス"), null);
  assert.equal(firstHarvestDay([...logs, spray("d", "2026-03-01", ["p1"], [pesticide(100, ["成分A", ""])])], "p1", "レタス"), "2026-03-08");
});

test("防除の指摘: 収穫のいちばん早い作付は、並びの途中にあっても選ぶ。数えない成分と、成分を渡さないときは、条件を言わない", () => {
  const none = { products: new Map(), ingredients: new Map() };
  const base = { date: "2026-03-20", dilution: 2000, regNo: 100, countsOf: () => none };
  const group = (extra) => ({ name: "レタス", area: 100, liters: 0, row: useRow, plantings: [{ id: "p1", harvestStart: null }], ...extra });
  const plantings = [
    { id: "p1", harvestStart: "2026-03-24" },
    { id: "p2", harvestStart: "2026-04-10" },
    { id: "p3", harvestStart: null },
  ];
  assert.ok(sprayWarnings({ ...base, ingredients: ["成分A"], groups: [group({ plantings })] }).includes("レタス: 収穫の開始（03/24）まで 4 日で、使用時期（収穫 7 日前まで）を満たしません"));
  // 1 番目の成分は数えない（空）。その位置の条件は言わない
  const row = { ...useRow, totals: ["1回(定植前)", "2回以内(定植後は1回以内)"] };
  assert.deepEqual(sprayWarnings({ ...base, ingredients: ["", "成分B"], groups: [group({ row })] }), [
    "レタス: 成分B の総使用回数には条件があります。確かめてください: 2回以内(定植後は1回以内)",
  ]);
  assert.deepEqual(sprayWarnings({ ...base, groups: [group({ row })] }), []);
});

test("面積あたりの使用量の読み方: 2 桁の上限、空白、小数の面積。まとまりがなければ基準はない", () => {
  assert.deepEqual(parseUsage("4~12kg/10a"), { min: 4, max: 12, unit: "g" });
  assert.deepEqual(parseUsage("6 kg/10a"), { min: 6, max: 6, unit: "g" });
  assert.deepEqual(parseUsage("5g/1.25m2"), { min: 4, max: 4, unit: "g" });
  assert.equal(usageRange([]), null);
});

test("前回の選択: 区画で選んだ記録、同じ日の記録の入れた順、肥料の写し、登録から消えた使い方", () => {
  const rows = [
    { crop: "野菜類", target: "一年生雑草", method: "全面土壌散布" },
    { crop: "レタス", target: "アブラムシ類", method: "散布" },
    { crop: "非結球レタス", target: "アブラムシ類", method: "散布" },
    { crop: "非結球レタス", target: "ヨトウムシ", method: "散布" },
  ];
  // 区画で選んだ記録は、区画の名前で探す
  const block = { id: "k", date: "2026-10-01", inputs: [{ kind: "pesticide", reg_no: 100, standard: { rows: [{ crop_name: "", group: "区画1", crop: "野菜類", target: "一年生雑草", method: "全面土壌散布" }] } }] };
  assert.deepEqual(previousChoice([block], { regNo: 100, groupName: "区画1" }, rows), { crop: "野菜類", use_key: "一年生雑草|全面土壌散布" });
  const input = (crop, target, extra = {}) => ({ kind: "pesticide", reg_no: 100, standard: { rows: [{ crop_name: "リーフレタス", crop, target, method: "散布" }] }, ...extra });
  const where = { regNo: 100, cropName: "リーフレタス" };
  // 同じ日の記録は、後に入れたほう。届く順によらない
  const early = { id: "a", date: "2026-10-01", created_at: "2026-10-01T08:00:00Z", inputs: [input("レタス", "アブラムシ類")] };
  const late = { id: "b", date: "2026-10-01", created_at: "2026-10-01T09:00:00Z", inputs: [input("非結球レタス", "ヨトウムシ")] };
  assert.deepEqual(previousChoice([early, late], where, rows), { crop: "非結球レタス", use_key: "ヨトウムシ|散布" });
  assert.deepEqual(previousChoice([late, early], where, rows), { crop: "非結球レタス", use_key: "ヨトウムシ|散布" });
  // 新しい記録の肥料の写しは使わない
  const fertilizer = { id: "f", date: "2026-10-05", inputs: [input("非結球レタス", "ヨトウムシ", { kind: "fertilizer" })] };
  assert.deepEqual(previousChoice([fertilizer, early], where, rows), { crop: "レタス", use_key: "アブラムシ類|散布" });
  // 前回の使い方が、いまの登録にない
  assert.deepEqual(previousChoice([{ id: "g", date: "2026-10-01", inputs: [input("レタス", "ハダニ類")] }], where, rows), { crop: "レタス", use_key: "" });
});

test("農薬の使用回数に、肥料と、登録番号のない農薬（名前を手で入れた）は数えない", () => {
  const logs = [
    spray("s1", "2026-03-01", ["p1"], [
      { kind: "fertilizer", reg_no: "F1", name: "肥料", standard: { ingredients: ["成分A"] } },
      { kind: "pesticide", reg_no: null, name: "手で入れた農薬", standard: { ingredients: ["成分B"] } },
    ]),
    { id: "s2", date: "2026-03-02" },
    spray("s3", "2026-03-03", ["p1"], [{ kind: "pesticide", reg_no: "100", name: "剤100" }]),
  ];
  const counts = pesticideCounts(logs, "p1");
  assert.deepEqual([...counts.products.entries()], [["100", 1]]);
  assert.deepEqual([...counts.ingredients.entries()], []);
});

test("収穫してよい最初の日: その作物の行の使用時期で、いちばん遅い日。ほかの作物の行や肥料は使わない", () => {
  // 記録は新しい順に届く。3/15 + 7 日 と 3/1 + 7 日のうち、遅いほう
  const newer = spray("n", "2026-03-15", ["p1"], [pesticide(100, ["成分A", ""])]);
  const older = spray("o", "2026-03-01", ["p1"], [pesticide(100, ["成分A", ""])]);
  assert.equal(firstHarvestDay([newer, older], "p1", "レタス"), "2026-03-22");
  // 写しに、ほかの作物の行が先にあっても、レタスの行（14 日前まで）を使う
  const rows = [{ ...useRow, crop_name: "キャベツ", preharvest_days: 30 }, { ...useRow, preharvest_days: 14 }];
  const other = spray("c", "2026-03-10", ["p1"], [{ kind: "pesticide", reg_no: "500", standard: { rows } }]);
  assert.equal(firstHarvestDay([other], "p1", "レタス"), "2026-03-24");
  // 対象の作付が 2 つ以上ある記録も数える
  assert.equal(firstHarvestDay([spray("m", "2026-03-20", ["p2", "p1"], [pesticide(100, ["成分A", ""])])], "p1", "レタス"), "2026-03-27");
  // 肥料と、使用時期の決まりのない行は使わない
  const skipped = spray("f", "2026-03-30", ["p1"], [
    { kind: "fertilizer", standard: { rows: [useRow] } },
    { kind: "pesticide", reg_no: "600", standard: { rows: [{ ...useRow, preharvest_days: null }] } },
  ]);
  assert.equal(firstHarvestDay([older, skipped], "p1", "レタス"), "2026-03-08");
});

test("農薬の使用回数の表: その作付の記録だけを、その作物の行で読む。上限と条件は新しい記録の写し", () => {
  const input = (regNo, name, standard) => ({ kind: "pesticide", reg_no: regNo, name, standard });
  const cabbage = { ...useRow, crop_name: "キャベツ", times_max: 1, total_max: [1, 1], totals: ["1回以内", "1回以内(定植時)"] };
  const logs = [
    // ほかの作付の、もっと新しい記録（上限も名前も違う）
    spray("x", "2026-04-01", ["p9"], [input("100", "他", { product: "他の名", ingredients: ["成分A", "成分B"], rows: [{ ...useRow, times_max: 9, total_max: [9, 9] }] })]),
    // 写しに、キャベツの行が先にある
    spray("s1", "2026-03-01", ["p1"], [input("100", "剤100", { product: "剤100", ingredients: ["成分A", "成分B"], rows: [cabbage, useRow] })]),
    // 新しい記録の写しには、成分B の条件がない
    spray("s2", "2026-03-05", ["p1"], [input("100", "剤100", { product: "剤100", ingredients: ["成分A", "成分B"], rows: [{ ...useRow, totals: ["3回以内", "2回以内"] }] })]),
    // 写しのない、もっと新しい記録（名前を手で入れ直した）は、上限を消さない
    spray("s3", "2026-03-09", ["p1"], [input("100", "剤100（手入力）", null)]),
  ];
  const table = usageTable(logs, "p1", "レタス");
  assert.deepEqual(table.products, [{ reg_no: "100", count: 3, name: "剤100", max: 3, ingredients: ["成分A", "成分B"] }]);
  assert.deepEqual(table.ingredients, [
    { name: "成分A", count: 2, max: 3, condition: "" },
    { name: "成分B", count: 2, max: 2, condition: "" },
  ]);
  // 写しに製品名がなければ、記録に入れた名前
  const unnamed = usageTable([spray("s4", "2026-03-01", ["p1"], [input("200", "記録の名前", { ingredients: ["成分C"], rows: [useRow] })])], "p1", "レタス");
  assert.equal(unnamed.products[0].name, "記録の名前");
});

test("量の単位をそろえる、読みやすく書く、面積あたりの使用量を読む", () => {
  assert.deepEqual(toBaseAmount(2, "kg"), { value: 2000, unit: "g" });
  assert.deepEqual(toBaseAmount("0.5", "L"), { value: 500, unit: "mL" });
  for (const amount of [null, undefined, "", "abc"]) {
    assert.equal(toBaseAmount(amount, "g"), null, String(amount));
  }
  assert.equal(toBaseAmount(3, "個"), null);
  assert.equal(formatAmount(1500, "mL"), "1.5 L");
  assert.equal(formatAmount(999, "mL"), "999 mL");
  assert.deepEqual(parseUsage("500ml/10a"), { min: 0.5, max: 0.5, unit: "mL" });
  assert.deepEqual(parseUsage("1.25~2.75kg/10a"), { min: 1.25, max: 2.75, unit: "g" });
  assert.deepEqual(parseUsage("0.25kg/a"), { min: 2.5, max: 2.5, unit: "g" });
  assert.equal(parseUsage("約6kg/10a"), null);
  assert.equal(parseUsage("6kg/10a当たり"), null);
  // g と mL のまとまりが混ざれば、合計しない。基準を出せなければ、量を比べない
  const mixed = [{ area: 10, row: { dilution_text: "6kg/10a" } }, { area: 10, row: { dilution_text: "500mL/10a" } }];
  assert.equal(usageRange(mixed), null);
  assert.deepEqual(usageWarnings({ amount: 10, unit: "g", groups: mixed }), []);
  assert.deepEqual(usageWarnings({ amount: "", unit: "g", groups: [{ area: 100, row: { dilution_text: "6kg/10a" } }] }), []);
});

test("作物名と使い方の選択: 区画の名前で探す。同じ日の記録は後に入れたほう。品目の選択は、いちばん新しい記録のもの", () => {
  const block = {
    rows: [
      { crop_name: "", group: "区画2", crop: "果樹類", target: "一年生雑草", method: "全面土壌散布" },
      { crop_name: "", group: "区画1", crop: "野菜類", target: "一年生雑草", method: "全面土壌散布" },
    ],
  };
  assert.deepEqual(standardChoice(block, { groupName: "区画1" }), { crop: "野菜類", use_key: "一年生雑草|全面土壌散布" });

  const rows = [
    { crop: "非結球レタス", target: "アブラムシ類", method: "散布" },
    { crop: "非結球レタス", target: "ヨトウムシ", method: "散布" },
    { crop: "レタス", target: "アブラムシ類", method: "散布" },
  ];
  const input = (regNo, crop, target) => ({ kind: "pesticide", reg_no: regNo, standard: { rows: [{ crop_name: "リーフレタス", crop, target, method: "散布" }] } });
  const where = { regNo: 100, cropName: "リーフレタス" };
  // 同じ日の記録は、後に入れた（created_at の新しい）ほう
  const sameDay = [
    { id: "a", date: "2026-10-01", created_at: "2026-10-01T08:00:00Z", inputs: [input(100, "レタス", "アブラムシ類")] },
    { id: "b", date: "2026-10-01", created_at: "2026-10-01T09:00:00Z", inputs: [input(100, "非結球レタス", "ヨトウムシ")] },
  ];
  assert.deepEqual(previousChoice(sameDay, where, rows), { crop: "非結球レタス", use_key: "ヨトウムシ|散布" });
  // ほかの農薬の記録から選ぶときも、いちばん新しい記録の作物名
  const others = [
    { id: "c", date: "2026-10-10", inputs: [input(300, "レタス", "アブラムシ類")] },
    { id: "d", date: "2026-10-01", inputs: [input(300, "非結球レタス", "アブラムシ類")] },
  ];
  assert.deepEqual(previousChoice(others, where, rows), { crop: "レタス", use_key: "アブラムシ類|散布" });
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

test("資材の文: 1 穴あたりの量で決めたものは、1 穴の量も書く", () => {
  assert.equal(inputText({ kind: "fertilizer", name: "化成肥料", amount: 2468, unit: "g", per_hole: 2 }), "化成肥料 2468 g（1 穴 2 g）");
  // 量が kg なら 1 穴は g、L なら mL
  assert.equal(inputText({ kind: "fertilizer", name: "化成肥料", amount: 2.468, unit: "kg", per_hole: 2 }), "化成肥料 2.468 kg（1 穴 2 g）");
  assert.equal(inputText({ kind: "fertilizer", name: "液肥", amount: 1.5, unit: "L", per_hole: 5 }), "液肥 1.5 L（1 穴 5 mL）");
  assert.equal(inputText({ kind: "fertilizer", name: "化成肥料", amount: 20, unit: "kg", per_hole: null }), "化成肥料 20 kg");
  assert.equal(inputText({ kind: "fertilizer", name: "化成肥料", amount: 20, unit: "kg" }), "化成肥料 20 kg");
  // DB の数は文字で届くことがある
  assert.equal(inputText({ kind: "pesticide", name: "試験粒剤", method: "植穴処理", amount: 2468, unit: "g", per_hole: "2.0" }), "試験粒剤 植穴処理 1 穴 2 g");
});

test("株の手入れの仕様の文に、株数の変動（符号つき）と理由を入れる", () => {
  assert.equal(specText("care", { items: ["抜き取り"], plant_change: -3, change_reason: "青枯病" }), "株数の変動 −3・変動の理由 青枯病");
  assert.equal(specText("care", { items: ["補植"], plant_change: 2 }), "株数の変動 +2");
  // DB の数は文字で届くことがある
  assert.equal(specText("care", { items: ["補植"], plant_change: "-1" }), "株数の変動 −1");
  assert.equal(specText("care", { plant_change: 0 }), "株数の変動 0");
  // 理由は文字の欄、変動は正負の整数の欄（画面の欄の種類と、保存するときの扱いが決まる）
  assert.deepEqual(
    SPEC_FIELDS.care.map(([key, , kind]) => [key, kind]),
    [["thin_gap_cm", undefined], ["plant_change", "signed"], ["change_reason", "text"]]
  );
});

test("仕様の文: 空・null・入れていないチェックは出さず、チェックは見出しだけを出す", () => {
  assert.equal(specText("plant", { plant_gap_cm: null, row_gap_cm: "", row_count: 3, staggered: false }), "条数 3");
  assert.equal(specText("plant", { row_count: 2, staggered: true }), "条数 2・千鳥");
  assert.equal(specText("care", { items: ["間引き"], thin_gap_cm: 30 }), "間引きで残した株間 30cm");
});

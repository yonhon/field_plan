// 苗数と施肥量の計算（app/crops.js）と、品目ごとの日数（app/schedule.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { cropLabel, plantingNumbers, summarize } from "../app/crops.js";
import { DEFAULT_WORK_TYPES as types, TEMPLATES, planProblems, scheduleForward, typesForCrop } from "../app/schedule.js";

const near = (actual, expected, digits = 6) => assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} != ${expected}`);
// 幅（cm）と長さ（m）の畝
const bed = (widthCm, length) => [[0, 0], [length, 0], [length, widthCm / 100], [0, widthCm / 100]];
const compound = { id: "f1", name: "化成 15", n_pct: 15 };
const coated = { id: "f2", name: "被覆 18", n_pct: 18 };

test("苗数 = 切り捨て（畝長 ÷ 株間）× 条数", () => {
  const numbers = plantingNumbers(bed(70, 24), { plant_gap_cm: 15, row_count: 3 }, null);
  assert.equal(numbers.seedlings, 480);
  near(numbers.area, 16.8);
  near(numbers.length, 24);
  near(numbers.width, 0.7);
  // 1 条に入る株の数を切り捨ててから、条数を掛ける: 25 ÷ 0.3 = 83.33 → 83 株 × 2 条
  assert.equal(plantingNumbers(bed(70, 25), { plant_gap_cm: 30, row_count: 2 }, null).seedlings, 166);
  // 掛けてから切り捨てるのとは違う: 23 ÷ 0.15 = 153.33 → 153 株 × 3 条 = 459（460 ではない）
  assert.equal(plantingNumbers(bed(70, 23), { plant_gap_cm: 15, row_count: 3 }, null).seedlings, 459);
  // 割り切れるものは、計算の誤差で 1 少なくならない
  for (const [length, gap, rows, expected] of [[24, 15, 3, 480], [23, 20, 2, 230], [1.3, 10, 1, 13], [1.1, 10, 4, 44]]) {
    assert.equal(plantingNumbers(bed(70, length), { plant_gap_cm: gap, row_count: rows }, null).seedlings, expected);
  }
});

test("窒素量と肥料の量", () => {
  // 16.8 ㎡ × 12 kg ÷ 1,000 ㎡ = 0.2016 kg。窒素 15% の肥料なら 1.344 kg
  const numbers = plantingNumbers(bed(70, 24), { n_kg_per_10a: 12 }, compound);
  near(numbers.nitrogenKg, 0.2016);
  near(numbers.fertilizerKg, 1.344);
  // 肥料を決めていなければ、窒素量だけ
  assert.equal(plantingNumbers(bed(70, 24), { n_kg_per_10a: 12 }, null).fertilizerKg, null);
});

test("設定値が空の項目は計算しない。品目がなければ寸法だけ", () => {
  const empty = plantingNumbers(bed(100, 20), { name: "名前だけ" }, null);
  assert.deepEqual([empty.seedlings, empty.nitrogenKg, empty.fertilizerKg], [null, null, null]);
  near(plantingNumbers(bed(100, 20), null, null).area, 20);
});

test("実際の畝幅と、品目の畝幅の差", () => {
  assert.equal(plantingNumbers(bed(70, 20), { bed_width_cm: 70 }, null).widthGapCm, 0);
  assert.equal(plantingNumbers(bed(70, 20), { bed_width_cm: 100 }, null).widthGapCm, -30);
  assert.equal(plantingNumbers(bed(90, 20), { bed_width_cm: 70 }, null).widthGapCm, 20);
});

test("プラン全体の集計", () => {
  const leek = { id: "c1", name: "葉ネギ", variety: "", plant_gap_cm: 15, row_count: 3, n_kg_per_10a: 12, fertilizer_id: "f1" };
  const lettuce = { id: "c2", name: "レタス", variety: "赤", plant_gap_cm: 30, row_count: 3, n_kg_per_10a: 15, fertilizer_id: "f2" };
  const beds = [1, 2, 3].map((n) => ({ id: `b${n}`, shape: bed(n === 3 ? 100 : 70, 24) }));
  const plantings = [
    { id: "p1", bed_id: "b1", crop_id: "c1", crop_name: "葉ネギ" },
    { id: "p2", bed_id: "b2", crop_id: "c1", crop_name: "葉ネギ" },
    { id: "p3", bed_id: "b3", crop_id: "c2", crop_name: "レタス" },
    { id: "p4", bed_id: "b3", crop_id: null, crop_name: "未登録の品目" },
  ];
  const summary = summarize({ beds, plantings, crops: [leek, lettuce], fertilizers: [compound, coated] });
  const rows = Object.fromEntries(summary.crops.map((row) => [row.name, row]));
  assert.equal(cropLabel(lettuce), "レタス（赤）");
  assert.equal(rows["葉ネギ"].count, 2);
  assert.equal(rows["葉ネギ"].seedlings, 960);
  assert.deepEqual(TEMPLATES.bed.bare.codes, ["ridge", "plant", "harvest", "residue"]);
  near(rows["葉ネギ"].fertilizerKg, 2.688);
  assert.equal(rows["レタス（赤）"].seedlings, 240);
  near(rows["レタス（赤）"].fertilizerKg, (24 * 15) / 1000 / 0.18);
  assert.equal(rows["未登録の品目"].registered, false);
  assert.equal(rows["未登録の品目"].seedlings, 0);
  assert.deepEqual(summary.fertilizers.map((row) => row.name), ["化成 15", "被覆 18"]);
});

test("品目の日数で、収穫までの間隔と収穫の日数が決まる", () => {
  const carrot = { id: "c1", grow_days: 120, harvest_days: 14 };
  const works = TEMPLATES.bed.bare.codes.map((code, i) => ({ id: `w${i}`, planting_id: "p1", block_id: null, work_type: code, seq: i + 1, plan_start: null, plan_end: null }));
  const local = typesForCrop(types, carrot, works);
  // 定植・播種は 3 日。開始から 120 日後に収穫を始めるので、終わってから 117 日あける
  assert.equal(local.find((type) => type.code === "plant").min_gap_days, 117);
  assert.equal(local.find((type) => type.code === "harvest").default_days, 14);
  const dated = scheduleForward(works, local, "2027-08-01");
  const found = Object.fromEntries(dated.map((work) => [work.work_type, work]));
  assert.equal(found.plant.plan_start, "2027-08-03");
  assert.equal(found.harvest.plan_start, "2027-12-01"); // 8/3 の 120 日後
  assert.equal(found.harvest.plan_end, "2027-12-14");
  // ほかの品目や、品目のない作付には効かない
  assert.equal(typesForCrop(types, null).find((type) => type.code === "plant").min_gap_days, 0);
  assert.equal(typesForCrop(types, { grow_days: null }).find((type) => type.code === "plant").min_gap_days, 0);

  // 警告も品目ごとに見る: 収穫を早めると、この品目の作付だけが指摘される
  const plan = {
    blocks: [{ id: "b1", start_date: null, end_date: null }],
    beds: [{ id: "bed1", block_id: "b1", seq: 1, start_date: null, removed_on: null, shape: bed(70, 20) }],
    plantings: [{ id: "p1", bed_id: "bed1", seq: 1, crop_id: "c1", crop_name: "ニンジン" }],
    works: dated,
    workTypes: types,
    crops: [carrot],
  };
  assert.deepEqual(planProblems(plan), []);
  found.harvest.plan_start = "2027-11-01";
  assert.match(planProblems(plan)[0].message, /定植・播種のあとは 117 日あけるのが目安です/);
  assert.deepEqual(planProblems({ ...plan, crops: [] }), []);
});

test("畝幅が品目の設定と違うと指摘する", () => {
  const plan = {
    blocks: [{ id: "b1", start_date: null, end_date: null }],
    beds: [{ id: "bed1", block_id: "b1", seq: 1, start_date: null, removed_on: null, shape: bed(70, 20) }],
    plantings: [{ id: "p1", bed_id: "bed1", seq: 1, crop_id: "c1", crop_name: "タマネギ" }],
    works: [],
    workTypes: types,
    crops: [{ id: "c1", bed_width_cm: 100 }],
  };
  assert.match(planProblems(plan)[0].message, /畝幅が、品目の設定（100 cm）と違います（いま 70 cm）/);
  plan.crops[0].bed_width_cm = 70;
  assert.deepEqual(planProblems(plan), []);
});

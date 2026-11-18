// 日程の計算（app/schedule.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WORK_TYPES as types,
  MANAGEMENT_TYPES,
  dayWidth,
  ganttWindow,
  isManagement,
  workName,
  TEMPLATES,
  addDays,
  diffDays,
  dueWorks,
  isPlannable,
  typesForCrop,
  existsOn,
  harvestEnd,
  planProblems,
  scheduleAnchored,
  scheduleBefore,
  scheduleForward,
  sequenceProblems,
  workDays,
  worksRange,
} from "../app/schedule.js";

let nextId = 0;
const worksOf = (codes, owner = {}) =>
  codes.map((code, i) => ({ id: `w${(nextId += 1)}`, block_id: null, planting_id: null, ...owner, work_type: code, seq: i + 1, plan_start: null, plan_end: null }));
const byType = (works) => Object.fromEntries(works.map((work) => [work.work_type, work]));

test("日付の足し算と差", () => {
  assert.equal(addDays("2027-06-30", 1), "2027-07-01");
  assert.equal(addDays("2028-03-01", -1), "2028-02-29");
  assert.equal(diffDays("2027-04-01", "2027-07-10"), 100);
  assert.equal(workDays({ plan_start: "2027-07-10", plan_end: "2027-07-12" }), 3);
});

test("区画の作業を、畝立ての日から逆算する", () => {
  const works = scheduleBefore(worksOf(TEMPLATES.block.green.codes), types, "2027-07-06");
  const found = byType(works);
  // すき込みのあと 21 日あけて畝立て、緑肥の播種のあと 50 日あけて伐採
  assert.equal(diffDays(found.incorporate.plan_end, "2027-07-06") - 1, 21);
  assert.equal(diffDays(found.green_sow.plan_end, found.mow.plan_start) - 1, 50);
  assert.deepEqual(sequenceProblems(works, types), []);
});

test("区画のひな形ごとに、畝立ての日から逆算した最初の作業の日", () => {
  assert.deepEqual(Object.keys(TEMPLATES.block), ["green", "both", "plain"]);
  const firstDay = (key) => scheduleBefore(worksOf(TEMPLATES.block[key].codes), types, "2027-07-06")[0].plan_start;
  assert.ok(firstDay("green") >= "2027-04-01");
  assert.equal(firstDay("both"), "2027-03-20");
  // 緑肥も太陽熱消毒もしなければ、4 日で終わる
  assert.equal(firstDay("plain"), "2027-07-02");
});

test("定植・播種の日を決めて、前は逆算、後ろは順に並べる", () => {
  const source = worksOf(TEMPLATES.bed.mulch.codes);
  const works = scheduleAnchored(source, types, 2, "2027-07-10");
  assert.deepEqual(
    works.map((work) => `${work.work_type} ${work.plan_start} ${work.plan_end}`),
    [
      "ridge 2027-07-06 2027-07-07",
      "mulch 2027-07-08 2027-07-09",
      "plant 2027-07-10 2027-07-12",
      "harvest 2027-07-13 2027-08-11",
      "residue 2027-08-12 2027-08-12",
    ]
  );
  assert.deepEqual(sequenceProblems(works, types), []);
});

test("入れてある日数は、並べ直しても保つ", () => {
  const works = worksOf(["solar", "rotary"]);
  Object.assign(works[0], { plan_start: "2027-05-01", plan_end: "2027-05-21" }); // 21 日に縮めた
  const result = scheduleBefore(works, types, "2027-07-06");
  assert.equal(workDays(result[0]), 21);
  assert.match(sequenceProblems(result, types)[0].message, /太陽熱消毒は 28 日が目安です（いま 21 日）/);
});

test("並びの中の重なりと、間隔の不足を指摘する", () => {
  const works = worksOf(["green_sow", "mow", "rotary", "amend"]);
  Object.assign(works[0], { plan_start: "2027-04-01", plan_end: "2027-04-01" });
  Object.assign(works[1], { plan_start: "2027-05-01", plan_end: "2027-05-01" });
  // 前の作業（伐採、5/1）より前に始まるロータリー。1 日の作業どうしでも、前の日より前は重なり
  Object.assign(works[2], { plan_start: "2027-04-30", plan_end: "2027-04-30" });
  const found = sequenceProblems(works, types);
  assert.deepEqual(found.map((problem) => problem.index), [1, 2, 3]);
  assert.match(found[0].message, /緑肥の播種のあとは 50 日あけるのが目安です（いま 29 日）/);
  assert.match(found[1].message, /重なっている/);
  assert.match(found[2].message, /日付が入っていません/);
});

// 区画 1 つに畝 1 本。区画は緑肥のひな形、畝はマルチありの作付を 1 つ
function plan({ ridge = "2027-07-06", removed_on = null } = {}) {
  const block = { id: "b1", start_date: null, end_date: null };
  const bed = { id: "bed1", block_id: "b1", seq: 1, start_date: null, removed_on };
  const planting = { id: "p1", bed_id: "bed1", seq: 1, crop_name: "オクラ" };
  const works = [
    ...scheduleBefore(worksOf(TEMPLATES.block.green.codes, { block_id: "b1" }), types, "2027-07-06"),
    ...scheduleForward(worksOf(TEMPLATES.bed.mulch.codes, { planting_id: "p1" }), types, ridge),
  ];
  return { blocks: [block], beds: [bed], plantings: [planting], works, workTypes: types };
}

test("無理のないプランには、指摘がない", () => {
  assert.deepEqual(planProblems(plan()), []);
});

test("管理作業の計画は、ほかの作業と重なっても指摘しない", () => {
  const base = plan();
  const plant = base.works.find((work) => work.work_type === "plant");
  // 定植と同じ日の灌水、定植より前の防除、区画の作業と重なる除草
  const extra = [
    { id: "m1", planting_id: "p1", block_id: null, work_type: "water", seq: 90, plan_start: plant.plan_start, plan_end: plant.plan_end },
    { id: "m2", planting_id: "p1", block_id: null, work_type: "spray", seq: 91, plan_start: "2027-06-01", plan_end: "2027-06-01" },
    { id: "m3", planting_id: null, block_id: "b1", work_type: "weed", seq: 92, plan_start: "2027-05-01", plan_end: "2027-05-03" },
  ];
  assert.deepEqual(planProblems({ ...base, works: [...base.works, ...extra] }), []);
});

test("作業の名前に、株の手入れとその他の中身を添える", () => {
  assert.equal(workName("株の手入れ", { items: ["摘葉", "誘引"] }), "株の手入れ（摘葉・誘引）");
  assert.equal(workName("株の手入れ", { items: ["中耕", "土寄せ"] }), "株の手入れ（中耕・土寄せ）");
  assert.equal(workName("その他", { items: ["発芽確認"] }), "その他（発芽確認）");
  assert.equal(workName("その他", { items: ["その他"], other: "支柱の撤去" }), "その他（支柱の撤去）");
  assert.equal(workName("防除", {}), "防除");
  assert.equal(workName("防除", undefined), "防除");
  assert.deepEqual(MANAGEMENT_TYPES.map(isManagement), MANAGEMENT_TYPES.map(() => true));
  assert.equal(isManagement("plant"), false);
});

test("区画の作業と、畝の最初の作業のつながり", () => {
  // すき込みは 6/14。21 日あけるので、畝立ては 7/6 から
  const early = planProblems(plan({ ridge: "2027-06-25" }));
  assert.equal(early.length, 1);
  assert.equal(early[0].planting_id, "p1");
  assert.match(early[0].message, /区画のすき込み（ロータリー）のあとは 21 日あけるのが目安です（いま 10 日）/);
  const overlapping = planProblems(plan({ ridge: "2027-06-10" }));
  assert.match(overlapping[0].message, /区画の作業（すき込み（ロータリー）、6\/14 まで）が終わる前に始まっています/);
});

test("作付どうしの重なりと、収穫完了予定日が未定の作付", () => {
  const data = plan();
  const first = data.works.filter((work) => work.planting_id === "p1");
  const end = harvestEnd(first); // 2027-08-11
  assert.equal(end, "2027-08-11");
  data.plantings.push({ id: "p2", bed_id: "bed1", seq: 2, crop_name: "リーフレタス" });
  const second = scheduleForward(worksOf(TEMPLATES.bed.bare.codes, { planting_id: "p2" }), types, "2027-08-05");
  data.works.push(...second);
  const overlap = planProblems(data);
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].planting_id, "p2");
  assert.equal(overlap[0].work_id, second[0].id);
  assert.match(overlap[0].message, /前の作付の収穫完了予定日（8\/11）より前に始まっています/);

  const restart = (date) => {
    data.works = data.works.filter((work) => work.planting_id !== "p2");
    data.works.push(...scheduleForward(worksOf(TEMPLATES.bed.bare.codes, { planting_id: "p2" }), types, date));
    return planProblems(data);
  };
  // 収穫完了の日に、2 日かかる畝立てを始めるのは、収穫と重なる
  assert.match(restart(end)[0].message, /前の作付の収穫完了予定日（8\/11）より前に始まっています/);
  // 残渣処理（1 日、8/12）の日に、次の作付の畝立てを始めてもよい（1 日の作業は同じ日に重ねられる）
  assert.deepEqual(restart(addDays(end, 1)), []);
  // 残渣処理より前（収穫完了の翌日に残渣処理が来る前）に始まるのは、前の作付の作業と重なる
  data.works = data.works.map((work) => (work.planting_id === "p1" && work.work_type === "residue" ? { ...work, plan_start: "2027-08-13", plan_end: "2027-08-13" } : work));
  assert.match(restart(addDays(end, 1))[0].message, /前の作付の作業が終わる日（8\/13）より前に始まっています/);
  data.works = data.works.map((work) => (work.planting_id === "p1" && work.work_type === "residue" ? { ...work, plan_start: "2027-08-12", plan_end: "2027-08-12" } : work));

  // 前の作付から収穫を外すと、収穫完了予定日が決まらない
  data.works = data.works.filter((work) => !(work.planting_id === "p1" && work.work_type === "harvest"));
  assert.match(planProblems(data)[0].message, /前の作付の収穫完了予定日が決まっていません/);
});

test("日付のない作業は、件数だけを指摘する", () => {
  const data = plan();
  data.works.filter((work) => work.planting_id === "p1").slice(2).forEach((work) => Object.assign(work, { plan_start: null, plan_end: null }));
  const found = planProblems(data);
  assert.equal(found.length, 1);
  assert.equal(found[0].work_id, null);
  assert.match(found[0].message, /日付の入っていない作業が 3 件あります/);
});

test("畝をなくす日より後の作業", () => {
  const found = planProblems(plan({ removed_on: "2027-08-01" }));
  assert.equal(found.length, 1);
  assert.equal(found[0].work_id, null);
  assert.match(found[0].message, /畝をなくす日（8\/1）以降に作業があります/);
});

test("今週の作業。なければ次の作業", () => {
  const works = scheduleBefore(worksOf(["subsoil", "rotary", "solar_prep", "solar", "amend", "rotary"]), types, "2027-07-06");
  const first = works[0].plan_start;
  assert.deepEqual(dueWorks(works, first).due.map((work) => work.work_type).slice(0, 2), ["subsoil", "rotary"]);
  // 太陽熱消毒の途中の週は、消毒だけが出る
  assert.deepEqual(dueWorks(works, addDays(works[3].plan_start, 5)).due.map((work) => work.work_type), ["solar"]);
  const before = dueWorks(works, "2027-01-01");
  assert.deepEqual(before.due, []);
  assert.deepEqual(before.upcoming.map((work) => work.work_type), ["subsoil"]);
  assert.deepEqual(dueWorks(works, "2028-01-01"), { due: [], upcoming: [] });
});

test("作付の期間と収穫完了予定日", () => {
  const works = scheduleForward(worksOf(TEMPLATES.bed.mulch.codes), types, "2027-07-06");
  // 期間は残渣処理まで。収穫完了予定日は、収穫の終了日
  assert.deepEqual(worksRange(works), { start: "2027-07-06", end: "2027-08-12" });
  assert.equal(harvestEnd(works), "2027-08-11");
  assert.equal(harvestEnd(works.slice(0, 3)), null);
  assert.equal(works.at(-1).work_type, "residue");
  assert.equal(worksRange(worksOf(["ridge"])), null);
});

test("区画や畝がその日にあるか", () => {
  assert.equal(existsOn(null, null, "2027-05-01"), true);
  assert.equal(existsOn("2027-06-01", null, "2027-05-31"), false);
  assert.equal(existsOn("2027-06-01", null, "2027-06-01"), true);
  // なくなる日には、もうない
  assert.equal(existsOn(null, "2027-11-01", "2027-10-31"), true);
  assert.equal(existsOn(null, "2027-11-01", "2027-11-01"), false);
});

test("かかる日数が 1 日の作業は、前後の作業と同じ日に重ねてよい", () => {
  const work = (code, start, end) => ({ id: code, work_type: code, plan_start: start, plan_end: end });
  // 畝立てとマルチ張りを同じ日に（どちらも 1 日）
  assert.deepEqual(sequenceProblems([work("ridge", "2027-06-01", "2027-06-01"), work("mulch", "2027-06-01", "2027-06-01")], types), []);
  // 2 日かかる畝立ての最後の日に、1 日のマルチ張り
  assert.deepEqual(sequenceProblems([work("ridge", "2027-06-01", "2027-06-02"), work("mulch", "2027-06-02", "2027-06-02")], types), []);
  // どちらも 2 日以上なら重なり
  assert.equal(sequenceProblems([work("ridge", "2027-06-01", "2027-06-02"), work("mulch", "2027-06-02", "2027-06-03")], types).length, 1);
  // 同じ日でも、前の日より前に始まるのは重なり
  assert.equal(sequenceProblems([work("ridge", "2027-06-02", "2027-06-02"), work("mulch", "2027-06-01", "2027-06-01")], types).length, 1);
  // あとに空ける日数がある作業（すき込みのあとの 21 日）は、1 日でも同じ日に重ねない
  const incorporate = sequenceProblems([work("incorporate", "2027-06-01", "2027-06-01"), work("ridge", "2027-06-01", "2027-06-01")], types);
  assert.equal(incorporate.length, 1);
});

test("工程表の表示期間と、1 日の幅", () => {
  // 全体は作業のある範囲。3 か月と 1 か月は今日を中心に
  assert.deepEqual(ganttWindow("all", "2026-07-01", "2027-06-30", "2026-10-27"), { from: "2026-07-01", to: "2027-06-30" });
  assert.deepEqual(ganttWindow("3m", "2026-07-01", "2027-06-30", "2026-10-27"), { from: "2026-09-12", to: "2026-12-11" });
  assert.deepEqual(ganttWindow("1m", "2026-07-01", "2027-06-30", "2026-10-27"), { from: "2026-10-12", to: "2026-11-11" });
  // 期間が幅にちょうど収まる幅。狭すぎれば 5px（横に送る）、広すぎれば 60px
  assert.equal(dayWidth(910, 91), 10);
  assert.equal(dayWidth(1000, 365), 5);
  assert.equal(dayWidth(1000, 10), 60);
});

// 以下は、Mutation testing（stryker.config.json）で、テストが気づかなかった書き換えを確かめる

// 作業 1 つ。seq は並びの順（配列の順とは別）
const job = (id, code, start, end, owner = {}, seq = 1) => ({ id, block_id: null, planting_id: null, ...owner, work_type: code, seq, plan_start: start, plan_end: end });

test("並びの指摘: 終了日が開始日より前、期間に意味がある作業の短すぎ、片方の日付だけ、名前のない種類", () => {
  assert.deepEqual(sequenceProblems([job("a", "ridge", "2027-06-03", "2027-06-01")], types), [{ index: 0, message: "終了日が開始日より前です。" }]);
  // 太陽熱消毒（目安 28 日）は、短いと言う。28 日ちょうどは言わない
  assert.deepEqual(sequenceProblems([job("a", "solar", "2027-06-01", "2027-06-20")], types), [{ index: 0, message: "太陽熱消毒は 28 日が目安です（いま 20 日）。" }]);
  assert.deepEqual(sequenceProblems([job("a", "solar", "2027-06-01", "2027-06-28")], types), []);
  // 収穫と、目安の短い作業（畝立て 2 日）は、短くても言わない
  assert.deepEqual(sequenceProblems([job("a", "harvest", "2027-06-01", "2027-06-05")], types), []);
  assert.deepEqual(sequenceProblems([job("a", "ridge", "2027-06-01", "2027-06-01")], types), []);
  // 開始日だけ、終了日だけ
  assert.deepEqual(
    sequenceProblems([job("a", "ridge", "2027-06-01", null), job("b", "ridge", null, "2027-06-01")], types).map((problem) => problem.message),
    ["日付が入っていません。", "日付が入っていません。"]
  );
  // 種類の表にない作業は、コードで書く
  const custom = sequenceProblems([job("a", "custom", "2027-06-01", "2027-06-02"), job("b", "ridge", "2027-06-02", "2027-06-03")], types);
  assert.deepEqual(custom, [{ index: 1, message: "前の作業（custom）と重なっているか、順番が逆です。" }]);
});

test("プランの指摘: 区画が始まる日より前、なくなる日以降の作業。区画の日がなければ見ない", () => {
  const check = (block, works) =>
    planProblems({ blocks: [{ id: "b1", start_date: null, end_date: null, ...block }], beds: [], plantings: [], works, workTypes: types }).map((problem) => problem.message);
  const dates = { start_date: "2027-05-01", end_date: "2027-09-01" };
  assert.deepEqual(check(dates, [job("a", "rotary", "2027-05-01", "2027-05-01", { block_id: "b1" }), job("b", "amend", "2027-08-31", "2027-08-31", { block_id: "b1" }, 2)]), []);
  assert.deepEqual(check(dates, [job("a", "rotary", "2027-04-30", "2027-04-30", { block_id: "b1" })]), ["区画が始まる日（5/1）より前に作業があります。"]);
  assert.deepEqual(check(dates, [job("a", "rotary", "2027-09-01", "2027-09-01", { block_id: "b1" })]), ["区画がなくなる日（9/1）以降に作業があります。"]);
  assert.deepEqual(check(dates, []), []);
  assert.deepEqual(check({}, [job("a", "rotary", "2027-04-30", "2027-04-30", { block_id: "b1" })]), []);
});

// 区画 2 つに、畝 1 本ずつ、作付 1 つずつ。配列の順は、並びの順（seq）と逆にしてある
function twoBlocks(p1Start = "2027-05-03") {
  const p1 = scheduleForward([job("p1-ridge", "ridge", null, null, { planting_id: "p1" }, 1), job("p1-mulch", "mulch", null, null, { planting_id: "p1" }, 2)], types, p1Start);
  return {
    blocks: [{ id: "b1" }, { id: "b2" }],
    beds: [{ id: "bed1", block_id: "b1" }, { id: "bed2", block_id: "b2" }],
    plantings: [{ id: "p2", bed_id: "bed2", seq: 1 }, { id: "p1", bed_id: "bed1", seq: 1 }],
    works: [
      job("b1-amend", "amend", "2027-05-02", "2027-05-02", { block_id: "b1" }, 2),
      job("b1-rotary", "rotary", "2027-05-01", "2027-05-01", { block_id: "b1" }, 1),
      job("b2-rotary", "rotary", "2027-05-20", "2027-05-20", { block_id: "b2" }, 1),
      p1[1],
      p1[0],
      // 区画 2 のロータリー（5/20）が終わる前に始まる
      job("p2-ridge", "ridge", "2027-05-19", "2027-05-20", { planting_id: "p2" }, 1),
    ],
    workTypes: types,
  };
}

test("プランの指摘は、区画ごと、畝ごと、作付ごとに、並びの順で見る", () => {
  assert.deepEqual(planProblems(twoBlocks()), [
    { block_id: null, planting_id: "p2", work_id: "p2-ridge", message: "区画の作業（ロータリー、5/20 まで）が終わる前に始まっています。" },
  ]);
  // 区画の最後の作業（1 日の堆肥・石灰・基肥、5/2）と同じ日に、畝立てを始めてよい
  assert.equal(planProblems(twoBlocks("2027-05-02")).length, 1);
});

test("プランの指摘: 畝ができる日より前、畝をなくす日以降の作業", () => {
  const withBed = (bed) => {
    const data = twoBlocks();
    data.beds[0] = { ...data.beds[0], ...bed };
    return planProblems(data).filter((problem) => problem.planting_id === "p1").map((problem) => problem.message);
  };
  // 作付 p1 は 5/3 から 5/6 まで
  assert.deepEqual(withBed({ start_date: "2027-05-03", removed_on: "2027-05-07" }), []);
  assert.deepEqual(withBed({ start_date: "2027-05-04" }), ["畝ができる日（5/4）より前に作業があります。"]);
  assert.deepEqual(withBed({ removed_on: "2027-05-06" }), ["畝をなくす日（5/6）以降に作業があります。"]);
});

test("プランの指摘: 畝幅が品目の設定と 1 cm 以上違う", () => {
  const withCrop = (crop) => {
    const data = twoBlocks();
    data.beds[0] = { ...data.beds[0], shape: [[0, 0], [10, 0], [10, 0.6], [0, 0.6]] };
    data.plantings[1] = { ...data.plantings[1], crop_id: "c1" };
    return planProblems({ ...data, crops: [{ id: "c0", bed_width_cm: 90 }, { id: "c1", ...crop }] })
      .filter((problem) => problem.planting_id === "p1")
      .map((problem) => problem.message);
  };
  assert.deepEqual(withCrop({ bed_width_cm: 60 }), []);
  assert.deepEqual(withCrop({ bed_width_cm: 60.5 }), []);
  assert.deepEqual(withCrop({ bed_width_cm: 61 }), ["畝幅が、品目の設定（61 cm）と違います（いま 60 cm）。"]);
  assert.deepEqual(withCrop({ bed_width_cm: 0 }), []);
  assert.deepEqual(withCrop({}), []);
});

test("プランの指摘: 日付のない作業の件数は、日付のある作業の指摘と別に数える", () => {
  const data = twoBlocks();
  data.works.push(
    job("p1-plant", "plant", null, null, { planting_id: "p1" }, 3),
    job("p1-harvest", "harvest", null, null, { planting_id: "p1" }, 4),
    // マルチ張り（5/5〜5/6）と重なる
    job("p1-residue", "residue", "2027-05-06", "2027-05-07", { planting_id: "p1" }, 5)
  );
  const mine = planProblems(data).filter((problem) => problem.planting_id === "p1").map((problem) => problem.message);
  assert.deepEqual(mine, ["前の作業（マルチ張り）と重なっているか、順番が逆です。", "日付の入っていない作業が 2 件あります。"]);
});

test("プランの指摘: 前の作付の最後の日に、次の作付を始めてよいのは、どちらかが 1 日の作業のとき", () => {
  const follow = (previous, next) =>
    planProblems({
      blocks: [{ id: "b1" }],
      beds: [{ id: "bed1", block_id: "b1" }],
      plantings: [{ id: "p1", bed_id: "bed1", seq: 1 }, { id: "p2", bed_id: "bed1", seq: 2 }],
      works: [...previous.map((work, i) => ({ ...work, planting_id: "p1", seq: i + 1 })), { ...next, planting_id: "p2" }],
      workTypes: types,
    }).map((problem) => problem.message);
  const harvest = job("h", "harvest", "2027-06-01", "2027-06-10");
  // 収穫（10 日）の最後の日に、1 日の定植
  assert.deepEqual(follow([harvest], job("n", "plant", "2027-06-10", "2027-06-10")), []);
  // 1 日の収穫の日に、2 日の畝立て
  assert.deepEqual(follow([job("h", "harvest", "2027-06-10", "2027-06-10")], job("n", "ridge", "2027-06-10", "2027-06-11")), []);
  // 収穫のあとの 2 日の残渣処理の最後の日に、2 日の畝立て
  const residue = job("r", "residue", "2027-06-12", "2027-06-13");
  assert.deepEqual(follow([harvest, residue], job("n", "ridge", "2027-06-13", "2027-06-14")), ["前の作付の作業が終わる日（6/13）より前に始まっています。"]);
  assert.deepEqual(follow([harvest, residue], job("n", "ridge", "2027-06-14", "2027-06-15")), []);
});

test("作業の期間、収穫完了予定日、日数: 片方の日付しかない作業は数えない。並びの順によらない", () => {
  const works = [job("b", "harvest", "2027-07-05", "2027-07-20"), job("a", "harvest", "2027-07-01", "2027-07-10"), job("c", "residue", "2027-07-21", null)];
  assert.deepEqual(worksRange(works), { start: "2027-07-01", end: "2027-07-20" });
  assert.equal(harvestEnd([works[1], works[0]]), "2027-07-20");
  assert.equal(harvestEnd(works), "2027-07-20");
  assert.equal(workDays(works[2]), null);
  assert.equal(workDays(job("d", "ridge", null, "2027-07-01")), null);
});

test("並べるときの日数: 日付が逆さまの作業は、目安の日数にする。表にない種類は 1 日", () => {
  const placed = scheduleForward([job("a", "ridge", "2027-06-05", "2027-06-04"), job("b", "custom", null, null, {}, 2)], types, "2027-07-01");
  assert.deepEqual(
    placed.map((work) => [work.plan_start, work.plan_end]),
    [
      ["2027-07-01", "2027-07-02"],
      ["2027-07-03", "2027-07-03"],
    ]
  );
  assert.equal(isPlannable({ code: "spray", plannable: false }), false);
  assert.equal(isPlannable({ code: "ridge" }), true);
});

test("品目に合わせた作業の目安: 定植・播種のあとの日数と、収穫の日数", () => {
  const of = (list, code) => list.find((type) => type.code === code);
  assert.equal(typesForCrop(types, null), types);
  // 定植・播種から収穫開始まで 40 日。定植に 5 日かけるなら、あとに 35 日あける
  const planted = typesForCrop(types, { grow_days: 40, harvest_days: 20 }, [job("p", "plant", "2027-06-01", "2027-06-05")]);
  assert.equal(of(planted, "plant").min_gap_days, 35);
  assert.equal(of(planted, "harvest").default_days, 20);
  // 定植の日がない、または日付が逆さまなら、定植の目安（3 日）で決める
  assert.equal(of(typesForCrop(types, { grow_days: 40 }), "plant").min_gap_days, 37);
  assert.equal(of(typesForCrop(types, { grow_days: 40 }, [job("p", "plant", "2027-06-05", "2027-06-01")]), "plant").min_gap_days, 37);
  // 日数の決まりがなければ、そのまま
  const plain = typesForCrop(types, { grow_days: null }, []);
  assert.equal(of(plain, "plant").min_gap_days, 0);
  assert.equal(of(plain, "harvest").default_days, 30);
  assert.equal(of(typesForCrop(types, { grow_days: 2 }), "plant").min_gap_days, 0);
});

test("今週の作業の境目: 7 日目に始まる作業は入り、8 日目は入らない。今日終わる作業も入る", () => {
  const works = [
    job("c", "ridge", "2027-07-08", "2027-07-08"),
    job("b", "ridge", "2027-07-07", "2027-07-07"),
    job("e", "ridge", "2027-06-25", "2027-07-01"),
    job("d", "ridge", null, null),
    job("a", "ridge", "2027-07-01", "2027-07-01"),
  ];
  assert.deepEqual(dueWorks(works, "2027-07-01").due.map((work) => work.id), ["e", "a", "b"]);
  assert.deepEqual(dueWorks(works, "2027-07-02", 1).due.map((work) => work.id), []);
  // 次の作業は、同じ日に始まる作業をまとめて返す
  const next = dueWorks([...works, job("f", "mulch", "2027-06-25", "2027-06-26")], "2027-06-01");
  assert.deepEqual(next.upcoming.map((work) => work.id), ["e", "f"]);
});

// 日程の計算（app/schedule.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WORK_TYPES as types,
  MANAGEMENT_TYPES,
  isManagement,
  workName,
  TEMPLATES,
  addDays,
  diffDays,
  dueWorks,
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

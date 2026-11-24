// 収量と売上の見込み、収穫量の実績、市況からの単価の推定（app/revenue.js）のテスト。実行: node --test "tests/*.test.mjs"
// 数字は、すべて説明のために作った値
import { test } from "./test-api.mjs";
import assert from "node:assert/strict";
import {
  MARKET_MIN_DAYS,
  daysOf,
  forecast,
  harvestActual,
  harvestWindow,
  marketEstimate,
  rankMarketItems,
  resolvePrice,
  resolveRate,
  resolveYield,
  splitHarvest,
} from "../app/revenue.js";

const near = (actual, expected, digits = 6) => assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} != ${expected}`);

test("収量: 作付の 1 株あたり → 作付の 10 a あたり → 品目の 1 株あたり → 品目の 10 a あたり の順", () => {
  const crop = { yield_kg_per_10a: 2000, yield_g_per_plant: 300 };
  const both = { yield_kg_per_10a: 3000, yield_g_per_plant: 500 };
  const size = { seedlings: 100, areaM2: 50 };
  assert.deepEqual(resolveYield(both, crop, size), { kg: 50, method: "plant", from: "planting", value: 500 });
  assert.deepEqual(resolveYield({ yield_kg_per_10a: 3000 }, crop, size), { kg: 150, method: "area", from: "planting", value: 3000 });
  assert.deepEqual(resolveYield({}, crop, size), { kg: 30, method: "plant", from: "crop", value: 300 });
  assert.deepEqual(resolveYield({}, { yield_kg_per_10a: 2000 }, size), { kg: 100, method: "area", from: "crop", value: 2000 });
  // 作付の値は、方法が違っても品目の値より先に使う
  assert.equal(resolveYield({ yield_kg_per_10a: 3000 }, { yield_g_per_plant: 300 }, size).from, "planting");
});

test("収量: 1 株あたりは苗数が分かるときだけ。分からなければ次の方法へ。面積がなければ 10 a あたりも使えない", () => {
  const crop = { yield_kg_per_10a: 2000, yield_g_per_plant: 300 };
  assert.deepEqual(resolveYield({ yield_g_per_plant: 500 }, crop, { seedlings: null, areaM2: 50 }), { kg: 100, method: "area", from: "crop", value: 2000 });
  assert.equal(resolveYield({}, crop, { seedlings: 0, areaM2: 50 }).method, "area", "苗数 0 は分からないのと同じ");
  assert.equal(resolveYield({}, crop, { seedlings: null, areaM2: null }), null);
  assert.equal(resolveYield({}, { yield_kg_per_10a: 2000 }, { seedlings: 100, areaM2: 0 }), null);
  assert.equal(resolveYield(null, null), null);
  assert.equal(resolveYield({ yield_kg_per_10a: null, yield_g_per_plant: "" }, {}, { seedlings: 10, areaM2: 10 }), null, "空の値は使わない");
  // 0 は値として使う（収量 0 の見込み）
  assert.deepEqual(resolveYield({ yield_kg_per_10a: 0 }, crop, { seedlings: null, areaM2: 50 }), { kg: 0, method: "area", from: "planting", value: 0 });
});

test("出荷率: 作付 → 品目。どちらも空なら 100 %", () => {
  assert.deepEqual(resolveRate({ shippable_pct: 80 }, { shippable_pct: 90 }), { pct: 80, from: "planting" });
  assert.deepEqual(resolveRate({ shippable_pct: null }, { shippable_pct: 90 }), { pct: 90, from: "crop" });
  assert.deepEqual(resolveRate({}, {}), { pct: 100, from: "default" });
  assert.deepEqual(resolveRate(null, null), { pct: 100, from: "default" });
  assert.deepEqual(resolveRate({ shippable_pct: 0 }, { shippable_pct: 90 }), { pct: 0, from: "planting" });
  // 負の数と、数でない値は使わない
  assert.deepEqual(resolveRate({ shippable_pct: -5 }, { shippable_pct: "abc" }), { pct: 100, from: "default" });
});

test("単価: 作付 → 品目 → 市況からの推定。どれもなければ null", () => {
  const estimate = { yen: 250 };
  assert.deepEqual(resolvePrice({ price_yen_per_kg: 400 }, { price_yen_per_kg: 300 }, estimate), { yen: 400, from: "planting" });
  assert.deepEqual(resolvePrice({}, { price_yen_per_kg: 300 }, estimate), { yen: 300, from: "crop" });
  assert.deepEqual(resolvePrice({}, {}, estimate), { yen: 250, from: "market", estimate });
  assert.equal(resolvePrice({}, {}, null), null);
  assert.equal(resolvePrice({}, {}, { yen: null }), null);
});

const JUNE = { start: "2027-06-01", end: "2027-06-10" };

test("見込み: 売上 = 出荷量を収穫の期間の日に均等に分け、日ごとの単価を掛けて足す。分からない値は null", () => {
  const result = forecast({ shippable_pct: 80 }, { yield_kg_per_10a: 2000, price_yen_per_kg: 300 }, { areaM2: 50, window: JUNE });
  near(result.yieldKg, 100);
  near(result.shippedKg, 80);
  near(result.salesYen, 24000);
  assert.deepEqual(result.price, { yen: 300, from: "crop" });
  assert.deepEqual([...result.monthly.keys()], ["2027-06"]);
  // 単価がなければ、売上だけが null
  const noPrice = forecast({}, { yield_kg_per_10a: 2000 }, { areaM2: 50, window: JUNE });
  assert.equal(noPrice.shippedKg, 100);
  assert.deepEqual([noPrice.salesYen, noPrice.monthly, noPrice.price], [null, null, null]);
  // 収量がなければ、出荷量も売上も null。単価は出す
  const noYield = forecast({}, { price_yen_per_kg: 300 }, { areaM2: 50, window: JUNE });
  assert.deepEqual([noYield.yieldKg, noYield.shippedKg, noYield.salesYen, noYield.monthly], [null, null, null, null]);
  assert.equal(noYield.price.yen, 300);
});

test("見込み: 収穫の計画がなければ、売上を出さない。単価は、作付 → 品目 → 市況の全期間の順に見せる", () => {
  const plain = forecast({}, { yield_kg_per_10a: 2000, price_yen_per_kg: 300 }, { areaM2: 50 });
  near(plain.shippedKg, 100);
  assert.deepEqual([plain.salesYen, plain.monthly], [null, null]);
  assert.deepEqual(plain.price, { yen: 300, from: "crop" });
  const estimate = { yen: 150, widen: "all" };
  assert.deepEqual(forecast({}, { yield_g_per_plant: 200 }, { seedlings: 50, estimate }).price, { yen: 150, from: "market", estimate });
  assert.equal(forecast({}, {}, { estimate: null }).price, null);
});

test("見込み: 市況のときは、日ごとにその日の市況から推し、月ごとに分ける", () => {
  // 6/29〜7/2 の 4 日。6 月の 2 日は 100 円、7 月の 2 日は 300 円（7/2 だけ前後 14 日に広げた）
  const marketOn = (day) => (day < "2027-07-01" ? { yen: 100, widen: 7 } : { yen: 300, widen: day === "2027-07-02" ? 14 : 7 });
  const result = forecast({}, { yield_g_per_plant: 1000 }, { seedlings: 8, window: { start: "2027-06-29", end: "2027-07-02" }, marketOn });
  // 出荷量 8 kg を 4 日に 2 kg ずつ
  assert.deepEqual([...result.monthly], [
    ["2027-06", 400],
    ["2027-07", 1200],
  ]);
  assert.equal(result.salesYen, 1600);
  assert.deepEqual(result.price, { yen: 200, from: "market", estimate: { widen: 14, counts: { 7: 3, 14: 1 }, days: 4 } });
  // 全期間を使った日があれば、いちばん広げた印は all
  const some = forecast({}, { yield_g_per_plant: 1000 }, { seedlings: 8, window: JUNE, marketOn: (day) => ({ yen: 100, widen: day === "2027-06-05" ? "all" : 30 }) });
  assert.deepEqual(some.price.estimate, { widen: "all", counts: { 30: 9, all: 1 }, days: 10 });
  // 1 日でも市況から推せなければ、単価も売上も null
  const gap = forecast({}, { yield_g_per_plant: 1000 }, { seedlings: 8, window: JUNE, marketOn: (day) => (day === "2027-06-03" ? null : { yen: 100, widen: 7 }) });
  assert.deepEqual([gap.price, gap.salesYen, gap.monthly], [null, null, null]);
  // 市況がない品目（marketOn なし）も null
  assert.equal(forecast({}, { yield_g_per_plant: 1000 }, { seedlings: 8, window: JUNE }).price, null);
  // 3 種類が混ざっても、いちばん広げた印（all）
  const mixed = forecast({}, { yield_g_per_plant: 1000 }, { seedlings: 8, window: { start: "2027-06-01", end: "2027-06-03" }, marketOn: (day) => ({ yen: 100, widen: { "2027-06-01": 7, "2027-06-02": "all", "2027-06-03": 30 }[day] }) });
  assert.equal(mixed.price.estimate.widen, "all");
  // 作付か品目に単価があれば、市況は使わない（引きもしない）
  let asked = 0;
  const manual = forecast({ price_yen_per_kg: 500 }, { yield_g_per_plant: 1000 }, { seedlings: 8, window: JUNE, marketOn: () => (asked += 1, { yen: 1, widen: 7 }) });
  assert.deepEqual([manual.price, manual.salesYen, asked], [{ yen: 500, from: "planting" }, 4000, 0]);
});

test("収穫の期間の日: 始まりから終わりまで。終わりが前か空なら、始まりの 1 日", () => {
  assert.deepEqual(daysOf({ start: "2027-02-27", end: "2027-03-02" }), ["2027-02-27", "2027-02-28", "2027-03-01", "2027-03-02"]);
  assert.deepEqual(daysOf({ start: "2027-06-05", end: "2027-06-01" }), ["2027-06-05"]);
  assert.deepEqual(daysOf({ start: "2027-06-05", end: null }), ["2027-06-05"]);
  assert.deepEqual(daysOf({ start: "2027-06-05", end: "2027-06-05" }), ["2027-06-05"]);
});

const target = (planting_id, area_m2, harvest_kg = null) => ({ planting_id, area_m2, harvest_kg });

test("収穫量の分け方: 畝ごとに入れた量はそのまま、残りを入れていない畝に面積の比で", () => {
  const parts = splitHarvest({ spec: { harvest_kg: 100 }, targets: [target("a", 10, 30), target("b", 20), target("c", 50)] });
  assert.deepEqual(
    parts.map((part) => [part.planting_id, Math.round(part.kg * 1000) / 1000, part.measured]),
    [
      ["a", 30, true],
      ["b", 20, false],
      ["c", 50, false],
    ]
  );
  // 畝ごとの量だけなら、合計が収穫量。残りは 0
  assert.deepEqual(
    splitHarvest({ spec: {}, targets: [target("a", 10, 4), target("b", 10)] }).map((part) => part.kg),
    [4, 0]
  );
  // 畝ごとの量が収穫量を超えても、残りは負にしない
  assert.deepEqual(
    splitHarvest({ spec: { harvest_kg: 5 }, targets: [target("a", 10, 8), target("b", 10)] }).map((part) => part.kg),
    [8, 0]
  );
});

test("収穫量の分け方: 面積が分からなければ等分。畝 1 本だけの記録は、量った値。区画の対象は返さない", () => {
  assert.deepEqual(
    splitHarvest({ spec: { harvest_kg: 9 }, targets: [target("a", null), target("b", 0), target("c", undefined)] }).map((part) => part.kg),
    [3, 3, 3]
  );
  assert.deepEqual(splitHarvest({ spec: { harvest_kg: 12 }, targets: [target("a", 10)] }), [{ planting_id: "a", kg: 12, measured: true }]);
  assert.deepEqual(splitHarvest({ spec: { harvest_kg: 12 }, targets: [{ block_id: "k", area_m2: 100 }] }), []);
  assert.deepEqual(splitHarvest({ spec: { harvest_kg: 12 } }), []);
  // 記録に仕様がなくても、畝ごとの量で分ける
  assert.deepEqual(splitHarvest({ targets: [target("a", 10, 2)] }), [{ planting_id: "a", kg: 2, measured: true }]);
  // 畝 2 本のうち 1 本だけ量ったときの、もう 1 本は分けた値
  assert.deepEqual(splitHarvest({ spec: { harvest_kg: 10 }, targets: [target("a", 10, 4), target("b", 10)] }), [
    { planting_id: "a", kg: 4, measured: true },
    { planting_id: "b", kg: 6, measured: false },
  ]);
  // 何も量っていない記録は 0
  assert.deepEqual(splitHarvest({ spec: {}, targets: [target("a", 10), target("b", 10)] }).map((part) => part.kg), [0, 0]);
});

test("作付の収穫量の実績: 収穫の記録だけを足し、分けた量を別に数える", () => {
  const logs = [
    { work_type: "harvest", spec: { harvest_kg: 30 }, targets: [target("a", 10), target("b", 20)] },
    { work_type: "harvest", spec: { harvest_kg: 7 }, targets: [target("a", 10)] },
    { work_type: "harvest", spec: { harvest_kg: 50 }, targets: [target("a", 10, 15), target("b", 10)] },
    { work_type: "spray", spec: { harvest_kg: 99 }, targets: [target("a", 10)] },
    { work_type: "harvest", spec: { harvest_kg: 5 }, targets: [target("b", 10)] },
  ];
  const a = harvestActual("a", logs);
  near(a.kg, 10 + 7 + 15);
  near(a.splitKg, 10);
  assert.equal(a.count, 3);
  assert.equal(a.unmeasured, 0);
  assert.deepEqual(harvestActual("z", logs), { kg: 0, splitKg: 0, count: 0, unmeasured: 0 });
  assert.deepEqual(harvestActual("a", []), { kg: 0, splitKg: 0, count: 0, unmeasured: 0 });
});

test("作付の収穫量の実績: 収穫量の入っていない記録は、量に数えず、件数を別に数える。0 と入れた記録は 0 kg として数える", () => {
  const logs = [
    // 量を量らずに収穫だけを記録した
    { work_type: "harvest", spec: {}, targets: [target("a", 10)] },
    { work_type: "harvest", targets: [target("a", 10)] },
    // 0 kg と入れた（穫れなかった）
    { work_type: "harvest", spec: { harvest_kg: 0 }, targets: [target("a", 10)] },
    // ほかの畝だけ量った。記録の収穫量は空なので、a は量っていない
    { work_type: "harvest", spec: {}, targets: [target("a", 10), target("b", 10, 4)] },
    // a の畝だけ量った
    { work_type: "harvest", spec: {}, targets: [target("a", 10, 3), target("b", 10)] },
  ];
  assert.deepEqual(harvestActual("a", logs), { kg: 3, splitKg: 0, count: 2, unmeasured: 3 });
  assert.deepEqual(harvestActual("b", logs), { kg: 4, splitKg: 0, count: 1, unmeasured: 1 });
  assert.deepEqual(harvestActual("a", logs.slice(0, 2)), { kg: 0, splitKg: 0, count: 0, unmeasured: 2 });
  // 同じ作付の対象が 2 つある記録（畝を作り直す前後の記録など）は、どちらかに量があれば量った記録
  const twice = { work_type: "harvest", spec: {}, targets: [target("a", 10, 2), target("a", 10)] };
  assert.deepEqual(harvestActual("a", [twice]), { kg: 2, splitKg: 0, count: 1, unmeasured: 0 });
});

test("収穫の計画の期間: 取りやめていない収穫の作業の、最初の始まりから最後の終わりまで", () => {
  const works = [
    { work_type: "harvest", plan_start: "2027-01-10", plan_end: "2027-01-31" },
    { work_type: "harvest", plan_start: "2027-01-05", plan_end: null },
    { work_type: "harvest", plan_start: "2026-12-01", plan_end: "2027-03-01", cancelled_on: "2026-11-30" },
    { work_type: "plant", plan_start: "2026-11-01", plan_end: "2026-11-02" },
    { work_type: "harvest", plan_start: null, plan_end: "2027-02-01" },
  ];
  assert.deepEqual(harvestWindow(works), { start: "2027-01-05", end: "2027-01-31" });
  // 収穫の作業が 3 つ以上でも、いちばん遅い終わり
  assert.deepEqual(harvestWindow([...works, { work_type: "harvest", plan_start: "2027-01-07", plan_end: "2027-01-08" }]), { start: "2027-01-05", end: "2027-01-31" });
  assert.equal(harvestWindow([{ work_type: "plant", plan_start: "2026-11-01" }]), null);
  assert.equal(harvestWindow([]), null);
});

// 1 日ごとの市況。from から days 日、値は value（関数なら日付から）
function days(from, count, value) {
  const rows = [];
  const start = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  for (let i = 0; i < count; i += 1) {
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10);
    rows.push({ sale_date: date, avg_price: typeof value === "function" ? value(date, i) : value });
  }
  return rows;
}

test("市況からの推定: 収穫の期間を前後 7 日に広げた月日に入る取引日の中央値と、25〜75 % の幅", () => {
  const prices = [...days("2026-05-01", 10, (date, i) => 100 + i * 10), ...days("2026-08-01", 10, 900)];
  const estimate = marketEstimate(prices, { start: "2027-05-01", end: "2027-05-10" });
  assert.equal(estimate.days, 10);
  assert.equal(estimate.widen, 7);
  near(estimate.yen, 145);
  near(estimate.low, 122.5);
  near(estimate.high, 167.5);
  assert.deepEqual([estimate.from, estimate.to], ["2026-05-01", "2026-05-10"]);
  // 値のない日、0 円の日、日付のない行は使わない
  const withGaps = [...prices, { sale_date: "2026-05-05", avg_price: null }, { sale_date: "2026-05-06", avg_price: 0 }, { avg_price: 120 }];
  assert.equal(marketEstimate(withGaps, { start: "2027-05-01", end: "2027-05-10" }).days, 10);
  // 並びが日付順でも値の順でもなくても、値を並べてから中央値を、日付を並べてから最初と最後を取る
  const shuffled = [
    { sale_date: "2026-05-09", avg_price: 500 },
    { sale_date: "2026-05-02", avg_price: 100 },
    { sale_date: "2026-05-07", avg_price: 300 },
    { sale_date: "2026-05-04", avg_price: 900 },
    { sale_date: "2026-05-03", avg_price: 200 },
  ];
  const sorted = marketEstimate(shuffled, { start: "2027-05-01", end: "2027-05-10" });
  assert.deepEqual([sorted.yen, sorted.low, sorted.high, sorted.from, sorted.to], [300, 200, 500, "2026-05-02", "2026-05-09"]);
  // その日だけの市況では推さない。前後 7 日ちょうどの日まで入り、8 日離れた日は入らない
  const edges = [...days("2026-06-03", 1, 100), ...days("2025-06-03", 1, 100), ...days("2024-06-03", 1, 100), ...days("2026-06-17", 1, 300), ...days("2025-06-17", 1, 300)];
  const far = [...days("2026-06-02", 1, 900), ...days("2026-06-18", 1, 900)];
  const seven = marketEstimate([...edges, ...far], { start: "2027-06-10", end: "2027-06-10" });
  assert.deepEqual([seven.widen, seven.days, seven.yen], [7, 5, 100]);
});

test("市況からの推定: 取引日が足りなければ、前後に 14、30、45 日と広げる", () => {
  // 期間（6/1〜6/3）の前後 7 日には 2 日しかない。前後 14 日で 5 日になる
  const prices = [...days("2026-06-01", 2, 200), ...days("2026-05-20", 3, 100), ...days("2026-09-01", 10, 900)];
  const near14 = marketEstimate(prices, { start: "2027-06-01", end: "2027-06-03" });
  assert.equal(near14.widen, 14);
  assert.equal(near14.days, 5);
  near(near14.yen, 100);
  // 前後 30 日で足りるとき
  const thirty = [...days("2026-06-01", 1, 200), ...days("2026-06-30", 4, 300)];
  assert.equal(marketEstimate(thirty, { start: "2027-06-01", end: "2027-06-03" }).widen, 30);
  // 前後 45 日で足りるとき
  const fortyFive = [...days("2026-06-01", 1, 200), ...days("2026-07-15", 4, 300)];
  assert.equal(marketEstimate(fortyFive, { start: "2027-06-01", end: "2027-06-03" }).widen, 45);
  assert.equal(MARKET_MIN_DAYS, 5);
});

test("市況からの推定: 45 日まで広げても足りなければ、品目の全期間の中央値（widen: all）", () => {
  // 12〜3 月の収穫。市況は 4 月からしかない
  const prices = [...days("2026-04-20", 3, 100), ...days("2026-07-01", 4, 300)];
  const estimate = marketEstimate(prices, { start: "2026-12-10", end: "2027-02-20" });
  assert.equal(estimate.widen, "all");
  assert.equal(estimate.days, 7);
  near(estimate.yen, 300);
  assert.deepEqual([estimate.from, estimate.to], ["2026-04-20", "2026-07-04"]);
  // 収穫の期間が分からないときも、全期間
  assert.equal(marketEstimate(prices, null).widen, "all");
  assert.equal(marketEstimate(prices, { start: null }).widen, "all");
  // 取引日がなければ null
  assert.equal(marketEstimate([], { start: "2026-12-10", end: "2027-02-20" }), null);
  assert.equal(marketEstimate(null, null), null);
});

test("市況からの推定: 年をまたぐ期間と、うるう日", () => {
  // 12/25〜1/5 の期間に、去年の 12 月末と今年の 1 月初めの値が入る
  const prices = [...days("2025-12-28", 4, 100), ...days("2026-01-02", 3, 200), ...days("2026-06-01", 10, 900)];
  const estimate = marketEstimate(prices, { start: "2026-12-25", end: "2027-01-05" });
  assert.equal(estimate.widen, 7);
  assert.equal(estimate.days, 7);
  near(estimate.yen, 100);
  // 2/29 は 2/28 と同じ日に数える（2/21 の前後 7 日の 2/14〜2/28 に入る。3/1 は入らない）
  const leap = ["2008-02-29", "2012-02-29", "2016-02-29", "2020-02-29", "2024-02-29", "2025-03-01"].map((sale_date) => ({ sale_date, avg_price: 500 }));
  const leapEstimate = marketEstimate(leap, { start: "2027-02-21", end: "2027-02-21" });
  assert.deepEqual([leapEstimate.days, leapEstimate.widen], [5, 7]);
  // 2 月のほかの月の 29〜31 日は、そのままの日（1/31 は、2/7 の前後 7 日の 1/31〜2/14 に入る）
  const monthEnd = days("2021-01-31", 1, 100).concat(days("2022-01-31", 1, 100), days("2023-01-31", 1, 100), days("2024-01-31", 1, 100), days("2025-01-31", 1, 100));
  assert.equal(marketEstimate(monthEnd, { start: "2027-02-07", end: "2027-02-07" }).widen, 7);
});

test("市況からの推定: 期間の終わりが始まりより前か空なら 1 日だけ、1 年を超える期間はどの日も入る", () => {
  const prices = [...days("2026-05-01", 5, 100), ...days("2026-10-01", 5, 300)];
  for (const end of ["2027-05-01", null]) {
    const one = marketEstimate(prices, { start: "2027-05-03", end });
    assert.deepEqual([one.widen, one.days], [7, 5], "5/3 の前後 7 日だけ（10 月は入らない）");
  }
  // ちょうど 365 日後まで（同じ月日の 1 年後）は、どの日も入る
  const fullYear = marketEstimate(prices, { start: "2026-03-01", end: "2027-03-01" });
  assert.deepEqual([fullYear.days, fullYear.widen], [10, 7]);
  const year = marketEstimate(prices, { start: "2026-01-01", end: "2027-02-01" });
  assert.equal(year.days, 10);
  assert.equal(year.widen, 7);
});

test("市況の品目名の候補: ひらがなとカタカナをそろえ、同じ、含む、含まれる、そのほかの順", () => {
  const items = [{ item_name: "玉葱" }, { item_name: "なす" }, { item_name: "米なす" }, { item_name: "キャベツ" }, { item_name: "な" }];
  assert.deepEqual(
    rankMarketItems("ナス", items).map((item) => item.item_name),
    ["なす", "米なす", "な", "キャベツ", "玉葱"]
  );
  assert.deepEqual(
    rankMarketItems("", items).map((item) => item.item_name),
    ["キャベツ", "な", "なす", "玉葱", "米なす"].sort((a, b) => a.localeCompare(b, "ja"))
  );
  assert.equal(rankMarketItems("ゴーヤー（中長）", [{ item_name: "ゴーヤー" }, { item_name: "ごーやー中長" }])[0].item_name, "ごーやー中長");
  // 同じ名前は、名前の順で前に来るものより先
  assert.deepEqual(
    rankMarketItems("ネギ", [{ item_name: "あさつきねぎ" }, { item_name: "ねぎ" }]).map((item) => item.item_name),
    ["ねぎ", "あさつきねぎ"]
  );
});

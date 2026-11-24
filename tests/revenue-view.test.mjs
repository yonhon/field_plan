// 「収支」のタブと作付の詳細が使う、市況からの日ごとの単価（app/revenue-view.js の marketOnDay）と、
// 単価の出どころの文（priceSource、priceTitle）のテスト。実行: node --test "tests/*.test.mjs"
// 通しテスト（tests/e2e/revenue.test.mjs）では、画面に出ることだけを確かめ、数字と文の中身はここで確かめる（2026-11-24）。
// 数字は、すべて説明のために作った値
import { test } from "./test-api.mjs";
import assert from "node:assert/strict";
import { forecast, marketEstimate } from "../app/revenue.js";
import { marketOnDay, priceSource, priceTitle } from "../app/revenue-view.js";

const near = (actual, expected, digits = 6) => assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} != ${expected}`);
const prices = (dates, yen) => dates.map((date) => ({ sale_date: date, avg_price: yen }));
// 6/20〜6/24 に 100 円、7/5〜7/9 に 400 円。日ごとに前後 7 日に入る取引が変わる
const MARKET = [
  ...prices(["2026-06-20", "2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24"], 100),
  ...prices(["2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09"], 400),
];
// 1 株 500 g × 40 株 × 出荷率 80 % = 出荷量 16 kg
const CROP = { yield_g_per_plant: 500, shippable_pct: 80 };
const marketOn = (day) => marketOnDay(MARKET, day);

test("市況からの日ごとの単価: 日ごとに、その日の前後 7 日の中央値。出荷量を日に均等に分けて、月ごとの売上にする", () => {
  // 中央値は 6/27〜6/29 が 100 円、6/30〜7/2 が 400 円
  assert.deepEqual(["2026-06-27", "2026-06-29", "2026-06-30", "2026-07-02"].map((day) => marketOn(day).yen), [100, 100, 400, 400]);
  const result = forecast({}, CROP, { seedlings: 40, window: { start: "2027-06-27", end: "2027-07-02" }, marketOn });
  // 単価は日ごとの単価の平均の 250 円。16 kg を 6 日に分け、6 月は 100・100・100・400 円の 4 日、7 月は 400 円の 2 日
  assert.deepEqual(result.price, { yen: 250, from: "market", estimate: { widen: 7, counts: { 7: 6 }, days: 6 } });
  near(result.salesYen, 4000);
  near(result.monthly.get("2027-06"), (16 / 6) * 700);
  near(result.monthly.get("2027-07"), (16 / 6) * 800);
});

test("市況からの日ごとの単価: その時期の市況がなければ、全期間の中央値。同じ市況の同じ月日は 1 回だけ求める", () => {
  // 1 月の収穫。市況は 6〜7 月しかないので、どの日も全期間の中央値（100 円 5 日と 400 円 5 日で 250 円）
  const result = forecast({}, CROP, { seedlings: 40, window: { start: "2027-01-10", end: "2027-01-20" }, marketOn });
  assert.deepEqual(result.price, { yen: 250, from: "market", estimate: { widen: "all", counts: { all: 11 }, days: 11 } });
  near(result.salesYen, 4000);
  // 年が違っても、同じ月日なら同じもの（作付ごと、日ごとに計算し直さない）
  assert.equal(marketOnDay(MARKET, "2027-06-27"), marketOnDay(MARKET, "2028-06-27"));
  assert.deepEqual(marketOnDay(MARKET, "2027-06-27"), marketEstimate(MARKET, { start: "2027-06-27", end: "2027-06-27" }));
});

test("単価の出どころ: 作付・品目、市況はどこまで広げたか。全期間を使った日が一部だけなら「一部全期間」", () => {
  const market = (estimate) => ({ yen: 250, from: "market", estimate });
  assert.equal(priceSource({ yen: 300, from: "planting" }), "作付");
  assert.equal(priceSource({ yen: 300, from: "crop" }), "品目");
  assert.equal(priceSource(market({ widen: 7, counts: { 7: 6 }, days: 6 })), "市況・前後 7 日");
  assert.equal(priceSource(market({ widen: 14, counts: { 7: 3, 14: 1 }, days: 4 })), "市況・前後 14 日");
  assert.equal(priceSource(market({ widen: "all", counts: { all: 11 }, days: 11 })), "市況・全期間");
  assert.equal(priceSource(market({ widen: "all", counts: { 30: 9, all: 1 }, days: 10 })), "市況・一部全期間");
  // 収穫の計画がない作付（日ごとではなく、全期間から 1 つ推した）
  assert.equal(priceSource(market(marketEstimate(MARKET, null))), "市況・全期間");
});

test("単価の説明: 日ごとに推した日数を、広げた幅ごとに。収穫の計画がなければ、全期間の日数・時期・幅。市況からでなければ空", () => {
  const market = (estimate) => ({ yen: 250, from: "market", estimate });
  assert.equal(priceTitle(market({ widen: 7, counts: { 7: 6 }, days: 6 })), "収穫の予定の 6 日それぞれの卸値から推した単価の平均（前後 7 日の中央値 6 日）");
  assert.equal(
    priceTitle(market({ widen: "all", counts: { all: 1, 7: 3 }, days: 4 })),
    "収穫の予定の 4 日それぞれの卸値から推した単価の平均（前後 7 日の中央値 3 日、市況が足りず全期間の中央値 1 日）",
    "幅の狭い順"
  );
  assert.equal(priceTitle(market(marketEstimate(MARKET, null))), "収穫の予定がないため、市況のある全期間の卸値の中央値（10 日分、2026/06〜2026/07、幅 100〜400 円）");
  assert.equal(priceTitle({ yen: 300, from: "crop" }), "");
});

// 気象の計算と読み取り（app/weather.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accumulate,
  addTwoWeek,
  dailyFromRecords,
  distanceKm,
  nearestStations,
  matchEtrnPoint,
  parseEtrnDaily,
  parseEtrnPoints,
  parseForecast,
  parseStations,
  parseWind,
  weatherIcon,
} from "../app/weather.js";

test("観測所の一覧と、近い順", () => {
  const stations = parseStations({
    100: { kjName: "甲", lat: [30, 30], lon: [130, 0], elems: "11111011" },
    200: { kjName: "乙", lat: [30, 0], lon: [130, 0], elems: "01000000" },
    300: { kjName: "丙", lat: [31, 0], lon: [130, 0], elems: "11112010" },
  });
  assert.deepEqual(stations[0], { code: "100", name: "甲", lat: 30.5, lng: 130, temp: true, rain: true });
  assert.equal(stations[1].temp, false);
  assert.deepEqual(nearestStations(stations, 30, 130, "temp").map((item) => item.code), ["100", "300"]);
  assert.deepEqual(nearestStations(stations, 30, 130, "rain").map((item) => item.code), ["200", "100", "300"]);
  assert.ok(Math.abs(distanceKm(30, 130, 30.5, 130) - 55.6) < 0.2);
});

// 10 分ごとの値。気温は時刻の時の数（1 時台は 1 ℃）、雨は 1 時台だけ 0.5 mm ずつ
function records(date, next, skipHours = []) {
  const out = {};
  const ymd = date.replaceAll("-", "");
  for (let h = 0; h < 24; h += 1) {
    for (let m = 0; m < 60; m += 10) {
      if (!skipHours.includes(h)) {
        out[`${ymd}${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}00`] = { temp: [h, 0], precipitation10m: [h === 1 ? 0.5 : 0, 0] };
      }
    }
  }
  out[`${next.replaceAll("-", "")}000000`] = { temp: [24, 0], precipitation10m: [0, 0] };
  return out;
}

test("日平均気温は毎正時 24 回の平均、降水量は 10 分ごとの合計", () => {
  // 1 時〜24 時の毎正時の値の平均は 12.5。0 時ちょうどの値は前の日の分なので使わない。
  // 雨は 1:00〜1:50 の 6 回ぶん
  assert.deepEqual(dailyFromRecords(records("2026-03-01", "2026-03-02"), "2026-03-01"), { temp_mean: 12.5, temp_max: 24, temp_min: 0, precip: 3 });
  // 毎正時の値が 20 回に満たなければ、日平均気温は欠測
  assert.equal(dailyFromRecords(records("2026-03-01", "2026-03-02", [1, 2, 3, 4, 5]), "2026-03-01").temp_mean, null);
  assert.equal(dailyFromRecords({}, "2026-03-01").precip, null);
});

test("積算は欠測の日を足さず、日付を返す", () => {
  const rows = [
    { date: "2026-03-01", temp_mean: 10, precip: 1 },
    { date: "2026-03-02", temp_mean: null, precip: 0 },
    { date: "2026-03-04", temp_mean: 12, precip: 2.5 },
  ];
  assert.deepEqual(accumulate(rows, "2026-03-01", "2026-03-04", "temp_mean"), { sum: 22, missing: ["2026-03-02", "2026-03-03"] });
  assert.deepEqual(accumulate(rows, "2026-03-01", "2026-03-04", "precip"), { sum: 3.5, missing: ["2026-03-03"] });
});

test("天気コードと風の文", () => {
  assert.deepEqual([100, 101, 201, 302, 400].map(weatherIcon), ["sun", "suncloud", "cloud", "rain", "snow"]);
  assert.deepEqual(parseWind("北東の風　後　北の風　やや強く"), { direction: "北東", degrees: 45, level: "やや強い" });
  assert.deepEqual(parseWind("南南西の風　強く"), { direction: "南南西", degrees: 202.5, level: "強い" });
  assert.equal(parseWind("西の風").level, "ふつう");
  assert.equal(parseWind(""), null);
});

// 府県天気予報と週間天気予報の形（気象庁の forecast/{office}.json）。値は作った値
const days = (list) => list.map((day) => `${day}T00:00:00+09:00`);
const forecast = [
  {
    timeSeries: [
      {
        timeDefines: ["2026-03-01T17:00:00+09:00", ...days(["2026-03-02", "2026-03-03"])],
        areas: [
          { area: { code: "A1" }, weatherCodes: ["100", "201", "300"], winds: ["南西の風　やや強く", "西の風", "北の風　強く"] },
          { area: { code: "A2" }, weatherCodes: ["200", "200", "200"], winds: ["", "", ""] },
        ],
      },
      {
        timeDefines: ["2026-03-01T18:00:00+09:00", "2026-03-02T00:00:00+09:00", "2026-03-02T06:00:00+09:00", "2026-03-02T12:00:00+09:00"],
        areas: [{ area: { code: "A1" }, pops: ["10", "20", "60", "30"] }],
      },
      {
        timeDefines: ["2026-03-02T00:00:00+09:00", "2026-03-02T09:00:00+09:00"],
        areas: [{ area: { code: "P1" }, temps: ["12", "19"] }],
      },
    ],
  },
  {
    timeSeries: [
      { timeDefines: days(["2026-03-02", "2026-03-03", "2026-03-04"]), areas: [{ area: { code: "W" }, weatherCodes: ["201", "200", "101"], pops: ["", "40", "20"] }] },
      { timeDefines: days(["2026-03-02", "2026-03-03", "2026-03-04"]), areas: [{ area: { code: "P1" }, tempsMin: ["", "10", "9"], tempsMax: ["", "18", "17"] }] },
    ],
  },
];

test("予報を、今日から 1 日 1 件にまとめる", () => {
  const result = parseForecast(forecast, { area: "A1", point: "P1" }, "2026-03-01");
  assert.deepEqual(
    result.map((day) => [day.date, day.code, day.pop, day.min, day.max, day.wind?.level ?? null]),
    [
      ["2026-03-01", "100", 10, null, null, "やや強い"],
      ["2026-03-02", "201", 60, 12, 19, "ふつう"],
      ["2026-03-03", "300", 40, 10, 18, "強い"],
      ["2026-03-04", "101", 20, 9, 17, null],
    ]
  );
  // 一次細分区域を選ぶと、その区域の天気
  assert.equal(parseForecast(forecast, { area: "A2" }, "2026-03-01")[0].code, "200");
  // 2 週間気温予報は、週間天気予報にない日だけを、気温だけの日として足す
  const more = addTwoWeek(result, { days: [{ date: "2026-03-04", max: 99, min: 99 }, { date: "2026-03-09", max: 20, min: 11 }] }, "2026-03-01");
  assert.deepEqual(more.slice(-2).map((day) => [day.date, day.max, day.source]), [["2026-03-04", 17, "weekly"], ["2026-03-09", 20, "twoweek"]]);
});

test("気象庁の過去の気象データ: 地点の一覧と、アメダスの観測所との突き合わせ", () => {
  const html =
    `<area onmouseover="javascript:viewPoint('a','0901','甲','コウ','30','30.0','130','0.0','10','1','1','1','1','0','1','9999','99','99','','','','','');">` +
    `<area onmouseover="javascript:viewPoint('a','0901','甲','コウ','30','30.0','130','0.0','10','1','1','1','1','0','1','9999','99','99','','','','','');">` +
    `<area onmouseover="javascript:viewPoint('s','47999','乙','オツ','31','0.0','130','0.0','5','1','1','1','1','1','1','9999','99','99','','','','','');">` +
    `<area onmouseover="javascript:viewPoint('as','bk_no','ch','ch_kn','lat_d','lat_m','lon_d','lon_m','height');">`;
  const points = parseEtrnPoints(html);
  assert.deepEqual(points.map((point) => [point.kind, point.block, point.name, point.lat]), [["a", "0901", "甲", 30.5], ["s", "47999", "乙", 31]]);
  assert.equal(matchEtrnPoint(points, { name: "乙", lat: 31.005, lng: 130 }).block, "47999");
  // 名前が同じでも、離れていれば別の地点
  assert.equal(matchEtrnPoint(points, { name: "乙", lat: 32, lng: 130 }), null);
  assert.equal(matchEtrnPoint(points, { name: "丙", lat: 31, lng: 130 }), null);
});

test("気象庁の過去の気象データ: 日別の表の値と印", () => {
  const row = (cells) => `<tr class="mtx" style="text-align:right;">${cells.map((cell) => `<td class="data_0_0">${cell}</td>`).join("")}</tr>`;
  // アメダス（a）: 日、降水量の合計、最大 1 時間、最大 10 分間、気温の平均、最高、最低
  const a = [
    row(["<a href='#'>1</a>", "0.0", "0.0", "0.0", "21.8", "25.1", "20.0"]),
    row(["2", "--", "--", "--", "23.8)", "28.3", "19.9"]), // 「--」は現象なし（降水量 0）、「)」は準正常値
    row(["3", "1.5", "1.0", "0.5", "24.0]", "26.6", "×"]), // 「]」は資料不足値、「×」は欠測
    row(["4", "///", "///", "///", "///", "///", "///"]), // まだ値のない日
  ].join("");
  assert.deepEqual(parseEtrnDaily(a, "a", 2026, 10), [
    { date: "2026-10-01", temp_mean: 21.8, temp_max: 25.1, temp_min: 20, precip: 0 },
    { date: "2026-10-02", temp_mean: 23.8, temp_max: 28.3, temp_min: 19.9, precip: 0 },
    { date: "2026-10-03", temp_mean: null, temp_max: 26.6, temp_min: null, precip: 1.5 },
  ]);
  // 気象台など（s）: 日、気圧（現地、海面）、降水量の合計、最大 1 時間、最大 10 分間、気温の平均、最高、最低
  const s = row(["17", "1018.5", "1019.4", "0.0", "0.0", "0.0", "26.1", "29.3", "24.0"]);
  assert.deepEqual(parseEtrnDaily(s, "s", 2026, 10), [{ date: "2026-10-17", temp_mean: 26.1, temp_max: 29.3, temp_min: 24, precip: 0 }]);
});

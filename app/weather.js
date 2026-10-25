// 気象。アメダスの観測値と、気象庁の予報。どれも気象庁のサイトが使っている JSON から読む（ブラウザーから直接読める）。
// 仕様の保証はないので、読めないときは空にして、画面に「取れなかった」と出す。
// 2 週間気温予報だけは、ブラウザーから読めないので、Supabase の関数（field-weather）を通して読む
import { addDays, diffDays } from "./schedule.js";

const AMEDAS = "https://www.jma.go.jp/bosai/amedas";
const FORECAST = "https://www.jma.go.jp/bosai/forecast/data/forecast";
const MIN_HOURS = 20; // 日平均気温に要る毎正時の値の数。これより少ない日は欠測にする
export const FETCH_DAYS = 10; // アメダスの値を、さかのぼって取りにいく日数

// ---- 観測所 ----

const degrees = ([deg, min]) => deg + min / 60;

// 2 点のあいだの距離（km）
export function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// 観測所の一覧（amedastable.json）を、番号・名前・緯度経度・気温と雨量を測っているかの形にする
export function parseStations(table) {
  return Object.entries(table).map(([code, item]) => ({
    code,
    name: item.kjName,
    lat: degrees(item.lat),
    lng: degrees(item.lon),
    temp: item.elems?.[0] === "1",
    rain: item.elems?.[1] === "1",
  }));
}

// 基準点から近い順の観測所。kind は "temp"（気温を測っている）か "rain"（雨量を測っている）
export function nearestStations(stations, lat, lng, kind, count = 10) {
  return stations
    .filter((station) => station[kind])
    .map((station) => ({ ...station, km: distanceKm(lat, lng, station.lat, station.lng) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, count);
}

let stationCache = null;
export async function fetchStations() {
  if (!stationCache) {
    const response = await fetch(`${AMEDAS}/const/amedastable.json`);
    if (!response.ok) {
      throw new Error(`観測所の一覧を読めませんでした（${response.status}）`);
    }
    stationCache = parseStations(await response.json());
  }
  return stationCache;
}

// ---- 日ごとの観測値 ----

const compact = (iso) => iso.replaceAll("-", "");

// 10 分ごとの値（キーは "yyyymmddHHMMSS"）から、date の日の値を求める。
// 日平均気温は毎正時（1 時〜24 時）の 24 回の平均、最高と最低は 10 分ごとの値から、降水量は 10 分ごとの量の合計。
// 1 日は 0 時 10 分から 24 時（次の日の 0 時）まで
export function dailyFromRecords(records, date) {
  const from = `${compact(date)}001000`;
  const to = `${compact(addDays(date, 1))}000000`;
  const keys = Object.keys(records)
    .filter((key) => key >= from && key <= to)
    .sort();
  const value = (key, field) => {
    const item = records[key]?.[field];
    return Array.isArray(item) && item[0] !== null && item[0] !== undefined && item[1] === 0 ? item[0] : null;
  };
  const temps = keys.map((key) => value(key, "temp")).filter((v) => v !== null);
  const hourly = keys.filter((key) => key.endsWith("0000")).map((key) => value(key, "temp")).filter((v) => v !== null);
  const rains = keys.map((key) => value(key, "precipitation10m"));
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    temp_mean: hourly.length >= MIN_HOURS ? round1(hourly.reduce((sum, v) => sum + v, 0) / hourly.length) : null,
    temp_max: temps.length ? Math.max(...temps) : null,
    temp_min: temps.length ? Math.min(...temps) : null,
    // 10 分ごとの量が 1 つも取れなければ欠測。取れた分だけ足す
    precip: rains.some((v) => v !== null) ? round1(rains.reduce((sum, v) => sum + (v || 0), 0)) : null,
  };
}

// 観測所の、date の日の値を、気象庁から取る。3 時間ごとのファイルを 8 つと、次の日の 0 時のファイルを読む
export async function fetchDay(station, date) {
  const files = [0, 3, 6, 9, 12, 15, 18, 21].map((hour) => `${compact(date)}_${String(hour).padStart(2, "0")}`);
  files.push(`${compact(addDays(date, 1))}_00`);
  const records = {};
  for (const file of files) {
    const response = await fetch(`${AMEDAS}/data/point/${station}/${file}.json`);
    if (response.ok) {
      Object.assign(records, await response.json());
    }
  }
  return dailyFromRecords(records, date);
}

// from から to までの積算温度（日平均気温の合計）と積算降水量。欠測の日は足さず、日付を返す
export function accumulate(rows, from, to, field) {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  let sum = 0;
  const missing = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const value = byDate.get(day)?.[field];
    if (value === null || value === undefined) {
      missing.push(day);
    } else {
      sum += Number(value);
    }
  }
  return { sum, missing };
}

// ---- 予報 ----

// 天気コード（気象庁）を、アイコンの種類にする。100 番台は晴れ、200 番台はくもり、300 番台は雨、400 番台は雪
export function weatherIcon(code) {
  const n = Number(code);
  if (n === 100 || n === 123 || n === 124 || n === 130 || n === 131) {
    return "sun";
  }
  if (n >= 100 && n < 200) {
    return "suncloud";
  }
  if (n >= 200 && n < 300) {
    return "cloud";
  }
  if (n >= 300 && n < 400) {
    return "rain";
  }
  return n >= 400 && n < 500 ? "snow" : "cloud";
}

export const ICON_LABELS = { sun: "晴れ", suncloud: "晴れ時々くもり", cloud: "くもり", rain: "雨", snow: "雪" };

const COMPASS = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"];

// 風の予報の文（「北の風　後　北東の風　やや強く」）から、最初の風向（風が吹いてくる方角の角度）と強さ
export function parseWind(text) {
  if (!text) {
    return null;
  }
  const direction = [...COMPASS].sort((a, b) => b.length - a.length).find((name) => text.startsWith(`${name}の風`));
  const level = text.includes("非常に強く") ? "非常に強い" : text.includes("やや強く") ? "やや強い" : text.includes("強く") ? "強い" : "ふつう";
  return direction ? { direction, degrees: COMPASS.indexOf(direction) * 22.5, level } : { direction: "", degrees: null, level };
}

const dateOf = (time) => time.slice(0, 10);

// 府県天気予報と週間天気予報（forecast/{office}.json）から、今日から 7 日分を 1 日 1 件にまとめる。
// area は一次細分区域、point は気温の地点。見つからなければ最初のものを使う
export function parseForecast(json, { area, point } = {}, today) {
  const pick = (areas, code) => areas.find((item) => item.area.code === code) || areas[0];
  const days = new Map();
  const dayOf = (date) => {
    if (!days.has(date)) {
      days.set(date, { date, code: null, pop: null, max: null, min: null, wind: null, source: "weekly" });
    }
    return days.get(date);
  };
  const [short, weekly] = json;
  if (short) {
    const [weather, pops, temps] = short.timeSeries;
    const w = pick(weather.areas, area);
    weather.timeDefines.forEach((time, i) => {
      const day = dayOf(dateOf(time));
      day.code = w.weatherCodes?.[i] || day.code;
      day.wind = parseWind(w.winds?.[i]);
      day.source = "short";
    });
    if (pops) {
      const p = pick(pops.areas, area);
      pops.timeDefines.forEach((time, i) => {
        const value = Number(p.pops?.[i]);
        if (p.pops?.[i] !== "" && Number.isFinite(value)) {
          const day = dayOf(dateOf(time));
          day.pop = Math.max(day.pop ?? 0, value);
        }
      });
    }
    if (temps) {
      const t = pick(temps.areas, point);
      temps.timeDefines.forEach((time, i) => {
        const value = Number(t.temps?.[i]);
        if (t.temps?.[i] === "" || !Number.isFinite(value)) {
          return;
        }
        // 0 時の値は朝の最低気温、9 時の値は日中の最高気温
        const day = dayOf(dateOf(time));
        if (time.slice(11, 13) === "00") {
          day.min = value;
        } else {
          day.max = value;
        }
      });
    }
  }
  if (weekly) {
    const [weather, temps] = weekly.timeSeries;
    const w = weather.areas[0];
    weather.timeDefines.forEach((time, i) => {
      const day = dayOf(dateOf(time));
      day.code = day.code || w.weatherCodes?.[i] || null;
      if (day.pop === null && w.pops?.[i] !== "" && w.pops?.[i] !== undefined) {
        day.pop = Number(w.pops[i]);
      }
    });
    if (temps) {
      const t = pick(temps.areas, point);
      temps.timeDefines.forEach((time, i) => {
        const day = dayOf(dateOf(time));
        if (day.min === null && t.tempsMin?.[i] !== "" && t.tempsMin?.[i] !== undefined) {
          day.min = Number(t.tempsMin[i]);
        }
        if (day.max === null && t.tempsMax?.[i] !== "" && t.tempsMax?.[i] !== undefined) {
          day.max = Number(t.tempsMax[i]);
        }
      });
    }
  }
  return [...days.values()].filter((day) => day.date >= today && diffDays(today, day.date) < 7).sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchForecast(office) {
  const response = await fetch(`${FORECAST}/${office}.json`);
  if (!response.ok) {
    throw new Error(`予報を読めませんでした（${response.status}）`);
  }
  return response.json();
}

// 府県予報区と一次細分区域の一覧（area.json）
let areaCache = null;
export async function fetchAreas() {
  if (!areaCache) {
    const response = await fetch("https://www.jma.go.jp/bosai/common/const/area.json");
    if (!response.ok) {
      throw new Error(`予報区の一覧を読めませんでした（${response.status}）`);
    }
    areaCache = await response.json();
  }
  return areaCache;
}

// 2 週間気温予報（field-weather の関数が返す形 { days: [{ date, max, min }] }）を、予報の日の並びに足す。
// 週間天気予報にない日だけを、気温だけの日として足す
export function addTwoWeek(days, twoWeek, today) {
  const known = new Set(days.map((day) => day.date));
  const extra = (twoWeek?.days || [])
    .filter((day) => day.date > today && !known.has(day.date) && diffDays(today, day.date) < 14)
    .map((day) => ({ date: day.date, code: null, pop: null, max: day.max ?? null, min: day.min ?? null, wind: null, source: "twoweek" }));
  return [...days, ...extra].sort((a, b) => a.date.localeCompare(b.date));
}

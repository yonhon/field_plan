// 気象の設定（圃場図の右の欄）と、日ごとの観測値の取得。
// 観測値は、GitHub Actions が毎日取って DB に入れる（scripts/fetch-weather.mjs）。アプリも、開いたときに、
// まだ DB にない直近の日（FETCH_DAYS 日前から昨日まで）を取って入れる（Actions が止まったときの予備）。
// それでも取りこぼした日は、気象庁の CSV から入れる（scripts/import_jma_csv.py）
import { notify } from "./dialog.js";
import { record } from "./journal.js";
import { addDays, localToday } from "./schedule.js";
import { FETCH_DAYS, fetchAreas, fetchDay, fetchForecast, fetchStations, nearestStations } from "./weather.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let ctx = null; // { state, setStatus, onWeatherChanged }
let syncing = false;
let twoWeekList = null;
const forecastCache = new Map(); // 府県予報区 → { at, json }
const FORECAST_TTL_MS = 30 * 60 * 1000;

const state = () => ctx.state;
export const weatherSettings = () => state().field.weather || {};

// 府県予報区の予報（30 分は同じものを使う）
export async function officeForecast(office) {
  const cached = forecastCache.get(office);
  if (cached && Date.now() - cached.at < FORECAST_TTL_MS) {
    return cached.json;
  }
  const json = await fetchForecast(office);
  forecastCache.set(office, { at: Date.now(), json });
  return json;
}

// ---- 設定の欄 ----

const option = (value, label, selected) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;

export async function renderWeatherSettings() {
  if (!ctx || $("appView").hidden) {
    return;
  }
  const field = state().field;
  const settings = weatherSettings();
  $("baseLat").value = field.base_lat ?? "";
  $("baseLng").value = field.base_lng ?? "";
  const hasBase = Number.isFinite(field.base_lat) && Number.isFinite(field.base_lng);
  try {
    const stations = await fetchStations();
    const list = (kind, selected) => {
      const near = hasBase ? nearestStations(stations, field.base_lat, field.base_lng, kind, 12) : [];
      const current = selected && !near.some((item) => item.code === selected) ? stations.find((item) => item.code === selected) : null;
      return (
        option("", hasBase ? "選んでください" : "先に基準点の緯度と経度を入れてください", selected || "") +
        [...(current ? [current] : []), ...near].map((item) => option(item.code, `${item.name}${item.km !== undefined ? `（${item.km.toFixed(1)} km）` : ""}`, selected)).join("")
      );
    };
    $("tempStation").innerHTML = list("temp", settings.temp_station);
    $("rainStation").innerHTML = list("rain", settings.rain_station);
  } catch (error) {
    $("weatherStatus").textContent = `観測所の一覧を読めませんでした: ${error.message}`;
  }
  try {
    const areas = await fetchAreas();
    $("forecastOffice").innerHTML =
      option("", "選んでください", settings.office || "") +
      Object.entries(areas.offices)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, item]) => option(code, item.name, settings.office))
        .join("");
    const children = settings.office ? areas.offices[settings.office]?.children || [] : [];
    $("forecastArea").innerHTML = option("", children.length ? "選んでください" : "先に府県予報区を選んでください", settings.area || "") + children.map((code) => option(code, areas.class10s[code]?.name || code, settings.area)).join("");
  } catch (error) {
    $("weatherStatus").textContent = `予報区の一覧を読めませんでした: ${error.message}`;
  }
  // 予報の気温の地点は、その府県予報区の予報に出てくる地点から選ぶ
  let points = [];
  if (settings.office) {
    try {
      const json = await officeForecast(settings.office);
      const seen = new Map();
      for (const part of json) {
        for (const series of part.timeSeries) {
          for (const item of series.areas) {
            if (item.temps || item.tempsMax) {
              seen.set(item.area.code, item.area.name);
            }
          }
        }
      }
      points = [...seen.entries()];
    } catch {
      // 予報を読めなければ、地点は選べない
    }
  }
  $("forecastPoint").innerHTML = option("", points.length ? "選んでください" : "先に府県予報区を選んでください", settings.point || "") + points.map(([code, name]) => option(code, name, settings.point)).join("");
  if (!twoWeekList) {
    twoWeekList = await state()
      .store.twoWeekStations()
      .catch(() => []);
  }
  $("twoweekStation").innerHTML =
    option("", (twoWeekList || []).length ? "選んでください" : "地点の一覧を読めませんでした", String(settings.twoweek || "")) +
    (twoWeekList || []).map((item) => option(String(item.no), item.name, String(settings.twoweek || ""))).join("");
  renderStatus();
}

function renderStatus(extra = "") {
  const settings = weatherSettings();
  const parts = [];
  if (!settings.temp_station || !settings.rain_station) {
    parts.push("観測所を選ぶと、積算温度と積算降水量が出ます。");
  }
  if (!settings.office) {
    parts.push("府県予報区を選ぶと、予報が出ます。");
  }
  $("weatherStatus").textContent = [extra, ...parts].filter(Boolean).join(" ");
}

async function saveSettings(change, text) {
  const field = state().field;
  const before = { base_lat: field.base_lat, base_lng: field.base_lng, weather: { ...weatherSettings() } };
  change(field);
  try {
    await state().store.saveFieldWeather(field.id, { base_lat: field.base_lat ?? null, base_lng: field.base_lng ?? null, weather: field.weather || {} });
    record({ kind: "field.weather", plan: false, target: ["field", field.id], text });
    ctx.setStatus("保存しました");
  } catch (error) {
    Object.assign(field, before);
    notify(`気象の設定を保存できませんでした: ${error.message}`);
  }
  await renderWeatherSettings();
  syncWeather();
  ctx.onWeatherChanged?.();
}

function onChange(event) {
  const el = event.target;
  const set = (key, value) => (field) => {
    field.weather = { ...(field.weather || {}), [key]: value || null };
  };
  if (el.id === "baseLat" || el.id === "baseLng") {
    const value = el.value.trim() === "" ? null : Number(el.value);
    if (value !== null && !Number.isFinite(value)) {
      return;
    }
    saveSettings((field) => {
      field[el.id === "baseLat" ? "base_lat" : "base_lng"] = value;
    }, "圃場の基準点の緯度経度を変更");
  } else if (el.id === "tempStation") {
    saveSettings(set("temp_station", el.value), "気温の観測所を変更");
  } else if (el.id === "rainStation") {
    saveSettings(set("rain_station", el.value), "雨量の観測所を変更");
  } else if (el.id === "forecastOffice") {
    saveSettings((field) => {
      field.weather = { ...(field.weather || {}), office: el.value || null, area: null, point: null };
    }, "府県予報区を変更");
  } else if (el.id === "forecastArea") {
    saveSettings(set("area", el.value), "予報の区域を変更");
  } else if (el.id === "forecastPoint") {
    saveSettings(set("point", el.value), "予報の気温の地点を変更");
  } else if (el.id === "twoweekStation") {
    saveSettings(set("twoweek", el.value ? Number(el.value) : null), "2 週間気温予報の地点を変更");
  }
}

// ---- 日ごとの観測値の取得 ----

// 選んだ観測所の、まだ DB にない直近の日（FETCH_DAYS 日前から昨日まで）を気象庁から取って入れる
export async function syncWeather() {
  const settings = weatherSettings();
  const stations = [...new Set([settings.temp_station, settings.rain_station].filter(Boolean))];
  if (syncing || !stations.length) {
    return;
  }
  syncing = true;
  const today = localToday();
  const from = addDays(today, -FETCH_DAYS);
  const to = addDays(today, -1);
  try {
    const have = await state().store.loadWeather(stations, from, to);
    // 昨日の分は、あとから直されることがあるので取り直す
    const known = new Set(have.filter((row) => row.date < to).map((row) => `${row.station}|${row.date}`));
    const rows = [];
    for (const station of stations) {
      for (let day = from; day <= to; day = addDays(day, 1)) {
        if (!known.has(`${station}|${day}`)) {
          const value = await fetchDay(station, day);
          if (value.temp_mean !== null || value.precip !== null) {
            rows.push({ station, date: day, ...value, source: "amedas", fetched_at: new Date().toISOString() });
          }
        }
      }
    }
    await state().store.saveWeather(rows);
    if (rows.length) {
      ctx.onWeatherChanged?.();
    }
  } catch (error) {
    ctx.setStatus(`気象の値を取れませんでした: ${error.message}`);
  } finally {
    syncing = false;
  }
}

export function initWeather(context) {
  ctx = context;
  $("weatherPanel").addEventListener("change", onChange);
}

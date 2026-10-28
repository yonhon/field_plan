// 「作付の詳細」の画面。作付 1 つ（または区画 1 つ）について、計画と実績を 1 つの画面で見る。
// 工程表の行の名前から開く。表示（計画／実績／計画と実績）は工程表と共有する
import { confirmAction, notify } from "./dialog.js";
import { record } from "./journal.js";
import { openLogEditor, openPlanEditor, uncancelWork } from "./log-view.js";
import { bedAreas, compressedAxis, dayGap, firstHarvestDay, inputText, logEnd, plantingStart, shiftAfterActual, specDiff, specText, usageTable } from "./logs.js";
import { NOTICE_URL, famicEnabled } from "./pesticide.js";
import { WORK_COLORS, addDays, diffDays, existsOn, harvestEnd, isManagement, localToday, workName } from "./schedule.js";
import { ICON_LABELS, accumulate, addTwoWeek, fetchAreas, fetchStations, parseForecast, weatherIcon } from "./weather.js";
import { officeForecast, weatherSettings } from "./weather-view.js";
import {
  actualSpans,
  anyTypeLabel,
  bedTarget,
  blockTarget,
  currentActuals,
  ganttMode,
  isActivePlan,
  modeButtons,
  setGanttMode,
} from "./schedule-view.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const MIN_GAP_DAYS = 3; // これ以上作業のない期間は、詰めて表示する

let ctx = null; // { state, showView, openInSchedule, setStatus }
const target = { kind: null, id: null }; // 開いている作付（planting）か区画（block）
// 読み込んだ観測値と予報。画面を開いたあとで読み、読み終えたら描き直す
const weather = { key: "", rows: null, loading: false };
const forecast = { key: "", days: null, error: "", loading: false };
let stationNames = null;
let wx = null; // いま描いている作付の気象の表示（作業の表の列で使う）

const state = () => ctx.state;
const bySeq = (a, b) => a.seq - b.seq;

function formatDay(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${month}/${day}（${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}）`;
}

const shortDay = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const rangeText = (start, end) => (!start ? "－" : start === end || !end ? formatDay(start) : `${formatDay(start)}〜${formatDay(end)}`);

export function openPlantingDetail(kind, id) {
  Object.assign(target, { kind, id });
}

// 開いている作付（区画）。画面の URL に書く
export const plantingTarget = () => ({ ...target });

// 開いている相手の、区画・畝・作付と、計画の作業、記録
function context() {
  const s = state();
  if (target.kind === "block") {
    const block = s.blocks.find((item) => item.id === target.id);
    if (!block) {
      return null;
    }
    const works = s.works.filter((work) => work.block_id === block.id).sort(bySeq);
    return { block, bed: null, planting: null, works, ownWorks: works, matches: blockTarget(block.id) };
  }
  const planting = s.plantings.find((item) => item.id === target.id);
  const bed = planting && s.beds.find((item) => item.id === planting.bed_id);
  const block = bed && s.blocks.find((item) => item.id === bed.block_id);
  if (!block) {
    return null;
  }
  const ownWorks = s.works.filter((work) => work.planting_id === planting.id).sort(bySeq);
  const blockWorks = s.works.filter((work) => work.block_id === block.id).sort(bySeq);
  // 区画の作業も、この作付の前の作業として並べる
  const matchesBed = (item) => item.planting_id === planting.id;
  return { block, bed, planting, works: [...blockWorks, ...ownWorks], ownWorks, blockWorks, matches: (item) => matchesBed(item) || blockTarget(block.id)(item) };
}

// 前後に移る相手。作付なら工程表の並び（区画ごと、畝の順、作付の順）、区画なら区画の並び
function neighbours(c) {
  const s = state();
  const list =
    target.kind === "block"
      ? s.blocks.map((block) => ({ kind: "block", id: block.id, label: block.name }))
      : s.blocks.flatMap((block) =>
          s.beds
            .filter((bed) => bed.block_id === block.id)
            .sort(bySeq)
            .flatMap((bed) =>
              s.plantings
                .filter((planting) => planting.bed_id === bed.id)
                .sort(bySeq)
                .map((planting) => ({ kind: "planting", id: planting.id, label: `畝${bed.seq} ${planting.crop_name}`.trim() }))
            )
        );
  const index = list.findIndex((item) => item.id === target.id);
  return { prev: index > 0 ? list[index - 1] : null, next: index >= 0 && index < list.length - 1 ? list[index + 1] : null, all: list, c };
}

function plannedSpec(planting) {
  const crop = state().crops.find((item) => item.id === planting.crop_id);
  const value = (key) => planting[key] ?? crop?.[key] ?? null;
  return { plant_gap_cm: value("plant_gap_cm"), row_gap_cm: value("row_gap_cm"), row_count: value("row_count"), staggered: Boolean(value("staggered")) };
}

// 品目の設定値（作付に値がなければ使う値。次に作付を作るときの初期値）
function cropSpec(crop) {
  return { plant_gap_cm: crop.plant_gap_cm ?? null, row_gap_cm: crop.row_gap_cm ?? null, row_count: crop.row_count ?? null, staggered: Boolean(crop.staggered) };
}

function plannedSpecText(planting) {
  return specSummary(plannedSpec(planting));
}

function specSummary(spec) {
  return [
    spec.plant_gap_cm ? `株間 ${spec.plant_gap_cm}cm` : "",
    spec.row_gap_cm ? `条間 ${spec.row_gap_cm}cm` : "",
    spec.row_count ? `${spec.row_count} 条` : "",
    spec.staggered ? "千鳥" : "",
  ]
    .filter(Boolean)
    .join("・");
}

// ---- 描画 ----

export function renderPlantingDetail() {
  if (!ctx || $("plantingView").hidden) {
    return;
  }
  const c = context();
  if (!c) {
    $("plantingBody").innerHTML =
      '<div class="detail-head"><button type="button" class="text-btn" data-act="back">← 工程表に戻る</button></div>' +
      '<p class="muted">この作付（区画）は、いま開いているプランにはありません。</p>';
    return;
  }
  const mode = ganttMode();
  const active = isActivePlan();
  const actuals = currentActuals();
  const logs = active ? (state().logs || []).filter((log) => log.targets.some(c.matches)) : [];
  wx = weatherView(c, actuals, active);
  $("plantingBody").innerHTML =
    headHtml(c, active) +
    `<div class="row detail-modes">${active ? `<div class="log-modes" role="group" aria-label="表示">${modeButtons(mode)}</div>` : ""}` +
    `${active ? "" : '<span class="muted">実績は、実際に使うプランを開くと出せます。</span>'}</div>` +
    `<div class="detail-layout"><div class="detail-main">` +
    `<section class="panel">${timelineHtml(c, mode, actuals)}</section>` +
    (mode === "both" ? diffHtml(c, actuals, logs) : "") +
    `<section class="panel"><div class="panel-heading"><h2>作業</h2>${tableNote(mode) ? `<span class="muted">${tableNote(mode)}</span>` : ""}</div>${tableHtml(c, mode, actuals, logs)}</section>` +
    `</div><aside class="detail-aside">${asideHtml(c, active)}</aside></div>`;
}

// ---- 気象 ----

// 作付の定植・播種の日。計画と実績の両方があれば実績を優先し、定植・播種の記録があればその最初の日
// （計画の作業につながっていない記録も含む）、なければ計画の定植・播種の開始日
function plantedDate(c, actuals) {
  const recorded = (state().logs || [])
    .filter((log) => log.work_type === "plant" && log.targets.some((target) => target.planting_id === c.planting.id))
    .map((log) => log.date)
    .sort()[0];
  if (recorded) {
    return recorded;
  }
  const plant = c.ownWorks.find((work) => work.work_type === "plant" && !work.cancelled_on);
  return plant ? actuals.get(plant.id)?.start || plant.plan_start || null : null;
}

// 作業の表の気温・降水量の列と、積算の欄に使う値。観測値はまだ読んでいなければ読みにいく
function weatherView(c, actuals, active) {
  const settings = weatherSettings();
  const planted = c.planting && active ? plantedDate(c, actuals) : null;
  const stations = [settings.temp_station, settings.rain_station].filter(Boolean);
  if (!planted || stations.length < 2) {
    return { planted, ready: false, configured: stations.length >= 2 };
  }
  const today = localToday();
  const key = `${settings.temp_station}|${settings.rain_station}|${planted}|${today}`;
  if (weather.key !== key && !weather.loading) {
    weather.loading = true;
    state()
      .store.loadWeather([...new Set(stations)], planted, today)
      .then((rows) => Object.assign(weather, { key, rows }))
      .catch(() => Object.assign(weather, { key, rows: [] }))
      .finally(() => {
        weather.loading = false;
        renderPlantingDetail();
      });
  }
  if (!stationNames) {
    fetchStations()
      .then((list) => {
        stationNames = new Map(list.map((item) => [item.code, item.name]));
        renderPlantingDetail();
      })
      .catch(() => (stationNames = new Map()));
  }
  const rows = weather.key === key ? weather.rows || [] : null;
  const temps = (rows || []).filter((row) => row.station === settings.temp_station);
  const rains = (rows || []).filter((row) => row.station === settings.rain_station);
  return {
    planted,
    configured: true,
    ready: Boolean(rows),
    settings,
    // date の日の値と、定植からその日までの積算
    at(date) {
      const day = (list, field) => list.find((row) => row.date === date)?.[field] ?? null;
      return {
        temp: day(temps, "temp_mean"),
        rain: day(rains, "precip"),
        tempSum: accumulate(temps, planted, date, "temp_mean"),
        rainSum: accumulate(rains, planted, date, "precip"),
      };
    },
  };
}

function wxCell(date) {
  if (!wx?.planted || !wx.configured || !date || date < wx.planted || date >= localToday()) {
    return "<td></td>";
  }
  if (!wx.ready) {
    return '<td class="muted">…</td>';
  }
  const value = wx.at(date);
  const number = (v, digits) => (v === null || v === undefined ? "欠測" : Number(v).toFixed(digits));
  return (
    `<td><div class="wx-cell"><div><span class="wx-temp">${value.temp === null ? "欠測" : `${number(value.temp, 1)} ℃`}</span>` +
    `<span class="wx-sum">積算 ${Math.round(value.tempSum.sum)} ℃日</span></div>` +
    `<div><span class="wx-rain">${value.rain === null ? "欠測" : `${number(value.rain, 1)} mm`}</span>` +
    `<span class="wx-sum">積算 ${value.rainSum.sum.toFixed(1)} mm</span></div></div></td>`
  );
}

// ---- 右の欄 ----

function asideHtml(c, active) {
  if (!c.planting) {
    return "";
  }
  return [famicEnabled() && active ? usageHtml(c) : "", accumulationHtml(), forecastHtml()].join("");
}

// 農薬の使用回数。有効成分ごと（その下に本剤ごと）の回数と上限
function usageHtml(c) {
  const logs = state().logs || [];
  const table = usageTable(logs, c.planting.id, c.planting.crop_name);
  if (!table.ingredients.length && !table.products.length) {
    return '<section class="panel"><h2>農薬の使用回数</h2><p class="muted">この作付の防除の実績は、まだありません。</p></section>';
  }
  const over = (item) => item.max && item.count >= item.max;
  const rows = [
    ...table.ingredients.map(
      (item) =>
        `<tr><td>${escapeHtml(item.name)}</td><td class="num${over(item) ? " usage-over" : ""}">${item.count}</td><td class="num">${item.max ?? "-"}</td></tr>`
    ),
    ...table.products.map(
      (item) =>
        `<tr class="usage-product"><td>本剤 ${escapeHtml(item.name)}</td><td class="num${over(item) ? " usage-over" : ""}">${item.count}</td><td class="num">${item.max ?? "-"}</td></tr>`
    ),
  ].join("");
  const notes = [
    ...table.ingredients.filter(over).map((item) => `${item.name}は上限に達しています。`),
    ...table.ingredients.filter((item) => item.condition).map((item) => `${item.name}の総使用回数には条件があります: ${item.condition}`),
  ];
  const first = firstHarvestDay(logs, c.planting.id, c.planting.crop_name);
  return (
    `<section class="panel"><h2>農薬の使用回数</h2><table class="work-table usage-table"><thead><tr><th>成分・本剤</th><th>回数</th><th>上限</th></tr></thead><tbody>${rows}</tbody></table>` +
    (notes.length ? `<ul class="famic-warnings">${notes.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : "") +
    (first ? `<p class="muted">防除の使用時期の基準を満たす最初の収穫日: ${formatDay(first)}</p>` : "") +
    `<p class="muted"><a href="${NOTICE_URL}" target="_blank" rel="noopener">総使用回数についての注意事項（FAMIC）</a></p></section>`
  );
}

// 定植からの積算温度・積算降水量
function accumulationHtml() {
  const title = "<h2>定植からの積算温度・積算降水量</h2>";
  if (!wx?.configured) {
    return `<section class="panel">${title}<p class="muted">圃場図の「気象」の欄で、気温と雨量の観測所を選ぶと出ます。</p></section>`;
  }
  if (!wx.planted) {
    return `<section class="panel">${title}<p class="muted">定植・播種の日が決まると出ます。</p></section>`;
  }
  if (!wx.ready) {
    return `<section class="panel">${title}<p class="muted">読み込み中…</p></section>`;
  }
  const yesterday = addDays(localToday(), -1);
  if (wx.planted > yesterday) {
    return `<section class="panel">${title}<p class="muted">定植・播種の日（${formatDay(wx.planted)}）のあとから積算します。</p></section>`;
  }
  const value = wx.at(yesterday);
  const missing = [...new Set([...value.tempSum.missing, ...value.rainSum.missing])].sort();
  const name = (code) => stationNames?.get(code) || code;
  return (
    `<section class="panel">${title}<div class="wx-totals"><div><span class="muted">${formatDay(wx.planted)}から</span><strong class="wx-temp">${Math.round(value.tempSum.sum)} <small>℃日</small></strong></div>` +
    `<div><span class="muted">${formatDay(wx.planted)}から</span><strong class="wx-rain">${value.rainSum.sum.toFixed(1)} <small>mm</small></strong></div></div>` +
    `<p class="muted">気温: ${escapeHtml(name(wx.settings.temp_station))}・雨量: ${escapeHtml(name(wx.settings.rain_station))}。昨日までの合計です。</p>` +
    (missing.length
      ? `<p class="muted wx-missing">値のない日（欠測か、まだ取れていない日）: ${missing.length > 6 ? `${missing.slice(0, 6).map(shortDay).join("、")} ほか ${missing.length - 6} 日` : missing.map(shortDay).join("、")}。積算に含まれていません。</p>`
      : "") +
    '<p class="muted wx-source">気象庁のデータを加工して作成</p></section>'
  );
}

const COMPASS_ARROW = (degrees) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(${degrees}deg)" aria-hidden="true"><path d="M12 4v16M6 14l6 6 6-6"></path></svg>`;
const ICONS = {
  sun: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d98a00" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>',
  suncloud:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3" stroke="#d98a00"></circle><path d="M9 2v1.5M3 8h1.5M4.8 3.8l1 1M13.2 3.8l-1 1" stroke="#d98a00"></path><path d="M9 20h9a3.5 3.5 0 000-7 5 5 0 00-9.6 1.4A3 3 0 009 20z" stroke="#6f8083"></path></svg>',
  cloud: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6f8083" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18h10a4 4 0 000-8 6 6 0 00-11.3 1.5A3.5 3.5 0 007 18z"></path></svg>',
  rain: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2f6fae" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 15h10a4 4 0 000-8 6 6 0 00-11.3 1.5A3.5 3.5 0 007 15z"></path><path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3"></path></svg>',
  snow: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6f8083" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"></path></svg>',
};

// これから 2 週間の予報。予報はまだ読んでいなければ読みにいく
// 予報の出典。選んだ区域と地点の名前を書く。2 週間気温予報を読めなかったときは、その知らせを先頭に出し、出典から外す
function forecastSource(settings) {
  const office = `${forecast.areaName ? `${forecast.areaName}の` : ""}府県天気予報`;
  const twoWeek = settings.twoweek && !forecast.twoWeekFailed ? `・${forecast.twoWeekName ? `${forecast.twoWeekName}の` : ""}2 週間気温予報` : "";
  const failed = forecast.twoWeekFailed ? '<span class="error">2 週間気温予報を読めませんでした。</span>' : "";
  return `<p class="muted wx-source">${failed}出典: 気象庁の予報（${escapeHtml(office + twoWeek)}）を加工して作成</p>`;
}

function forecastHtml() {
  const settings = weatherSettings();
  const title = "<h2>これから 2 週間の予報</h2>";
  if (!settings.office) {
    return `<section class="panel">${title}<p class="muted">圃場図の「気象」の欄で、府県予報区を選ぶと出ます。</p></section>`;
  }
  const today = localToday();
  const key = `${settings.office}|${settings.area}|${settings.point}|${settings.twoweek}|${today}`;
  if (forecast.key !== key && !forecast.loading) {
    forecast.loading = true;
    Promise.all([
      officeForecast(settings.office),
      // 2 週間気温予報を読めなくても、週間天気予報の分は出す（読めなかったことだけを知らせる）
      settings.twoweek ? state().store.twoWeek(settings.twoweek).catch(() => false) : null,
      // 出典に書く区域の名前（予報区の一覧は、気象の欄でも読んでいるので、手元に残っていればそれを使う）
      fetchAreas().catch(() => null),
    ])
      .then(([json, twoWeek, areas]) =>
        Object.assign(forecast, {
          key,
          days: addTwoWeek(parseForecast(json, settings, today), twoWeek || null, today),
          error: "",
          twoWeekFailed: twoWeek === false,
          areaName: areas?.class10s?.[settings.area]?.name || areas?.offices?.[settings.office]?.name || "",
          twoWeekName: twoWeek?.name || "",
        })
      )
      .catch((error) => Object.assign(forecast, { key, days: null, error: error.message }))
      .finally(() => {
        forecast.loading = false;
        renderPlantingDetail();
      });
  }
  if (forecast.key !== key) {
    return `<section class="panel">${title}<p class="muted">読み込み中…</p></section>`;
  }
  if (!forecast.days) {
    return `<section class="panel">${title}<p class="muted">予報を取れませんでした（${escapeHtml(forecast.error)}）。</p></section>`;
  }
  const rows = forecast.days
    .map((day, i) => {
      const previous = forecast.days[i - 1];
      const divider = previous && previous.source !== day.source ? " wx-divider" : "";
      const icon = day.code ? weatherIcon(day.code) : null;
      const [y, m, d] = day.date.split("-").map(Number);
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      const trend = day.source === "twoweek";
      return (
        `<tr class="${divider.trim()}${trend ? " wx-trend" : ""}"><td class="wx-day${weekday === 0 ? " is-sun" : weekday === 6 ? " is-sat" : ""}">${formatDay(day.date)}</td>` +
        `<td class="wx-icon">${icon ? `<span role="img" aria-label="${ICON_LABELS[icon]}">${ICONS[icon]}</span>` : ""}</td>` +
        `<td class="num wx-temps"><span class="wx-temp">${day.max === null ? "" : `${day.max}℃`}</span><br><span class="wx-rain">${day.min === null ? "" : `${day.min}℃`}</span></td>` +
        `<td class="num wx-pop">${day.pop === null ? "" : `${day.pop}%`}</td>` +
        `<td class="wx-wind">${
          day.wind
            ? `${day.wind.degrees === null ? "" : `<span role="img" aria-label="${escapeHtml(day.wind.direction)}の風">${COMPASS_ARROW(day.wind.degrees)}</span>`}<br><span class="${day.wind.level === "ふつう" ? "muted" : "wx-strong"}">${escapeHtml(day.wind.level)}</span>`
            : ""
        }</td></tr>`
      );
    })
    .join("");
  return (
    `<section class="panel">${title}<table class="wx-forecast"><thead><tr><th>日</th><th>天気</th><th>気温</th><th>降水確率</th><th>風</th></tr></thead><tbody>${rows}</tbody></table>` +
    // 出典だけを書く。2 週間気温予報を読めなかったときは、その知らせを先頭に出し、出典からも外す
    forecastSource(settings) +
    "</section>"
  );
}

function headHtml(c, active) {
  const { prev, next } = neighbours(c);
  let title;
  let info = "";
  if (c.planting) {
    const many = state().plantings.filter((item) => item.bed_id === c.bed.id).length > 1;
    title = `${c.block.name} 畝${c.bed.seq} ${c.planting.crop_name || ""}${many ? `（作付 ${c.planting.seq}）` : ""}`;
    const crop = state().crops.find((item) => item.id === c.planting.crop_id);
    const mulch = c.planting.mulch ?? crop?.mulch;
    const today = localToday();
    const live = state().beds.filter((bed) => bed.block_id === c.block.id && existsOn(bed.start_date, bed.removed_on, today));
    const area = bedAreas(c.block, live.some((bed) => bed.id === c.bed.id) ? live : [c.bed]).get(c.bed.id);
    const end = harvestEnd(c.ownWorks);
    info = [mulch ? "マルチ" : "裸地", area ? `畝＋通路 ${area.toFixed(1)} ㎡` : "", end ? `収穫完了予定 ${formatDay(end)}` : ""].filter(Boolean).join("・");
  } else {
    title = `${c.block.name}（区画の作業）`;
  }
  const go = (item, arrow) =>
    item ? `<button type="button" class="chip-btn" data-act="go" data-kind="${item.kind}" data-id="${item.id}">${arrow === "prev" ? "← " : ""}${escapeHtml(item.label)}${arrow === "next" ? " →" : ""}</button>` : "";
  const recordButton = active && c.planting ? '<button type="button" class="primary-btn" data-act="record">＋ この作付の作業を入力する</button>' : "";
  return (
    `<div class="detail-head"><button type="button" class="text-btn" data-act="back">← 工程表に戻る</button>` +
    `<h2>${escapeHtml(title)}</h2><span class="muted">${escapeHtml(info)}</span>` +
    `<div class="detail-nav">${recordButton}${go(prev, "prev")}${go(next, "next")}</div></div>`
  );
}

const tableNote = (mode) =>
  ({
    plan: "計画の作業です。日付を押すと、計画を直す窓を開きます。",
    act: "実績だけです。日付を押すと、実績を直す窓を開きます。",
  })[mode];

// 工程の小さな図。作業の種類ごとの行に、計画の帯と実績の帯を重ねる。作業のない期間は詰める
function timelineHtml(c, mode, actuals) {
  const showPlan = mode !== "act";
  const showActual = mode !== "plan";
  const today = localToday();
  const laneOf = (work) => (work.block_id ? "block" : work.work_type);
  const lanes = new Map();
  const add = (key, bar) => {
    if (!lanes.has(key)) {
      lanes.set(key, []);
    }
    lanes.get(key).push(bar);
  };
  if (showPlan) {
    c.works
      .filter((work) => work.plan_start && work.plan_end)
      .forEach((work) => add(laneOf(work), { type: work.work_type, start: work.plan_start, end: work.plan_end, plan: true, cancelled: Boolean(work.cancelled_on) }));
  }
  if (showActual) {
    const blockSpans = c.blockWorks || c.planting ? actualSpans(c.blockWorks || [], blockTarget(c.block.id), actuals) : [];
    const ownSpans = c.planting
      ? actualSpans(c.ownWorks, (item) => item.planting_id === c.planting.id, actuals)
      : actualSpans(c.works, blockTarget(c.block.id), actuals);
    blockSpans.forEach((span) => add("block", { ...span, plan: false }));
    ownSpans.forEach((span) => add(c.planting ? span.type : "block", { ...span, plan: false }));
  }
  const bars = [...lanes.values()].flat();
  const axis = compressedAxis([...bars.map((bar) => [bar.start, bar.end]), [today, today]], { minGap: MIN_GAP_DAYS });
  if (!bars.length || !axis) {
    return '<h2>工程</h2><p class="muted">日付の入った計画や実績がまだありません。</p>';
  }
  const pct = (units) => `${((units / axis.total) * 100).toFixed(3)}%`;
  const span = (start, end) => `left:${pct(axis.x(start))};width:${pct(axis.x(end) + 1 - axis.x(start))}`;
  const both = mode === "both";
  const order = (state().allWorkTypes || state().workTypes).map((type) => type.code);
  const keys = [...lanes.keys()].sort((a, b) => (a === "block" ? -1 : b === "block" ? 1 : order.indexOf(a) - order.indexOf(b)));
  const breaks = axis.breaks.map((item) => `<span class="tl-break" style="left:${pct(item.x)};width:${pct(item.width)}"></span>`).join("");
  const todayLine = `<span class="tl-today" style="left:${pct(axis.x(today))}"></span>`;
  const rows = keys
    .map((key) => {
      const content = lanes
        .get(key)
        .map((bar) => {
          const cls = bar.plan ? `tl-plan${both ? " is-both" : ""}${bar.cancelled ? " is-cancelled" : ""}` : `tl-actual${both ? " is-both" : ""}${bar.open ? " is-open" : ""}`;
          const tip = `${anyTypeLabel(bar.type)}（${bar.plan ? "計画" : "実績"}） ${rangeText(bar.start, bar.end)}`;
          return `<span class="${cls}" title="${escapeHtml(tip)}" style="${span(bar.start, bar.end)};background:${WORK_COLORS[bar.type] || "#888"}"></span>`;
        })
        .join("");
      return `<div class="tl-row"><span class="tl-label">${escapeHtml(key === "block" ? "区画の作業" : anyTypeLabel(key))}</span><div class="tl-track">${breaks}${todayLine}${content}</div></div>`;
    })
    .join("");
  const ticks = axis.ticks.map((tick) => `<span style="left:${pct(tick.x)}">${shortDay(tick.day)}</span>`).join("");
  const gapLabels = axis.breaks.map((item) => `<span style="left:${pct(item.x)};width:${pct(item.width)}">${item.days} 日</span>`).join("");
  const legend = [
    showPlan ? `<span><span class="tl-key tl-plan${both ? " is-both" : ""}"></span>計画</span>` : "",
    showActual ? `<span><span class="tl-key tl-actual${both ? " is-both" : ""}"></span>実績</span>` : "",
    '<span><span class="tl-key tl-break"></span>作業のない期間（詰めて表示）</span>',
    '<span><span class="tl-key tl-today-key"></span>今日</span>',
  ].join("");
  return (
    `<h2>工程</h2><div class="timeline"><div class="tl-row tl-axis"><span class="tl-label"></span><div class="tl-track tl-ticks">${ticks}</div></div>` +
    `${rows}<div class="tl-row tl-axis"><span class="tl-label"></span><div class="tl-track tl-gaps">${gapLabels}</div></div></div>` +
    `<div class="tl-legend">${legend}</div>`
  );
}

// 計画との差。定植・播種の仕様の違いと、実績に合わせて後ろを並べ直すボタン
function diffHtml(c, actuals, logs) {
  const parts = [];
  if (c.planting) {
    const plantLog = logs.find((log) => log.work_type === "plant" && log.targets.some((item) => item.planting_id === c.planting.id) && Object.keys(log.spec || {}).length);
    const diff = plantLog ? specDiff(plantLog.spec, plannedSpec(c.planting)) : [];
    if (diff.length) {
      const text = diff
        .map((item) => `${item.label}は、実績が ${item.key === "staggered" ? (item.actual ? "千鳥" : "千鳥なし") : `${item.actual}${item.unit}`}、計画が ${item.key === "staggered" ? (item.planned ? "千鳥" : "千鳥なし") : `${item.planned ?? "なし"}${item.planned === null ? "" : item.unit}`}`)
        .join("。");
      // 計画は書き換えない。次からの作付のために、品目の設定値を記録に合わせられる
      const crop = state().crops.find((item) => item.id === c.planting.crop_id);
      const action = !crop
        ? '<p class="muted">品目の一覧にない品目なので、品目の設定値には合わせられません。</p>'
        : specDiff(plantLog.spec, cropSpec(crop)).length
          ? `<button type="button" class="chip-btn" data-act="apply-spec" data-spec-log="${plantLog.id}">品目の設定値を実績に合わせる</button>`
          : '<p class="muted">品目の設定値は、実績と同じです。</p>';
      parts.push(`<p>定植の${escapeHtml(text)}です。</p>${action}`);
    }
  }
  const shift = shiftAfterActual(c.planting ? c.ownWorks : c.works, actuals);
  if (shift?.works.length) {
    const way = shift.days > 0 ? `${shift.days} 日後ろ` : `${-shift.days} 日前`;
    parts.push(
      `<p>最後に終わった作業が、計画より ${Math.abs(shift.days)} 日${shift.days > 0 ? "遅れ" : "早く"}ました。後ろの作業 ${shift.works.length} 件を ${way}へずらせます（${escapeHtml(anyTypeLabel(shift.works[0].work_type))}が ${shortDay(shift.works[0].plan_start)} から）。作業どうしの間隔は変わりません。</p>` +
        '<button type="button" class="chip-btn" data-act="reschedule">後ろを実績に合わせて並べ直す</button>'
    );
  }
  return parts.length ? `<section class="panel detail-diff"><h2>計画との差</h2>${parts.join("")}</section>` : "";
}

// 作業の表。計画の作業と、それにつながる記録を同じ行に、計画にない作業の記録は別の行に並べる
function tableHtml(c, mode, actuals, logs) {
  const today = localToday();
  const showPlan = mode !== "act";
  const showActual = mode !== "plan";
  const entries = [];
  for (const work of c.works) {
    const linked = logs.filter((log) => log.targets.some((item) => item.work_id === work.id)).sort((a, b) => a.date.localeCompare(b.date));
    const actual = actuals.get(work.id);
    if (!showPlan && !actual && !work.cancelled_on) {
      continue;
    }
    entries.push({ work, linked, actual, key: (showPlan ? work.plan_start : actual?.start) || work.plan_start || "9999-12-31", end: work.plan_end || work.plan_start });
  }
  if (showActual) {
    for (const log of logs) {
      if (log.targets.some((item) => !item.work_id && c.matches(item))) {
        entries.push({ log, key: log.date, end: logEnd(log) });
      }
    }
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  if (!entries.length) {
    return '<p class="muted">計画も実績もまだありません。</p>';
  }
  // 気温・降水量の列は、定植・播種の日が決まり、観測所を選んであり、実績を出しているときだけ
  const showWeather = showActual && Boolean(wx?.planted && wx.configured);
  const cols = 1 + (showPlan ? 1 : 0) + (showActual ? 1 : 0) + (mode === "both" ? 1 : 0) + (showWeather ? 1 : 0);
  const head =
    `<tr><th>作業</th>${showPlan ? "<th>計画</th>" : ""}${showActual ? "<th>実績</th>" : ""}${mode === "both" ? "<th>ずれ</th>" : ""}` +
    `${showWeather ? '<th>気温・降水量<br><span class="muted">その日／定植からの積算</span></th>' : ""}</tr>`;
  const rows = [];
  let previousEnd = null;
  let todayShown = false;
  for (const entry of entries) {
    if (!todayShown && entry.key > today && entry.key !== "9999-12-31") {
      rows.push(`<tr class="detail-gap is-today"><td colspan="${cols}">今日 ${formatDay(today)}</td></tr>`);
      todayShown = true;
    } else if (previousEnd && entry.key !== "9999-12-31" && diffDays(previousEnd, entry.key) - 1 >= MIN_GAP_DAYS) {
      rows.push(`<tr class="detail-gap"><td colspan="${cols}">作業のない期間 ${diffDays(previousEnd, entry.key) - 1} 日</td></tr>`);
    }
    if (entry.end && entry.end !== "9999-12-31" && (!previousEnd || entry.end > previousEnd)) {
      previousEnd = entry.end;
    }
    // 気温・降水量は、作業を終えた日（つながる記録が複数あれば最後の記録の終えた日）の値
    const last = entry.log || entry.linked?.at(-1);
    const date = last ? logEnd(last) : null;
    rows.push((entry.work ? workRow(c, entry, mode, today) : logRow(entry.log, mode)).replace("</tr>", `${showWeather ? wxCell(date) : ""}</tr>`));
  }
  return `<div class="table-scroll"><table class="work-table detail-table"><thead>${head}</thead><tbody>${rows.join("")}</tbody></table></div>`;
}

// 作業の欄。株の手入れ・その他は中身も添える（spec は実績の仕様か、計画の予定の中身）
const typeCell = (type, tag, spec) =>
  `<td><span class="swatch" style="background:${WORK_COLORS[type] || "#888"}"></span><strong>${escapeHtml(workName(anyTypeLabel(type), spec))}</strong>${tag ? `<br><span class="muted">${escapeHtml(tag)}</span>` : ""}</td>`;

function logLines(log) {
  return [specText(log.work_type, log.spec), ...(log.inputs || []).map(inputText), log.note].filter(Boolean);
}

function logLink(log) {
  const days = logEnd(log) > log.date ? `${formatDay(log.date)}〜${formatDay(logEnd(log))}` : formatDay(log.date);
  return `<a href="#" data-log="${log.id}">${days}</a>${log.finishes ? '<span class="log-done">完了</span>' : ""}`;
}

function workRow(c, { work, linked, actual }, mode, today) {
  const showPlan = mode !== "act";
  const showActual = mode !== "plan";
  const tag = work.block_id && c.planting ? `${c.block.name}の作業` : "";
  const planLines = [work.note, work.work_type === "plant" && c.planting ? plannedSpecText(c.planting) : ""].filter(Boolean);
  const planCell = showPlan
    ? `<td class="detail-plan" data-plan="${work.id}"><a href="#" data-plan-edit="${work.id}"><strong>${work.plan_start ? rangeText(work.plan_start, work.plan_end) : "日付なし"}</strong></a>` +
      planLines.map((line) => `<br><span class="muted">${escapeHtml(line)}</span>`).join("") +
      "</td>"
    : "";
  let actualCell = "";
  if (showActual) {
    if (work.cancelled_on) {
      actualCell =
        `<td><button type="button" class="detail-badge is-cancelled-badge" data-uncancel="${work.id}" title="押すと、取りやめを元に戻せます">取りやめ</button>` +
        `<span class="muted"> ${formatDay(work.cancelled_on)}${work.cancel_note ? `・${escapeHtml(work.cancel_note)}` : ""}</span></td>`;
    } else if (linked.length) {
      actualCell =
        "<td>" +
        linked
          .map((log) => `${logLink(log)}${logLines(log).map((line) => `<br><span class="detail-line">${escapeHtml(line)}</span>`).join("")}`)
          .join("<br>") +
        (actual && !actual.end ? '<br><span class="log-going">作業中</span>' : "") +
        "</td>";
    } else if (work.plan_end && work.plan_end < today) {
      actualCell = '<td><span class="detail-badge is-missing">未実施</span></td>';
    } else {
      actualCell = '<td class="muted">－</td>';
    }
  }
  const gapCell = mode === "both" ? `<td class="detail-gap-cell">${escapeHtml(work.cancelled_on ? "" : dayGap(work, actual))}</td>` : "";
  return `<tr>${typeCell(work.work_type, tag, work.detail?.spec)}${planCell}${actualCell}${gapCell}</tr>`;
}

function logRow(log, mode) {
  const showPlan = mode !== "act";
  const lines = logLines(log)
    .map((line) => `<br><span class="detail-line">${escapeHtml(line)}</span>`)
    .join("");
  return `<tr>${typeCell(log.work_type, "計画にない実績", log.spec)}${showPlan ? '<td class="muted">－</td>' : ""}<td>${logLink(log)}${lines}</td>${mode === "both" ? "<td></td>" : ""}</tr>`;
}

// ---- 操作 ----

// 計画の日付を押したとき、計画を直す窓を開く。管理作業（防除など）の計画は、実際に使うプランなら入力の窓（計画を直す）で、
// 中身や対象まで直せる。工程の作業（畝立て、定植など）は、開始日、終了日、メモを直す
function openWorkPlanEditor(work) {
  if (isManagement(work.work_type) && isActivePlan()) {
    openPlanEditor(work);
    return;
  }
  const c = context();
  const place = c ? `${c.block.name}${c.bed && !work.block_id ? ` 畝${c.bed.seq}` : ""}` : "";
  const name = workName(anyTypeLabel(work.work_type), work.detail?.spec);
  const box = document.createElement("dialog");
  box.className = "notice plan-edit";
  box.innerHTML =
    `<h3>計画を直す</h3><p class="muted">${escapeHtml(place)}の${escapeHtml(name)}</p>` +
    `<div class="form-grid"><label>開始日<input type="date" data-k="start" value="${work.plan_start || ""}" /></label>` +
    `<label>終了日<input type="date" data-k="end" value="${work.plan_end || ""}" /></label></div>` +
    `<label>メモ<textarea data-k="note" rows="2">${escapeHtml(work.note || "")}</textarea></label>` +
    `<p class="muted">開始日を変えると、日数を保って終了日も動きます。</p>` +
    '<p class="error" data-k="error"></p>' +
    '<div class="row"><button type="button" class="text-btn" data-action="cancel">キャンセル</button><button type="button" class="primary-btn" data-action="save">直す</button></div>';
  document.body.append(box);
  const field = (key) => box.querySelector(`[data-k="${key}"]`);
  // 開始日を変えたら、日数を保って終了日も動かす（日程の画面の表と同じ）
  const days = work.plan_start && work.plan_end ? diffDays(work.plan_start, work.plan_end) : 0;
  field("start").addEventListener("change", () => {
    if (field("start").value) {
      field("end").value = addDays(field("start").value, days);
    }
  });
  box.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "cancel") {
      box.close();
    } else if (action === "save") {
      const start = field("start").value || null;
      const end = field("end").value || start;
      const note = field("note").value.trim();
      if (start && end < start) {
        field("error").textContent = "終了日は、開始日より後の日にしてください。";
        return;
      }
      const before = { plan_start: work.plan_start, plan_end: work.plan_end, note: work.note };
      const dated = start !== work.plan_start || end !== work.plan_end;
      const noted = note !== (work.note || "");
      if (!dated && !noted) {
        box.close();
        return;
      }
      Object.assign(work, { plan_start: start, plan_end: start ? end : null, note });
      try {
        await state().store.upsert("works", [work]);
        if (dated) {
          record({
            kind: "work.date",
            target: ["work", work.id],
            text: `${place}の「${name}」の日付を変更`,
            before: before.plan_start ? rangeText(before.plan_start, before.plan_end) : "日付なし",
            after: start ? rangeText(start, end) : "日付なし",
          });
        }
        if (noted) {
          record({ kind: "work.note", target: ["work", work.id], text: `${place}の「${name}」のメモを変更`, before: before.note || "空", after: note || "空" });
        }
        ctx.setStatus("計画を直しました");
        box.close();
      } catch (error) {
        Object.assign(work, before);
        field("error").textContent = `直せませんでした: ${error.message}`;
        return;
      }
      ctx.refresh();
    }
  });
  box.addEventListener("close", () => box.remove());
  box.showModal();
}

// 品目の設定値を、定植の記録の仕様に合わせる。今回の作付の計画は書き換えない。
// 品目の設定値を使っている作付（作付に値がない作付）のうち、今回の作付と、このプランですでに始まった作付には、
// いまの品目の値を写してから変える。まだ始まっていない作付は、新しい設定値になる
async function applySpec(logId) {
  const c = context();
  const log = (state().logs || []).find((item) => item.id === logId);
  const crop = c?.planting && state().crops.find((item) => item.id === c.planting.crop_id);
  if (!crop || !log) {
    return;
  }
  const diff = specDiff(log.spec, cropSpec(crop));
  if (!diff.length) {
    return;
  }
  const today = localToday();
  const keys = diff.map((item) => item.key);
  const frozen = state().plantings.filter(
    (planting) =>
      planting.crop_id === crop.id &&
      (planting.id === c.planting.id || (plantingStart(planting, state().works, state().logs || []) || "9999") <= today) &&
      keys.some((key) => planting[key] === null || planting[key] === undefined)
  );
  const before = specSummary(cropSpec(crop));
  const after = specSummary({ ...cropSpec(crop), ...Object.fromEntries(diff.map((item) => [item.key, item.key === "staggered" ? Boolean(item.actual) : Number(item.actual)])) });
  const ok = await confirmAction({
    message:
      `品目「${crop.name}」の設定値を「${before || "なし"}」から「${after || "なし"}」に変えます。今回の作付の計画は変わりません。` +
      "まだ始まっていない作付で、作付に値を入れていないものは、新しい設定値になります（ほかの圃場とプランも同じです）。",
    action: "合わせる",
  });
  if (!ok) {
    return;
  }
  const savedCrop = { ...crop };
  const savedPlantings = frozen.map((planting) => ({ ...planting }));
  frozen.forEach((planting) => {
    keys.forEach((key) => {
      if (planting[key] === null || planting[key] === undefined) {
        planting[key] = crop[key] ?? (key === "staggered" ? false : null);
      }
    });
  });
  diff.forEach((item) => {
    crop[item.key] = item.key === "staggered" ? Boolean(item.actual) : Number(item.actual);
  });
  try {
    if (frozen.length) {
      await state().store.upsert("plantings", frozen);
    }
    await state().store.upsert("crops", [crop]);
    record({
      kind: "crops.spec",
      target: ["crop", crop.id],
      plan: false,
      text: `品目「${crop.name}」の設定値を、${c.block.name} 畝${c.bed.seq} の定植の実績に合わせた`,
      before,
      after,
    });
    ctx.setStatus("品目の設定値を合わせました");
  } catch (error) {
    Object.assign(crop, savedCrop);
    savedPlantings.forEach((saved) => Object.assign(state().plantings.find((planting) => planting.id === saved.id), saved));
    notify(`品目の設定値を合わせられませんでした: ${error.message}`);
  }
  ctx.refresh();
}

async function reschedule() {
  const c = context();
  if (!c) {
    return;
  }
  const shift = shiftAfterActual(c.planting ? c.ownWorks : c.works, currentActuals());
  const moved = shift?.works || [];
  if (!moved.length) {
    return;
  }
  for (const row of moved) {
    const live = state().works.find((work) => work.id === row.id);
    Object.assign(live, { plan_start: row.plan_start, plan_end: row.plan_end });
  }
  try {
    await state().store.upsert(
      "works",
      moved.map((row) => state().works.find((work) => work.id === row.id))
    );
    const name = c.planting ? `${c.block.name} 畝${c.bed.seq}（${c.planting.crop_name}）` : c.block.name;
    record({
      kind: "work.reschedule",
      target: [c.planting ? "planting" : "block", target.id],
      text: `${name}の後ろの作業 ${moved.length} 件を、実績に合わせて ${Math.abs(shift.days)} 日${shift.days > 0 ? "後ろ" : "前"}へずらした`,
    });
    ctx.setStatus("並べ直しました");
  } catch (error) {
    notify(`並べ直せませんでした: ${error.message}`);
  }
  ctx.refresh();
}

function onClick(event) {
  const el = event.target.closest("[data-act], [data-log], [data-plan-edit], [data-uncancel], [data-gantt-mode], [data-plan]");
  if (!el) {
    return;
  }
  if (el.dataset.ganttMode) {
    setGanttMode(el.dataset.ganttMode);
    renderPlantingDetail();
    return;
  }
  if (el.dataset.log) {
    event.preventDefault();
    const log = (state().logs || []).find((item) => item.id === el.dataset.log);
    if (log) {
      openLogEditor(log);
    }
    return;
  }
  if (el.dataset.planEdit) {
    event.preventDefault();
    const work = state().works.find((item) => item.id === el.dataset.planEdit);
    if (work) {
      openWorkPlanEditor(work);
    }
    return;
  }
  if (el.dataset.uncancel) {
    const work = state().works.find((item) => item.id === el.dataset.uncancel);
    if (work) {
      uncancelWork(work);
    }
    return;
  }
  if (el.dataset.plan) {
    // 計画の行: 日程の画面で、その作業の計画を開く
    const work = state().works.find((item) => item.id === el.dataset.plan);
    if (work) {
      ctx.openInSchedule(work.block_id ? "block" : "planting", work.block_id || work.planting_id);
      ctx.showView("schedule");
    }
    return;
  }
  const act = el.dataset.act;
  if (act === "back") {
    ctx.showView("schedule");
  } else if (act === "go") {
    // 隣の作付へは、履歴を積まずに URL を置き換える（戻るボタンで、日程にすぐ戻れるように）
    history.replaceState({ fieldPlanView: "planting" }, "", `#detail/${el.dataset.kind}/${el.dataset.id}`);
    openPlantingDetail(el.dataset.kind, el.dataset.id);
    renderPlantingDetail();
    window.scrollTo(0, 0);
  } else if (act === "record") {
    openLogEditor(null, { plantingId: target.id });
  } else if (act === "apply-spec") {
    applySpec(el.dataset.specLog);
  } else if (act === "reschedule") {
    reschedule();
  }
}

export function initPlantingView(context) {
  ctx = context;
  $("plantingBody").addEventListener("click", onClick);
}

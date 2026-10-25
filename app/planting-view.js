// 「作付の詳細」の画面。作付 1 つ（または区画 1 つ）について、計画と実績を 1 つの画面で見る。
// 工程表の行の名前から開く。表示（計画／実績／計画と実績）は工程表と共有する
import { notify } from "./dialog.js";
import { record } from "./journal.js";
import { inputText, openLogEditor, specText, uncancelWork } from "./log-view.js";
import { bedAreas, compressedAxis, dayGap, shiftAfterActual, specDiff } from "./logs.js";
import { WORK_COLORS, diffDays, existsOn, harvestEnd, localToday } from "./schedule.js";
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

function plannedSpecText(planting) {
  const spec = plannedSpec(planting);
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
  $("plantingBody").innerHTML =
    headHtml(c, active) +
    `<div class="row detail-modes">${active ? `<div class="log-modes" role="group" aria-label="表示">${modeButtons(mode)}</div>` : ""}` +
    `<span class="muted">${active ? "工程表で選んでいた表示のまま開きます。" : "実績は、実際に使うプランを開くと出せます。"}</span></div>` +
    `<section class="panel">${timelineHtml(c, mode, actuals)}</section>` +
    (mode === "both" ? diffHtml(c, actuals, logs) : "") +
    `<section class="panel"><div class="panel-heading"><h2>作業</h2><span class="muted">${tableNote(mode)}</span></div>${tableHtml(c, mode, actuals, logs)}</section>`;
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
  const recordButton = active && c.planting ? '<button type="button" class="primary-btn" data-act="record">＋ この作付の記録を入れる</button>' : "";
  return (
    `<div class="detail-head"><button type="button" class="text-btn" data-act="back">← 工程表に戻る</button>` +
    `<h2>${escapeHtml(title)}</h2><span class="muted">${escapeHtml(info)}</span>` +
    `<div class="detail-nav">${recordButton}${go(prev, "prev")}${go(next, "next")}</div></div>`
  );
}

const tableNote = (mode) =>
  ({
    plan: "計画の作業です。行を押すと、日程の画面で作業の計画を開きます。",
    act: "記録だけです。日付を押すと、記録を直す画面を開きます。",
    both: "計画の作業と、つながる記録を同じ行に並べます。計画にない作業は、計画の欄が「－」です。",
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
    return '<h2>工程</h2><p class="muted">日付の入った作業や記録がまだありません。</p>';
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
        .map((item) => `${item.label}は、記録が ${item.key === "staggered" ? (item.actual ? "千鳥" : "千鳥なし") : `${item.actual}${item.unit}`}、計画が ${item.key === "staggered" ? (item.planned ? "千鳥" : "千鳥なし") : `${item.planned ?? "なし"}${item.planned === null ? "" : item.unit}`}`)
        .join("。");
      parts.push(`<p>定植の${escapeHtml(text)}です。</p><button type="button" class="chip-btn" data-act="apply-spec" data-spec-log="${plantLog.id}">記録の仕様を計画に反映</button>`);
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
        entries.push({ log, key: log.date, end: log.date });
      }
    }
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  if (!entries.length) {
    return '<p class="muted">作業も記録もまだありません。</p>';
  }
  const cols = 1 + (showPlan ? 1 : 0) + (showActual ? 1 : 0) + (mode === "both" ? 1 : 0);
  const head =
    `<tr><th>作業</th>${showPlan ? "<th>計画</th>" : ""}${showActual ? "<th>実績</th>" : ""}${mode === "both" ? "<th>ずれ</th>" : ""}</tr>`;
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
    rows.push(entry.work ? workRow(c, entry, mode, today) : logRow(entry.log, mode));
  }
  return `<div class="table-scroll"><table class="work-table detail-table"><thead>${head}</thead><tbody>${rows.join("")}</tbody></table></div>`;
}

const typeCell = (type, tag) =>
  `<td><span class="swatch" style="background:${WORK_COLORS[type] || "#888"}"></span><strong>${escapeHtml(anyTypeLabel(type))}</strong>${tag ? `<br><span class="muted">${escapeHtml(tag)}</span>` : ""}</td>`;

function logLines(log) {
  return [specText(log.work_type, log.spec), ...(log.inputs || []).map(inputText), log.note].filter(Boolean);
}

function logLink(log) {
  return `<a href="#" data-log="${log.id}">${formatDay(log.date)}</a>${log.finishes ? '<span class="log-done">完了</span>' : ""}`;
}

function workRow(c, { work, linked, actual }, mode, today) {
  const showPlan = mode !== "act";
  const showActual = mode !== "plan";
  const tag = work.block_id && c.planting ? `${c.block.name}の作業` : "";
  const planLines = [work.note, work.work_type === "plant" && c.planting ? plannedSpecText(c.planting) : ""].filter(Boolean);
  const planCell = showPlan
    ? `<td class="detail-plan" data-plan="${work.id}"><strong>${work.plan_start ? rangeText(work.plan_start, work.plan_end) : "日付なし"}</strong>` +
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
        "</td>";
    } else if (work.plan_end && work.plan_end < today) {
      actualCell = '<td><span class="detail-badge is-missing">未実施</span></td>';
    } else {
      actualCell = '<td class="muted">－</td>';
    }
  }
  const gapCell = mode === "both" ? `<td class="detail-gap-cell">${escapeHtml(work.cancelled_on ? "" : dayGap(work, actual))}</td>` : "";
  return `<tr>${typeCell(work.work_type, tag)}${planCell}${actualCell}${gapCell}</tr>`;
}

function logRow(log, mode) {
  const showPlan = mode !== "act";
  const lines = logLines(log)
    .map((line) => `<br><span class="detail-line">${escapeHtml(line)}</span>`)
    .join("");
  return `<tr>${typeCell(log.work_type, "計画にない作業")}${showPlan ? '<td class="muted">－</td>' : ""}<td>${logLink(log)}${lines}</td>${mode === "both" ? "<td></td>" : ""}</tr>`;
}

// ---- 操作 ----

async function applySpec(logId) {
  const c = context();
  const log = (state().logs || []).find((item) => item.id === logId);
  if (!c?.planting || !log) {
    return;
  }
  const diff = specDiff(log.spec, plannedSpec(c.planting));
  if (!diff.length) {
    return;
  }
  const planting = c.planting;
  const before = plannedSpecText(planting);
  diff.forEach((item) => {
    planting[item.key] = item.key === "staggered" ? Boolean(item.actual) : Number(item.actual);
  });
  try {
    await state().store.upsert("plantings", [planting]);
    record({
      kind: "planting.spec",
      target: ["planting", planting.id],
      text: `${c.block.name} 畝${c.bed.seq}（${planting.crop_name}）の仕様を、定植の記録に合わせた`,
      before,
      after: plannedSpecText(planting),
    });
    ctx.setStatus("計画に反映しました");
  } catch (error) {
    notify(`計画に反映できませんでした: ${error.message}`);
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
  const el = event.target.closest("[data-act], [data-log], [data-uncancel], [data-gantt-mode], [data-plan]");
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

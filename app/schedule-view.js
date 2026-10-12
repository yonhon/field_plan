// 「日程」の画面。耕起対象区画には畝立ての前までの作業を、畝には作付ごとに畝立てから後の作業を並べる。
import {
  TEMPLATES,
  WORK_COLORS as TYPE_COLORS,
  addDays,
  diffDays,
  dueWorks,
  harvestEnd,
  localToday,
  planProblems,
  scheduleAnchored,
  scheduleBefore,
  scheduleForward,
  typesForCrop,
  workDays,
  worksRange,
} from "./schedule.js";
import { cropLabel, plantingNumbers, summarize } from "./crops.js";
import { notify } from "./dialog.js";
import { record } from "./journal.js";
import { initStrip, renderStrip } from "./strip-view.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DAY_PX = 7;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const SCOPE_LABELS = { block: "区画の作業（畝立ての前まで）", bed: "畝の作業（畝立てから後）" };

let ctx = null; // { state, setStatus, queueSave, cropColor, plantingOn }
// いま編集している相手。target は "block"（区画の作業）か、畝の ID
const sel = { blockId: null, target: "block", plantingId: null };
let daysBeforeEdit = null; // 開始日を動かす前の日数 { id, days }
const folded = new Set(); // 折りたたんでいる作付の ID
const arrangeChoice = new Map(); // 並べ直しの欄で選んだ基準と日 { mode, date }。区画や作付ごと
const template = { key: Object.keys(TEMPLATES.block)[0], start: "" }; // 区画のひな形の欄で選んだもの
let problems = []; // 日程の無理。描くたびに求め直す
const ARRANGE_MODES = {
  block: { before: "畝立てをこの日に始められるように逆算", forward: "最初の作業をこの日に始める" },
  bed: { plant: "定植・播種をこの日に始める（前は逆算）", forward: "最初の作業をこの日に始める" },
};
const picked = new Set(); // 工程表で選んでいる作業の ID
let clipboard = null; // コピーか切り取りをした作業 { works, cut }
let barDrag = null; // 工程表で帯をドラッグしている途中の状態
let addingFor = null; // 「作付を追加」の日付の初期値を入れたときの状態

const state = () => ctx.state;
const store = () => ctx.state.store;
const typeOf = (code) => state().workTypes.find((type) => type.code === code);
const cropOf = (planting) => state().crops.find((crop) => crop.id === planting?.crop_id) || null;
// 区画や作付に合わせた、作業の種類の目安。品目を登録した作付なら、その品目の日数を使う
function typesFor(owner) {
  const planting = state().plantings.find((item) => item.id === owner.planting_id);
  return typesForCrop(state().workTypes, cropOf(planting), planting ? plantingWorks(planting.id) : []);
}
const typeLabel = (code) => typeOf(code)?.label || code;
const bySeq = (a, b) => a.seq - b.seq;

const blockBeds = (blockId) => state().beds.filter((bed) => bed.block_id === blockId).sort(bySeq);
const bedPlantings = (bedId) => state().plantings.filter((planting) => planting.bed_id === bedId).sort(bySeq);
const blockWorks = (blockId) => state().works.filter((work) => work.block_id === blockId).sort(bySeq);
const plantingWorks = (plantingId) => state().works.filter((work) => work.planting_id === plantingId).sort(bySeq);

const kindOf = (owner) => (owner.block_id ? "block" : "bed");
const worksOf = (owner) => (owner.block_id ? blockWorks(owner.block_id) : plantingWorks(owner.planting_id));

function formatDay(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${month}/${day}（${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}）`;
}

// 年も入れた日付。例: 2027/5/12（水）
function fullDay(iso) {
  return `${Number(iso.slice(0, 4))}/${formatDay(iso)}`;
}

function formatRange(work) {
  return work.plan_start === work.plan_end ? formatDay(work.plan_start) : `${formatDay(work.plan_start)}〜${formatDay(work.plan_end)}`;
}

// 作業がどこのものかを、区画と畝の名前で表す
function placeOf(work) {
  if (work.block_id) {
    return state().blocks.find((block) => block.id === work.block_id)?.name || "";
  }
  const planting = state().plantings.find((item) => item.id === work.planting_id);
  const bed = planting && state().beds.find((item) => item.id === planting.bed_id);
  const block = bed && state().blocks.find((item) => item.id === bed.block_id);
  return bed ? `${block?.name || ""} 畝${bed.seq}${planting.crop_name ? `（${planting.crop_name}）` : ""}` : "";
}

async function run(action) {
  ctx.setStatus("保存中…");
  try {
    await action();
    ctx.setStatus("保存しました");
  } catch (error) {
    ctx.setStatus(`保存に失敗しました: ${error.message}`);
  }
  renderSchedule();
}

// ---- 描画 ----

function keepSelection() {
  const blocks = state().blocks;
  if (!blocks.some((block) => block.id === sel.blockId)) {
    sel.blockId = blocks[0]?.id || null;
    sel.target = "block";
  }
  if (sel.target !== "block" && !blockBeds(sel.blockId).some((bed) => bed.id === sel.target)) {
    sel.target = "block";
  }
  if (sel.target === "block") {
    sel.plantingId = null;
  } else {
    const plantings = bedPlantings(sel.target);
    if (!plantings.some((planting) => planting.id === sel.plantingId)) {
      sel.plantingId = plantings.at(-1)?.id || null;
    }
  }
}

// 圃場図で選んだ区画や畝を、日程でも開く
export function openInSchedule(kind, id) {
  if (kind === "block") {
    Object.assign(sel, { blockId: id, target: "block", plantingId: null });
  } else if (kind === "planting") {
    const planting = state().plantings.find((item) => item.id === id);
    const bed = state().beds.find((item) => item.id === planting.bed_id);
    Object.assign(sel, { blockId: bed.block_id, target: bed.id, plantingId: id });
    folded.delete(id);
  } else if (kind === "bed") {
    const bed = state().beds.find((item) => item.id === id);
    Object.assign(sel, { blockId: bed.block_id, target: id, plantingId: null });
  }
}

export function renderSchedule() {
  if (!ctx) {
    return;
  }
  keepSelection();
  const blocks = state().blocks;
  $("scheduleEmpty").hidden = blocks.length > 0;
  $("scheduleBody").hidden = blocks.length === 0;
  renderWeek();
  problems = planProblems(state());
  renderProblems();
  renderSummary();
  if (!blocks.length) {
    return;
  }
  renderStrip();
  renderGantt();
  renderEditor();
  renderTypes();
}

function renderWeek() {
  const { due, upcoming } = dueWorks(state().works, localToday());
  // 同じ日の同じ作業は、場所をまとめて 1 行にする
  const lines = new Map();
  for (const work of due.length ? due : upcoming) {
    const key = `${work.plan_start}|${work.plan_end}|${work.work_type}`;
    if (!lines.has(key)) {
      lines.set(key, { work, places: [] });
    }
    lines.get(key).places.push(placeOf(work));
  }
  const items = [...lines.values()].map(({ work, places }) => {
    const where = places.length > 4 ? `${places[0]} ほか ${places.length - 1} か所` : places.join("、");
    return (
      `<li><span class="week-date">${formatRange(work)}</span>` +
      `<span class="week-work"><span class="swatch" style="background:${TYPE_COLORS[work.work_type] || "#888"}"></span>${escapeHtml(typeLabel(work.work_type))}</span>` +
      `<span class="muted">${escapeHtml(where)}${places.length === 1 && work.note ? ` / ${escapeHtml(work.note)}` : ""}</span></li>`
    );
  });
  $("weekTitle").textContent = due.length || !upcoming.length ? "今週やること" : "次の作業（今週の予定はありません）";
  $("weekList").innerHTML = items.length ? items.join("") : '<li class="muted">予定はありません</li>';
}

// 作業の期間を「6/17（木）〜6/29（火）」の形にする。日付がなければ「日付なし」
function rangeText(works) {
  const range = worksRange(works);
  return range ? (range.start === range.end ? fullDay(range.start) : `${fullDay(range.start)}〜${formatDay(range.end)}`) : "日付なし";
}

// 作付のある場所の名前。例: 区画1 畝3 作付 2
function placeName(planting) {
  const bed = state().beds.find((item) => item.id === planting.bed_id);
  return `${state().blocks.find((item) => item.id === bed.block_id).name} 畝${bed.seq} 作付 ${planting.seq}`;
}

// 無理のある作付が、どの区画のどの畝かを名前にする
function ownerName(problem) {
  if (problem.block_id) {
    return state().blocks.find((block) => block.id === problem.block_id)?.name || "";
  }
  const planting = state().plantings.find((item) => item.id === problem.planting_id);
  const bed = state().beds.find((item) => item.id === planting.bed_id);
  const block = state().blocks.find((item) => item.id === bed.block_id);
  return `${block.name} 畝${bed.seq} 作付 ${planting.seq}${planting.crop_name ? `（${planting.crop_name}）` : ""}`;
}

const problemBed = (problem) => state().plantings.find((item) => item.id === problem.planting_id)?.bed_id;

// 同じ内容の指摘は、場所をまとめて 1 行にする（コピーした畝は同じ指摘が並ぶため）
function renderProblems() {
  $("problemPanel").hidden = problems.length === 0;
  const groups = new Map();
  for (const problem of problems) {
    const work = state().works.find((item) => item.id === problem.work_id);
    const text = `${work ? `${typeLabel(work.work_type)}: ` : ""}${problem.message}`;
    const key = `${problem.block_id ? "block" : "bed"}|${text}`;
    if (!groups.has(key)) {
      groups.set(key, { text, items: [] });
    }
    groups.get(key).items.push(problem);
  }
  $("problemCount").textContent = `${problems.length} 件`;
  $("problemList").innerHTML = [...groups.values()]
    .map(({ text, items }) => {
      const first = items[0];
      const where = items.length > 1 ? `${ownerName(first)} ほか ${items.length - 1} か所` : ownerName(first);
      const target = first.block_id ? `data-kind="block" data-id="${first.block_id}"` : `data-kind="planting" data-id="${first.planting_id}"`;
      return `<li ${target}><strong>${escapeHtml(where)}</strong>${escapeHtml(text)}</li>`;
    })
    .join("");
}

function renderGantt() {
  const isDated = (work) => work.plan_start && work.plan_end && work.plan_end >= work.plan_start;
  const dated = state().works.filter(isDated);
  if (!dated.length) {
    $("gantt").innerHTML = '<p class="muted">日付の入った作業がまだありません。</p>';
    renderPickTools();
    return;
  }
  const all = dated.flatMap((work) => [work.plan_start, work.plan_end]).sort();
  const first = `${addDays(all[0], -3).slice(0, 8)}01`;
  const last = addDays(all.at(-1), 7);
  const x = (iso) => diffDays(first, iso) * DAY_PX;
  const width = x(last) + DAY_PX;
  const today = localToday();

  const months = [];
  for (let day = first; day <= last; day = `${addDays(day, 32).slice(0, 8)}01`) {
    months.push(`<span class="gantt-month" style="left:${x(day)}px">${Number(day.slice(0, 4))}年${Number(day.slice(5, 7))}月</span>`);
  }
  const flaggedWorks = new Set(problems.map((problem) => problem.work_id).filter(Boolean));
  const bars = (works, extra = "") =>
    works
      .filter(isDated)
      .map((work) => {
        const days = workDays(work);
        const tip = `<strong>${escapeHtml(typeLabel(work.work_type))}${escapeHtml(extra)}</strong>${fullDay(work.plan_start)} 〜 ${fullDay(work.plan_end)}（${days} 日）`;
        return (
          `<span class="gantt-bar${picked.has(work.id) ? " is-picked" : ""}${flaggedWorks.has(work.id) ? " is-flagged" : ""}" data-id="${work.id}" data-tip="${escapeHtml(tip)}" ` +
          `style="left:${x(work.plan_start)}px;width:${days * DAY_PX}px;background-color:${TYPE_COLORS[work.work_type] || "#888"}">` +
          `${days * DAY_PX > 60 ? escapeHtml(typeLabel(work.work_type)) : ""}</span>`
        );
      })
      .join("");
  const openRow = sel.target === "block" ? `data-block="${sel.blockId}"` : `data-bed="${sel.target}"`;
  const row = (cls, name, content, attrs) =>
    `<div class="gantt-row ${cls}${attrs === openRow ? " is-open" : ""}" ${attrs}><div class="gantt-name">${escapeHtml(name)}</div><div class="gantt-track">${content}</div></div>`;

  const rows = [];
  for (const block of state().blocks) {
    rows.push(row("block", block.name, bars(blockWorks(block.id)), `data-block="${block.id}"`));
    for (const bed of blockBeds(block.id)) {
      const plantings = bedPlantings(bed.id);
      const crops = plantings.map((planting) => planting.crop_name).filter(Boolean).join(" → ");
      const gone = bed.removed_on ? `（〜${formatDay(bed.removed_on)}）` : "";
      const content = plantings.map((planting) => bars(plantingWorks(planting.id), planting.crop_name ? `（${planting.crop_name}）` : "")).join("");
      rows.push(row("bed", `畝${bed.seq}${crops ? ` ${crops}` : ""}${gone}`, content, `data-bed="${bed.id}"`));
    }
  }

  const used = new Set(dated.map((work) => work.work_type));
  const legend = state()
    .workTypes.filter((type) => used.has(type.code))
    .map((type) => `<span><span class="swatch" style="background:${TYPE_COLORS[type.code] || "#888"}"></span>${escapeHtml(type.label)}</span>`)
    .join("");
  const mark = today >= first && today <= last ? `<span class="gantt-mark today" style="left:${x(today)}px"><span>今日</span></span>` : "";

  const previous = $("gantt").querySelector(".gantt-scroll")?.scrollLeft;
  $("gantt").innerHTML =
    `<div class="gantt-scroll"><div class="gantt-inner" style="width:${width}px">` +
    `<div class="gantt-months">${months.join("")}</div>${rows.join("")}${mark}` +
    `</div></div><div class="gantt-legend">${legend}<span><span class="swatch is-flagged"></span>白い対角線: 確認が必要</span></div>`;
  // 初めて描くときは、今日が左から少し入った位置に来るように送る。描き直しでは位置を保つ
  $("gantt").querySelector(".gantt-scroll").scrollLeft = previous ?? (mark ? Math.max(x(today) - 60, 0) : 0);
  renderPickTools();
}

// 作付の寸法、苗数、肥料の量を 1 行にする
function numbersText(planting) {
  const bed = state().beds.find((item) => item.id === planting.bed_id);
  const crop = cropOf(planting);
  const fertilizer = state().fertilizers.find((item) => item.id === crop?.fertilizer_id);
  const numbers = plantingNumbers(bed.shape, crop, fertilizer);
  const parts = [`畝 ${Math.round(numbers.width * 100)} cm × ${numbers.length.toFixed(1)} m（${numbers.area.toFixed(1)} ㎡）`];
  if (numbers.seedlings !== null) {
    parts.push(`苗 ${numbers.seedlings.toLocaleString("ja-JP")}`);
  }
  if (numbers.nitrogenKg !== null) {
    parts.push(`窒素 ${numbers.nitrogenKg.toFixed(2)} kg`);
  }
  if (numbers.fertilizerKg !== null) {
    parts.push(`${fertilizer.name} ${numbers.fertilizerKg.toFixed(2)} kg`);
  }
  return parts.join(" ／ ");
}

// プラン全体の、品目ごとの苗数と、肥料ごとの量
function renderSummary() {
  const summary = summarize(state());
  $("summaryPanel").hidden = summary.crops.length === 0;
  const number = (value, digits = 0) => value.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  $("cropSummary").innerHTML = summary.crops
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.name)}${row.registered ? "" : '<span class="muted">（未登録）</span>'}</td>` +
        `<td class="num">${row.count}</td><td class="num">${number(row.area, 1)}</td>` +
        `<td class="num">${row.seedlings ? number(row.seedlings) : "-"}</td>` +
        `<td>${row.fertilizerKg ? `${escapeHtml(row.fertilizer)} ${number(row.fertilizerKg, 2)} kg` : "-"}</td></tr>`
    )
    .join("");
  $("fertilizerSummary").textContent = summary.fertilizers.length
    ? `肥料の合計: ${summary.fertilizers.map((row) => `${row.name} ${number(row.kg, 2)} kg`).join("、")}`
    : "";
}

// 並んだ作業がすべて終わり、最後の作業のあとにあける日数（すき込みのあとの 21 日など）も過ぎた、最初の日。
// 日付の入った作業がなければ空
function startAfter(works) {
  const last = works.filter((work) => work.plan_start && work.plan_end).sort((a, b) => a.plan_end.localeCompare(b.plan_end)).at(-1);
  return last ? addDays(last.plan_end, 1 + (typeOf(last.work_type)?.min_gap_days || 0)) : "";
}

const optionList = (entries, selected) =>
  entries.map(([value, text]) => `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(text)}</option>`).join("");
const cropOptions = (selected) =>
  optionList([["", "登録していない品目"], ...state().crops.map((crop) => [crop.id, cropLabel(crop)])], selected || "");

// 並べ直しの欄に出す基準と日。手で選んだものがあればそれを、なければ初期値を使う
function arrangeFor(owner) {
  const chosen = arrangeChoice.get(ownerKey(owner)) || {};
  const mode = chosen.mode || Object.keys(ARRANGE_MODES[kindOf(owner)])[0];
  return { mode, date: chosen.date ?? arrangeDefault(owner, mode) };
}

// 並べ直しの欄、指摘、作業の表、「作業を追加」。区画の作業と、作付の作業で同じ形
function worksBlock(owner) {
  const kind = kindOf(owner);
  const works = worksOf(owner);
  const mine = problems.filter((problem) => (owner.block_id ? problem.block_id === owner.block_id : problem.planting_id === owner.planting_id));
  const flagged = new Set(mine.map((problem) => problem.work_id).filter(Boolean));
  const warnings = mine
    .map((problem) => {
      const index = works.findIndex((work) => work.id === problem.work_id);
      const where = index >= 0 ? `${index + 1}. ${escapeHtml(typeLabel(works[index].work_type))}: ` : "";
      return `<li>${where}${escapeHtml(problem.message)}</li>`;
    })
    .join("");
  const choice = arrangeFor(owner);
  // 相手に合う種類を先に、それ以外を後ろに出す
  const groups = [kind, kind === "block" ? "bed" : "block"];
  const typeOptions = (selected) =>
    groups
      .map((group) => {
        const types = state().workTypes.filter((type) => (type.scope || "block") === group);
        return `<optgroup label="${SCOPE_LABELS[group]}">${optionList(types.map((type) => [type.code, type.label]), selected)}</optgroup>`;
      })
      .join("");
  const rows = works.length
    ? works
        .map((work, index) => {
          const days = workDays(work);
          const previous = works[index - 1];
          const gap = previous && previous.plan_end && work.plan_start ? diffDays(previous.plan_end, work.plan_start) - 1 : null;
          return (
            `<tr data-id="${work.id}" class="${flagged.has(work.id) ? "is-flagged" : ""}">` +
            `<td>${index + 1}</td>` +
            `<td><select data-field="work_type">${typeOptions(work.work_type)}</select></td>` +
            `<td><input type="date" data-field="plan_start" value="${work.plan_start || ""}" /></td>` +
            `<td><input type="date" data-field="plan_end" value="${work.plan_end || ""}" /></td>` +
            `<td class="num">${days ?? "-"}</td>` +
            `<td class="num">${gap === null ? "-" : gap}</td>` +
            `<td><input type="text" data-field="note" value="${escapeHtml(work.note)}" /></td>` +
            `<td class="edit-only actions">` +
            `<button data-action="up" title="上へ"${index === 0 ? " disabled" : ""}>↑</button>` +
            `<button data-action="down" title="下へ"${index === works.length - 1 ? " disabled" : ""}>↓</button>` +
            `<button data-action="delete" title="削除" class="danger">✕</button></td></tr>`
          );
        })
        .join("")
    : `<tr><td colspan="8" class="muted">作業がまだありません。${kind === "bed" ? "下の「作付を追加」で入れるか" : "ひな形から作るか"}、「作業を追加」で足してください。</td></tr>`;
  return (
    `<div class="row edit-only schedule-tools"${works.length ? "" : " hidden"}>` +
    `<select data-field="arrange-mode" aria-label="並べ直しの基準">${optionList(Object.entries(ARRANGE_MODES[kind]), choice.mode)}</select>` +
    `<input type="date" data-field="arrange-date" aria-label="基準にする日" value="${choice.date}" />` +
    `<button class="chip-btn" data-action="arrange">並べ直す</button></div>` +
    `<ul class="error warning-list">${warnings}</ul>` +
    `<div class="table-scroll"><table class="work-table"><thead><tr><th></th><th>作業</th><th>開始日</th><th>終了日</th><th>日数</th>` +
    `<th>前との間隔</th><th>メモ</th><th class="edit-only"></th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<button class="text-btn edit-only" data-action="add-work">＋ 作業を追加</button>`
  );
}

// 作付 1 つぶんの欄。見出しの行に、折りたたみ、品目、削除。その下に並べ直しの欄と作業の表
function plantingSection(planting) {
  const works = plantingWorks(planting.id);
  const crop = cropOf(planting);
  const closed = folded.has(planting.id);
  const end = harvestEnd(works);
  const range = worksRange(works);
  const info = end
    ? `収穫完了予定日: ${formatDay(end)}`
    : works.length
      ? "収穫完了予定日: 未定（「収穫」の終了日を入れると決まります）"
      : "まだ作業がありません。下で日を決めて「作付を追加」を押すと、この作付にひな形の作業が入ります。";
  // たたんだときは、期間と作業の数だけを見出しの行に出す
  const brief = closed ? `<span class="muted">${range ? `${formatDay(range.start)}〜${formatDay(range.end)}` : "日付なし"}、作業 ${works.length} 件</span>` : "";
  return (
    `<section class="work-section${sel.plantingId === planting.id ? " is-current" : ""}" data-planting="${planting.id}">` +
    `<div class="row section-head">` +
    `<button class="fold-btn" data-action="fold" aria-expanded="${!closed}" title="${closed ? "開く" : "たたむ"}">${closed ? "▸" : "▾"}</button>` +
    `<h3>作付 ${planting.seq}</h3>` +
    `<span class="view-only">${escapeHtml(planting.crop_name)}</span>` +
    `<label class="inline-field edit-only">この作付の品目<select data-field="crop">${cropOptions(crop?.id)}</select>` +
    `<input type="text" data-field="crop_name" placeholder="品目の名前" value="${escapeHtml(planting.crop_name)}"${crop ? " hidden" : ""} /></label>` +
    `<button class="text-btn danger edit-only" data-action="delete-planting">この作付を削除</button>${brief}</div>` +
    `<p class="muted">${escapeHtml(numbersText(planting))} ／ ${info}</p>` +
    `<div class="section-body"${closed ? " hidden" : ""}>${worksBlock({ planting_id: planting.id })}</div></section>`
  );
}

// 区画の作業の欄。ひな形から作る欄は、ここにだけある
function blockSection(block) {
  return (
    `<section class="work-section" data-block="${block.id}">` +
    `<div class="row section-head"><h3>${escapeHtml(block.name)}の作業（畝立ての前まで）</h3></div>` +
    `<div class="section-body">` +
    `<div class="row edit-only schedule-tools">` +
    `<select data-field="template" aria-label="ひな形">${optionList(Object.entries(TEMPLATES.block).map(([key, item]) => [key, item.label]), template.key)}</select>` +
    `<label class="inline-field">最初の作業の日<input type="date" data-field="template-start" value="${template.start}" /></label>` +
    `<button class="chip-btn" data-action="template">ひな形から作る</button></div>` +
    `${worksBlock({ block_id: block.id })}</div></section>`
  );
}

function renderEditor() {
  const blocks = state().blocks;
  const beds = blockBeds(sel.blockId);
  $("scheduleBlock").innerHTML = blocks.map((block) => `<option value="${block.id}">${escapeHtml(block.name)}</option>`).join("");
  $("scheduleBlock").value = sel.blockId;
  $("scheduleTarget").innerHTML =
    `<option value="block">区画の作業（畝立ての前まで）</option>` +
    beds
      .map((bed) => {
        const crops = bedPlantings(bed.id).map((planting) => planting.crop_name).filter(Boolean).join(" → ");
        return `<option value="${bed.id}">畝${bed.seq}${crops ? `（${escapeHtml(crops)}）` : ""}</option>`;
      })
      .join("");
  $("scheduleTarget").value = sel.target;

  const onBed = sel.target !== "block";
  const plantings = onBed ? bedPlantings(sel.target) : [];
  $("addPlantingBar").hidden = !onBed;
  if (onBed) {
    // 追加する作付の品目。選んだままにしておく（同じ品目を続けて足せるように）
    const choice = $("newCropSelect").value;
    $("newCropSelect").innerHTML = cropOptions(state().crops.some((item) => item.id === choice) ? choice : "");
    // 日付の初期値は、畝、作付の数、品目、基準が変わったときに入れ直す（手で直した日は、それまで保つ）
    const adding = [sel.target, plantings.length, plantings.at(-1)?.id, $("newCropSelect").value, $("newPlantingMode").value, state().works.length].join("|");
    if (addingFor !== adding) {
      addingFor = adding;
      $("newPlantingDate").value = newPlantingDefault();
    }
  }
  // 畝では、作付を上から順に並べる。足すたびに下へ伸びる
  $("editorSections").innerHTML = onBed
    ? plantings.map(plantingSection).join("") ||
      '<p class="muted">この畝には作付がまだありません。下で品目と日を決めて「作付を追加」を押すと、畝立てから残渣処理までの作業が入った作付ができます。</p>'
    : blockSection(blocks.find((block) => block.id === sel.blockId));
}

// 並べ直しの基準にする日の初期値
function arrangeDefault(owner, mode) {
  const works = worksOf(owner);
  if (mode === "plant") {
    return works.find((work) => work.work_type === "plant")?.plan_start || "";
  }
  if (mode === "before") {
    // この区画の畝のうち、いちばん早く始まる最初の作付の開始日
    const starts = blockBeds(owner.block_id)
      .map((bed) => bedPlantings(bed.id)[0])
      .filter(Boolean)
      .map((planting) => worksRange(plantingWorks(planting.id))?.start)
      .filter(Boolean);
    return starts.sort()[0] || "";
  }
  return works.find((work) => work.plan_start)?.plan_start || "";
}

function arrange(owner, mode, date) {
  const works = worksOf(owner);
  if (!date) {
    notify("基準にする日を入れてください。");
    return;
  }
  let result;
  if (mode === "before") {
    result = scheduleBefore(works, typesFor(owner), date);
  } else if (mode === "plant") {
    const index = works.findIndex((work) => work.work_type === "plant");
    if (index < 0) {
      notify("この作付には「定植・播種」の作業がありません。");
      return;
    }
    result = scheduleAnchored(works, typesFor(owner), index, date);
  } else {
    result = scheduleForward(works, typesFor(owner), date);
  }
  // 並べ直したあとは、欄の日を結果に合わせて出し直す
  record({
    kind: "work.arrange",
    target: owner.block_id ? ["block", owner.block_id] : ["planting", owner.planting_id],
    text: `${ownerName(owner)}の作業を並べ直した（${ARRANGE_MODES[kindOf(owner)][mode]}: ${fullDay(date)}）`,
  });
  arrangeChoice.delete(ownerKey(owner));
  run(() => replaceWorks(owner, result));
}

function renderTypes() {
  $("typeRows").innerHTML = state()
    .workTypes.map(
      (type) =>
        `<tr data-code="${type.code}"><td><span class="swatch" style="background:${TYPE_COLORS[type.code] || "#888"}"></span>${escapeHtml(type.label)}</td>` +
        `<td><input type="number" min="1" data-field="default_days" value="${type.default_days}" /></td>` +
        `<td><input type="number" min="0" data-field="min_gap_days" value="${type.min_gap_days}" /></td></tr>`
    )
    .join("");
}

// ---- 操作 ----

function newWork(owner, workType, seq) {
  return {
    id: crypto.randomUUID(),
    plan_id: state().plan.id,
    block_id: null,
    planting_id: null,
    ...owner,
    work_type: workType,
    seq,
    plan_start: null,
    plan_end: null,
    actual_start: null,
    actual_end: null,
    note: "",
  };
}

const currentOwner = () => (sel.target === "block" ? { block_id: sel.blockId } : { planting_id: sel.plantingId });
const ownedBy = (work, owner) => (owner.block_id ? work.block_id === owner.block_id : work.planting_id === owner.planting_id);

// ある区画または作付の作業を、まるごと入れ替えて保存する
async function replaceWorks(owner, works) {
  const old = state().works.filter((work) => ownedBy(work, owner));
  const kept = new Set(works.map((work) => work.id));
  works.forEach((work, index) => {
    work.seq = index + 1;
  });
  state().works = [...state().works.filter((work) => !ownedBy(work, owner)), ...works];
  await store().remove("works", old.filter((work) => !kept.has(work.id)).map((work) => work.id));
  await store().upsert("works", works);
}

function applyTemplate(blockId) {
  const owner = { block_id: blockId };
  if (worksOf(owner).length && !confirm("いまの作業を、ひな形の内容に置き換えます。")) {
    return;
  }
  record({ kind: "work.template", target: ["block", blockId], text: `${ownerName(owner)}の作業を、ひな形「${TEMPLATES.block[template.key].label}」から作成` });
  run(async () => {
    let works = TEMPLATES.block[template.key].codes.map((code, index) => newWork(owner, code, index + 1));
    if (template.start) {
      works = scheduleForward(works, state().workTypes, template.start);
    }
    await replaceWorks(owner, works);
  });
}

// 作付のひな形の作業（日付なし）。品目を登録してあれば、マルチを張るかどうかでひな形を選ぶ。
// 品目を登録していない作付は、マルチありで作る（張らないなら、マルチ張りの行を消す）
function draftWorks(crop, owner = {}) {
  const key = crop && !crop.mulch ? "bare" : "mulch";
  return { key, works: TEMPLATES.bed[key].codes.map((code, index) => newWork(owner, code, index + 1)) };
}

// その畝の seq 番目の作付を、いちばん早く始められる日。
// 前の作付（なければ区画）の作業が終わり、あける日数も過ぎた最初の日。どちらにも日付がなければ空
function earliestStart(bed, seq) {
  const earlier = bedPlantings(bed.id).filter((item) => item.seq < seq).at(-1);
  return startAfter(earlier ? plantingWorks(earlier.id) : blockWorks(bed.block_id));
}

// 作付に、ひな形の作業を入れる。日付は品目の日数（収穫開始まで、収穫の日数）で決める。
// timing = { mode: "plant"（定植・播種をその日に始め、前は逆算）か "forward"（最初の作業をその日に始める）, date }
// date が空なら、いちばん早く始められる日から順に並べる。それも分からなければ、日付は空のまま
async function fillPlanting(planting, timing = {}) {
  const crop = cropOf(planting);
  const owner = { planting_id: planting.id };
  const draft = draftWorks(crop, owner);
  const types = typesForCrop(state().workTypes, crop, []);
  const anchor = draft.works.findIndex((work) => work.work_type === "plant");
  const earliest = earliestStart(state().beds.find((item) => item.id === planting.bed_id), planting.seq);
  let works = draft.works;
  if (timing.date && timing.mode === "plant" && anchor >= 0) {
    works = scheduleAnchored(works, types, anchor, timing.date);
  } else if (timing.date || earliest) {
    works = scheduleForward(works, types, timing.date || earliest);
  }
  await replaceWorks(owner, works);
}

// 「作付を追加」の日付の初期値。いちばん早く始められる日から並べたときの、定植・播種の日（または最初の作業の日）
function newPlantingDefault() {
  const plantings = bedPlantings(sel.target);
  const last = plantings.at(-1);
  // 作業のない作付が最後にあれば、足すのではなく、その作付に入れる
  const seq = last && !plantingWorks(last.id).length ? last.seq : (last?.seq || 0) + 1;
  const earliest = earliestStart(state().beds.find((bed) => bed.id === sel.target), seq);
  if (!earliest || $("newPlantingMode").value === "forward") {
    return earliest;
  }
  const crop = state().crops.find((item) => item.id === $("newCropSelect").value);
  const dated = scheduleForward(draftWorks(crop).works, typesForCrop(state().workTypes, crop, []), earliest);
  return dated.find((work) => work.work_type === "plant")?.plan_start || earliest;
}

// 作付を足す。「追加する作付の品目」で選んだ品目の作付を作り、ひな形の作業まで入れる。
// 作業のない作付がもうあるときは、新しく足さずに、その作付に品目と作業を入れる
function addPlanting() {
  const plantings = bedPlantings(sel.target);
  const last = plantings.at(-1);
  const crop = state().crops.find((item) => item.id === $("newCropSelect").value);
  const timing = { mode: $("newPlantingMode").value, date: $("newPlantingDate").value };
  const empty = last && !plantingWorks(last.id).length ? last : null;
  if (last && !empty && !harvestEnd(plantingWorks(last.id))) {
    notify(
      `作付 ${last.seq}${last.crop_name ? `（${last.crop_name}）` : " "}の収穫完了予定日が決まっていません。\n` +
        "次の作付を足す前に、その作付に「収穫」の作業を入れ、終了日を入れてください。"
    );
    return;
  }
  run(async () => {
    let planting = empty;
    if (planting && crop) {
      planting.crop_id = crop.id;
      planting.crop_name = crop.name;
      await store().upsert("plantings", [planting]);
    } else if (!planting) {
      planting = await newPlanting(sel.target, crop?.name || "", crop?.id || null);
    }
    sel.plantingId = planting.id;
    await fillPlanting(planting, timing);
    record({ kind: "planting.add", target: ["planting", planting.id], text: `${ownerName({ planting_id: planting.id })}を追加`, after: rangeText(plantingWorks(planting.id)) });
  });
}

function deletePlanting(id) {
  const planting = state().plantings.find((item) => item.id === id);
  if (!planting || !confirm(`作付 ${planting.seq}${planting.crop_name ? `（${planting.crop_name}）` : ""}と、その作業を削除します。`)) {
    return;
  }
  run(async () => {
    record({ kind: "planting.delete", text: `${ownerName({ planting_id: planting.id })}を削除` });
    await store().remove("plantings", [planting.id]);
    state().plantings = state().plantings.filter((item) => item.id !== planting.id);
    state().works = state().works.filter((work) => work.planting_id !== planting.id);
    folded.delete(planting.id);
    if (sel.plantingId === planting.id) {
      sel.plantingId = null;
    }
  });
}

// 作付の品目を選び直す。cropId が空なら「登録していない品目」（名前は残す）
function changeCrop(plantingId, cropId) {
  const planting = state().plantings.find((item) => item.id === plantingId);
  const crop = state().crops.find((item) => item.id === cropId);
  const was = planting.crop_name || "品目なし";
  planting.crop_id = crop?.id || null;
  if (crop) {
    planting.crop_name = crop.name;
  }
  record({
    kind: "planting.crop",
    target: ["planting", planting.id],
    text: `${placeName(planting)}の品目を変更`,
    before: was,
    after: crop ? crop.name : `${planting.crop_name || "品目なし"}（登録していない品目）`,
  });
  run(async () => {
    await store().upsert("plantings", [planting]);
    // まだ作業のない作付なら、選んだ品目のひな形で作業を入れる。作業があれば、そのままにする
    if (crop && !plantingWorks(planting.id).length) {
      await fillPlanting(planting);
    }
  });
}

function addWork(owner) {
  const works = worksOf(owner);
  const last = works.at(-1);
  const first = state().workTypes.find((type) => (type.scope || "block") === kindOf(owner)) || state().workTypes[0];
  const work = newWork(owner, first.code, works.length + 1);
  if (last && last.plan_end) {
    work.plan_start = addDays(last.plan_end, 1 + (typeOf(last.work_type)?.min_gap_days || 0));
    work.plan_end = addDays(work.plan_start, first.default_days - 1);
  }
  record({ kind: "work.add", target: ["work", work.id], text: `${ownerName(owner)}に、作業「${first.label}」を追加` });
  run(() => replaceWorks(owner, [...works, work]));
}

function changeWork(id, field, value) {
  const work = state().works.find((item) => item.id === id);
  const was = field === "work_type" ? typeLabel(work.work_type) : field === "note" ? null : rangeText([work]);
  if (field === "work_type" || field === "note") {
    work[field] = value;
  } else {
    work[field] = value || null;
    // 開始日だけ入れたら、目安の日数で終了日を入れる。開始日を動かしたら、日数を保って終了日も動かす
    if (field === "plan_start" && value) {
      const kept = daysBeforeEdit && daysBeforeEdit.id === id ? daysBeforeEdit.days : null;
      work.plan_end = addDays(value, (kept || typeOf(work.work_type)?.default_days || 1) - 1);
    }
  }
  record({
    kind: field === "work_type" ? "work.type" : field === "note" ? "work.note" : "work.date",
    target: ["work", id],
    text: `${ownerName(ownerOf(work))}の「${typeLabel(work.work_type)}」の${field === "work_type" ? "種類" : field === "note" ? "メモ" : "日付"}を変更`,
    before: was,
    after: field === "work_type" ? typeLabel(work.work_type) : field === "note" ? null : rangeText([work]),
  });
  daysBeforeEdit = null;
  run(() => store().upsert("works", [work]));
}

function workAction(id, action) {
  const owner = ownerOf(state().works.find((work) => work.id === id));
  const works = worksOf(owner);
  const index = works.findIndex((work) => work.id === id);
  if (action === "delete") {
    record({ kind: "work.delete", text: `${ownerName(owner)}の作業「${typeLabel(works[index].work_type)}」を削除` });
    run(() => replaceWorks(owner, works.filter((work) => work.id !== id)));
    return;
  }
  const other = action === "up" ? index - 1 : index + 1;
  if (other < 0 || other >= works.length) {
    return;
  }
  record({ kind: "work.order", target: owner.block_id ? ["block", owner.block_id] : ["planting", owner.planting_id], text: `${ownerName(owner)}の作業の順番を変更` });
  [works[index], works[other]] = [works[other], works[index]];
  run(() => replaceWorks(owner, works));
}

// 「作業の計画」の欄の中の操作。欄は描くたびに作り直すので、外側でまとめて受ける
function initEditor() {
  const root = $("editorSections");
  const ownerAt = (element) => {
    const section = element.closest(".work-section");
    return section ? (section.dataset.block ? { block_id: section.dataset.block } : { planting_id: section.dataset.planting }) : null;
  };

  root.addEventListener("click", (event) => {
    const owner = ownerAt(event.target);
    if (!owner) {
      return;
    }
    // 触った作付を、貼り付けの入れ先などに使う「いまの作付」にする
    if (owner.planting_id && sel.plantingId !== owner.planting_id) {
      sel.plantingId = owner.planting_id;
      root.querySelectorAll(".work-section").forEach((section) => section.classList.toggle("is-current", section.dataset.planting === sel.plantingId));
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    const row = event.target.closest("tr[data-id]");
    const section = event.target.closest(".work-section");
    const field = (name) => section.querySelector(`[data-field="${name}"]`).value;
    if (action === "fold") {
      if (!folded.delete(owner.planting_id)) {
        folded.add(owner.planting_id);
      }
      renderSchedule();
    } else if (action === "delete-planting") {
      deletePlanting(owner.planting_id);
    } else if (action === "arrange") {
      arrange(owner, field("arrange-mode"), field("arrange-date"));
    } else if (action === "template") {
      applyTemplate(owner.block_id);
    } else if (action === "add-work") {
      addWork(owner);
    } else if (row && action) {
      workAction(row.dataset.id, action);
    }
  });

  root.addEventListener("change", (event) => {
    const owner = ownerAt(event.target);
    const name = event.target.dataset.field;
    const row = event.target.closest("tr[data-id]");
    if (!owner || !name) {
      return;
    }
    if (row) {
      changeWork(row.dataset.id, name, event.target.value);
    } else if (name === "crop") {
      changeCrop(owner.planting_id, event.target.value);
    } else if (name === "crop_name") {
      const planting = state().plantings.find((item) => item.id === owner.planting_id);
      const was = planting.crop_name || "品目なし";
      planting.crop_name = event.target.value.trim();
      record({ kind: "planting.crop", target: ["planting", planting.id], text: `${placeName(planting)}の品目を変更`, before: was, after: planting.crop_name || "品目なし" });
      run(() => store().upsert("plantings", [planting]));
    } else if (name === "arrange-mode") {
      // 基準を変えたら、日もその基準の初期値に入れ直す
      const date = arrangeDefault(owner, event.target.value);
      arrangeChoice.set(ownerKey(owner), { mode: event.target.value, date });
      event.target.closest(".work-section").querySelector('[data-field="arrange-date"]').value = date;
    } else if (name === "arrange-date") {
      arrangeChoice.set(ownerKey(owner), { ...arrangeFor(owner), date: event.target.value });
    } else if (name === "template") {
      template.key = event.target.value;
    } else if (name === "template-start") {
      template.start = event.target.value;
    }
  });

  root.addEventListener("focusin", (event) => {
    // 開始日を動かす前の日数を覚えておく
    const row = event.target.closest("tr[data-id]");
    if (row && event.target.dataset.field === "plan_start") {
      daysBeforeEdit = { id: row.dataset.id, days: workDays(state().works.find((item) => item.id === row.dataset.id)) };
    }
  });
}

// ---- 工程表の上での操作 ----
// 帯を選び、ドラッグで日をずらす。別の行へドラッグすると、その区画や畝へ移す（Ctrl でコピー）

const canEdit = () => !window.matchMedia("(max-width: 800px)").matches;
const ownerOf = (work) => (work.block_id ? { block_id: work.block_id } : { planting_id: work.planting_id });
const ownerKey = (owner) => (owner.block_id ? `block:${owner.block_id}` : `planting:${owner.planting_id}`);
const pickedWorks = () => state().works.filter((work) => picked.has(work.id));
const rowKey = (row) => (row.dataset.block ? `block:${row.dataset.block}` : `bed:${row.dataset.bed}`);
// 作業が工程表のどの行にあるか（畝の作業は、作付ではなく畝の行）
const rowOf = (work) =>
  work.block_id ? `block:${work.block_id}` : `bed:${state().plantings.find((planting) => planting.id === work.planting_id)?.bed_id}`;

function renderPickTools() {
  const count = pickedWorks().length;
  $("pickInfo").textContent = count ? `${count} 件を選択中` : "選択なし";
  for (const id of ["copyPickedBtn", "cutPickedBtn", "deletePickedBtn"]) {
    $(id).disabled = !count;
  }
  $("pastePickedBtn").disabled = !clipboard;
  $("pastePickedBtn").textContent = clipboard ? `貼り付け（${clipboard.works.length} 件）` : "貼り付け";
}

function showPicked() {
  $("gantt").querySelectorAll(".gantt-bar").forEach((bar) => bar.classList.toggle("is-picked", picked.has(bar.dataset.id)));
  renderPickTools();
}

// 区画や作付の作業を、日付の順に並べ直して番号を振る（日付のない作業は後ろ）
function sortOwner(owner) {
  const works = state()
    .works.filter((work) => ownedBy(work, owner))
    .sort((a, b) => (a.plan_start || "9999").localeCompare(b.plan_start || "9999") || a.seq - b.seq);
  works.forEach((work, index) => {
    work.seq = index + 1;
  });
  return works;
}

async function newPlanting(bedId, cropName, cropId = null) {
  const planting = {
    id: crypto.randomUUID(),
    plan_id: state().plan.id,
    bed_id: bedId,
    seq: (bedPlantings(bedId).at(-1)?.seq || 0) + 1,
    crop_id: cropId,
    crop_name: cropName || "",
    note: "",
  };
  await store().upsert("plantings", [planting]);
  state().plantings.push(planting);
  return planting;
}

// 工程表の行に作業を入れるときの入れ先。畝の行なら、その日が入る作付、
// なければその日より前に始まる最後の作付、それもなければ最初の作付。作付がなければ作る
async function ownerForRow(row, date, cropName) {
  if (row.dataset.block) {
    return { block_id: row.dataset.block };
  }
  const plantings = bedPlantings(row.dataset.bed).map((planting) => ({ planting, range: worksRange(plantingWorks(planting.id)) }));
  if (!plantings.length) {
    return { planting_id: (await newPlanting(row.dataset.bed, cropName)).id };
  }
  const hit =
    plantings.find(({ range }) => range && date && range.start <= date && date <= range.end) ||
    plantings.filter(({ range }) => range && date && range.start <= date).at(-1) ||
    plantings[0];
  return { planting_id: hit.planting.id };
}

async function shiftWorks(works, days) {
  const changed = new Set();
  for (const work of works) {
    work.plan_start = addDays(work.plan_start, days);
    work.plan_end = addDays(work.plan_end, days);
  }
  for (const owner of new Map(works.map((work) => [ownerKey(ownerOf(work)), ownerOf(work)])).values()) {
    sortOwner(owner).forEach((work) => changed.add(work));
  }
  await store().upsert("works", [...changed]);
}

// 作業を別の区画や作付へ移す。copy なら、元を残して写しを入れる
async function transferWorks(works, owner, days, copy) {
  const sources = new Map(works.map((work) => [ownerKey(ownerOf(work)), ownerOf(work)]));
  const placed = works.map((work) => {
    const target = copy ? { ...work, id: crypto.randomUUID() } : work;
    if (days && target.plan_start && target.plan_end) {
      target.plan_start = addDays(target.plan_start, days);
      target.plan_end = addDays(target.plan_end, days);
    }
    target.block_id = owner.block_id || null;
    target.planting_id = owner.planting_id || null;
    if (copy) {
      state().works.push(target);
    }
    return target;
  });
  const changed = new Set(placed);
  for (const each of [...sources.values(), owner]) {
    sortOwner(each).forEach((work) => changed.add(work));
  }
  await store().upsert("works", [...changed]);
  picked.clear();
  placed.forEach((work) => picked.add(work.id));
}

function deletePicked() {
  const works = pickedWorks();
  if (!works.length || !confirm(`選んだ作業 ${works.length} 件を削除します。`)) {
    return;
  }
  run(async () => {
    const ids = new Set(works.map((work) => work.id));
    record({ kind: "work.delete", text: `${ownerName(ownerOf(works[0]))}の作業 ${works.length} 件（${works.map((work) => typeLabel(work.work_type)).join("、")}）を削除` });
    state().works = state().works.filter((work) => !ids.has(work.id));
    picked.clear();
    await store().remove("works", [...ids]);
    const changed = new Set();
    for (const owner of new Map(works.map((work) => [ownerKey(ownerOf(work)), ownerOf(work)])).values()) {
      sortOwner(owner).forEach((work) => changed.add(work));
    }
    await store().upsert("works", [...changed]);
  });
}

function copyPicked(cut) {
  const works = pickedWorks();
  if (works.length) {
    clipboard = { works: works.map((work) => ({ ...work })), cut };
    renderPickTools();
    ctx.setStatus(`${works.length} 件を${cut ? "切り取り" : "コピー"}ました。行をクリックして入れ先を選び、「貼り付け」を押してください。`);
  }
}

// 「作業の計画」で開いている区画や作付に貼り付ける
function pastePicked() {
  if (!clipboard) {
    return;
  }
  const { works, cut } = clipboard;
  run(async () => {
    let owner = currentOwner();
    if (sel.target !== "block" && !sel.plantingId) {
      const crop = state().plantings.find((planting) => planting.id === works[0].planting_id)?.crop_name;
      sel.plantingId = (await newPlanting(sel.target, crop)).id;
      owner = { planting_id: sel.plantingId };
    }
    if (cut) {
      // 切り取ったあとで消された作業は、もう移せない
      const originals = state().works.filter((work) => works.some((item) => item.id === work.id));
      if (originals.length) {
        record({ kind: "work.transfer", text: `${ownerName(ownerOf(originals[0]))}の作業 ${originals.length} 件を、切り取って貼り付けで移動` });
      }
      await transferWorks(originals, owner, 0, false);
      clipboard = null;
    } else {
      await transferWorks(works, owner, 0, true);
      record({ kind: "work.transfer", text: `作業 ${works.length} 件（${works.map((work) => typeLabel(work.work_type)).join("、")}）を、${ownerName(owner)}へコピーして貼り付け` });
    }
  });
}

function initGanttEditing() {
  const gantt = $("gantt");
  const tip = $("ganttTip");
  const clearDragMarks = () => {
    gantt.classList.remove("is-dragging");
    gantt.querySelectorAll(".gantt-row.is-drop").forEach((row) => row.classList.remove("is-drop"));
    gantt.querySelectorAll(".gantt-bar").forEach((bar) => {
      bar.style.transform = "";
    });
  };

  // 帯を押したあとに届くクリックは、帯の操作の続きなので、行のクリックとして扱わない
  // （押しているあいだに図を描き直すと、クリックの相手が帯ではなく行になることがある）
  let pressedBar = false;

  gantt.addEventListener("pointerdown", (event) => {
    const bar = event.target.closest(".gantt-bar");
    pressedBar = Boolean(bar);
    if (!bar || !canEdit() || event.button !== 0) {
      return;
    }
    const id = bar.dataset.id;
    const row = bar.closest(".gantt-row");
    // 複数選べるのは同じ行の中だけ。別の行の帯を選んだら、選び直す
    const sameRow = pickedWorks().every((work) => rowOf(work) === rowKey(row));
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      if (!sameRow) {
        picked.clear();
      }
      if (picked.has(id)) {
        picked.delete(id);
      } else {
        picked.add(id);
      }
      showPicked();
      return;
    }
    if (!picked.has(id) || !sameRow) {
      picked.clear();
      picked.add(id);
    }
    showPicked();
    barDrag = { id, row, startX: event.clientX, startY: event.clientY, moved: false, days: 0, target: null };
    gantt.setPointerCapture(event.pointerId);
  });

  gantt.addEventListener("pointermove", (event) => {
    if (!barDrag) {
      return;
    }
    const dx = event.clientX - barDrag.startX;
    const dy = event.clientY - barDrag.startY;
    if (!barDrag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 6) {
      return;
    }
    barDrag.moved = true;
    barDrag.days = Math.round(dx / DAY_PX);
    gantt.classList.add("is-dragging");
    const under = document.elementFromPoint(event.clientX, event.clientY)?.closest(".gantt-row");
    barDrag.target = under && gantt.contains(under) && under !== barDrag.row ? under : null;
    gantt.querySelectorAll(".gantt-row.is-drop").forEach((row) => row.classList.remove("is-drop"));
    barDrag.target?.classList.add("is-drop");
    const top = (row) => row.querySelector(".gantt-track").getBoundingClientRect().top;
    const offsetY = barDrag.target ? top(barDrag.target) - top(barDrag.row) : 0;
    gantt.querySelectorAll(".gantt-bar.is-picked").forEach((bar) => {
      bar.style.transform = `translate(${barDrag.days * DAY_PX}px, ${offsetY}px)`;
    });
    // 同じ行の中で動かしているあいだは、動かした先の日付で無理を見直して、斜線を付け外しする
    if (!barDrag.target) {
      const moved = (work) =>
        picked.has(work.id) && work.plan_start && work.plan_end
          ? { ...work, plan_start: addDays(work.plan_start, barDrag.days), plan_end: addDays(work.plan_end, barDrag.days) }
          : work;
      const flagged = new Set(planProblems({ ...state(), works: state().works.map(moved) }).map((problem) => problem.work_id));
      gantt.querySelectorAll(".gantt-bar").forEach((bar) => bar.classList.toggle("is-flagged", flagged.has(bar.dataset.id)));
    }
    // 動かした先の日付と、移す先を出す
    const work = state().works.find((item) => item.id === barDrag.id);
    const where = barDrag.target ? `<br>→ ${escapeHtml(barDrag.target.querySelector(".gantt-name").textContent)}${event.ctrlKey ? " へコピー" : " へ移動"}` : "";
    tip.innerHTML =
      `<strong>${escapeHtml(typeLabel(work.work_type))}</strong>` +
      `${fullDay(addDays(work.plan_start, barDrag.days))} 〜 ${fullDay(addDays(work.plan_end, barDrag.days))}${where}`;
    tip.hidden = false;
    tip.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${event.clientY + 18}px`;
  });

  const finish = (event) => {
    const drag = barDrag;
    barDrag = null;
    if (!drag) {
      return;
    }
    const target = drag.target;
    clearDragMarks();
    tip.hidden = true;
    if (event.type === "pointercancel") {
      renderSchedule();
      return;
    }
    if (!drag.moved) {
      // 動かさずに離した: その行を「作業の計画」で開く
      openInSchedule(drag.row.dataset.block ? "block" : "bed", drag.row.dataset.block || drag.row.dataset.bed);
      renderSchedule();
      return;
    }
    const works = pickedWorks();
    if (target) {
      run(async () => {
        const first = works.map((work) => addDays(work.plan_start, drag.days)).sort()[0];
        const crop = state().plantings.find((planting) => planting.id === works[0].planting_id)?.crop_name;
        const from = ownerName(ownerOf(works[0]));
        const names = works.map((work) => typeLabel(work.work_type)).join("、");
        const owner = await ownerForRow(target, first, crop);
        await transferWorks(works, owner, drag.days, event.ctrlKey);
        record({ kind: "work.transfer", text: `${from}の作業 ${works.length} 件（${names}）を、${ownerName(owner)}へ${event.ctrlKey ? "コピー" : "移動"}` });
      });
    } else if (drag.days) {
      record({
        kind: "work.shift",
        target: ["work", works[0].id],
        text: `${ownerName(ownerOf(works[0]))}の作業 ${works.length} 件（${works.map((work) => typeLabel(work.work_type)).join("、")}）を、${Math.abs(drag.days)} 日${drag.days > 0 ? "後ろ" : "前"}へずらした`,
      });
      run(() => shiftWorks(works, drag.days));
    } else {
      renderSchedule();
    }
  };
  gantt.addEventListener("pointerup", finish);
  gantt.addEventListener("pointercancel", finish);

  // 帯のない所をクリックすると、選択を外して、その行を「作業の計画」で開く
  gantt.addEventListener("click", (event) => {
    const row = event.target.closest(".gantt-row");
    if (pressedBar || event.target.closest(".gantt-bar") || !row) {
      return;
    }
    picked.clear();
    openInSchedule(row.dataset.block ? "block" : "bed", row.dataset.block || row.dataset.bed);
    renderSchedule();
  });

  $("copyPickedBtn").addEventListener("click", () => copyPicked(false));
  $("cutPickedBtn").addEventListener("click", () => copyPicked(true));
  $("pastePickedBtn").addEventListener("click", pastePicked);
  $("deletePickedBtn").addEventListener("click", deletePicked);
  document.addEventListener("keydown", (event) => {
    if ($("scheduleView").hidden || !canEdit() || ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) {
      return;
    }
    const command = event.ctrlKey || event.metaKey;
    if (event.key === "Delete" || event.key === "Backspace") {
      deletePicked();
    } else if (event.key === "Escape") {
      picked.clear();
      showPicked();
    } else if (command && event.key === "c") {
      copyPicked(false);
    } else if (command && event.key === "x") {
      copyPicked(true);
    } else if (command && event.key === "v") {
      pastePicked();
    }
  });
}

export function initSchedule(context) {
  ctx = context;
  initStrip({
    ...context,
    selection: () => sel,
    refresh: renderSchedule,
    // 足した畝に、品目を決めた作付を 1 つずつ作り、ひな形の作業を入れる
    assignCrop: (beds, cropId) => {
      const crop = state().crops.find((item) => item.id === cropId);
      if (crop && beds.length) {
        run(async () => {
          for (const bed of beds) {
            await fillPlanting(await newPlanting(bed.id, crop.name, crop.id));
          }
          const block = state().blocks.find((item) => item.id === beds[0].block_id);
          record({
            kind: "planting.add",
            target: ["block", block.id],
            text: `${block.name}の畝 ${beds.map((bed) => bed.seq).join("、")} に、作付（${crop.name}）を追加`,
          });
        });
      }
    },
    flagged: (kind, id) => problems.some((problem) => (kind === "block" ? problem.block_id === id : problemBed(problem) === id)),
    open: (kind, id) => {
      openInSchedule(kind, id);
      renderSchedule();
    },
  });

  $("scheduleBlock").addEventListener("change", (event) => {
    Object.assign(sel, { blockId: event.target.value, target: "block", plantingId: null });
    renderSchedule();
  });
  $("scheduleTarget").addEventListener("change", (event) => {
    Object.assign(sel, { target: event.target.value, plantingId: null });
    renderSchedule();
  });
  initEditor();
  initGanttEditing();
  // 工程表の帯にマウスを乗せると、開始日と終了日を出す
  const tip = $("ganttTip");
  $("gantt").addEventListener("pointermove", (event) => {
    if (barDrag) {
      return; // ドラッグ中は、動かした先の日付を別に出している
    }
    const bar = event.target.closest(".gantt-bar");
    tip.hidden = !bar;
    if (bar) {
      tip.innerHTML = bar.dataset.tip;
      const width = tip.offsetWidth;
      tip.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - width - 8))}px`;
      tip.style.top = `${event.clientY + 18}px`;
    }
  });
  $("gantt").addEventListener("pointerleave", () => {
    tip.hidden = true;
  });
  $("addPlantingBtn").addEventListener("click", addPlanting);
  for (const id of ["newCropSelect", "newPlantingMode"]) {
    $(id).addEventListener("change", () => {
      $("newPlantingDate").value = newPlantingDefault();
    });
  }
  $("problemList").addEventListener("click", (event) => {
    const item = event.target.closest("li[data-id]");
    if (item) {
      openInSchedule(item.dataset.kind, item.dataset.id);
      renderSchedule();
      const section = $("editorSections").querySelector(`[data-planting="${sel.plantingId}"]`) || $("editorSections");
      section.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
  $("typeRows").addEventListener("change", (event) => {
    const row = event.target.closest("tr[data-code]");
    const value = Number(event.target.value);
    if (!row || !Number.isFinite(value) || value < 0) {
      return;
    }
    const type = typeOf(row.dataset.code);
    const was = type[event.target.dataset.field];
    type[event.target.dataset.field] = Math.round(value);
    record({
      kind: `type.${event.target.dataset.field}`,
      target: ["type", null],
      plan: false,
      text: `作業の種類「${type.label}」の${event.target.dataset.field === "default_days" ? "かかる日数" : "あとにあける日数"}の目安を変更`,
      before: `${was} 日`,
      after: `${Math.round(value)} 日`,
    });
    run(() => store().saveWorkType(type));
  });
}

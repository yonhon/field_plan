// 「日程」の画面。耕起対象区画には畝立ての前までの作業を、畝には作付ごとに畝立てから後の作業を並べる。
import {
  TEMPLATES,
  WORK_COLORS as TYPE_COLORS,
  addDays,
  diffDays,
  dueWorks,
  GANTT_RANGES,
  dayWidth,
  ganttWindow,
  isManagement,
  localToday,
  planProblems,
  scheduleAnchored,
  scheduleForward,
  typesForCrop,
  workDays,
  workName,
  worksRange,
} from "./schedule.js";
import { summarize } from "./crops.js";
import { confirmDelete, notify, notifySaveFailed } from "./dialog.js";
import { record } from "./journal.js";
import { completeWorks, copyPlanWorks, logForWork, moveLogs, openLogEditor, openPlanEditor } from "./log-view.js";
import { isBlockTarget, lateWorks, layoutBars, logEnd, plantingOnDate, withActualDates, workActuals, workStatus } from "./logs.js";
import { loadPref, savePref } from "./prefs.js";
import { PAGE_PX, printPage } from "./print.js";
import { initStrip, renderStrip } from "./strip-view.js";
import { draw } from "./draw.js";
import { escapeHtml } from "./html.js";

const $ = (id) => document.getElementById(id);
// 工程表の寸法。1 日の幅は、表示期間が画面の幅に収まるように描くたびに決める（dayPx）
let dayPx = 7;
const NAME_W = 180; // 名前の列の幅
const BAR_TOP = 4; // 帯の欄の上の余白
const BAR_H = 26; // 計画の帯の高さ（「実績」だけのときは実績の帯も）
const THIN_H = 10; // 「計画と実績」で計画の帯の下側に重ねる、実績の帯の高さ
const MIN_BAR_PX = 12; // 1 日の作業も、押せるようにこの幅より細くしない
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
export const SCOPE_LABELS = { block: "区画の作業（畝立ての前まで）", bed: "畝の作業（畝立てから後）" };

let ctx = null; // { state, setStatus, queueSave, cropColor, plantingOn }
// いま編集している相手。target は "block"（区画の作業）か、畝の ID
const sel = { blockId: null, target: "block", plantingId: null };
// URL の区画で開いたとき、前に開いていたのがその区画の畝なら、その畝に戻す（データを読んでから、keepSelection で）
let restoreBed = false;
let problems = []; // 日程の無理。描くたびに求め直す
export const ARRANGE_MODES = {
  block: { before: "畝立てをこの日に始められるように逆算", forward: "最初の作業をこの日に始める" },
  bed: { plant: "定植・播種をこの日に始める（前は逆算）", forward: "最初の作業をこの日に始める" },
};
const picked = new Set(); // 工程表で選んでいる作業の ID
let clipboard = null; // コピーか切り取りをした作業 { works, cut }
let barDrag = null; // 工程表で帯をドラッグしている途中の状態
// 工程表で選んでいる行（"block:区画の ID" か "bed:畝の ID"）。貼り付けの入れ先と、「＋ 入力する」の対象になる。
// 日程の画面で開いている区画・畝（sel）とは別に覚える
let rowSel = null;
let ganttScrollKey = ""; // 工程表の横の位置を保つための、表示期間とプランと、描く区画
let ganttScopeKey = null; // 前に描いた工程表の範囲（区画の ID か "all"）。範囲が変わったら、帯の選択を外す
let ganttFocused = false; // 最後に押したのが工程表の欄か。圃場図の画面で、キーの操作を工程表と図のどちらに渡すかを決める
let actualDrag = null; // 工程表で実績の帯をドラッグしている途中の状態

const state = () => ctx.state;
const store = () => ctx.state.store;
const typeOf = (code) => state().workTypes.find((type) => type.code === code);
const cropOf = (planting) => state().crops.find((crop) => crop.id === planting?.crop_id) || null;
// 区画や作付に合わせた、作業の種類の目安。品目を登録した作付なら、その品目の日数を使う
function typesFor(owner) {
  const planting = state().plantings.find((item) => item.id === owner.planting_id);
  return typesForCrop(state().workTypes, cropOf(planting), planting ? plantingWorks(planting.id) : []);
}
const typeFor = (owner, code) => typesFor(owner).find((type) => type.code === code);
// 工程の作業の種類になければ（管理作業）、すべての種類から探す
const typeLabel = (code) => typeOf(code)?.label || anyTypeLabel(code);
const bySeq = (a, b) => a.seq - b.seq;

const blockBeds = (blockId) => state().beds.filter((bed) => bed.block_id === blockId).sort(bySeq);
const bedPlantings = (bedId) => state().plantings.filter((planting) => planting.bed_id === bedId).sort(bySeq);
const blockWorks = (blockId) => state().works.filter((work) => work.block_id === blockId).sort(bySeq);
const plantingWorks = (plantingId) => state().works.filter((work) => work.planting_id === plantingId).sort(bySeq);

// 開いているプランが、実際に使うプランか。記録がつながるのはこのときだけなので、完了のボタンや実績もこのときだけ出す
export const isActivePlan = () => state().field.active_plan_id === state().plan.id;
// 計画の作業の実績（作業の ID → { start, end }）。実際に使うプランでなければ空
export const currentActuals = () => (isActivePlan() ? workActuals(state().logs || []) : new Map());

// 工程の作業だけ。管理作業（防除など）は、工程の計画と並べ直しの対象にしない（入力の窓の「管理作業の計画」で入れる）
const processOnly = (works) => works.filter((work) => !isManagement(work.work_type));

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
    notifySaveFailed(error);
  }
  renderSchedule();
}

// ---- 描画 ----

// 日程の画面で開いていた区画・畝を、プランごとにブラウザーへ覚える（次に開いたときに、同じ区画・畝を開く）
const savedPlace = () => (state().field && state().plan ? loadPref(state().field.id, "schedulePlace")?.[state().plan.id] || null : null);

function rememberPlace() {
  if (!state().field || !state().plan || !sel.blockId) {
    return;
  }
  const place = { blockId: sel.blockId, target: sel.target, plantingId: sel.plantingId };
  const saved = savedPlace();
  if (saved && saved.blockId === place.blockId && saved.target === place.target && saved.plantingId === place.plantingId) {
    return;
  }
  const places = loadPref(state().field.id, "schedulePlace") || {};
  savePref(state().field.id, "schedulePlace", { ...places, [state().plan.id]: place });
}

function keepSelection() {
  const blocks = state().blocks;
  if (!blocks.length) {
    Object.assign(sel, { blockId: null, target: "block", plantingId: null });
    return;
  }
  const saved = savedPlace();
  if (!blocks.some((block) => block.id === sel.blockId)) {
    // 開いていた区画がこのプランにない（起動したとき、プランを替えたとき）: 前にこのプランで開いていた区画・畝。なければ先頭の区画
    const known = saved && blocks.some((block) => block.id === saved.blockId);
    Object.assign(sel, known ? { blockId: saved.blockId, target: saved.target, plantingId: saved.plantingId } : { blockId: blocks[0].id, target: "block", plantingId: null });
  } else if (restoreBed && saved?.blockId === sel.blockId) {
    Object.assign(sel, { target: saved.target, plantingId: saved.plantingId });
  }
  restoreBed = false;
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

// 圃場図で選んだ区画や畝を、日程でも開く。restore: URL の区画で開いたとき（前にその区画の畝を開いていたら、その畝に戻す）
export function openInSchedule(kind, id, { restore = false } = {}) {
  restoreBed = restore;
  if (kind === "block") {
    Object.assign(sel, { blockId: id, target: "block", plantingId: null });
  } else if (kind === "planting") {
    const planting = state().plantings.find((item) => item.id === id);
    const bed = state().beds.find((item) => item.id === planting.bed_id);
    Object.assign(sel, { blockId: bed.block_id, target: bed.id, plantingId: id });
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
  rememberPlace();
  const blocks = state().blocks;
  $("scheduleEmpty").hidden = blocks.length > 0;
  $("scheduleBody").hidden = blocks.length === 0;
  renderOverview();
  renderSummary();
  if (!blocks.length) {
    return;
  }
  renderStrip();
  renderGantt();
  ctx.renderBlockRecord(sel.blockId);
  renderTypes();
  if (!$("scheduleView").hidden) {
    renderPicker("schedule");
    // 開いている区画を URL に書く（再読み込みしても同じ区画を開く）。「区画と畝」の図で区画を替えたときも書き換える
    if (location.hash !== scheduleHash()) {
      history.replaceState(history.state, "", scheduleHash());
    }
  }
}

// 日程の画面で開いている区画（「作業を入力する」の窓の、工程の計画の初めの相手に使う）
export const currentBlockId = () => sel.blockId;

// 日程の画面の URL。区画を選んでいれば #schedule/block/区画の ID
export const scheduleHash = () => (sel.blockId ? `#schedule/block/${sel.blockId}` : "#schedule");

// ---- 区画・畝の欄 ----

// 区画か畝を選ぶ欄を、日程（"schedule"）か作付の詳細（"planting"）の上へ移す
export function placePicker(view) {
  const slot = $(view === "planting" ? "pickerSlotPlanting" : "pickerSlotSchedule");
  if ($("pickerPanel").parentElement !== slot) {
    slot.append($("pickerPanel"));
  }
}

// 畝を選んだときに開く作付。今日その畝にある作付、なければ最後の作付
const bedPlantingNow = (bedId) => {
  const plantings = bedPlantings(bedId);
  return plantingOnDate(plantings, state().works, localToday(), state().logs || []) || plantings.at(-1) || null;
};

// 区画・畝の欄を描く。日程の画面では選んでいる区画、作付の詳細では開いている作付の畝を選んだ形にする。
// 確認が必要な点のある区画と畝には ⚠ を付け、その区画（畝）の確認が必要な点を欄の下に並べる
export function renderPicker(view) {
  if (!ctx) {
    return;
  }
  const blocks = state().blocks;
  $("pickerPanel").hidden = !blocks.length;
  if (!blocks.length) {
    return;
  }
  const blockOfProblem = (problem) => problem.block_id || state().beds.find((bed) => bed.id === problemBed(problem))?.block_id;
  const mark = (on) => (on ? " ⚠" : "");
  draw(
    $("schedulePicker"),
    blocks
      .map((block) => {
        const beds = blockBeds(block.id)
          .map((bed) => {
            const crops = bedPlantings(bed.id).map((planting) => planting.crop_name).filter(Boolean).join(" → ");
            const flagged = problems.some((problem) => problemBed(problem) === bed.id);
            return `<option value="bed:${bed.id}">${escapeHtml(`${block.name} 畝${bed.seq}${crops ? ` ${crops}` : ""}${mark(flagged)}`)}</option>`;
          })
          .join("");
        // 区画の行は太字にして、その下に畝の行を並べる（区画の行も選べる）
        const flagged = problems.some((problem) => blockOfProblem(problem) === block.id);
        return `<option value="block:${block.id}" class="picker-block">${escapeHtml(`${block.name}${mark(flagged)}`)}</option>${beds}`;
      })
      .join("")
  );
  if (view === "planting") {
    const target = ctx.plantingTarget();
    const bedId = state().plantings.find((planting) => planting.id === target.id)?.bed_id;
    $("schedulePicker").value = bedId ? `bed:${bedId}` : "";
  } else {
    $("schedulePicker").value = `block:${sel.blockId}`;
  }
}

// 区画（kind "block"）か畝（"bed"）の、確認が必要な点の欄（HTML）。なければ空。
// 区画の頭と作付の詳細の頭の下に置く（区画・畝の欄の中に置くと、有無で頭の位置が上下するため）
export function scopeProblemsHtml(kind, id) {
  const blockOf = (problem) => problem.block_id || state().beds.find((bed) => bed.id === problemBed(problem))?.block_id;
  const shown = problems.filter((problem) => (kind === "block" ? blockOf(problem) === id : problemBed(problem) === id));
  return shown.length ? `<section class="panel problem-panel"><ul class="problem-list">${problemItems(shown)}</ul></section>` : "";
}

// 区画（kind "block"）か作付（"planting"）の工程の計画を、「作業を入力する」の窓の「工程の計画」のタブで開く。
// 確認が必要な点の行、作付の詳細の計画の欄、変更の履歴の行から使う
export function openProcessPlan(kind, id) {
  openLogEditor(null, kind === "block" ? { tab: "process", blockId: id } : { tab: "process", plantingId: id });
}

// 確認が必要な点の行を押したとき: その区画か作付の工程の計画を、窓で開く
export function openProblemTarget(kind, id) {
  openProcessPlan(kind, id);
}

// 区画・畝の欄で選んだとき。区画なら日程の画面でその区画を、畝ならその畝の作付の詳細を開く。
// 作付のない畝は、日程の画面でその区画を開き、窓の工程の計画をその畝で開く（作付を足せる）
function onPick(value) {
  const [kind, id] = value.split(":");
  if (kind === "block") {
    Object.assign(sel, { blockId: id, target: "block", plantingId: null });
    ctx.showView("schedule");
    return;
  }
  const bed = state().beds.find((item) => item.id === id);
  if (!bed) {
    return;
  }
  const planting = bedPlantingNow(id);
  if (planting) {
    // 日程の画面に戻ったときも、この畝の区画を開く
    Object.assign(sel, { blockId: bed.block_id, target: bed.id, plantingId: planting.id });
    rememberPlace();
    ctx.openDetail("planting", planting.id);
  } else {
    Object.assign(sel, { blockId: bed.block_id, target: bed.id, plantingId: null });
    ctx.showView("schedule");
    openLogEditor(null, { tab: "process", bedId: bed.id });
  }
}

// 圃場図の上に出す、圃場の全体の情報（今週やること、遅れている作業、確認が必要な点と、タブの件数）。
// 日程の画面を描くときと、圃場図を開いたときに描く
function renderOverview() {
  if (!ctx) {
    return;
  }
  renderWeek();
  // 取りやめた作業は見ない。実績のある作業は、実績の日で無理を見る
  const live = state().works.filter((work) => !work.cancelled_on);
  problems = planProblems({ ...state(), works: isActivePlan() ? withActualDates(live, currentActuals()) : live });
  renderProblems();
  ctx.renderWarnings();
}

// 確認が必要な点の件数。圃場図の警告と合わせて、「圃場図」のタブに出す
export const problemTotal = () => problems.length;

// 同じ日の同じ作業は、場所をまとめて 1 行にする
function weekLines(works) {
  const lines = new Map();
  for (const work of works) {
    const key = `${work.plan_start}|${work.plan_end}|${work.work_type}`;
    if (!lines.has(key)) {
      lines.set(key, { work, works: [], places: [] });
    }
    lines.get(key).works.push(work);
    lines.get(key).places.push(placeOf(work));
  }
  return [...lines.values()];
}

// 今週やることと遅れている作業の 1 行。実際に使うプランなら「完了」と「修正」のボタンを付ける。
// 完了した行は ✓ と実施日を付けて薄くし、「修正」でその記録を開く
function weekItem({ work, works, places }, actuals, late) {
  const today = localToday();
  const where = places.length > 4 ? `${places[0]} ほか ${places.length - 1} か所` : places.join("、");
  const ids = works.map((item) => item.id).join(",");
  const done = isActivePlan() && works.every((item) => workStatus(item, actuals, today) === "done");
  const started = works.map((item) => actuals.get(item.id)?.start).filter(Boolean).sort()[0];
  const ends = works.map((item) => actuals.get(item.id)?.end).filter(Boolean).sort();
  let status = "";
  if (done) {
    const first = works.map((item) => actuals.get(item.id).start).sort()[0];
    status = `${first === ends.at(-1) ? formatDay(first) : `${formatDay(first)}〜${formatDay(ends.at(-1))}`} に実施`;
  } else if (late) {
    status = `${diffDays(work.plan_end, today)} 日遅れ${started ? `・${formatDay(started)} に開始` : ""}`;
  } else if (started) {
    status = `${formatDay(started)} に開始`;
  }
  const buttons = !isActivePlan()
    ? ""
    : done
      ? `<button class="text-btn" data-week="edit-log" data-ids="${ids}">修正</button>`
      : `<button class="chip-btn" data-week="edit" data-ids="${ids}" title="日付や内容を入れて、実績を入力します（初めは計画の日）">修正</button>` +
        `<button class="primary-btn" data-week="done" data-ids="${ids}" title="計画どおりの日に行ったものとして、実績を入力します">完了</button>`;
  return (
    `<li class="${done ? "is-done" : ""}"><span class="week-date">${done ? "✓ " : ""}${formatRange(work)}</span>` +
    `<span class="week-work"><span class="swatch" style="background:${TYPE_COLORS[work.work_type] || "#888"}"></span>${escapeHtml(workName(typeLabel(work.work_type), work.detail?.spec))}</span>` +
    `<span class="muted">${escapeHtml(where)}${places.length === 1 && work.note ? ` / ${escapeHtml(work.note)}` : ""}${status ? `・${escapeHtml(status)}` : ""}</span>` +
    `${buttons ? `<span class="week-actions">${buttons}</span>` : ""}</li>`
  );
}

function renderWeek() {
  const today = localToday();
  const actuals = currentActuals();
  const live = state().works.filter((work) => !work.cancelled_on);
  const { due, upcoming } = dueWorks(live, today);
  const late = isActivePlan() ? lateWorks(live, actuals, today) : [];
  // 遅れている作業のタブ: あるときは、タブの名前に ⚠ と件数を付ける（見落とさないように）
  const lateCount = weekLines(late).length;
  $("lateBadge").hidden = !lateCount;
  $("lateBadge").textContent = `⚠${lateCount}`;
  $("lateEmpty").hidden = Boolean(lateCount);
  draw(
    $("lateList"),
    weekLines(late)
      .map((line) => weekItem(line, actuals, true))
      .join("")
  );
  const items = weekLines(due.length ? due : upcoming).map((line) => weekItem(line, actuals, false));
  $("weekNote").hidden = Boolean(due.length || !upcoming.length);
  draw($("weekList"), items.length ? items.join("") : '<li class="muted">予定はありません</li>');
}

// 今週やることの「完了」「修正」
async function onWeekClick(event) {
  const button = event.target.closest("[data-week]");
  if (!button) {
    return;
  }
  const ids = button.dataset.ids.split(",");
  const works = ids.map((id) => state().works.find((work) => work.id === id)).filter(Boolean);
  if (!works.length) {
    return;
  }
  if (button.dataset.week === "done") {
    // 防除と追肥は、農薬や肥料の量を入れないと実績にならないので、計画の中身を入れた実績の窓を開く
    if (["spray", "topdress"].includes(works[0].work_type)) {
      openLogEditor(null, { works: works.filter((work) => !currentActuals().get(work.id)?.end) });
      return;
    }
    button.disabled = true;
    await completeWorks(works);
  } else if (button.dataset.week === "edit") {
    // 作業中の記録（まだ終わっていない、何日かにわたる記録）があれば、それを開いて続きを入れる
    const going = (state().logs || []).find((log) => !log.finishes && log.targets.some((target) => works.some((work) => work.id === target.work_id)));
    if (going) {
      openLogEditor(going);
    } else {
      openLogEditor(null, { works: works.filter((work) => !currentActuals().get(work.id)?.end) });
    }
  } else {
    const log = logForWork(works[0].id);
    if (log) {
      openLogEditor(log);
    }
  }
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

// 圃場図の「警告」の欄の、確認が必要な点（すべての区画）
function renderProblems() {
  draw($("problemList"), problemItems(problems));
}

// 確認が必要な点の行（HTML）。同じ内容の指摘は、場所をまとめて 1 行にする（コピーした畝は同じ指摘が並ぶため）
function problemItems(list) {
  const groups = new Map();
  for (const problem of list) {
    const work = state().works.find((item) => item.id === problem.work_id);
    const text = `${work ? `${typeLabel(work.work_type)}: ` : ""}${problem.message}`;
    const key = `${problem.block_id ? "block" : "bed"}|${text}`;
    if (!groups.has(key)) {
      groups.set(key, { text, items: [] });
    }
    groups.get(key).items.push(problem);
  }
  return [...groups.values()]
    .map(({ text, items }) => {
      const first = items[0];
      const where = items.length > 1 ? `${ownerName(first)} ほか ${items.length - 1} か所` : ownerName(first);
      const target = first.block_id ? `data-kind="block" data-id="${first.block_id}"` : `data-kind="planting" data-id="${first.planting_id}"`;
      return `<li ${target}><strong>${escapeHtml(where)}</strong>${escapeHtml(text)}</li>`;
    })
    .join("");
}

// 工程表の表示。plan（計画）、act（実績）、both（計画と実績）。工程表と作付の詳細で共有し、ブラウザーが圃場ごとに覚える
const GANTT_MODE_KEY = "field_plan_gantt_mode"; // 圃場ごとに覚える前の、1 つだけの値
const GANTT_MODES = { plan: "計画", act: "実績", both: "計画と実績" };

export function ganttMode() {
  if (!isActivePlan()) {
    return "plan";
  }
  const saved = loadPref(state().field.id, "ganttMode", GANTT_MODE_KEY);
  return GANTT_MODES[saved] ? saved : "plan";
}

// 工程表の表示期間（全体／3 か月／1 か月）。圃場ごとに覚える
export function ganttRange() {
  const saved = loadPref(state().field.id, "ganttRange");
  return GANTT_RANGES[saved] ? saved : "3m";
}

function rangeButtons(range) {
  return Object.entries(GANTT_RANGES)
    .map(([key, label]) => `<button type="button" class="chip-btn${key === range ? " is-on" : ""}" data-gantt-range="${key}" aria-pressed="${key === range}">${label}</button>`)
    .join("");
}

export function setGanttMode(mode) {
  savePref(state().field.id, "ganttMode", mode);
}

// 表示の切り替えのボタン（工程表と作付の詳細で同じ形）
export function modeButtons(mode) {
  return Object.entries(GANTT_MODES)
    .map(([key, label]) => `<button type="button" class="chip-btn${key === mode ? " is-on" : ""}" data-gantt-mode="${key}" aria-pressed="${key === mode}">${label}</button>`)
    .join("");
}

// 記録だけに使う種類（灌水など）も含めた、作業の種類の名前
export const anyTypeLabel = (code) => (state().allWorkTypes || state().workTypes).find((type) => type.code === code)?.label || code;

// 区画または畝の実績の帯。計画の作業につながった記録は、開始から終了まで（終わっていなければ開始の日だけ）。
// 計画にない作業の記録は、その日だけ
// logs は、その帯のもとになった記録の ID（帯をドラッグすると、これらの記録の日付を動かす）
export function actualSpans(ownerWorks, matchesTarget, actuals) {
  const spans = [];
  const logs = state().logs || [];
  for (const work of ownerWorks) {
    const actual = actuals.get(work.id);
    if (actual) {
      const ids = logs.filter((log) => log.targets.some((target) => target.work_id === work.id && matchesTarget(target))).map((log) => log.id);
      spans.push({ type: work.work_type, start: actual.start, end: actual.end || actual.last || actual.start, open: !actual.end, logs: ids });
    }
  }
  const byDay = new Map();
  for (const log of logs) {
    if (log.targets.some((target) => !target.work_id && matchesTarget(target))) {
      const key = `${log.work_type}|${log.date}|${logEnd(log)}`;
      if (!byDay.has(key)) {
        byDay.set(key, { type: log.work_type, start: log.date, end: logEnd(log), open: false, logs: [] });
        spans.push(byDay.get(key));
      }
      byDay.get(key).logs.push(log.id);
    }
  }
  return spans;
}

// 区画の記録か（畝の記録ではなく）
export const blockTarget = (blockId) => (target) => isBlockTarget(target) && target.block_id === blockId;
// その畝（の作付）の記録か
export const bedTarget = (bed, plantingIds) => (target) => target.bed_id === bed.id || plantingIds.includes(target.planting_id);

// 工程表の欄は 1 つで、開いた画面へ移す。圃場図ではすべての区画と畝、日程の画面では選んだ区画だけを描く
const ganttOnMap = () => $("ganttPanel").parentElement.id === "ganttSlotMap";
const ganttShown = () => $("ganttPanel").offsetParent !== null;
// 工程表に描く区画。null はすべての区画
const ganttBlockId = () => (ganttOnMap() ? null : sel.blockId);

// 工程表の欄を、圃場図（"map"）か日程（"schedule"）へ移す。描くのは renderSchedule
export function placeGantt(view) {
  const slot = $(view === "map" ? "ganttSlotMap" : "ganttSlotSchedule");
  if ($("ganttPanel").parentElement !== slot) {
    slot.append($("ganttPanel"));
  }
}

// 圃場図の画面で、キーの操作（Delete など）を工程表に渡すか。最後に工程表の欄を押したときだけ渡す
export const ganttHasFocus = () => ganttFocused && ganttShown();

// fit を渡すと（PDF 出力）、表示期間を「全体」にして、その幅（px）に収める
function renderGantt(fit = null) {
  const scopeId = ganttBlockId();
  const blocks = scopeId ? state().blocks.filter((block) => block.id === scopeId) : state().blocks;
  // 範囲が変わったら、見えなくなった帯を選んだままにしない（見えない作業を Delete で消さないように）
  const scopeKey = scopeId || "all";
  if (ganttScopeKey !== scopeKey) {
    ganttScopeKey = scopeKey;
    picked.clear();
  }
  const mode = ganttMode();
  $("ganttModes").hidden = !isActivePlan();
  draw($("ganttModes"), modeButtons(mode));
  draw($("ganttRanges"), rangeButtons(ganttRange()));
  $("ganttModeNote").textContent = isActivePlan()
    ? mode === "both"
      ? "計画は太い帯、実績は計画の帯の下側に重ねた細い帯です。実績のある計画は薄く出します。"
      : mode === "act"
        ? "実績の日です。計画にない実績（灌水、防除など）も出ます。"
        : ""
    : "実績は、実際に使うプランを開くと出せます。";
  $("ganttModeNote").hidden = !$("ganttModeNote").textContent;
  const showPlan = mode !== "act";
  const showActual = mode !== "plan";
  const actuals = currentActuals();
  const isDated = (work) => work.plan_start && work.plan_end && work.plan_end >= work.plan_start;
  // 描く区画の作業だけ（区画の作業と、その区画の畝の作付の作業）
  const inScope = new Set(blocks.flatMap((block) => [...blockWorks(block.id), ...blockBeds(block.id).flatMap((bed) => bedPlantings(bed.id).flatMap((planting) => plantingWorks(planting.id)))]).map((work) => work.id));
  const dated = state().works.filter((work) => inScope.has(work.id) && isDated(work));
  // 区画と畝ごとの実績の帯を、先に集めておく（表示の範囲を決めるのにも使う）
  const spansOf = new Map();
  if (showActual) {
    for (const block of blocks) {
      spansOf.set(block.id, actualSpans(blockWorks(block.id), blockTarget(block.id), actuals));
      for (const bed of blockBeds(block.id)) {
        const plantings = bedPlantings(bed.id);
        spansOf.set(
          bed.id,
          actualSpans(plantings.flatMap((planting) => plantingWorks(planting.id)), bedTarget(bed, plantings.map((planting) => planting.id)), actuals)
        );
      }
    }
  }
  const allSpans = [...spansOf.values()].flat();
  if (!dated.length && !allSpans.length) {
    draw($("gantt"), '<p class="muted">日付の入った作業がまだありません。</p>');
    renderPickTools();
    return;
  }
  const all = [...dated.flatMap((work) => [work.plan_start, work.plan_end]), ...allSpans.flatMap((span) => [span.start, span.end])].sort();
  const today = localToday();
  // 表示期間が画面の幅にちょうど収まるように 1 日の幅を決める。作業のある範囲は全部描くので、期間の外は横に送って見られる
  const range = fit ? "all" : ganttRange();
  const dataFirst = `${addDays(all[0], -3).slice(0, 8)}01`;
  const dataLast = addDays(all.at(-1), 7);
  const view = ganttWindow(range, dataFirst, dataLast, today);
  const first = view.from < dataFirst ? view.from : dataFirst;
  const last = view.to > dataLast ? view.to : dataLast;
  const available = Math.max(320, (fit || $("gantt").clientWidth || 1000) - NAME_W - 2);
  dayPx = dayWidth(available, diffDays(view.from, view.to) + 1);
  const x = (iso) => diffDays(first, iso) * dayPx;
  const width = Math.ceil(x(last) + dayPx);
  const barWidth = (start, end) => Math.max(MIN_BAR_PX, (diffDays(start, end) + 1) * dayPx);

  // 目盛り: 月の始めと、1 日の幅に余裕があれば週の始め（月曜）
  const ticks = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    if (day.endsWith("-01") || day === first) {
      ticks.push(`<span class="gantt-month" style="left:${x(day)}px">${Number(day.slice(5, 7)) === 1 || day === first ? `${Number(day.slice(0, 4))}年` : ""}${Number(day.slice(5, 7))}月</span>`);
    } else if (dayPx >= 4 && new Date(`${day}T00:00:00Z`).getUTCDay() === 1) {
      ticks.push(`<span class="gantt-week" style="left:${x(day)}px">${Number(day.slice(5, 7))}/${Number(day.slice(8))}</span>`);
    }
  }
  const flaggedWorks = new Set(problems.map((problem) => problem.work_id).filter(Boolean));
  // 帯の置き方（layoutBars）。1 日の作業と長い作業が重なる日は 1 日の作業を描き、長い作業はほかの日に普通の高さで描く。
  // 上下に分けるのは、1 日の作業どうしが同じ日に重なるときだけ。計画は帯の欄の上から BAR_H の高さ、
  // 実績は「計画と実績」では計画の帯の下側に細く重ね、「実績」だけのときは計画と同じ太さにする
  const laneStyle = ({ lane, lanes }, thin = false) => {
    if (thin && lanes === 1) {
      return `top:${BAR_TOP + BAR_H - THIN_H}px;height:${THIN_H}px;`;
    }
    const h = BAR_H / lanes;
    return `top:${BAR_TOP + lane * h}px;height:${h - (lanes > 1 ? 1 : 0)}px;`;
  };
  const cutClass = (bar) => `${bar.cutStart ? " cut-start" : ""}${bar.cutEnd ? " cut-end" : ""}`;
  // 分かれた作業の名前は、いちばん長い切れ端にだけ書く
  const labelled = (layout) => {
    const best = new Map();
    layout.forEach((bar, k) => {
      const days = diffDays(bar.start, bar.end) + 1;
      if (bar.lanes === 1 && days * dayPx > 60 && (!best.has(bar.item) || days > best.get(bar.item).days)) {
        best.set(bar.item, { k, days });
      }
    });
    return new Set([...best.values()].map((item) => item.k));
  };
  // entries は { work, extra }（extra は、帯の説明に添える品目の名前）
  const bars = (entries) => {
    const dated = entries.filter(({ work }) => isDated(work));
    const layout = layoutBars(dated.map(({ work }) => ({ start: work.plan_start, end: work.plan_end })));
    const named = labelled(layout);
    return layout
      .map((bar, k) => {
        const { work, extra = "" } = dated[bar.item];
        const name = workName(typeLabel(work.work_type), work.detail?.spec);
        const tip =
          `<strong>${escapeHtml(name)}${escapeHtml(extra)}</strong>${fullDay(work.plan_start)} 〜 ${fullDay(work.plan_end)}（${workDays(work)} 日）` +
          (isManagement(work.work_type) && isActivePlan() ? "<br>押すと計画を直せます。Ctrl を押しながら横に動かすとコピー" : "");
        // 「計画と実績」では、実績のある計画の帯を薄くし、その上に実績の帯を重ねる
        const faded = showActual && actuals.has(work.id) ? " is-faded" : "";
        return (
          `<span class="gantt-bar${faded}${cutClass(bar)}${picked.has(work.id) ? " is-picked" : ""}${flaggedWorks.has(work.id) ? " is-flagged" : ""}" data-id="${work.id}" data-tip="${escapeHtml(tip)}" ` +
          `style="left:${x(bar.start)}px;width:${barWidth(bar.start, bar.end)}px;${laneStyle(bar)}background-color:${TYPE_COLORS[work.work_type] || "#888"}">` +
          `${named.has(k) ? escapeHtml(typeLabel(work.work_type)) : ""}</span>`
        );
      })
      .join("");
  };
  const actualBars = (spans) => {
    const layout = layoutBars(spans);
    const named = showPlan ? new Set() : labelled(layout);
    return layout
      .map((bar, k) => {
        const span = spans[bar.item];
        const range = span.start === span.end ? fullDay(span.start) : `${fullDay(span.start)} 〜 ${fullDay(span.end)}`;
        const tip = `<strong>${escapeHtml(anyTypeLabel(span.type))}（実績${span.open ? "。まだ終わっていない" : ""}）</strong>${range}${canEdit() ? "<br>ドラッグで実績の日を動かせます" : ""}`;
        return (
          `<span class="gantt-actual-bar${cutClass(bar)}${span.open ? " is-open" : ""}" data-tip="${escapeHtml(tip)}" data-logs="${span.logs.join(",")}" ` +
          `data-start="${span.start}" data-end="${span.end}" data-type="${span.type}" ` +
          `style="left:${x(bar.start)}px;width:${barWidth(bar.start, bar.end)}px;${laneStyle(bar, showPlan)}background-color:${TYPE_COLORS[span.type] || "#888"}">` +
          `${named.has(k) ? escapeHtml(anyTypeLabel(span.type)) : ""}</span>`
        );
      })
      .join("");
  };
  // 1 行が 1 つの区画（畝）。左に名前の列、右に帯の欄。data-block / data-bed は計画の帯のドラッグと貼り付けの行、
  // data-actual-block / data-actual-bed は、実績の帯をドラッグしたときに、どの畝（区画）の実績を動かすかに使う
  const keys = new Set();
  const row = (cls, key, attrs, name, content) => {
    keys.add(key);
    return (
      `<div class="gantt-row ${cls}${rowSel === key ? " is-selected" : ""}" ${attrs}>` +
      `<div class="gantt-name">${name}</div><div class="gantt-track" style="width:${width}px">${content}</div></div>`
    );
  };
  const link = (kind, id, text) => `<a href="#" class="gantt-link" data-detail="${kind}" data-id="${id}">${escapeHtml(text)}</a>`;

  const rows = [];
  for (const block of blocks) {
    const content = (showPlan ? bars(blockWorks(block.id).map((work) => ({ work }))) : "") + (showActual ? actualBars(spansOf.get(block.id)) : "");
    rows.push(row("block", `block:${block.id}`, `data-block="${block.id}" data-actual-block="${block.id}" data-name="${escapeHtml(block.name)}"`, link("block", block.id, block.name), content));
    for (const bed of blockBeds(block.id)) {
      const plantings = bedPlantings(bed.id);
      // 畝の番号は、今日その畝にある作付の詳細へ。品目の名前は、それぞれの作付の詳細へ
      const current = plantingOnDate(plantings, state().works, today, state().logs || []);
      const bedName = current ? link("planting", current.id, `畝${bed.seq}`) : `畝${bed.seq}`;
      const crops = plantings.map((planting) => link("planting", planting.id, planting.crop_name || `作付 ${planting.seq}`)).join(" → ");
      const gone = bed.removed_on ? `<span class="muted">（〜${formatDay(bed.removed_on)}）</span>` : "";
      const content =
        (showPlan
          ? bars(plantings.flatMap((planting) => plantingWorks(planting.id).map((work) => ({ work, extra: planting.crop_name ? `（${planting.crop_name}）` : "" }))))
          : "") + (showActual ? actualBars(spansOf.get(bed.id)) : "");
      const label = `${block.name} 畝${bed.seq}`;
      rows.push(
        row("bed", `bed:${bed.id}`, `data-bed="${bed.id}" data-actual-bed="${bed.id}" data-name="${escapeHtml(label)}"`, `<span class="gantt-bed">${bedName}</span><span class="gantt-crops">${crops}${gone}</span>`, content)
      );
    }
  }
  // 選んでいた行がなくなったら（畝を消した、プランを替えた）、選択を外す
  if (rowSel && !keys.has(rowSel)) {
    rowSel = null;
  }

  const used = new Set([...(showPlan ? dated.map((work) => work.work_type) : []), ...allSpans.map((span) => span.type)]);
  const legend = (state().allWorkTypes || state().workTypes)
    .filter((type) => used.has(type.code))
    .map((type) => `<span><span class="swatch" style="background:${TYPE_COLORS[type.code] || "#888"}"></span>${escapeHtml(type.label)}</span>`)
    .join("");
  const overlay = showPlan && showActual ? '<span><span class="swatch is-faded-key"></span>計画（実績のあるものは薄く）</span><span><span class="swatch is-thin-key"></span>実績（細い帯）</span>' : "";
  const mark = today >= first && today <= last ? `<span class="gantt-mark today" style="left:${NAME_W + x(today)}px"><span>今日</span></span>` : "";

  const scroller = $("gantt").querySelector(".gantt-scroll");
  // 描き直しでは横の位置を保つ。初めて描くときと、表示期間を替えたときは、表示期間の始めを左に合わせる
  const scrollKey = `${range}|${state().plan.id}|${scopeKey}|${fit || ""}`;
  const keep = scroller && ganttScrollKey === scrollKey ? scroller.scrollLeft : null;
  ganttScrollKey = scrollKey;
  draw(
    $("gantt"),
    `<div class="gantt-scroll"><div class="gantt-inner" style="width:${NAME_W + width}px">` +
    `<div class="gantt-axis"><div class="gantt-name"></div><div class="gantt-track" style="width:${width}px">${ticks.join("")}</div></div>` +
    `${rows.join("")}${mark}` +
    `</div></div><div class="gantt-legend">${legend}${overlay}<span><span class="swatch is-flagged"></span>白い対角線: 確認が必要</span></div>`
  );
  $("gantt").querySelector(".gantt-scroll").scrollLeft = keep ?? Math.max(x(view.from), 0);
  $("gantt").dataset.dayPx = dayPx; // 1 日の幅（確かめるときに読む）
  renderPickTools();
}

// 工程表の全体を、横向きの紙の幅に収まる倍率で印刷に回す
// 表示期間によらず、作業のある範囲の全体を紙の幅に合わせて描いてから写し、画面はもとの表示期間に戻す
function printGantt() {
  if (!$("gantt").querySelector(".gantt-inner")) {
    notify("日付の入った作業がまだありません。");
    return;
  }
  renderGantt(PAGE_PX.landscape[0]);
  const zoom = Math.min(1, PAGE_PX.landscape[0] / $("gantt").querySelector(".gantt-inner").offsetWidth).toFixed(4);
  const copy = $("gantt").cloneNode(true);
  renderGantt();
  copy.querySelectorAll(".is-picked, .is-selected").forEach((element) => element.classList.remove("is-picked", "is-selected"));
  printPage({
    name: "工程表",
    title: `工程表　プラン: ${state().plan.name}${ganttBlockId() ? `　${state().blocks.find((block) => block.id === ganttBlockId())?.name || ""}` : ""}　出力日: ${fullDay(localToday())}`,
    body: `<div style="zoom:${zoom}">${copy.innerHTML}</div>`,
    landscape: true,
  });
}

// 選んでいる区画の、品目ごとの苗数と、肥料ごとの量。区画の頭の面積・畝・苗の行を押すと開く（planting-view.js）
function renderSummary() {
  const summary = summarize({ ...state(), beds: blockBeds(sel.blockId), logs: state().logs || [] });
  const number = (value, digits = 0) => value.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  draw(
    $("cropSummary"),
    summary.crops
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.name)}${row.registered ? "" : '<span class="muted">（未登録）</span>'}</td>` +
          `<td class="num">${row.count}</td><td class="num">${number(row.area, 1)}</td>` +
          `<td class="num">${row.seedlings ? number(row.seedlings) : "-"}</td>` +
          `<td>${row.fertilizerKg ? `${escapeHtml(row.fertilizer)} ${number(row.fertilizerKg, 2)} kg` : "-"}</td></tr>`
      )
      .join("")
  );
  $("fertilizerSummary").textContent = summary.fertilizers.length
    ? `肥料の合計: ${summary.fertilizers.map((row) => `${row.name} ${number(row.kg, 2)} kg`).join("、")}`
    : "";
}

// 並んだ作業がすべて終わり、最後の作業のあとにあける日数（すき込みのあとの 21 日など）も過ぎた、最初の日。
// 日付の入った作業がなければ空
function startAfter(works) {
  const last = works.filter((work) => work.plan_start && work.plan_end).sort((a, b) => a.plan_end.localeCompare(b.plan_end)).at(-1);
  return last ? addDays(last.plan_end, 1 + (typeFor(ownerOf(last), last.work_type)?.min_gap_days || 0)) : "";
}

// 作業の種類と目安の日数の表（台帳の「工程作業日数」）
export function renderTypes() {
  draw(
    $("typeRows"),
    state()
      .workTypes.map(
        (type) =>
          `<tr data-code="${type.code}"><td><span class="swatch" style="background:${TYPE_COLORS[type.code] || "#888"}"></span>${escapeHtml(type.label)}</td>` +
          `<td><input type="number" min="1" data-field="default_days" value="${type.default_days}" /></td>` +
          `<td><input type="number" min="0" data-field="min_gap_days" value="${type.min_gap_days}" /></td></tr>`
      )
      .join("")
  );
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
    note: "",
  };
}

const ownedBy = (work, owner) => (owner.block_id ? work.block_id === owner.block_id : work.planting_id === owner.planting_id);

// ある区画または作付の作業を、まるごと入れ替えて保存する
// 入れ替えるのは工程の作業だけ。管理作業（防除などの計画）は、そのまま残す
// （入れ替えの相手に含めると、管理作業の計画が、なくなった行として消えてしまう）
async function replaceWorks(owner, works) {
  const replaced = (work) => ownedBy(work, owner) && !isManagement(work.work_type);
  const old = state().works.filter(replaced);
  const kept = new Set(works.map((work) => work.id));
  works.forEach((work, index) => {
    work.seq = index + 1;
  });
  state().works = [...state().works.filter((work) => !replaced(work)), ...works];
  await store().remove("works", old.filter((work) => !kept.has(work.id)).map((work) => work.id));
  await store().upsert("works", works);
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
  return startAfter(processOnly(earlier ? plantingWorks(earlier.id) : blockWorks(bed.block_id)));
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
  $("pastePickedBtn").title = rowSel ? "工程表で選んだ行に貼り付けます" : "先に、貼り付ける行を工程表で選んでください";
}

// 工程表の行を選ぶ（貼り付けの入れ先、「＋ 入力する」の対象）
function selectRow(row) {
  rowSel = rowKey(row);
  $("gantt").querySelectorAll(".gantt-row").forEach((item) => item.classList.toggle("is-selected", rowKey(item) === rowSel));
  renderPickTools();
}

// 「＋ 入力する」で、工程表で選んだ行を対象に入れて開くための値。畝なら今日その畝にある作付、区画なら区画
export function selectedRowPreset() {
  if (!rowSel || !ganttShown() || !isActivePlan()) {
    return {};
  }
  const [kind, id] = rowSel.split(":");
  if (kind === "block") {
    return { blockId: id };
  }
  const planting = plantingOnDate(bedPlantings(id), state().works, localToday(), state().logs || []);
  return planting ? { plantingId: planting.id } : {};
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
// なければその日より前に始まる最後の作付、それもなければ最初の作付。作付がなければ作る。
// source は、作業の元の作付。新しく作る作付は、その品目を引き継ぐ
async function ownerForRow(row, date, source) {
  if (row.dataset.block) {
    return { block_id: row.dataset.block };
  }
  const plantings = bedPlantings(row.dataset.bed).map((planting) => ({ planting, range: worksRange(plantingWorks(planting.id)) }));
  if (!plantings.length) {
    return { planting_id: (await newPlanting(row.dataset.bed, source?.crop_name, source?.crop_id || null)).id };
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

async function deletePicked() {
  const works = pickedWorks();
  if (!works.length || !(await confirmDelete("選んだ作業を削除します。", `${ownerName(ownerOf(works[0]))}の作業 ${works.length} 件`))) {
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

// 工程表で選んだ行（区画か畝）に貼り付ける。畝では、貼り付ける作業の日付が入る作付に入れる
// （帯を別の行へドラッグしたときと同じ決め方。作付がなければ作る）
function pastePicked() {
  if (!clipboard) {
    return;
  }
  if (!rowSel) {
    notify("貼り付ける行（区画か畝）を、工程表で選んでください。");
    return;
  }
  const { works, cut } = clipboard;
  const [kind, id] = rowSel.split(":");
  run(async () => {
    const first = works.map((work) => work.plan_start).filter(Boolean).sort()[0] || null;
    const source = state().plantings.find((planting) => planting.id === works[0].planting_id);
    const owner = await ownerForRow({ dataset: kind === "block" ? { block: id } : { bed: id } }, first, source);
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
    barDrag.days = Math.round(dx / dayPx);
    gantt.classList.add("is-dragging");
    const under = document.elementFromPoint(event.clientX, event.clientY)?.closest(".gantt-row");
    barDrag.target = under && gantt.contains(under) && under !== barDrag.row ? under : null;
    gantt.querySelectorAll(".gantt-row.is-drop").forEach((row) => row.classList.remove("is-drop"));
    barDrag.target?.classList.add("is-drop");
    const top = (row) => row.querySelector(".gantt-track").getBoundingClientRect().top;
    const offsetY = barDrag.target ? top(barDrag.target) - top(barDrag.row) : 0;
    gantt.querySelectorAll(".gantt-bar.is-picked").forEach((bar) => {
      bar.style.transform = `translate(${barDrag.days * dayPx}px, ${offsetY}px)`;
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
    draw(
      tip,
      `<strong>${escapeHtml(typeLabel(work.work_type))}</strong>` +
      `${fullDay(addDays(work.plan_start, barDrag.days))} 〜 ${fullDay(addDays(work.plan_end, barDrag.days))}${where}`
    );
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
    const pressed = state().works.find((work) => work.id === drag.id);
    if (!drag.moved) {
      // 動かさずに離した: その帯と行を選ぶ。管理作業の計画は、計画の窓も開く
      selectRow(drag.row);
      if (pressed && isManagement(pressed.work_type) && isActivePlan()) {
        openPlanEditor(pressed);
      }
      return;
    }
    const works = pickedWorks();
    // 同じ行の中で Ctrl を押しながら動かした管理作業の計画は、その日数だけ後ろ（前）にコピーする（繰り返しの計画）
    if (!target && drag.days && event.ctrlKey && works.every((work) => isManagement(work.work_type)) && isActivePlan()) {
      copyPlanWorks(works, drag.days).then(() => renderSchedule());
      return;
    }
    if (target) {
      run(async () => {
        const first = works.map((work) => addDays(work.plan_start, drag.days)).sort()[0];
        const source = state().plantings.find((planting) => planting.id === works[0].planting_id);
        const from = ownerName(ownerOf(works[0]));
        const names = works.map((work) => typeLabel(work.work_type)).join("、");
        const owner = await ownerForRow(target, first, source);
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

  // 実績の帯のドラッグ。横に動かした日数だけ、もとになった記録の日付を動かす
  gantt.addEventListener("pointerdown", (event) => {
    const bar = event.target.closest(".gantt-actual-bar");
    if (!bar || !bar.dataset.logs || !canEdit() || event.button !== 0) {
      return;
    }
    pressedBar = true;
    const row = bar.closest(".gantt-row");
    // 1 日の作業をよけて分かれた帯は、まとめて動かす
    const parts = [...row.querySelectorAll(".gantt-actual-bar")].filter(
      (item) => item.dataset.logs === bar.dataset.logs && item.dataset.start === bar.dataset.start && item.dataset.type === bar.dataset.type
    );
    actualDrag = { bar, parts, row, startX: event.clientX, days: 0, moved: false };
    gantt.setPointerCapture(event.pointerId);
  });
  gantt.addEventListener("pointermove", (event) => {
    if (!actualDrag) {
      return;
    }
    const dx = event.clientX - actualDrag.startX;
    if (!actualDrag.moved && Math.abs(dx) < 4) {
      return;
    }
    actualDrag.moved = true;
    actualDrag.days = Math.round(dx / dayPx);
    actualDrag.parts.forEach((part) => (part.style.transform = `translateX(${actualDrag.days * dayPx}px)`));
    const { start, end, type } = actualDrag.bar.dataset;
    const moved = (iso) => fullDay(addDays(iso, actualDrag.days));
    draw(tip, `<strong>${escapeHtml(anyTypeLabel(type))}の実績</strong>${start === end ? moved(start) : `${moved(start)} 〜 ${moved(end)}`}`);
    tip.hidden = false;
    tip.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${event.clientY + 18}px`;
  });
  const finishActual = async (event) => {
    const drag = actualDrag;
    actualDrag = null;
    if (!drag) {
      return;
    }
    drag.parts.forEach((part) => (part.style.transform = ""));
    tip.hidden = true;
    if (event.type === "pointercancel") {
      return;
    }
    // 動かさずに離した: その行を選ぶ
    if (!drag.moved || !drag.days) {
      selectRow(drag.row);
      return;
    }
    const { actualBlock, actualBed, name } = drag.row.dataset;
    let matches;
    if (actualBlock) {
      matches = blockTarget(actualBlock);
    } else {
      const bed = state().beds.find((item) => item.id === actualBed);
      matches = bedTarget(bed, bedPlantings(actualBed).map((planting) => planting.id));
    }
    await moveLogs(drag.bar.dataset.logs.split(","), drag.days, matches, name);
  };
  gantt.addEventListener("pointerup", finishActual);
  gantt.addEventListener("pointercancel", finishActual);

  // 名前のリンク: 区画の名前は日程の画面でその区画を、畝の番号と品目の名前は作付の詳細を開く。
  // 帯のない所を押すと、帯の選択を外して、その行を選ぶ
  gantt.addEventListener("click", (event) => {
    const link = event.target.closest("[data-detail]");
    if (link) {
      event.preventDefault();
      if (link.dataset.detail === "block") {
        // 区画の名前: 日程の画面で、その区画を開く
        openInSchedule("block", link.dataset.id);
        ctx.showView("schedule");
      } else {
        ctx.openDetail(link.dataset.detail, link.dataset.id);
      }
      return;
    }
    const row = event.target.closest(".gantt-row");
    if (!row) {
      return;
    }
    const bar = event.target.closest(".gantt-bar, .gantt-actual-bar");
    if (bar && !canEdit()) {
      // スマホ（帯は動かせない）: 帯を押しても行を選ぶ。管理作業の計画は、計画の窓を開く
      selectRow(row);
      const work = bar.classList.contains("gantt-bar") ? state().works.find((item) => item.id === bar.dataset.id) : null;
      if (work && isManagement(work.work_type) && isActivePlan()) {
        openPlanEditor(work);
      }
      return;
    }
    if (pressedBar || bar) {
      return;
    }
    picked.clear();
    showPicked();
    selectRow(row);
  });
  // 表示期間（全体／3 か月／1 か月）
  $("ganttRanges").addEventListener("click", (event) => {
    const button = event.target.closest("[data-gantt-range]");
    if (button) {
      savePref(state().field.id, "ganttRange", button.dataset.ganttRange);
      renderGantt();
    }
  });
  // 画面の幅が変わったら、表示期間が幅に収まるように描き直す
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => ganttShown() && state().blocks.length && renderGantt(), 200);
  });

  $("copyPickedBtn").addEventListener("click", () => copyPicked(false));
  $("cutPickedBtn").addEventListener("click", () => copyPicked(true));
  $("pastePickedBtn").addEventListener("click", pastePicked);
  $("deletePickedBtn").addEventListener("click", deletePicked);
  // 最後に押した所が工程表の欄か。圃場図の画面では、そのときだけキーを工程表で受ける（図の操作と取り合わない）
  document.addEventListener("pointerdown", (event) => {
    ganttFocused = Boolean(event.target.closest?.("#ganttPanel"));
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!ganttShown() || (ganttOnMap() && !ganttFocused) || !canEdit() || ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) {
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
    // 畝の図形を押したとき: その畝を選ぶ（図の上の「選んだ畝を…」のボタンの相手）
    select: (kind, id) => {
      openInSchedule(kind, id);
      renderSchedule();
    },
    // 区画の作業の欄: 窓の工程の計画をその区画で開く。畝の下の作付の欄: その作付（なければ今の作付）の詳細を開く。
    // 作付のない畝は、窓の工程の計画をその畝で開く（作付を足せる）
    open: (kind, id, plantingId = null) => {
      if (kind === "block") {
        openProcessPlan("block", id);
        return;
      }
      const planting = (plantingId && state().plantings.find((item) => item.id === plantingId)) || bedPlantingNow(id);
      if (planting) {
        ctx.openDetail("planting", planting.id);
      } else {
        openLogEditor(null, { tab: "process", bedId: id });
      }
    },
  });

  $("schedulePicker").addEventListener("change", (event) => onPick(event.target.value));
  initGanttEditing();
  $("weekList").addEventListener("click", onWeekClick);
  // 遅れている作業・今週やること・最近の実績のタブ
  document.querySelector(".wt-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-wtab]");
    if (!tab) {
      return;
    }
    document.querySelectorAll("[data-wtab]").forEach((item) => {
      item.classList.toggle("is-on", item === tab);
      item.setAttribute("aria-selected", String(item === tab));
    });
    document.querySelectorAll("[data-wpanel]").forEach((panel) => (panel.hidden = panel.dataset.wpanel !== tab.dataset.wtab));
  });
  $("lateList").addEventListener("click", onWeekClick);
  $("ganttModes").addEventListener("click", (event) => {
    const button = event.target.closest("[data-gantt-mode]");
    if (button) {
      setGanttMode(button.dataset.ganttMode);
      renderSchedule();
    }
  });
  // 工程表の帯にマウスを乗せると、開始日と終了日を出す
  const tip = $("ganttTip");
  $("gantt").addEventListener("pointermove", (event) => {
    if (barDrag || actualDrag) {
      return; // ドラッグ中は、動かした先の日付を別に出している
    }
    const bar = event.target.closest(".gantt-bar, .gantt-actual-bar");
    tip.hidden = !bar;
    if (bar) {
      draw(tip, bar.dataset.tip);
      const width = tip.offsetWidth;
      tip.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - width - 8))}px`;
      tip.style.top = `${event.clientY + 18}px`;
    }
  });
  $("gantt").addEventListener("pointerleave", () => {
    tip.hidden = true;
  });
  $("ganttPdfBtn").addEventListener("click", printGantt);
  // 圃場図の「警告」の、確認が必要な点の行
  $("problemList").addEventListener("click", (event) => {
    const item = event.target.closest("li[data-id]");
    if (item) {
      openProblemTarget(item.dataset.kind, item.dataset.id);
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

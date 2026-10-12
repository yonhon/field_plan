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
  workDays,
  worksRange,
} from "./schedule.js";
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
let suggestedFor = null; // ひな形の開始日の候補を入れた相手
let problems = []; // 日程の無理。描くたびに求め直す
const ARRANGE_MODES = {
  block: { before: "畝立てをこの日に始められるように逆算", forward: "最初の作業をこの日に始める" },
  bed: { plant: "定植・播種をこの日に始める（前は逆算）", forward: "最初の作業をこの日に始める" },
};
const picked = new Set(); // 工程表で選んでいる作業の ID
let clipboard = null; // コピーか切り取りをした作業 { works, cut }
let barDrag = null; // 工程表で帯をドラッグしている途中の状態
let arrangedFor = null; // 並べ直しの基準日の初期値を入れた相手

const state = () => ctx.state;
const store = () => ctx.state.store;
const typeOf = (code) => state().workTypes.find((type) => type.code === code);
const typeLabel = (code) => typeOf(code)?.label || code;
const bySeq = (a, b) => a.seq - b.seq;

const blockBeds = (blockId) => state().beds.filter((bed) => bed.block_id === blockId).sort(bySeq);
const bedPlantings = (bedId) => state().plantings.filter((planting) => planting.bed_id === bedId).sort(bySeq);
const blockWorks = (blockId) => state().works.filter((work) => work.block_id === blockId).sort(bySeq);
const plantingWorks = (plantingId) => state().works.filter((work) => work.planting_id === plantingId).sort(bySeq);

const scope = () => (sel.target === "block" ? "block" : "bed");
const currentWorks = () => (sel.target === "block" ? blockWorks(sel.blockId) : sel.plantingId ? plantingWorks(sel.plantingId) : []);

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

// ひな形を並べ始める日の候補。畝なら、前の作付の収穫完了の翌日か、区画の作業が終わった翌日
function suggestedStart() {
  if (sel.target === "block") {
    return "";
  }
  const plantings = bedPlantings(sel.target);
  const index = plantings.findIndex((planting) => planting.id === sel.plantingId);
  const before = index > 0 ? harvestEnd(plantingWorks(plantings[index - 1].id)) : worksRange(blockWorks(sel.blockId))?.end;
  return before ? addDays(before, 1) : "";
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
  const planting = plantings.find((item) => item.id === sel.plantingId);
  $("plantingBar").hidden = !onBed;
  if (onBed) {
    $("plantingSelect").innerHTML = plantings
      .map((item) => `<option value="${item.id}">作付 ${item.seq}${item.crop_name ? `: ${escapeHtml(item.crop_name)}` : ""}</option>`)
      .join("");
    $("plantingSelect").value = sel.plantingId || "";
    $("plantingSelect").hidden = plantings.length === 0;
    $("deletePlantingBtn").hidden = !planting;
    $("cropField").hidden = !planting;
    if (planting && document.activeElement !== $("cropName")) {
      $("cropName").value = planting.crop_name;
    }
    const end = planting ? harvestEnd(plantingWorks(planting.id)) : null;
    $("harvestInfo").textContent = !planting
      ? "この畝には作付がまだありません。「作付を追加」で、畝立てから収穫までの 1 回ぶんを作ります。"
      : end
        ? `収穫完了予定日: ${formatDay(end)}`
        : "収穫完了予定日: 未定（「収穫」の終了日を入れると決まります）";
  }

  const usable = !onBed || Boolean(planting);
  $("workTools").hidden = !usable;
  $("workTable").hidden = !usable;
  $("addWorkBtn").hidden = !usable;
  const templates = TEMPLATES[scope()];
  const templateKey = `${scope()}`;
  if ($("templateSelect").dataset.scope !== templateKey) {
    $("templateSelect").dataset.scope = templateKey;
    $("templateSelect").innerHTML = Object.entries(templates)
      .map(([key, template]) => `<option value="${key}">${template.label}</option>`)
      .join("");
  }
  const target = `${sel.blockId}|${sel.target}|${sel.plantingId}`;
  if (suggestedFor !== target) {
    suggestedFor = target;
    $("templateStart").value = suggestedStart();
  }
  $("copyWorksBtn").hidden = !onBed;
  $("copyWorksBtn").disabled = beds.length < 2;

  const works = currentWorks();
  const owner = usable ? currentOwner() : null;
  const mine = owner ? problems.filter((problem) => (owner.block_id ? problem.block_id === owner.block_id : problem.planting_id === owner.planting_id)) : [];
  const flagged = new Set(mine.map((problem) => problem.work_id).filter(Boolean));
  $("scheduleWarnings").innerHTML = mine
    .map((problem) => {
      const index = works.findIndex((work) => work.id === problem.work_id);
      const where = index >= 0 ? `${index + 1}. ${escapeHtml(typeLabel(works[index].work_type))}: ` : "";
      return `<li>${where}${escapeHtml(problem.message)}</li>`;
    })
    .join("");
  $("arrangeTools").hidden = !usable || works.length === 0;
  if ($("arrangeMode").dataset.scope !== scope()) {
    $("arrangeMode").dataset.scope = scope();
    $("arrangeMode").innerHTML = Object.entries(ARRANGE_MODES[scope()])
      .map(([key, text]) => `<option value="${key}">${text}</option>`)
      .join("");
    arrangedFor = null;
  }
  if (arrangedFor !== target) {
    arrangedFor = target;
    $("arrangeDate").value = arrangeDefault();
  }
  // 相手に合う種類を先に、それ以外を後ろに出す
  const groups = [scope(), scope() === "block" ? "bed" : "block"];
  const typeOptions = (selected) =>
    groups
      .map((group) => {
        const options = state()
          .workTypes.filter((type) => (type.scope || "block") === group)
          .map((type) => `<option value="${type.code}"${type.code === selected ? " selected" : ""}>${escapeHtml(type.label)}</option>`)
          .join("");
        return `<optgroup label="${SCOPE_LABELS[group]}">${options}</optgroup>`;
      })
      .join("");
  $("workRows").innerHTML = works.length
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
    : '<tr><td colspan="8" class="muted">作業がまだありません。ひな形から作るか、「作業を追加」で足してください。</td></tr>';
}

// 並べ直しの基準にする日の初期値
function arrangeDefault() {
  const works = currentWorks();
  const mode = $("arrangeMode").value;
  if (mode === "plant") {
    return works.find((work) => work.work_type === "plant")?.plan_start || "";
  }
  if (mode === "before") {
    // この区画の畝のうち、いちばん早く始まる最初の作付の開始日
    const starts = blockBeds(sel.blockId)
      .map((bed) => bedPlantings(bed.id)[0])
      .filter(Boolean)
      .map((planting) => worksRange(plantingWorks(planting.id))?.start)
      .filter(Boolean);
    return starts.sort()[0] || "";
  }
  return works.find((work) => work.plan_start)?.plan_start || "";
}

function arrange() {
  const works = currentWorks();
  const date = $("arrangeDate").value;
  const mode = $("arrangeMode").value;
  if (!date) {
    alert("基準にする日を入れてください。");
    return;
  }
  let result;
  if (mode === "before") {
    result = scheduleBefore(works, state().workTypes, date);
  } else if (mode === "plant") {
    const index = works.findIndex((work) => work.work_type === "plant");
    if (index < 0) {
      alert("この作付には「定植・播種」の作業がありません。");
      return;
    }
    result = scheduleAnchored(works, state().workTypes, index, date);
  } else {
    result = scheduleForward(works, state().workTypes, date);
  }
  run(() => replaceWorks(currentOwner(), result));
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

function applyTemplate() {
  const template = TEMPLATES[scope()][$("templateSelect").value];
  const owner = currentOwner();
  if (currentWorks().length && !confirm("いまの作業を、ひな形の内容に置き換えます。")) {
    return;
  }
  run(async () => {
    let works = template.codes.map((code, index) => newWork(owner, code, index + 1));
    if ($("templateStart").value) {
      works = scheduleForward(works, state().workTypes, $("templateStart").value);
    }
    await replaceWorks(owner, works);
  });
}

function copyWorks() {
  const source = currentWorks();
  const clone = (owner) => source.map((work) => ({ ...work, id: crypto.randomUUID(), block_id: null, planting_id: null, ...owner }));
  // 区画の作業は、ほかの区画の計画を置き換えてしまうので、まとめては写さない（工程表のコピーと貼り付けを使う）
  if (sel.target === "block") {
    return;
  }
  // 畝: 同じ回の作付があれば置き換え、ちょうど次の回なら作付を足す。回がずれている畝は飛ばす
  const planting = state().plantings.find((item) => item.id === sel.plantingId);
  const targets = blockBeds(sel.blockId).filter((bed) => bed.id !== sel.target);
  if (!confirm(`この作付（品目と作業）を、同じ区画のほかの畝 ${targets.length} 本にコピーします。同じ回の作付は置き換わります。`)) {
    return;
  }
  run(async () => {
    let skipped = 0;
    for (const bed of targets) {
      const plantings = bedPlantings(bed.id);
      let other = plantings.find((item) => item.seq === planting.seq);
      if (!other && plantings.length !== planting.seq - 1) {
        skipped += 1;
        continue;
      }
      if (other) {
        other.crop_name = planting.crop_name;
      } else {
        other = { ...planting, id: crypto.randomUUID(), bed_id: bed.id };
        state().plantings.push(other);
      }
      await store().upsert("plantings", [other]);
      await replaceWorks({ planting_id: other.id }, clone({ planting_id: other.id }));
    }
    if (skipped) {
      alert(`作付の回数が合わない畝 ${skipped} 本は、コピーしませんでした。`);
    }
  });
}

function addPlanting() {
  const plantings = bedPlantings(sel.target);
  const last = plantings.at(-1);
  if (last && !harvestEnd(plantingWorks(last.id))) {
    alert("前の作付の収穫完了予定日が決まっていません。「収穫」の終了日を入れてから、次の作付を足してください。");
    return;
  }
  const planting = {
    id: crypto.randomUUID(),
    plan_id: state().plan.id,
    bed_id: sel.target,
    seq: (last?.seq || 0) + 1,
    crop_id: null,
    crop_name: "",
    note: "",
  };
  run(async () => {
    await store().upsert("plantings", [planting]);
    state().plantings.push(planting);
    sel.plantingId = planting.id;
  });
}

function deletePlanting() {
  const planting = state().plantings.find((item) => item.id === sel.plantingId);
  if (!planting || !confirm(`作付 ${planting.seq}${planting.crop_name ? `（${planting.crop_name}）` : ""}と、その作業を削除します。`)) {
    return;
  }
  run(async () => {
    await store().remove("plantings", [planting.id]);
    state().plantings = state().plantings.filter((item) => item.id !== planting.id);
    state().works = state().works.filter((work) => work.planting_id !== planting.id);
    sel.plantingId = null;
  });
}

function addWork() {
  const works = currentWorks();
  const last = works.at(-1);
  const first = state().workTypes.find((type) => (type.scope || "block") === scope()) || state().workTypes[0];
  const work = newWork(currentOwner(), first.code, works.length + 1);
  if (last && last.plan_end) {
    work.plan_start = addDays(last.plan_end, 1 + (typeOf(last.work_type)?.min_gap_days || 0));
    work.plan_end = addDays(work.plan_start, first.default_days - 1);
  }
  run(() => replaceWorks(currentOwner(), [...works, work]));
}

function changeWork(id, field, value) {
  const work = state().works.find((item) => item.id === id);
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
  daysBeforeEdit = null;
  run(() => store().upsert("works", [work]));
}

function workAction(id, action) {
  const works = currentWorks();
  const index = works.findIndex((work) => work.id === id);
  if (action === "delete") {
    run(() => replaceWorks(currentOwner(), works.filter((work) => work.id !== id)));
    return;
  }
  const other = action === "up" ? index - 1 : index + 1;
  if (other < 0 || other >= works.length) {
    return;
  }
  [works[index], works[other]] = [works[other], works[index]];
  run(() => replaceWorks(currentOwner(), works));
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

async function newPlanting(bedId, cropName) {
  const planting = {
    id: crypto.randomUUID(),
    plan_id: state().plan.id,
    bed_id: bedId,
    seq: (bedPlantings(bedId).at(-1)?.seq || 0) + 1,
    crop_id: null,
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
      await transferWorks(originals, owner, 0, false);
      clipboard = null;
    } else {
      await transferWorks(works, owner, 0, true);
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
        await transferWorks(works, await ownerForRow(target, first, crop), drag.days, event.ctrlKey);
      });
    } else if (drag.days) {
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
  $("plantingSelect").addEventListener("change", (event) => {
    sel.plantingId = event.target.value;
    renderSchedule();
  });
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
  $("deletePlantingBtn").addEventListener("click", deletePlanting);
  $("cropName").addEventListener("change", (event) => {
    const planting = state().plantings.find((item) => item.id === sel.plantingId);
    planting.crop_name = event.target.value.trim();
    run(() => store().upsert("plantings", [planting]));
  });
  $("applyTemplateBtn").addEventListener("click", applyTemplate);
  $("arrangeBtn").addEventListener("click", arrange);
  $("arrangeMode").addEventListener("change", () => {
    $("arrangeDate").value = arrangeDefault();
  });
  $("problemList").addEventListener("click", (event) => {
    const item = event.target.closest("li[data-id]");
    if (item) {
      openInSchedule(item.dataset.kind, item.dataset.id);
      renderSchedule();
      $("workTable").scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
  $("copyWorksBtn").addEventListener("click", copyWorks);
  $("addWorkBtn").addEventListener("click", addWork);

  $("workRows").addEventListener("focusin", (event) => {
    // 開始日を動かす前の日数を覚えておく
    const row = event.target.closest("tr[data-id]");
    if (row && event.target.dataset.field === "plan_start") {
      daysBeforeEdit = { id: row.dataset.id, days: workDays(state().works.find((item) => item.id === row.dataset.id)) };
    }
  });
  $("workRows").addEventListener("change", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (row && event.target.dataset.field) {
      changeWork(row.dataset.id, event.target.dataset.field, event.target.value);
    }
  });
  $("workRows").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (row && event.target.dataset.action) {
      workAction(row.dataset.id, event.target.dataset.action);
    }
  });
  $("typeRows").addEventListener("change", (event) => {
    const row = event.target.closest("tr[data-code]");
    const value = Number(event.target.value);
    if (!row || !Number.isFinite(value) || value < 0) {
      return;
    }
    const type = typeOf(row.dataset.code);
    type[event.target.dataset.field] = Math.round(value);
    run(() => store().saveWorkType(type));
  });
}

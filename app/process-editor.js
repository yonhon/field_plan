// 「作業を入力する」の窓の「工程の計画」のタブ。区画の作業（畝立ての前まで）か、畝 1 本の作付ごとの作業
// （畝立てから残渣処理まで）を、作業 1 件をカード 1 枚にして直す。
// 直すのは写し（書きかけ）で、「保存する」を押したときにまとめて保存する。「キャンセル」で捨てる。
// 管理作業（防除、追肥など）の計画は、このタブでは扱わない（「管理作業の計画」のタブ）
import {
  TEMPLATES,
  WORK_COLORS,
  addDays,
  diffDays,
  harvestEnd,
  isManagement,
  planProblems,
  scheduleAnchored,
  scheduleBefore,
  scheduleForward,
  typesForCrop,
  workDays,
  worksRange,
} from "./schedule.js";
import { cropLabel } from "./crops.js";
import { confirmAction, notify } from "./dialog.js";
import { noteChange } from "./history.js";
import { record } from "./journal.js";
import { ARRANGE_MODES, SCOPE_LABELS, currentActuals, isActivePlan } from "./schedule-view.js";
import { escapeHtml } from "./html.js";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

let ctx = null; // { state, refresh, setStatus }
// 書きかけ。target は { kind: "block" | "bed", id }。plantings と works は、その相手の作付と工程の作業の写し
let pd = null;

const state = () => ctx.state;
const bySeq = (a, b) => a.seq - b.seq;
const processOnly = (works) => works.filter((work) => !isManagement(work.work_type));
const typeLabel = (code) => (state().allWorkTypes || state().workTypes).find((type) => type.code === code)?.label || code;
const cropOf = (planting) => state().crops.find((crop) => crop.id === planting?.crop_id) || null;
const blockBeds = (blockId) => state().beds.filter((bed) => bed.block_id === blockId).sort(bySeq);

function formatDay(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${month}/${day}（${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}）`;
}
const shortDay = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

// 作業の持ち主（区画か作付）
const ownerOf = (work) => (work.block_id ? { block_id: work.block_id } : { planting_id: work.planting_id });
const ownerKey = (owner) => (owner.block_id ? `block:${owner.block_id}` : `planting:${owner.planting_id}`);
const ownerFromKey = (key) => {
  const [kind, id] = key.split(":");
  return kind === "block" ? { block_id: id } : { planting_id: id };
};
const owns = (work, owner) => (owner.block_id ? work.block_id === owner.block_id : work.planting_id === owner.planting_id);
const kindOf = (owner) => (owner.block_id ? "block" : "bed");
const worksOf = (owner) => pd.works.filter((work) => owns(work, owner));
const plantingOf = (owner) => (owner.planting_id ? pd.plantings.find((planting) => planting.id === owner.planting_id) : null);

// 区画や作付に合わせた、作業の種類の目安。品目を登録した作付なら、その品目の日数を使う
const typesFor = (owner) => {
  const planting = plantingOf(owner);
  return typesForCrop(state().workTypes, cropOf(planting), planting ? worksOf(owner) : []);
};
const typeFor = (owner, code) => typesFor(owner).find((type) => type.code === code);

// その持ち主の作業を、並びごと入れ替える
function setWorksOf(owner, works) {
  pd.works = [...pd.works.filter((work) => !owns(work, owner)), ...works];
}

function newWork(owner, workType) {
  return { id: crypto.randomUUID(), plan_id: state().plan.id, block_id: null, planting_id: null, ...owner, work_type: workType, seq: 0, plan_start: null, plan_end: null, note: "" };
}

// 保存するときの並び。持ち主ごとに、カードの順に 1 から番号を振った写し
function ordered() {
  const counts = new Map();
  return pd.works.map((work) => {
    const key = ownerKey(ownerOf(work));
    counts.set(key, (counts.get(key) || 0) + 1);
    return { ...work, seq: counts.get(key) };
  });
}

const snapshot = () => JSON.stringify({ plantings: pd.plantings, works: pd.works });

export function initProcessEditor(context) {
  ctx = context;
}

// 直す相手の初期値。区画（blockId）、作付（plantingId → その畝）、どちらもなければ日程で開いている区画
export function startProcess({ blockId = null, plantingId = null, bedId = null } = {}) {
  const s = state();
  const planting = plantingId && s.plantings.find((item) => item.id === plantingId);
  let target = null;
  if (bedId && s.beds.some((bed) => bed.id === bedId)) {
    target = { kind: "bed", id: bedId };
  } else if (planting) {
    target = { kind: "bed", id: planting.bed_id };
  } else if (blockId && s.blocks.some((block) => block.id === blockId)) {
    target = { kind: "block", id: blockId };
  } else if (s.blocks.length) {
    // 相手が決まっていなければ（圃場図から開いたとき）、日程で開いている区画、なければ最初の区画
    const current = ctx.currentBlockId?.();
    target = { kind: "block", id: s.blocks.some((block) => block.id === current) ? current : s.blocks[0].id };
  }
  pd = {
    target,
    blockId: null,
    plantings: [],
    works: [],
    template: { key: Object.keys(TEMPLATES.block)[0], start: "" },
    arrange: new Map(), // 並べ直しの欄で選んだ基準と日。持ち主ごと
    folded: new Set(), // たたんでいる作付
    memo: new Set(), // メモの欄を開いている作業
    adding: { cropId: "", mode: "plant", date: null }, // 次の作付を足す欄
  };
  if (target?.kind === "block") {
    pd.blockId = target.id;
    pd.works = processOnly(s.works.filter((work) => work.block_id === target.id)).sort(bySeq).map((work) => ({ ...work }));
  } else if (target) {
    pd.blockId = s.beds.find((bed) => bed.id === target.id).block_id;
    pd.plantings = s.plantings.filter((item) => item.bed_id === target.id).sort(bySeq).map((item) => ({ ...item }));
    const ids = new Set(pd.plantings.map((item) => item.id));
    pd.works = processOnly(s.works.filter((work) => ids.has(work.planting_id))).sort(bySeq).map((work) => ({ ...work }));
  }
  pd.origPlantings = new Map(pd.plantings.map((item) => [item.id, JSON.stringify(item)]));
  pd.origWorks = new Map(pd.works.map((work) => [work.id, JSON.stringify(work)]));
  pd.orig = snapshot();
}

export const processDirty = () => Boolean(pd?.target) && snapshot() !== pd.orig;

// ほかのタブへ移るときに渡す相手。区画なら区画、畝ならその畝の最後の作付
export function processPreset() {
  if (!pd?.target) {
    return {};
  }
  if (pd.target.kind === "block") {
    return { blockId: pd.target.id };
  }
  const last = state().plantings.filter((item) => item.bed_id === pd.target.id).sort(bySeq).at(-1);
  return last ? { plantingId: last.id } : { blockId: pd.blockId };
}

// ---- 描画 ----

// 書きかけを入れた状態での、確認が必要な点（この相手のぶんだけ）
function draftProblems() {
  const s = state();
  const ownedHere = (work) =>
    !isManagement(work.work_type) && (pd.target.kind === "block" ? work.block_id === pd.blockId : pd.origPlantings.has(work.planting_id) || pd.plantings.some((item) => item.id === work.planting_id));
  const plantings = pd.target.kind === "bed" ? [...s.plantings.filter((item) => item.bed_id !== pd.target.id), ...pd.plantings] : s.plantings;
  const works = [...s.works.filter((work) => !ownedHere(work)), ...ordered()].filter((work) => !work.cancelled_on);
  const ids = new Set(pd.plantings.map((item) => item.id));
  return planProblems({ ...s, plantings, works }).filter((problem) => (pd.target.kind === "block" ? problem.block_id === pd.blockId : ids.has(problem.planting_id)));
}

const optionList = (entries, selected) =>
  entries.map(([value, text]) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(text)}</option>`).join("");
const cropOptions = (selected) => optionList([["", "登録していない品目"], ...state().crops.map((crop) => [crop.id, cropLabel(crop)])], selected || "");

function targetSelect() {
  const s = state();
  const options = s.blocks
    .map((block) => {
      const beds = blockBeds(block.id)
        .map((bed) => {
          const crops = s.plantings.filter((item) => item.bed_id === bed.id).sort(bySeq).map((item) => item.crop_name).filter(Boolean).join(" → ");
          return [`bed:${bed.id}`, `${block.name} 畝${bed.seq}${crops ? `（${crops}）` : ""}`];
        });
      return `<optgroup label="${escapeHtml(block.name)}">${optionList([[`block:${block.id}`, `${block.name}の作業（畝立ての前まで）`], ...beds], `${pd.target.kind}:${pd.target.id}`)}</optgroup>`;
    })
    .join("");
  return `<label class="pe-target">直す相手<select data-pe="target">${options}</select></label>`;
}

export function processHtml() {
  if (!pd?.target) {
    return '<p class="muted">耕起対象区画がまだありません。圃場図で区画を作ると、ここで工程の計画を作れます。</p>';
  }
  const problems = draftProblems();
  return `<div class="pe">${targetSelect()}${pd.target.kind === "block" ? blockHtml(problems) : bedHtml(problems)}</div>`;
}

// 並べ直しの欄に出す基準と日
function arrangeFor(owner) {
  const chosen = pd.arrange.get(ownerKey(owner)) || {};
  const mode = chosen.mode || Object.keys(ARRANGE_MODES[kindOf(owner)])[0];
  return { mode, date: chosen.date ?? arrangeDefault(owner, mode) };
}

function arrangeDefault(owner, mode) {
  const works = worksOf(owner);
  if (mode === "plant") {
    return works.find((work) => work.work_type === "plant")?.plan_start || "";
  }
  if (mode === "before") {
    // この区画の畝のうち、いちばん早く始まる最初の作付の開始日
    const starts = blockBeds(owner.block_id)
      .map((bed) => state().plantings.filter((item) => item.bed_id === bed.id).sort(bySeq)[0])
      .filter(Boolean)
      .map((planting) => worksRange(processOnly(state().works.filter((work) => work.planting_id === planting.id)))?.start)
      .filter(Boolean);
    return starts.sort()[0] || "";
  }
  return works.find((work) => work.plan_start)?.plan_start || "";
}

function arrangeHtml(owner) {
  const key = ownerKey(owner);
  const choice = arrangeFor(owner);
  return (
    `<div class="pe-line"><select data-pe="arrange-mode" data-owner="${key}" aria-label="並べ直しの基準">${optionList(Object.entries(ARRANGE_MODES[kindOf(owner)]), choice.mode)}</select></div>` +
    `<div class="pe-line"><input type="date" data-pe="arrange-date" data-owner="${key}" aria-label="基準にする日" value="${choice.date}" />` +
    `<button type="button" class="chip-btn" data-pe-act="arrange" data-owner="${key}">並べ直す</button></div>`
  );
}

// 持ち主に付いた指摘のうち、作業 1 件に結び付かないもの（日付のない作業の件数など）
function ownerNotes(owner, problems) {
  const mine = problems.filter((problem) => !problem.work_id && (owner.block_id ? problem.block_id === owner.block_id : problem.planting_id === owner.planting_id));
  return mine.length ? `<ul class="pe-notes">${mine.map((problem) => `<li>⚠ ${escapeHtml(problem.message)}</li>`).join("")}</ul>` : "";
}

function cardsHtml(owner, problems) {
  const works = worksOf(owner);
  if (!works.length) {
    return `<p class="muted">作業がまだありません。${kindOf(owner) === "block" ? "ひな形から作るか、" : ""}「＋ 作業を追加」で足してください。</p>`;
  }
  const actuals = isActivePlan() ? currentActuals() : new Map();
  const groups = [kindOf(owner), kindOf(owner) === "block" ? "bed" : "block"];
  const typeOptions = (selected) =>
    groups
      .map((group) => {
        const types = state().workTypes.filter((type) => (type.scope || "block") === group);
        return `<optgroup label="${SCOPE_LABELS[group]}">${optionList(types.map((type) => [type.code, type.label]), selected)}</optgroup>`;
      })
      .join("");
  return works
    .map((work, index) => {
      const notes = problems.filter((problem) => problem.work_id === work.id);
      const previous = works[index - 1];
      const gap = previous?.plan_end && work.plan_start ? diffDays(previous.plan_end, work.plan_start) - 1 : null;
      const actual = actuals.get(work.id);
      const done = Boolean(actual?.end);
      let actualText = "実績 －";
      if (work.cancelled_on) {
        actualText = "取りやめ";
      } else if (actual) {
        const end = actual.end || actual.last;
        actualText = `実績 <b>${actual.start === end ? shortDay(actual.start) : `${shortDay(actual.start)}〜${shortDay(end)}`}</b> ${done ? '<span class="pe-badge is-done">完了</span>' : '<span class="pe-badge">作業中</span>'}`;
      }
      const memoOpen = pd.memo.has(work.id);
      const memoButton = work.note
        ? `<button type="button" class="text-btn pe-memo-btn" data-pe-act="memo">${escapeHtml(work.note.length > 12 ? `${work.note.slice(0, 12)}…` : work.note)} ✎</button>`
        : `<button type="button" class="text-btn pe-memo-btn" data-pe-act="memo">メモ ＋</button>`;
      return (
        `<div class="pe-card${done ? " is-done" : ""}${notes.length ? " is-flagged" : ""}" data-id="${work.id}">` +
        `<div class="pe-card-top"><span class="pe-no">${index + 1}</span><span class="swatch" style="background:${WORK_COLORS[work.work_type] || "#888"}"></span>` +
        `<select data-pe="work_type" aria-label="作業の種類">${typeOptions(work.work_type)}</select></div>` +
        `<div class="pe-dates"><input type="date" data-pe="plan_start" aria-label="開始日" value="${work.plan_start || ""}" /><span class="muted">〜</span>` +
        `<input type="date" data-pe="plan_end" aria-label="終了日" value="${work.plan_end || ""}" /></div>` +
        `<div class="pe-meta"><span>${workDays(work) ?? "-"} 日</span>${gap === null ? "" : `<span>間隔 ${gap} 日</span>`}<span>${actualText}</span>${memoOpen ? "" : memoButton}</div>` +
        notes.map((problem) => `<p class="pe-flag">⚠ ${escapeHtml(problem.message)}</p>`).join("") +
        (memoOpen ? `<input type="text" data-pe="note" aria-label="メモ" placeholder="メモ" value="${escapeHtml(work.note)}" />` : "") +
        `<div class="pe-actions"><button type="button" class="pe-icon" data-pe-act="up" aria-label="上へ"${index === 0 ? " disabled" : ""}>↑</button>` +
        `<button type="button" class="pe-icon" data-pe-act="down" aria-label="下へ"${index === works.length - 1 ? " disabled" : ""}>↓</button>` +
        `<button type="button" class="pe-icon is-danger" data-pe-act="delete">削除</button></div></div>`
      );
    })
    .join("");
}

function blockHtml(problems) {
  const owner = { block_id: pd.blockId };
  const key = ownerKey(owner);
  return (
    `<details class="strip-detail pe-tools"><summary>ひな形から作る・並べ直す</summary>` +
    `<div class="pe-line"><select data-pe="template" aria-label="ひな形">${optionList(Object.entries(TEMPLATES.block).map(([name, item]) => [name, item.label]), pd.template.key)}</select>` +
    `<input type="date" data-pe="template-start" aria-label="最初の作業の日" value="${pd.template.start}" /></div>` +
    `<div class="pe-line"><button type="button" class="chip-btn" data-pe-act="template">ひな形から作る</button></div>` +
    (worksOf(owner).length ? arrangeHtml(owner) : "") +
    `</details>` +
    ownerNotes(owner, problems) +
    cardsHtml(owner, problems) +
    `<button type="button" class="text-btn pe-add" data-pe-act="add-work" data-owner="${key}">＋ 作業を追加</button>`
  );
}

function bedHtml(problems) {
  const sections = pd.plantings
    .map((planting) => {
      const owner = { planting_id: planting.id };
      const key = ownerKey(owner);
      const crop = cropOf(planting);
      const closed = pd.folded.has(planting.id);
      const works = worksOf(owner);
      const range = worksRange(works);
      return (
        `<section class="pe-planting" data-owner="${key}">` +
        `<div class="pe-planting-head"><h3>作付 ${planting.seq}　${escapeHtml(planting.crop_name || "品目なし")}</h3>` +
        `<button type="button" class="text-btn" data-pe-act="fold" data-owner="${key}" aria-expanded="${!closed}">${closed ? `▸ ひらく（${range ? `${shortDay(range.start)}〜${shortDay(range.end)}` : "日付なし"}、${works.length} 件）` : "▾ たたむ"}</button></div>` +
        (closed
          ? ""
          : `<div class="pe-line"><select data-pe="crop" data-owner="${key}" aria-label="この作付の品目">${cropOptions(crop?.id)}</select>` +
            `<button type="button" class="text-btn danger" data-pe-act="delete-planting" data-owner="${key}">この作付を削除</button></div>` +
            (crop ? "" : `<input type="text" data-pe="crop_name" data-owner="${key}" placeholder="品目の名前" value="${escapeHtml(planting.crop_name)}" />`) +
            (works.length ? `<details class="strip-detail pe-tools"><summary>並べ直す</summary>${arrangeHtml(owner)}</details>` : "") +
            ownerNotes(owner, problems) +
            cardsHtml(owner, problems) +
            `<button type="button" class="text-btn pe-add" data-pe-act="add-work" data-owner="${key}">＋ 作業を追加</button>`) +
        `</section>`
      );
    })
    .join("");
  return (
    (sections || '<p class="muted">この畝には作付がまだありません。下で品目と日を決めて「作付を追加」を押すと、畝立てから残渣処理までの作業が入った作付ができます。</p>') +
    addPlantingHtml()
  );
}

function addPlantingHtml() {
  const adding = pd.adding;
  const date = adding.date ?? newPlantingDefault();
  return (
    `<div class="pe-add-planting"><strong>次の作付を追加</strong>` +
    `<select data-pe="add-crop" aria-label="追加する作付の品目">${cropOptions(adding.cropId)}</select>` +
    `<select data-pe="add-mode" aria-label="日付の基準">${optionList([["plant", "定植・播種をこの日に始める（前は逆算）"], ["forward", "最初の作業をこの日に始める"]], adding.mode)}</select>` +
    `<div class="pe-line"><input type="date" data-pe="add-date" aria-label="基準にする日" value="${date}" />` +
    `<button type="button" class="chip-btn" data-pe-act="add-planting">作付を追加</button></div></div>`
  );
}

// ---- 作付のひな形 ----

// 作付のひな形の作業（日付なし）。品目を登録してあれば、マルチを張るかどうかでひな形を選ぶ
function templateWorks(crop, owner) {
  const key = crop && !crop.mulch ? "bare" : "mulch";
  return TEMPLATES.bed[key].codes.map((code) => newWork(owner, code));
}

// 並んだ作業がすべて終わり、最後の作業のあとにあける日数も過ぎた、最初の日
function startAfter(works, owner) {
  const last = works.filter((work) => work.plan_start && work.plan_end).sort((a, b) => a.plan_end.localeCompare(b.plan_end)).at(-1);
  return last ? addDays(last.plan_end, 1 + (typeFor(owner, last.work_type)?.min_gap_days || 0)) : "";
}

// その畝の seq 番目の作付を、いちばん早く始められる日。前の作付（なければ区画）の作業が終わった日のあと
function earliestStart(seq) {
  const earlier = pd.plantings.filter((item) => item.seq < seq).at(-1);
  if (earlier) {
    const owner = { planting_id: earlier.id };
    return startAfter(worksOf(owner), owner);
  }
  // 前の作付がなければ、区画の作業（この窓では直していない、保存済みのもの）が終わったあと
  const blockWorks = processOnly(state().works.filter((work) => work.block_id === pd.blockId));
  const last = blockWorks.filter((work) => work.plan_start && work.plan_end).sort((a, b) => a.plan_end.localeCompare(b.plan_end)).at(-1);
  if (!last) {
    return "";
  }
  return addDays(last.plan_end, 1 + (state().workTypes.find((type) => type.code === last.work_type)?.min_gap_days || 0));
}

// 作付に、ひな形の作業を入れる。timing = { mode: "plant" | "forward", date }。date が空なら、いちばん早く始められる日から
function fillPlanting(planting, timing = {}) {
  const crop = cropOf(planting);
  const owner = { planting_id: planting.id };
  let works = templateWorks(crop, owner);
  const types = typesForCrop(state().workTypes, crop, []);
  const anchor = works.findIndex((work) => work.work_type === "plant");
  const earliest = earliestStart(planting.seq);
  if (timing.date && timing.mode === "plant" && anchor >= 0) {
    works = scheduleAnchored(works, types, anchor, timing.date);
  } else if (timing.date || earliest) {
    works = scheduleForward(works, types, timing.date || earliest);
  }
  setWorksOf(owner, works);
}

// 「作付を追加」の日付の初期値。いちばん早く始められる日から並べたときの、定植・播種の日（または最初の作業の日）
function newPlantingDefault() {
  const last = pd.plantings.at(-1);
  const seq = last && !worksOf({ planting_id: last.id }).length ? last.seq : (last?.seq || 0) + 1;
  const earliest = earliestStart(seq);
  if (!earliest || pd.adding.mode === "forward") {
    return earliest;
  }
  const crop = state().crops.find((item) => item.id === pd.adding.cropId);
  const dated = scheduleForward(templateWorks(crop, {}), typesForCrop(state().workTypes, crop, []), earliest);
  return dated.find((work) => work.work_type === "plant")?.plan_start || earliest;
}

// ---- 操作 ----

function addWork(owner) {
  const works = worksOf(owner);
  const last = works.at(-1);
  const first = state().workTypes.find((type) => (type.scope || "block") === kindOf(owner)) || state().workTypes[0];
  const work = newWork(owner, first.code);
  if (last?.plan_end) {
    work.plan_start = addDays(last.plan_end, 1 + (typeFor(owner, last.work_type)?.min_gap_days || 0));
    work.plan_end = addDays(work.plan_start, first.default_days - 1);
  }
  setWorksOf(owner, [...works, work]);
}

function moveWork(id, step) {
  const owner = ownerOf(pd.works.find((work) => work.id === id));
  const works = worksOf(owner);
  const index = works.findIndex((work) => work.id === id);
  const other = index + step;
  if (other < 0 || other >= works.length) {
    return;
  }
  [works[index], works[other]] = [works[other], works[index]];
  setWorksOf(owner, works);
}

function arrange(owner) {
  const { mode, date } = arrangeFor(owner);
  if (!date) {
    notify("基準にする日を入れてください。");
    return false;
  }
  const works = worksOf(owner);
  let result;
  if (mode === "before") {
    result = scheduleBefore(works, typesFor(owner), date);
  } else if (mode === "plant") {
    const index = works.findIndex((work) => work.work_type === "plant");
    if (index < 0) {
      notify("この作付には「定植・播種」の作業がありません。");
      return false;
    }
    result = scheduleAnchored(works, typesFor(owner), index, date);
  } else {
    result = scheduleForward(works, typesFor(owner), date);
  }
  pd.arrange.delete(ownerKey(owner));
  setWorksOf(owner, result);
  return true;
}

async function applyTemplate(rerender) {
  const owner = { block_id: pd.blockId };
  const count = worksOf(owner).length;
  if (count && !(await confirmAction({ message: "いまの作業を、ひな形の内容に置き換えます（保存するまでは、キャンセルで戻せます）。", name: `作業 ${count} 件`, action: "置き換える" }))) {
    return;
  }
  let works = TEMPLATES.block[pd.template.key].codes.map((code) => newWork(owner, code));
  if (pd.template.start) {
    works = scheduleForward(works, state().workTypes, pd.template.start);
  }
  setWorksOf(owner, works);
  rerender();
}

function addPlanting() {
  const last = pd.plantings.at(-1);
  const crop = state().crops.find((item) => item.id === pd.adding.cropId) || null;
  const lastWorks = last ? worksOf({ planting_id: last.id }) : [];
  const empty = last && !lastWorks.length ? last : null;
  if (last && !empty && !harvestEnd(lastWorks)) {
    notify(`作付 ${last.seq}${last.crop_name ? `（${last.crop_name}）` : ""}の収穫完了予定日が決まっていません。\n次の作付を足す前に、その作付に「収穫」の作業を入れ、終了日を入れてください。`);
    return;
  }
  const timing = { mode: pd.adding.mode, date: pd.adding.date ?? newPlantingDefault() };
  let planting = empty;
  if (planting && crop) {
    planting.crop_id = crop.id;
    planting.crop_name = crop.name;
  } else if (!planting) {
    planting = { id: crypto.randomUUID(), plan_id: state().plan.id, bed_id: pd.target.id, seq: (last?.seq || 0) + 1, crop_id: crop?.id || null, crop_name: crop?.name || "", note: "" };
    pd.plantings.push(planting);
  }
  fillPlanting(planting, timing);
  pd.adding.date = null; // 次の作付の日は、また初期値から
}

// 写しを書き換えたら true（描き直す）。窓の外の操作は false
export function processClick(event, rerender) {
  const button = event.target.closest("[data-pe-act]");
  if (!button || !pd) {
    return false;
  }
  const act = button.dataset.peAct;
  const card = button.closest(".pe-card");
  const owner = button.dataset.owner ? ownerFromKey(button.dataset.owner) : null;
  if (act === "memo") {
    pd.memo.add(card.dataset.id);
    rerender();
    document.querySelector(`.pe-card[data-id="${card.dataset.id}"] [data-pe="note"]`)?.focus();
    return true;
  }
  if (act === "up" || act === "down") {
    moveWork(card.dataset.id, act === "up" ? -1 : 1);
  } else if (act === "delete") {
    pd.works = pd.works.filter((work) => work.id !== card.dataset.id);
  } else if (act === "add-work") {
    addWork(owner);
  } else if (act === "arrange") {
    if (!arrange(owner)) {
      return true;
    }
  } else if (act === "template") {
    applyTemplate(rerender);
    return true;
  } else if (act === "fold") {
    if (!pd.folded.delete(owner.planting_id)) {
      pd.folded.add(owner.planting_id);
    }
  } else if (act === "delete-planting") {
    pd.plantings = pd.plantings.filter((item) => item.id !== owner.planting_id);
    pd.works = pd.works.filter((work) => work.planting_id !== owner.planting_id);
  } else if (act === "add-planting") {
    addPlanting();
  } else {
    return false;
  }
  rerender();
  return true;
}

// 直す相手を替える。書きかけがあれば、捨ててよいかを確かめる
async function changeTarget(value, select, rerender) {
  if (processDirty() && !(await confirmDiscard("捨てて切り替える"))) {
    select.value = `${pd.target.kind}:${pd.target.id}`;
    return;
  }
  const [kind, id] = value.split(":");
  startProcess(kind === "block" ? { blockId: id } : { bedId: id });
  rerender();
}

// 書きかけを捨ててよいかを確かめる。action は捨てるボタンの名前（「捨てて切り替える」「捨てて閉じる」）
export function confirmDiscard(action = "捨てる") {
  return confirmAction({ message: "まだ保存していない入力があります。この入力は消えます。", action, cancel: "入力を続ける" });
}

export function processChange(event, rerender) {
  const field = event.target.dataset.pe;
  if (!field || !pd) {
    return false;
  }
  const value = event.target.value;
  const card = event.target.closest(".pe-card");
  const owner = event.target.dataset.owner ? ownerFromKey(event.target.dataset.owner) : null;
  if (field === "target") {
    changeTarget(value, event.target, rerender);
    return true;
  }
  if (card) {
    const work = pd.works.find((item) => item.id === card.dataset.id);
    if (field === "work_type") {
      work.work_type = value;
    } else if (field === "note") {
      work.note = value;
    } else if (field === "plan_start") {
      // 開始日を動かしたら、日数を保って終了日も動かす。日数が分からなければ、目安の日数で入れる
      const days = work.plan_start && work.plan_end ? workDays(work) : typeFor(ownerOf(work), work.work_type)?.default_days || 1;
      work.plan_start = value || null;
      if (value) {
        work.plan_end = addDays(value, days - 1);
      }
    } else if (field === "plan_end") {
      work.plan_end = value || null;
    }
  } else if (field === "template") {
    pd.template.key = value;
    return true;
  } else if (field === "template-start") {
    pd.template.start = value;
    return true;
  } else if (field === "arrange-mode") {
    pd.arrange.set(ownerKey(owner), { mode: value, date: arrangeDefault(owner, value) });
  } else if (field === "arrange-date") {
    pd.arrange.set(ownerKey(owner), { ...arrangeFor(owner), date: value });
    return true;
  } else if (field === "crop") {
    const planting = plantingOf(owner);
    const crop = state().crops.find((item) => item.id === value);
    planting.crop_id = crop?.id || null;
    if (crop) {
      planting.crop_name = crop.name;
      // まだ作業のない作付なら、選んだ品目のひな形で作業を入れる
      if (!worksOf(owner).length) {
        fillPlanting(planting);
      }
    }
  } else if (field === "crop_name") {
    plantingOf(owner).crop_name = value.trim();
  } else if (field === "add-crop") {
    pd.adding.cropId = value;
    pd.adding.date = null;
  } else if (field === "add-mode") {
    pd.adding.mode = value;
    pd.adding.date = null;
  } else if (field === "add-date") {
    pd.adding.date = value;
    return true;
  } else {
    return false;
  }
  rerender();
  return true;
}

// ---- 保存 ----

function targetName() {
  const block = state().blocks.find((item) => item.id === pd.blockId);
  if (pd.target.kind === "block") {
    return block?.name || "";
  }
  const bed = state().beds.find((item) => item.id === pd.target.id);
  return `${block?.name || ""} 畝${bed?.seq ?? ""}`;
}

// 書きかけをまとめて保存する。作付を先に入れ、作業を入れてから、消した作業と作付を消す
export async function saveProcess() {
  const s = state();
  const store = s.store;
  pd.works = ordered();
  const changedPlantings = pd.plantings.filter((item) => pd.origPlantings.get(item.id) !== JSON.stringify(item));
  const removedPlantings = [...pd.origPlantings.keys()].filter((id) => !pd.plantings.some((item) => item.id === id));
  const changedWorks = pd.works.filter((work) => pd.origWorks.get(work.id) !== JSON.stringify(work));
  const removedWorks = [...pd.origWorks.keys()].filter((id) => !pd.works.some((work) => work.id === id));
  const added = changedWorks.filter((work) => !pd.origWorks.has(work.id)).length;
  ctx.setStatus("保存中…");
  if (changedPlantings.length) {
    await store.upsert("plantings", changedPlantings);
  }
  if (changedWorks.length) {
    await store.upsert("works", changedWorks);
  }
  if (removedWorks.length) {
    await store.remove("works", removedWorks);
  }
  if (removedPlantings.length) {
    await store.remove("plantings", removedPlantings);
  }
  // 画面のデータも入れ替える（消した作付の作業は、管理作業も一緒に消える）
  const gone = new Set(removedPlantings);
  if (pd.target.kind === "bed") {
    s.plantings = [...s.plantings.filter((item) => item.bed_id !== pd.target.id), ...pd.plantings];
  }
  s.works = [...s.works.filter((work) => !pd.origWorks.has(work.id) && !gone.has(work.planting_id)), ...pd.works];
  const parts = [
    added ? `追加 ${added} 件` : "",
    changedWorks.length - added ? `変更 ${changedWorks.length - added} 件` : "",
    removedWorks.length ? `削除 ${removedWorks.length} 件` : "",
    removedPlantings.length ? `作付の削除 ${removedPlantings.length} 件` : "",
  ].filter(Boolean);
  record({
    kind: "work.process",
    target: pd.target.kind === "block" ? ["block", pd.target.id] : ["bed", pd.target.id],
    text: `${targetName()}の工程の計画を保存${parts.length ? `（${parts.join("、")}）` : ""}`,
  });
  ctx.setStatus("保存しました");
  ctx.refresh();
  noteChange();
}

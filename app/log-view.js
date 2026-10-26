// 作業の記録の画面。日程の画面の「最近の記録」の欄と「記録する」のボタン、記録を入れる窓。
// 記録は、実際に使うプランの区画・畝・作付・作業につなぐ。計画はスマホでは直せないが、記録はスマホでも入れられる。
import { WORK_COLORS, WORK_ITEMS, addDays, diffDays, isManagement, localToday, workName } from "./schedule.js";
import { confirmAction, confirmDelete, notify } from "./dialog.js";
import { record } from "./journal.js";
import { SPEC_FIELDS, formatAmount, inputText, logEnd, productAmount, specText, splitByArea, targetChoices, targetSummary, workActuals } from "./logs.js";
import * as famic from "./pesticide.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const RECENT = 5; // 「最近の記録」に出す件数
const QUICK_TYPES = ["spray", "topdress", "weed", "water", "care", "plant"]; // 大きめのボタンで並べる種類
const COPY_DAYS = 7; // 計画の「コピーして足す」の初めの日数
const METHODS = ["散布", "土壌混和", "種子・種球の浸漬", "株元散布", "灌注", "その他"];
const FERTILIZER_TYPES = new Set(["amend", "topdress"]);

let ctx = null; // { state, setStatus, activePlanData }
let showAll = false;
let dialog = null;
let draft = null; // 窓で入れている記録
let data = null; // 実際に使うプランの区画・畝・作付・作業

const state = () => ctx.state;
const allTypes = () => state().allWorkTypes || state().workTypes;
const typeLabel = (code) => allTypes().find((type) => type.code === code)?.label || code;
const typeScope = (code) => allTypes().find((type) => type.code === code)?.scope || "bed";
const inputKind = (code) => (code === "spray" ? "pesticide" : FERTILIZER_TYPES.has(code) ? "fertilizer" : "material");
const num = (value) => (value === "" || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
const round = (value, digits) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const fmt = (value, digits = 1) => (value === null ? "-" : value.toFixed(digits));

function formatDay(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${month}/${day}（${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}）`;
}

// 記録の日。何日かかかった作業は「10/15（木）〜10/17（土）」
export const logDays = (log) => (logEnd(log) > log.date ? `${formatDay(log.date)}〜${formatDay(logEnd(log))}` : formatDay(log.date));

const activePlan = () => state().plans.find((plan) => plan.id === state().field.active_plan_id) || null;

// ---- 最近の記録 ----

export function renderLogs() {
  if (!ctx) {
    return;
  }
  const logs = state().logs || [];
  const shown = showAll ? logs : logs.slice(0, RECENT);
  $("logTitle").textContent = showAll ? `実績（${logs.length} 件）` : "最近の実績";
  $("logToggle").hidden = logs.length <= RECENT;
  $("logToggle").textContent = showAll ? "最近だけ" : "すべて";
  const active = activePlan();
  const note = !active
    ? "実績や管理作業の計画を入力するには、圃場図の「プラン」の欄で、実際に使うプランを決めてください。"
    : active.id !== state().plan.id
      ? `実績と管理作業の計画は、実際に使うプラン「${active.name}」の畝に入力します（いま開いているのはプラン「${state().plan.name}」です）。`
      : "";
  $("logNote").textContent = note;
  $("logNote").hidden = !note;
  $("logList").innerHTML = shown.length
    ? shown
        .map((log) => {
          const details = [targetSummary(log.targets || []), ...(log.inputs || []).map(inputText), log.note].filter(Boolean).join(" / ");
          return (
            `<li data-log="${log.id}"><span class="week-date">${logDays(log)}</span>` +
            `<span class="week-work"><span class="swatch" style="background:${WORK_COLORS[log.work_type] || "#888"}"></span>` +
            `${escapeHtml(workName(typeLabel(log.work_type), log.spec))}${log.finishes ? '<span class="log-done">完了</span>' : ""}</span>` +
            `<span class="muted">${escapeHtml(details)}</span></li>`
          );
        })
        .join("")
    : '<li class="muted">まだ実績はありません</li>';
}

// ---- 記録を入れる窓 ----

async function loadData() {
  if (!state().field.active_plan_id) {
    notify("実績や管理作業の計画を入力するには、先に圃場図の「プラン」の欄で、実際に使うプランを決めてください。");
    return false;
  }
  try {
    data = await ctx.activePlanData();
    return true;
  } catch (error) {
    notify(`実際に使うプランを読み込めませんでした: ${error.message}`);
    return false;
  }
}

// 計画の作業の対象（作付の畝、または区画）。その日の対象の一覧から取り、なければ名前だけで作る
function targetForWork(work, date) {
  const choices = targetChoices({ ...data, logs: state().logs || [] }, date);
  if (work.block_id) {
    const block = data.blocks.find((item) => item.id === work.block_id);
    return choices.blocks.find((item) => item.block_id === work.block_id) || { block_id: work.block_id, label: block?.name || "", crop_name: "", area_m2: null };
  }
  const found = choices.crops.flatMap((group) => group.items).find((item) => item.planting_id === work.planting_id);
  if (found) {
    return found;
  }
  const planting = data.plantings.find((item) => item.id === work.planting_id);
  const bed = planting && data.beds.find((item) => item.id === planting.bed_id);
  const block = bed && data.blocks.find((item) => item.id === bed.block_id);
  return {
    planting_id: work.planting_id,
    bed_id: bed?.id || null,
    block_id: block?.id || null,
    label: `${block?.name || ""} 畝${bed?.seq ?? ""} ${planting?.crop_name || ""}`.trim(),
    crop_name: planting?.crop_name || "",
    area_m2: null,
  };
}

// 計画の作業を、画面を開かずに、計画どおりに行ったものとして完了にする。works は同じ種類・同じ計画の日の作業（畝ごと）。
// 記録の日は計画の日。計画が 1 日ならその日に完了の記録を 1 件、何日かにわたるなら開始日の記録と終了日の完了の記録の 2 件を作る
// （実績の期間が計画どおりになるように）。計画の日が入っていない作業は、今日の日付にする
export async function completeWorks(works) {
  if (!works.length || !(await loadData())) {
    return;
  }
  const start = works[0].plan_start || localToday();
  const end = works[0].plan_end || start;
  const targets = works.map((work) => {
    const item = targetForWork(work, end);
    return {
      planting_id: item.planting_id || null,
      bed_id: item.bed_id || null,
      block_id: item.block_id || null,
      work_id: work.id,
      label: item.label,
      crop_name: item.crop_name || "",
      area_m2: round(item.area_m2 ?? null, 2),
      spray_l: null,
    };
  });
  // 管理作業の計画なら、予定の中身（株の手入れ・その他の中身など）を実績にも入れる
  const base = { field_id: state().field.id, work_type: works[0].work_type, spec: { ...(works[0].detail?.spec || {}) }, note: "", inputs: [] };
  ctx.setStatus("実績を入力しています…");
  try {
    // 何日かかかった作業も、記録は 1 件（開始日と終えた日）
    await state().store.saveLog({ ...base, date: start, end_date: start < end ? end : null, finishes: true, targets });
    await reload();
    ctx.setStatus(`${typeLabel(works[0].work_type)}を、計画どおり（${start === end ? formatDay(end) : `${formatDay(start)}〜${formatDay(end)}`}）に完了にしました`);
  } catch (error) {
    ctx.setStatus("");
    notify(`実績を入力できませんでした: ${error.message}`);
  }
}

// 記録がほかの畝にも付いているときに、動かす範囲を尋ねる。"one"（この畝だけ）、"all"（記録ごと）、null（やめる）
function chooseScope(rowName, others) {
  const box = document.createElement("dialog");
  box.className = "notice";
  box.innerHTML =
    '<p class="notice-text"></p><div class="row">' +
    '<button class="primary-btn" data-scope="one"></button><button class="chip-btn" data-scope="all"></button>' +
    '<button class="text-btn" data-scope="">キャンセル</button></div>';
  box.querySelector(".notice-text").textContent = `この実績は、ほかの ${others} か所の畝（区画）にも付いています。どこまで日付を動かしますか。`;
  box.querySelector('[data-scope="one"]').textContent = `${rowName}だけ動かす`;
  box.querySelector('[data-scope="all"]').textContent = `実績ごと動かす（${others + 1} か所）`;
  document.body.append(box);
  return new Promise((resolve) => {
    box.addEventListener("click", (event) => {
      const button = event.target.closest("[data-scope]");
      if (button) {
        box.returnValue = button.dataset.scope;
        box.close();
      }
    });
    box.addEventListener("close", () => {
      box.remove();
      resolve(box.returnValue || null);
    });
    box.showModal();
  });
}

// 記録の日付を days 日ずらす（工程表の実績の帯のドラッグ）。matches(対象) は、ドラッグした行（畝か区画）の対象か。
// 記録がほかの畝にも付いているときは、その行の分だけを別の記録に分けて動かすか、記録ごと動かすかを尋ねる
export async function moveLogs(logIds, days, matches, rowName) {
  const logs = logIds.map((id) => (state().logs || []).find((log) => log.id === id)).filter(Boolean);
  if (!logs.length || !days) {
    return false;
  }
  const others = Math.max(0, ...logs.map((log) => log.targets.filter((target) => !matches(target)).length));
  const scope = others ? await chooseScope(rowName, others) : "all";
  if (!scope) {
    return false;
  }
  const fields = (log) => ({ id: log.id, field_id: log.field_id, date: log.date, end_date: log.end_date || null, work_type: log.work_type, finishes: log.finishes, spec: log.spec, note: log.note });
  const strip = ({ id, log_id, ...rest }) => rest;
  ctx.setStatus("実績の日付を動かしています…");
  try {
    for (const log of logs) {
      const date = addDays(log.date, days);
      const end_date = log.end_date ? addDays(log.end_date, days) : null;
      const mine = log.targets.filter(matches);
      const rest = log.targets.filter((target) => !matches(target));
      if (scope === "all" || !rest.length) {
        await state().store.saveLog({ ...fields(log), date, end_date, targets: log.targets, inputs: log.inputs || [] });
      } else {
        // 残す畝の記録と、動かす畝の記録に分ける
        await state().store.saveLog({ ...fields(log), targets: rest, inputs: log.inputs || [] });
        const { id, ...copy } = fields(log);
        await state().store.saveLog({ ...copy, date, end_date, targets: mine.map(strip), inputs: (log.inputs || []).map(strip) });
      }
    }
    await reload();
    ctx.setStatus(`実績の日付を ${Math.abs(days)} 日${days > 0 ? "後ろ" : "前"}へ動かしました`);
    return true;
  } catch (error) {
    ctx.setStatus("");
    notify(`実績の日付を動かせませんでした: ${error.message}`);
    await reload().catch(() => {});
    return false;
  }
}

// 計画の作業を終えた記録（いちばん新しいもの）。なければ null
export function logForWork(workId) {
  return (state().logs || []).find((log) => log.finishes && log.targets.some((target) => target.work_id === workId)) || null;
}

// 窓を開く。log を渡すとその記録を直す。
// preset.works を渡すと、その計画の作業（同じ種類、畝ごと）の記録として、種類と対象とつながりを入れて開く。
// preset.plantingId を渡すと、その作付の畝を対象に入れて開く
export async function openLogEditor(log = null, preset = {}) {
  if (!(await loadData())) {
    return;
  }
  const presetWorks = !log && preset.works?.length ? preset.works : [];
  // 管理作業の計画を直すときは、一緒に入力した計画（まとまり）ごと開く
  // 計画の行は、読み込んだ実際に使うプランのものに置き換える（開いているプランが違うときに、古い行を直さないように）
  const planWork = !log && preset.planWork ? data.works.find((work) => work.id === preset.planWork.id) || null : null;
  if (preset.planWork && !planWork) {
    notify("管理作業の計画は、実際に使うプランのものだけを直せます。");
    return;
  }
  const planWorks = planWork ? (planWork.batch_id ? data.works.filter((work) => work.batch_id === planWork.batch_id) : [planWork]) : [];
  const source = planWork || presetWorks[0] || null; // 予定の中身（detail）を入れる元の計画
  const type = log?.work_type || source?.work_type || "";
  draft = {
    id: log?.id || null,
    // plan は管理作業の計画、actual は実績。「入力する」のボタンから開いたときだけ、窓の上で切り替えられる
    kind: planWork || preset.plan ? "plan" : "actual",
    switchable: !log && !planWork && !presetWorks.length,
    planWork,
    planWorks,
    onlyThis: false, // 計画を直すとき、この畝だけ直すか（一緒に入力した全部か）
    copyDays: COPY_DAYS,
    // 実績がつながる計画の作業（5.5）。計画の「完了」「修正」から開いたときと、実績の窓で印を付けたときだけ
    linked: new Set(log ? log.targets.map((target) => target.work_id).filter(Boolean) : presetWorks.map((work) => work.id)),
    // 計画の作業から開いたときは、計画の開始日と終了日（「この日で終わり」に印が付く）。それ以外は今日
    date: log?.date || source?.plan_start || source?.plan_end || localToday(),
    // 何日かかかった作業の、終えた日（作業中なら、進んだ日）。1 日の作業は空
    end_date: log ? log.end_date || "" : source?.plan_end && source.plan_end > (source.plan_start || "") ? source.plan_end : "",
    work_type: type,
    finishes: log ? log.finishes : true,
    spec: { ...(log?.spec || source?.detail?.spec || {}) },
    note: log?.note ?? (planWork ? planWork.note || "" : ""),
    mode: log
      ? log.targets.some((target) => target.bed_id || target.planting_id) || !log.targets.length
        ? "crops"
        : "blocks"
      : presetWorks.some((work) => work.block_id)
        ? "blocks"
        : "crops",
    beds: new Set(),
    blocks: new Set(),
    orphans: [], // 対象の一覧にない対象（畝や区画を消した記録など）。そのまま残す
    spray: {}, // 品目のまとまり（または区画）ごとの散布液の量（L）
    inputs: (log?.inputs || source?.detail?.inputs || []).map((input) => ({ ...input })),
    cancellable: presetWorks.map((work) => work.id), // 取りやめにできる計画の作業
  };
  const ownerWorks = planWorks.length ? planWorks : presetWorks;
  const existing = log ? log.targets : ownerWorks.map((work) => ({ ...targetForWork(work, draft.date), work_id: work.id }));
  if (!log && preset.plantingId) {
    existing.push(targetForWork({ planting_id: preset.plantingId }, draft.date));
  }
  if (existing.length) {
    const choices = currentChoices();
    const bedIds = new Set(choices.crops.flatMap((group) => group.items.map((item) => item.bed_id)));
    const blockIds = new Set(choices.blocks.map((item) => item.block_id));
    for (const target of existing) {
      if (target.bed_id && bedIds.has(target.bed_id)) {
        draft.beds.add(target.bed_id);
      } else if (!target.bed_id && target.block_id && blockIds.has(target.block_id)) {
        draft.blocks.add(target.block_id);
      } else {
        draft.orphans.push(target);
      }
    }
  }
  // 定植・播種の計画の作業から開いたときは、仕様の欄に計画の値を入れておく（違うところだけ直せるように）
  if (type === "plant" && presetWorks.length && !Object.keys(draft.spec).length) {
    const planting = data.plantings.find((item) => item.id === presetWorks[0].planting_id);
    const crop = planting && data.crops.find((item) => item.id === planting.crop_id);
    for (const key of ["plant_gap_cm", "row_gap_cm", "row_count", "staggered"]) {
      const value = planting?.[key] ?? crop?.[key];
      if (value !== null && value !== undefined) {
        draft.spec[key] = value;
      }
    }
  }
  if (log) {
    const choices = currentChoices();
    // 散布液の量は、まとまりごとの合計に戻す
    for (const group of choices.crops) {
      const liters = log.targets.filter((target) => group.items.some((item) => item.bed_id === target.bed_id)).reduce((sum, target) => sum + (num(target.spray_l) || 0), 0);
      if (liters > 0) {
        draft.spray[group.key] = round(liters, 2);
      }
    }
    log.targets.filter((target) => !target.bed_id && target.block_id && num(target.spray_l)).forEach((target) => (draft.spray[target.block_id] = num(target.spray_l)));
  }
  if (!draft.inputs.length && type) {
    draft.inputs = defaultInputs(type);
  }
  if (!dialog) {
    build();
  }
  renderDialog();
  dialog.showModal();
  updateTotals();
  refreshUses(); // 直す記録の農薬は、使用基準を読み込んでから、使い方と指摘を出す
}

function defaultInputs(type) {
  const kind = inputKind(type);
  return kind === "material" ? [] : [blankInput(kind)];
}

function blankInput(kind) {
  return { kind, name: "", method: kind === "pesticide" ? METHODS[0] : "", dilution: null, amount: null, unit: kind === "pesticide" ? "mL" : "kg", fertilizer_id: null };
}

function currentChoices() {
  return targetChoices({ ...data, logs: state().logs || [] }, draft.date || localToday());
}

// 選んでいる対象。品目で選ぶときは畝ごと（まとまりの key 付き）、区画で選ぶときは区画ごと
function pickedItems(choices = currentChoices()) {
  if (draft.mode === "blocks") {
    return choices.blocks.filter((item) => draft.blocks.has(item.block_id)).map((item) => ({ ...item, group: item.block_id }));
  }
  return choices.crops.flatMap((group) => group.items.filter((item) => draft.beds.has(item.bed_id)).map((item) => ({ ...item, group: group.key })));
}

// 計画の作業の実績。直している記録そのものは除いて求める（自分の「終わり」で自分を外さないように）
const otherActuals = () => workActuals((state().logs || []).filter((log) => log.id !== draft.id));

// 選んだ対象（畝の作付、または区画）の計画の作業か
const ownsWork = (item, work) => (item.bed_id ? work.planting_id === item.planting_id : work.block_id === item.block_id && !work.planting_id);

// 実績がつながる計画の作業。印の付いた計画のうち、選んでいる対象の、同じ種類のもの
function linkedWorks(items) {
  if (!draft.work_type || draft.kind !== "actual") {
    return [];
  }
  return data.works.filter((work) => draft.linked.has(work.id) && work.work_type === draft.work_type && items.some((item) => ownsWork(item, work)));
}

// つなげる候補（5.5）。選んでいる対象に、同じ種類の、取りやめておらず、まだ終わっていない計画があれば、
// いちばん早いものを挙げる。自動ではつながず、印を付けたときだけつなぐ
function candidateWorks(items) {
  if (!draft.work_type || draft.kind !== "actual") {
    return [];
  }
  const actuals = otherActuals();
  const linkedOwners = linkedWorks(items);
  return items
    .filter((item) => !linkedOwners.some((work) => ownsWork(item, work)))
    .map((item) =>
      data.works
        .filter((work) => ownsWork(item, work) && work.work_type === draft.work_type && !work.cancelled_on && !actuals.get(work.id)?.end)
        .sort((a, b) => (a.plan_start || "9999").localeCompare(b.plan_start || "9999"))[0]
    )
    .filter(Boolean);
}

function build() {
  dialog = document.createElement("dialog");
  dialog.className = "log-dialog";
  dialog.setAttribute("aria-labelledby", "logDialogTitle");
  document.body.append(dialog);
  dialog.addEventListener("click", onClick);
  dialog.addEventListener("change", onChange);
  dialog.addEventListener("input", onInput);
  // Esc で閉じたときも、入れかけの内容は捨てる（確かめない）。窓の外を押しても閉じない
  dialog.addEventListener("close", () => {
    draft = null;
  });
}

function renderDialog() {
  const choices = currentChoices();
  const items = pickedItems(choices);
  const area = items.reduce((sum, item) => sum + (item.area_m2 || 0), 0);
  const plan = activePlan();
  dialog.innerHTML =
    `<div class="log-head"><h2 id="logDialogTitle">${dialogTitle()}</h2>` +
    `<button type="button" class="text-btn" data-act="close" aria-label="閉じる">閉じる</button></div>` +
    `<div class="log-body">` +
    (draft.switchable
      ? `<div class="log-kinds" role="group" aria-label="入力するもの">` +
        `<button type="button" class="chip-btn${draft.kind === "actual" ? " is-on" : ""}" data-act="kind" data-kind="actual" aria-pressed="${draft.kind === "actual"}">実績</button>` +
        `<button type="button" class="chip-btn${draft.kind === "plan" ? " is-on" : ""}" data-act="kind" data-kind="plan" aria-pressed="${draft.kind === "plan"}">計画</button></div>`
      : "") +
    `<p class="muted">${draft.kind === "plan" ? "管理作業（防除、追肥、除草、灌水、株の手入れ、その他）の計画を、" : ""}プラン「${escapeHtml(plan?.name || "")}」の畝${draft.kind === "plan" ? "に入れます。工程の作業の計画は、日程の画面の「作業の計画」で入れます。" : "につなぎます。"}</p>` +
    planScopeSection() +
    `<label>${draft.kind === "plan" ? "予定の日" : "作業をした日"}<span class="log-date"><input type="date" data-f="date" value="${draft.date}" required />` +
    `<button type="button" class="chip-btn" data-act="today">本日</button></span></label>` +
    `<label>${draft.kind === "plan" ? "終える予定の日（何日かかるときだけ）" : "終えた日（何日かかったときだけ）"}<span class="log-date"><input type="date" data-f="end_date" value="${draft.end_date}" min="${draft.date}" />` +
    (draft.end_date
      ? '<button type="button" class="chip-btn" data-act="oneDay">1 日の作業</button>'
      : localToday() > draft.date
        ? '<button type="button" class="chip-btn" data-act="todayEnd">本日</button>'
        : "") +
    `</span></label>` +
    `<p class="muted log-date-note">${dateNote()}</p>` +
    typeSection() +
    targetSection(choices, area) +
    specSection() +
    inputSection(items) +
    linkSection(items) +
    `<label>メモ<textarea data-f="note" rows="2">${escapeHtml(draft.note)}</textarea></label>` +
    `<p class="error" id="logError" role="alert"></p>` +
    `</div>` +
    planCopySection() +
    `<div class="log-foot">${draft.id ? '<button type="button" class="text-btn danger" data-act="delete">この実績を削除</button>' : ""}` +
    `${draft.planWorks.length ? '<button type="button" class="text-btn danger" data-act="deletePlan">この計画を消す</button>' : ""}` +
    `${!draft.id && draft.cancellable.length ? '<button type="button" class="text-btn danger" data-act="cancelWork">この作業を取りやめる</button>' : ""}` +
    `<span class="log-spacer"></span><button type="button" class="text-btn" data-act="close">キャンセル</button>` +
    `<button type="button" class="primary-btn" data-act="save">入力する</button></div>`;
  // 品目の一部の畝だけを選んでいるときは、品目のチェックを「一部」の表示にする
  dialog.querySelectorAll('[data-act="group"]').forEach((box) => {
    const group = choices.crops.find((item) => item.key === box.dataset.key);
    const count = group.items.filter((item) => draft.beds.has(item.bed_id)).length;
    box.checked = count === group.items.length;
    box.indeterminate = count > 0 && count < group.items.length;
  });
}

function dialogTitle() {
  if (draft.kind === "plan") {
    return draft.planWorks.length ? "計画を直す" : "計画を入力する";
  }
  return draft.id ? "実績を直す" : "実績を入力する";
}

function dateNote() {
  const span = draft.end_date ? `${formatDay(draft.date)}〜${formatDay(draft.end_date)}（${diffDays(draft.date, draft.end_date) + 1} 日）` : "";
  if (draft.kind === "plan") {
    return span ? `${span}の計画です。` : "1 日の計画です。何日かかるときは、終える予定の日を入れます。";
  }
  return span
    ? `${span}の作業として、1 件の実績にします。作業の途中なら、ここまで進んだ日を入れておき、終わったら直します。`
    : "1 日の作業です。何日かかかったときは、終えた日を入れます。";
}

// 計画を直すとき: 一緒に入力した計画が複数あれば、この畝だけ直すか、全部を直すかを選ぶ
function planScopeSection() {
  if (draft.planWorks.length < 2) {
    return "";
  }
  return (
    `<div class="log-section"><p class="muted">一緒に入力した計画が ${draft.planWorks.length} か所あります。</p>` +
    `<label class="check"><input type="checkbox" data-f="onlyThis"${draft.onlyThis ? " checked" : ""} />${escapeHtml(targetForWork(draft.planWork, draft.date).label)}の計画だけを直す（消す）</label></div>`
  );
}

// 計画を直すとき: 同じ内容の計画を、何日か後ろに足す（繰り返しの計画）
function planCopySection() {
  if (!draft.planWorks.length) {
    return "";
  }
  return (
    `<div class="log-section log-copy"><label class="inline-field">この内容の計画を<input type="number" min="1" step="1" data-f="copyDays" value="${draft.copyDays}" aria-label="何日後" /> 日後に</label>` +
    `<button type="button" class="chip-btn" data-act="copyPlan">コピーして足す</button></div>`
  );
}

function typeSection() {
  // 計画で入れられるのは管理作業だけ（工程の作業の計画は「作業の計画」の表で入れる）
  const usable = draft.kind === "plan" ? allTypes().filter((type) => isManagement(type.code)) : allTypes();
  const quick = QUICK_TYPES.filter((code) => usable.some((type) => type.code === code));
  const others = usable.filter((type) => !quick.includes(type.code));
  const buttons = quick
    .map(
      (code) =>
        `<button type="button" class="chip-btn log-type${draft.work_type === code ? " is-on" : ""}" data-act="type" data-code="${code}" aria-pressed="${draft.work_type === code}">` +
        `${escapeHtml(typeLabel(code))}</button>`
    )
    .join("");
  const select =
    `<select data-f="typeOther" aria-label="ほかの作業の種類"><option value="">ほか…</option>` +
    others.map((type) => `<option value="${type.code}"${draft.work_type === type.code ? " selected" : ""}>${escapeHtml(type.label)}</option>`).join("") +
    `</select>`;
  return `<div class="log-section"><h3>作業の種類</h3><div class="log-types">${buttons}${others.length ? select : ""}</div></div>`;
}

function targetSection(choices, area) {
  const modes =
    `<div class="log-modes" role="group" aria-label="対象の選び方">` +
    `<button type="button" class="chip-btn${draft.mode === "crops" ? " is-on" : ""}" data-act="mode" data-mode="crops">品目で選ぶ</button>` +
    `<button type="button" class="chip-btn${draft.mode === "blocks" ? " is-on" : ""}" data-act="mode" data-mode="blocks">区画で選ぶ</button></div>`;
  let list;
  if (draft.mode === "blocks") {
    list = choices.blocks.length
      ? choices.blocks
          .map(
            (item) =>
              `<label class="check log-row"><input type="checkbox" data-act="block" data-id="${item.block_id}"${draft.blocks.has(item.block_id) ? " checked" : ""} />` +
              `<strong>${escapeHtml(item.label)}</strong><span class="muted">${fmt(item.area_m2)} ㎡</span></label>`
          )
          .join("")
      : '<p class="muted">この日にある区画はありません。</p>';
  } else {
    list = choices.crops.length
      ? choices.crops
          .map((group) => {
            const count = group.items.filter((item) => draft.beds.has(item.bed_id)).length;
            const chips = group.items
              .map(
                (item) =>
                  `<button type="button" class="log-chip${draft.beds.has(item.bed_id) ? " is-on" : ""}" data-act="bed" data-id="${item.bed_id}" aria-pressed="${draft.beds.has(item.bed_id)}">` +
                  `${escapeHtml(item.label.replace(` ${item.crop_name}`, ""))}</button>`
              )
              .join("");
            return (
              `<div class="log-group"><label class="check log-row"><input type="checkbox" data-act="group" data-key="${escapeHtml(group.key)}" />` +
              `<strong>${escapeHtml(group.name)}${group.mulch ? "（マルチ）" : ""}</strong><span class="muted">${count} / ${group.items.length} 本</span></label>` +
              `<div class="log-chips">${chips}</div></div>`
            );
          })
          .join("")
      : '<p class="muted">この日に作付のある畝はありません。区画の作業なら「区画で選ぶ」に切り替えてください。</p>';
  }
  const orphans = draft.orphans.length
    ? `<p class="muted">この日の一覧にない対象（そのまま残します）: ${draft.orphans
        .map((target, i) => `${escapeHtml(target.label)} <button type="button" class="text-btn danger" data-act="orphan" data-i="${i}">外す</button>`)
        .join("、")}</p>`
    : "";
  return (
    `<div class="log-section"><div class="log-section-head"><h3>対象</h3>${modes}</div>${list}${orphans}` +
    `<p class="muted">${draft.mode === "blocks" ? "選んだ区画の面積" : "選んだ畝の面積（畝＋通路）"}: ${fmt(area)} ㎡</p></div>`
  );
}

function specSection() {
  const fields = SPEC_FIELDS[draft.work_type] || [];
  const choices = WORK_ITEMS[draft.work_type];
  // 株の手入れとその他の中身（複数選べる）。その他の「その他」は、何をしたかを文字で入れる
  const chosen = draft.spec.items || [];
  const items = choices
    ? `<div class="log-items">${choices
        .map((item) => `<button type="button" class="chip-btn${chosen.includes(item) ? " is-on" : ""}" data-act="item" data-item="${escapeHtml(item)}" aria-pressed="${chosen.includes(item)}">${escapeHtml(item)}</button>`)
        .join("")}</div>` +
      (draft.work_type === "other" && chosen.includes("その他")
        ? `<label>何をしたか（例: 支柱の撤去）<input type="text" data-spec="other" value="${escapeHtml(draft.spec.other || "")}" /></label>`
        : "")
    : "";
  if (!fields.length && !items) {
    return "";
  }
  const inputs = fields
    .map(([key, label, kind]) => {
      const value = draft.spec[key];
      if (kind === "check") {
        return `<label class="check"><input type="checkbox" data-spec="${key}"${value ? " checked" : ""} />${label}</label>`;
      }
      const type = kind === "text" ? "text" : "number";
      return `<label>${label}<input type="${type}" data-spec="${key}" value="${escapeHtml(value ?? "")}"${type === "number" ? ' step="any" min="0" inputmode="decimal"' : ""} /></label>`;
    })
    .join("");
  return `<div class="log-section"><h3>${choices ? "中身" : draft.kind === "plan" ? "予定の仕様" : "実際の仕様"}</h3>${items}${inputs ? `<div class="form-grid">${inputs}</div>` : ""}</div>`;
}

function inputSection(items) {
  if (!draft.work_type) {
    return "";
  }
  const kind = inputKind(draft.work_type);
  const rows = draft.inputs.map((input, i) => inputRow(input, i)).join("");
  if (kind === "pesticide") {
    return (
      `<div class="log-section"><h3>農薬</h3>${rows}<button type="button" class="text-btn" data-act="addInput">＋ もう 1 剤</button></div>` +
      spraySection(items)
    );
  }
  const title = kind === "fertilizer" ? "肥料" : "資材";
  const add = kind === "fertilizer" ? "＋ 肥料を足す" : "＋ 資材を足す";
  return `<div class="log-section"><h3>${title}</h3>${rows}<button type="button" class="text-btn" data-act="addInput">${add}</button></div>`;
}

function inputRow(input, i) {
  const field = (key, label, value, attrs = "") =>
    `<label>${label}<input data-in="${i}" data-k="${key}" value="${escapeHtml(value ?? "")}" ${attrs} /></label>`;
  const numberAttrs = 'type="number" step="any" min="0" inputmode="decimal"';
  const unitSelect = (units) =>
    `<label>単位<select data-in="${i}" data-k="unit">${units.map((unit) => `<option${input.unit === unit ? " selected" : ""}>${unit}</option>`).join("")}</select></label>`;
  const remove = `<button type="button" class="text-btn danger" data-act="removeInput" data-i="${i}">外す</button>`;
  if (input.kind === "pesticide") {
    // 使用基準の使い方（FAMIC の使用方法）を選んだときは、それを使い方として持つ
    const methodList = input.method && !METHODS.includes(input.method) ? [input.method, ...METHODS] : METHODS;
    const methods = methodList.map((method) => `<option${input.method === method ? " selected" : ""}>${escapeHtml(method)}</option>`).join("");
    const withFamic = famic.famicEnabled();
    // 面積あたりの使用量で使う農薬（粒剤など）は、希釈倍率を入れず、使った製品の量だけを入れる
    const dosed = withFamic && famic.areaDosed(input, sprayGroups());
    return (
      `<div class="log-input">` +
      (withFamic ? field("name", "農薬の名前（名前の一部か登録番号で探す）", input.name, 'type="text" autocomplete="off"') + famic.pickerHtml(input, i, sprayGroups()) : "") +
      `<div class="form-grid">` +
      (withFamic ? "" : field("name", "農薬の名前", input.name, 'type="text"')) +
      `<label>使い方<select data-in="${i}" data-k="method">${methods}</select></label>` +
      (dosed ? "" : field("dilution", "希釈倍率（倍）", input.dilution, numberAttrs)) +
      field("amount", dosed ? "使った製品の量" : "製品の量", input.amount, numberAttrs) +
      unitSelect(["mL", "g", "kg", "L"]) +
      `</div>${dosed ? "" : `<p class="muted" data-hint="${i}"></p>`}${remove}</div>`
    );
  }
  if (input.kind === "fertilizer") {
    const options = state()
      .fertilizers.map((item) => `<option value="${item.id}"${input.fertilizer_id === item.id ? " selected" : ""}>${escapeHtml(item.name)}</option>`)
      .join("");
    return (
      `<div class="log-input"><div class="form-grid">` +
      `<label>肥料<select data-in="${i}" data-k="fertilizer_id"><option value="">（一覧にない肥料）</option>${options}</select></label>` +
      (input.fertilizer_id ? "" : field("name", "肥料の名前", input.name, 'type="text"')) +
      field("amount", "量", input.amount, numberAttrs) +
      unitSelect(["kg", "g", "L"]) +
      `</div>${remove}</div>`
    );
  }
  return (
    `<div class="log-input"><div class="form-grid">` +
    field("name", "資材の名前", input.name, 'type="text"') +
    field("amount", "量", input.amount, numberAttrs) +
    field("unit", "単位", input.unit, 'type="text"') +
    `</div>${remove}</div>`
  );
}

// 防除で散布した液の量。品目のまとまり（区画で選ぶときは区画）ごとに入れる
function spraySection(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.group)) {
      const name = draft.mode === "blocks" ? item.label : sprayGroupName(item.group);
      groups.set(item.group, { name, area: 0 });
    }
    groups.get(item.group).area += item.area_m2 || 0;
  }
  if (!groups.size) {
    return `<div class="log-section"><h3>散布した液の量</h3><p class="muted">対象を選ぶと、品目ごとに入れられます。</p></div>`;
  }
  const rows = [...groups.entries()]
    .map(
      ([key, group]) =>
        `<label class="inline-field log-spray">${escapeHtml(group.name)}<span class="muted">${fmt(group.area)} ㎡</span>` +
        `<input type="number" step="any" min="0" inputmode="decimal" data-spray="${escapeHtml(key)}" value="${draft.spray[key] ?? ""}" aria-label="${escapeHtml(group.name)}の散布液の量（L）" /> L</label>`
    )
    .join("");
  // 農薬の使用基準（FAMIC）: 品目ごとの基準と基準散布量、希釈倍率をどの品目に合わせたか、指摘
  let standards = "";
  if (famic.famicEnabled()) {
    const list = sprayGroups();
    const boxes = famic.standardsHtml(draft.inputs, list, state().logs || [], draft.id);
    const notes = draft.inputs
      .filter((input) => input.kind === "pesticide" && input._dilutionBy)
      .map((input) => `<p class="muted">${escapeHtml(input.name)}の希釈倍率は、いちばん厳しい${escapeHtml(input._dilutionBy)}の基準（${input._dilutionValue} 倍）に合わせました。直せます。</p>`)
      .join("");
    standards =
      (boxes ? `<div class="log-section"><h3>${draft.mode === "blocks" ? "区画" : "品目"}ごとの使用基準</h3>${boxes}${notes}<p class="muted" id="logBaseline"></p>` +
        `<p class="muted"><a href="${famic.NOTICE_URL}" target="_blank" rel="noopener">総使用回数についての注意事項（FAMIC）</a></p></div>` : "");
  }
  // 面積あたりの使用量の農薬（粒剤など）だけなら、散布した液の量は入れない。計画では入れない
  const liquid = draft.kind === "plan"
    ? ""
    : allAreaDosed()
    ? '<div class="log-section"><p class="muted">粒剤など、面積あたりの使用量で使う農薬なので、散布した液の量は入れません。</p></div>'
    : `<div class="log-section"><h3>実際に散布した液の量</h3>${rows}<p class="muted" id="logSprayTotal"></p></div>`;
  return `${standards}${liquid}<ul class="famic-warnings" id="logWarnings" hidden></ul>`;
}

// 登録番号のある農薬がすべて、面積あたりの使用量で使う農薬（粒剤など）か
function allAreaDosed() {
  if (!famic.famicEnabled() || draft.work_type !== "spray") {
    return false;
  }
  const groups = sprayGroups();
  const pesticides = draft.inputs.filter((input) => input.kind === "pesticide" && (input.name || "").trim());
  return pesticides.length > 0 && pesticides.every((input) => famic.areaDosed(input, groups));
}

// 防除の対象の、品目のまとまり（区画で選ぶときは区画）。作物名と使い方を選び、使用基準を照らす単位
function sprayGroups(items = pickedItems()) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.group)) {
      const choice = draft.mode === "crops" ? currentChoices().crops.find((group) => group.key === item.group) : null;
      groups.set(item.group, {
        key: item.group,
        name: draft.mode === "blocks" ? item.label : sprayGroupName(item.group),
        cropName: choice?.name || "",
        area: 0,
        plantingIds: [],
      });
    }
    const group = groups.get(item.group);
    group.area += item.area_m2 || 0;
    if (item.planting_id) {
      group.plantingIds.push(item.planting_id);
    }
  }
  return [...groups.values()];
}

// 作付の収穫が始まる日。収穫の計画の開始日か、収穫の記録のいちばん早い日（早いほう）
function harvestStartOf(plantingId) {
  const planned = data.works.filter((work) => work.planting_id === plantingId && work.work_type === "harvest" && !work.cancelled_on && work.plan_start).map((work) => work.plan_start);
  const recorded = (state().logs || []).filter((log) => log.work_type === "harvest" && log.targets.some((target) => target.planting_id === plantingId)).map((log) => log.date);
  return [...planned, ...recorded].sort()[0] || null;
}

// 選んだ農薬の使用基準を、対象の品目に合わせて読み込み直す（対象を変えたとき）
function refreshUses() {
  if (!famic.famicEnabled() || !draft) {
    return;
  }
  const groups = sprayGroups();
  draft.inputs
    .filter((input) => input.kind === "pesticide" && input.reg_no)
    .forEach((input) => famic.ensureUses(input, groups).catch((error) => showError(`使用基準を読めませんでした: ${error.message}`)));
}

function sprayGroupName(key) {
  const group = currentChoices().crops.find((item) => item.key === key);
  return group ? `${group.name}${group.mulch ? "（マルチ）" : ""}` : key;
}

// 計画とのつながり（実績のときだけ）。つながっている計画と、つなげる候補を、計画の日ごとにまとめて、印で付け外しする
function linkSection(items) {
  const linked = linkedWorks(items);
  const candidates = candidateWorks(items);
  if (!linked.length && !candidates.length) {
    return "";
  }
  const groups = new Map();
  for (const work of [...linked, ...candidates]) {
    const key = `${draft.linked.has(work.id)}|${work.plan_start}|${work.plan_end}`;
    if (!groups.has(key)) {
      groups.set(key, { on: draft.linked.has(work.id), start: work.plan_start, end: work.plan_end, works: [] });
    }
    groups.get(key).works.push(work);
  }
  const rows = [...groups.values()]
    .map((group) => {
      const days = !group.start ? "日付のない" : group.start === group.end ? `${formatDay(group.start)}の` : `${formatDay(group.start)}〜${formatDay(group.end)}の`;
      return (
        `<label class="check"><input type="checkbox" data-act="link" data-ids="${group.works.map((work) => work.id).join(",")}"${group.on ? " checked" : ""} />` +
        `${days}${escapeHtml(typeLabel(draft.work_type))}の計画（${group.works.length} か所）の実績にする</label>`
      );
    })
    .join("");
  const note = candidates.length && !linked.length ? `<p class="muted">この対象には、${escapeHtml(typeLabel(draft.work_type))}の計画があります。計画の実績にするときだけ、印を付けてください。</p>` : "";
  return (
    `<div class="log-section log-link"><h3>計画とのつながり</h3>${note}${rows}` +
    (linked.length ? `<label class="check"><input type="checkbox" data-f="finishes"${draft.finishes ? " checked" : ""} />この日で終わり（計画の作業を完了にする）</label>` : "") +
    "</div>"
  );
}

// 液の量の合計と、希釈倍率から計算した製品の量を、描き直さずに書き換える
function updateTotals() {
  if (!dialog || !draft) {
    return;
  }
  const keys = new Set(pickedItems().map((item) => item.group));
  const total = [...keys].reduce((sum, key) => sum + (num(draft.spray[key]) || 0), 0);
  const totalBox = dialog.querySelector("#logSprayTotal");
  if (totalBox) {
    totalBox.textContent = total > 0 ? `合計 ${fmt(total, 2)} L` : "";
  }
  draft.inputs.forEach((input, i) => {
    const hint = dialog.querySelector(`[data-hint="${i}"]`);
    if (hint) {
      const amount = productAmount(total, num(input.dilution));
      hint.textContent = amount === null ? "" : `液 ${fmt(total, 2)} L と希釈倍率から: 製品 ${fmt(amount, 1)} ${input.unit || "mL"}`;
    }
  });
  if (!famic.famicEnabled() || draft.work_type !== "spray") {
    return;
  }
  const groups = sprayGroups();
  // 基準散布量の合計と、そこから計算した製品の量（散布する前に、作る液の量を決めるため）
  const baseline = famic.baselineLiters(draft.inputs, groups);
  const usage = famic.baselineUsage(draft.inputs, groups);
  const baselineBox = dialog.querySelector("#logBaseline");
  if (baselineBox && usage) {
    const span = usage.min === usage.max ? formatAmount(usage.max, usage.unit) : `${formatAmount(usage.min, usage.unit)}〜${formatAmount(usage.max, usage.unit)}`;
    baselineBox.textContent = `選んだ畝の面積の基準使用量の合計 ${span}`;
  } else if (baselineBox) {
    const first = draft.inputs.find((input) => input.kind === "pesticide" && num(input.dilution));
    const low = baseline && first ? productAmount(baseline.low, num(first.dilution)) : null;
    const high = baseline && first ? productAmount(baseline.high, num(first.dilution)) : null;
    baselineBox.textContent = baseline
      ? `基準散布量の合計 ${fmt(baseline.low, 1)}〜${fmt(baseline.high, 1)} L${low !== null ? ` → ${first.name || "製品"} ${fmt(low, 1)}〜${fmt(high, 1)} ${first.unit || "mL"}` : ""}`
      : "";
  }
  const list = famic.warnings({
    inputs: draft.inputs.map((input) => ({ ...input, dilution: num(input.dilution) })),
    groups,
    date: draft.date,
    sprayOf: (key) => num(draft.spray[key]),
    logs: state().logs || [],
    excludeLogId: draft.id,
    harvestStartOf,
  });
  const box = dialog.querySelector("#logWarnings");
  if (box) {
    box.hidden = !list.length;
    box.innerHTML = list.map((text) => `<li>${escapeHtml(text)}</li>`).join("");
  }
}

function setType(code) {
  if (code === draft.work_type) {
    return;
  }
  const kindChanged = !draft.work_type || inputKind(code) !== inputKind(draft.work_type);
  draft.work_type = code;
  draft.spec = {};
  if (kindChanged) {
    draft.inputs = defaultInputs(code);
  }
  // 区画に付ける作業（ロータリーなど）は、区画で選ぶ
  if (typeScope(code) === "block") {
    draft.mode = "blocks";
  }
  renderDialog();
  updateTotals();
}

// 希釈倍率が空か、前に基準に合わせた値なら、選んだ作物名のうち、いちばん厳しい基準に合わせる
function applySuggestedDilution(input) {
  const suggested = famic.suggestedDilution(input, sprayGroups());
  if (suggested && (num(input.dilution) === null || input._dilutionBy)) {
    Object.assign(input, { dilution: suggested.value, _dilutionBy: suggested.by, _dilutionValue: suggested.value });
  }
}

function onClick(event) {
  const button = event.target.closest("[data-act]");
  if (!button || button.tagName === "INPUT") {
    return;
  }
  const act = button.dataset.act;
  if (act === "close") {
    dialog.close();
  } else if (act === "today") {
    setDate(localToday());
  } else if (act === "todayEnd") {
    draft.end_date = localToday() > draft.date ? localToday() : "";
    renderDialog();
  } else if (act === "oneDay") {
    draft.end_date = "";
    renderDialog();
  } else if (act === "type") {
    setType(button.dataset.code);
  } else if (act === "kind") {
    draft.kind = button.dataset.kind;
    if (draft.kind === "plan" && draft.work_type && !isManagement(draft.work_type)) {
      draft.work_type = "";
      draft.spec = {};
      draft.inputs = [];
    }
    renderDialog();
    updateTotals();
  } else if (act === "item") {
    const items = new Set(draft.spec.items || []);
    items.has(button.dataset.item) ? items.delete(button.dataset.item) : items.add(button.dataset.item);
    draft.spec.items = (WORK_ITEMS[draft.work_type] || []).filter((item) => items.has(item));
    renderDialog();
  } else if (act === "deletePlan") {
    deletePlan();
  } else if (act === "copyPlan") {
    copyPlan();
  } else if (act === "mode") {
    draft.mode = button.dataset.mode;
    renderDialog();
    updateTotals();
    refreshUses();
  } else if (act === "bed") {
    const id = button.dataset.id;
    draft.beds.has(id) ? draft.beds.delete(id) : draft.beds.add(id);
    renderDialog();
    updateTotals();
    refreshUses();
  } else if (act === "famic-pick") {
    const i = Number(button.closest(".log-input").querySelector("[data-results]").dataset.results);
    famic.pick(draft.inputs[i], button.dataset.reg, sprayGroups()).catch((error) => showError(`使用基準を読めませんでした: ${error.message}`));
  } else if (act === "famic-crop") {
    const input = draft.inputs[Number(button.dataset.i)];
    famic.chooseCrop(input, button.dataset.g, button.dataset.crop, sprayGroups());
    applySuggestedDilution(input);
    renderDialog();
    updateTotals();
  } else if (act === "famic-crop-reset") {
    famic.resetCrop(draft.inputs[Number(button.dataset.i)], button.dataset.g);
    renderDialog();
    updateTotals();
  } else if (act === "famic-unpick") {
    famic.unpick(draft.inputs[Number(button.dataset.i)]);
    renderDialog();
    updateTotals();
  } else if (act === "orphan") {
    draft.orphans.splice(Number(button.dataset.i), 1);
    renderDialog();
  } else if (act === "addInput") {
    draft.inputs.push(blankInput(inputKind(draft.work_type)));
    renderDialog();
    updateTotals();
  } else if (act === "removeInput") {
    draft.inputs.splice(Number(button.dataset.i), 1);
    renderDialog();
    updateTotals();
  } else if (act === "save") {
    save();
  } else if (act === "delete") {
    remove();
  } else if (act === "cancelWork") {
    cancelFromDialog();
  }
}

// 「修正」から開いた計画の作業を取りやめる。記録は作らず、計画の作業に取りやめの日と理由（メモ欄）を付ける
async function cancelFromDialog() {
  const ids = draft.cancellable;
  const works = data.works.filter((work) => ids.includes(work.id));
  const ok = await confirmAction({
    message: "この作業を取りやめます。実績は作らず、計画の作業に取りやめの印を付けます。メモ欄の文は、取りやめの理由として残ります。作付の詳細から元に戻せます。",
    name: `${typeLabel(works[0]?.work_type)}（${works.length} 件）`,
    action: "取りやめる",
  });
  if (!ok || !draft) {
    return;
  }
  try {
    await setCancelled(works, localToday(), draft.note.trim());
    dialog.close();
  } catch (error) {
    showError(`取りやめにできませんでした: ${error.message}`);
  }
}

// 計画の作業の取りやめを付け外しする。date が null なら元に戻す。
// 開いているプランの作業なら、画面の中の行も同じに直す（元に戻すの履歴に乗る）
async function setCancelled(works, date, note = "") {
  const rows = works.map((work) => ({ ...work, cancelled_on: date, cancel_note: date ? note : "" }));
  await state().store.upsert("works", rows);
  for (const row of rows) {
    const live = state().works.find((work) => work.id === row.id);
    if (live) {
      Object.assign(live, { cancelled_on: row.cancelled_on, cancel_note: row.cancel_note });
    }
    const loaded = data?.works.find((work) => work.id === row.id);
    if (loaded && loaded !== live) {
      Object.assign(loaded, { cancelled_on: row.cancelled_on, cancel_note: row.cancel_note });
    }
  }
  const plan = activePlan();
  const label = typeLabel(works[0].work_type);
  record({
    kind: date ? "work.cancel" : "work.uncancel",
    target: ["work", works[0].id],
    plan,
    text: date ? `作業「${label}」${works.length} 件を取りやめ${note ? `（${note}）` : ""}` : `作業「${label}」${works.length} 件の取りやめを元に戻した`,
  });
  ctx.setStatus(date ? "作業を取りやめにしました" : "取りやめを元に戻しました");
  ctx.onLogsChanged?.();
}

// 取りやめた計画の作業を、元に戻す（作付の詳細から呼ぶ）
export async function uncancelWork(work) {
  if (!(await loadData())) {
    return;
  }
  const ok = await confirmAction({
    message: `この作業の取りやめを元に戻します。${work.cancel_note ? `取りやめの理由: ${work.cancel_note}` : ""}`,
    name: typeLabel(work.work_type),
    action: "元に戻す",
  });
  if (ok) {
    try {
      await setCancelled([data.works.find((item) => item.id === work.id) || work], null);
    } catch (error) {
      notify(`元に戻せませんでした: ${error.message}`);
    }
  }
}

// 作業をした日を変える。その日にない畝や区画は、選びから外れる。
// 一覧にない対象になっていた畝や区画も、その日の一覧にあれば、選んだ畝（区画）に戻す
function setDate(date) {
  draft.date = date;
  if (draft.end_date && draft.end_date <= date) {
    draft.end_date = "";
  }
  const choices = currentChoices();
  const beds = new Set(choices.crops.flatMap((group) => group.items.map((item) => item.bed_id)));
  const blocks = new Set(choices.blocks.map((item) => item.block_id));
  draft.beds = new Set([...draft.beds].filter((id) => beds.has(id)));
  draft.blocks = new Set([...draft.blocks].filter((id) => blocks.has(id)));
  draft.orphans = draft.orphans.filter((target) => {
    if (target.bed_id && beds.has(target.bed_id)) {
      draft.beds.add(target.bed_id);
      return false;
    }
    if (!target.bed_id && target.block_id && blocks.has(target.block_id)) {
      draft.blocks.add(target.block_id);
      return false;
    }
    return true;
  });
  renderDialog();
  updateTotals();
}

function onChange(event) {
  const el = event.target;
  if (el.dataset.f === "date") {
    if (el.value) {
      setDate(el.value);
    }
  } else if (el.dataset.act === "link") {
    el.dataset.ids.split(",").forEach((id) => (el.checked ? draft.linked.add(id) : draft.linked.delete(id)));
    if (el.checked) {
      draft.finishes = true;
    }
    renderDialog();
  } else if (el.dataset.f === "onlyThis") {
    draft.onlyThis = el.checked;
    // この畝だけを直すときは、対象をその畝に戻す
    if (el.checked) {
      const target = targetForWork(draft.planWork, draft.date);
      draft.beds = new Set(target.bed_id ? [target.bed_id] : []);
      draft.blocks = new Set(!target.bed_id && target.block_id ? [target.block_id] : []);
    }
    renderDialog();
  } else if (el.dataset.f === "copyDays") {
    draft.copyDays = Math.max(1, Math.round(num(el.value) || COPY_DAYS));
  } else if (el.dataset.f === "end_date") {
    draft.end_date = el.value && el.value > draft.date ? el.value : "";
    renderDialog();
  } else if (el.dataset.f === "typeOther") {
    if (el.value) {
      setType(el.value);
    }
  } else if (el.dataset.f === "finishes") {
    draft.finishes = el.checked;
  } else if (el.dataset.act === "group") {
    const group = currentChoices().crops.find((item) => item.key === el.dataset.key);
    group.items.forEach((item) => (el.checked ? draft.beds.add(item.bed_id) : draft.beds.delete(item.bed_id)));
    renderDialog();
    updateTotals();
    refreshUses();
  } else if (el.dataset.act === "block") {
    el.checked ? draft.blocks.add(el.dataset.id) : draft.blocks.delete(el.dataset.id);
    renderDialog();
    updateTotals();
  } else if (el.dataset.spec && el.type === "checkbox") {
    draft.spec[el.dataset.spec] = el.checked;
  } else if (el.dataset.in !== undefined && el.dataset.k === "use_key") {
    // まとまりの使い方・適用病害虫を選んだ: 使い方を使用基準のものにし、希釈倍率をいちばん厳しい基準に合わせる
    const input = draft.inputs[Number(el.dataset.in)];
    famic.chooseUse(input, el.dataset.g, el.value, sprayGroups());
    applySuggestedDilution(input);
    renderDialog();
    updateTotals();
  } else if (el.dataset.in !== undefined && el.tagName === "SELECT") {
    const input = draft.inputs[Number(el.dataset.in)];
    input[el.dataset.k] = el.value || null;
    if (el.dataset.k === "fertilizer_id") {
      // 一覧の肥料を選んだら、名前の欄は要らない
      renderDialog();
    }
    updateTotals();
  }
}

function onInput(event) {
  const el = event.target;
  if (el.dataset.famicFilter !== undefined) {
    // 作物名の絞り込み: 一覧だけを描き直す（入れている文字を消さないため）
    const i = Number(el.dataset.famicFilter);
    const input = draft.inputs[i];
    input._filters[el.dataset.g] = el.value;
    const group = sprayGroups().find((item) => item.key === el.dataset.g);
    const list = el.closest(".famic-choice")?.querySelector(".famic-crop-list");
    if (group && list) {
      list.innerHTML = famic.cropListHtml(input, i, group);
    }
    return;
  }
  if (el.dataset.f === "note") {
    draft.note = el.value;
  } else if (el.dataset.spec && el.type !== "checkbox") {
    draft.spec[el.dataset.spec] = el.value;
  } else if (el.dataset.in !== undefined && el.tagName === "INPUT") {
    const input = draft.inputs[Number(el.dataset.in)];
    input[el.dataset.k] = el.type === "number" ? num(el.value) : el.value;
    if (el.dataset.k === "dilution") {
      input._dilutionBy = null; // 手で直した倍率は、品目の基準に合わせ直さない
    }
    // 農薬の名前を打つと、農薬登録情報から探す。選んだ農薬の名前を書き換えたら、選び直しにする
    if (el.dataset.k === "name" && input.kind === "pesticide" && famic.famicEnabled()) {
      if (input.reg_no && input._product && el.value !== input._product.name) {
        famic.unpick(input);
      }
      famic.search(input, el.value, el.closest(".log-input").querySelector("[data-results]"));
    }
    updateTotals();
  } else if (el.dataset.spray !== undefined) {
    draft.spray[el.dataset.spray] = num(el.value);
    updateTotals();
  }
}

function showError(text) {
  dialog.querySelector("#logError").textContent = text;
}

// 窓の内容から、保存する記録・対象・資材を作る
function buildLog() {
  const items = pickedItems();
  const kind = inputKind(draft.work_type);
  const groupItems = new Map();
  items.forEach((item) => groupItems.set(item.group, [...(groupItems.get(item.group) || []), item]));
  const sprayOf = new Map();
  if (kind === "pesticide") {
    for (const [key, members] of groupItems) {
      splitByArea(members, num(draft.spray[key])).forEach((liters, i) => sprayOf.set(members[i], liters));
    }
  }
  const targets = [
    ...items.map((item) => {
      const work = draft.kind === "actual" ? data.works.find((row) => draft.linked.has(row.id) && row.work_type === draft.work_type && ownsWork(item, row)) : null;
      return {
        planting_id: item.planting_id || null,
        bed_id: item.bed_id || null,
        block_id: item.block_id || null,
        work_id: work?.id || null,
        label: item.label,
        crop_name: item.crop_name || "",
        area_m2: round(item.area_m2 ?? null, 2),
        spray_l: round(sprayOf.get(item) ?? null, 3),
      };
    }),
    ...draft.orphans,
  ];
  const spec = {};
  for (const [key, , type] of SPEC_FIELDS[draft.work_type] || []) {
    const value = draft.spec[key];
    if (type === "check") {
      if (value) {
        spec[key] = true;
      }
    } else if (type === "text") {
      if (String(value ?? "").trim()) {
        spec[key] = String(value).trim();
      }
    } else if (num(value) !== null) {
      spec[key] = num(value);
    }
  }
  // 株の手入れとその他の中身。その他の「その他」は、何をしたかの文字も
  if (WORK_ITEMS[draft.work_type] && draft.spec.items?.length) {
    spec.items = draft.spec.items.filter((item) => WORK_ITEMS[draft.work_type].includes(item));
    if (spec.items.includes("その他") && String(draft.spec.other || "").trim()) {
      spec.other = String(draft.spec.other).trim();
    }
  }
  const groups = kind === "pesticide" && famic.famicEnabled() ? sprayGroups(items) : [];
  // 粒剤などは、希釈倍率と散布した液の量を持たない
  const dosed = (input) => famic.famicEnabled() && famic.areaDosed(input, groups);
  if (kind === "pesticide" && allAreaDosed()) {
    targets.forEach((target) => {
      target.spray_l = null;
    });
  }
  const inputs = draft.inputs
    .filter((input) => (input.name || "").trim() || input.fertilizer_id || input.amount !== null || input.dilution !== null)
    .map((input, seq) => {
      const fertilizer = state().fertilizers.find((item) => item.id === input.fertilizer_id);
      return {
        seq,
        kind: input.kind,
        reg_no: input.reg_no || null,
        // 記録した時点の使用基準を写して残す（あとで登録が変わったり失効したりしても、そのときの基準で読める）
        standard: input.kind === "pesticide" && input.reg_no && famic.famicEnabled() ? famic.snapshot(input, groups) : input.standard || null,
        fertilizer_id: fertilizer?.id || null,
        name: fertilizer ? fertilizer.name : (input.name || "").trim(),
        method: input.method || "",
        dilution: dosed(input) ? null : num(input.dilution),
        amount: num(input.amount),
        unit: input.unit || "",
      };
    });
  const linked = targets.some((target) => target.work_id);
  return {
    log: {
      ...(draft.id ? { id: draft.id } : {}),
      field_id: state().field.id,
      date: draft.date,
      end_date: draft.end_date && draft.end_date > draft.date ? draft.end_date : null,
      work_type: draft.work_type,
      finishes: linked && draft.finishes,
      spec,
      note: draft.note.trim(),
    },
    targets,
    inputs,
  };
}

async function save() {
  if (!draft.date) {
    showError(draft.kind === "plan" ? "予定の日を入れてください。" : "作業をした日を入れてください。");
    return;
  }
  if (!draft.work_type) {
    showError("作業の種類を選んでください。");
    return;
  }
  if (draft.kind === "plan") {
    savePlan();
    return;
  }
  const { log, targets, inputs } = buildLog();
  if (!targets.length) {
    showError("対象の畝か区画を選んでください。");
    return;
  }
  // 登録番号のある農薬は、まとまりごとに作物名と使い方を選ばないと保存しない（当てはまる作物名がなければ使えない農薬）
  if (draft.work_type === "spray" && famic.famicEnabled()) {
    const missing = famic.missingChoices(draft.inputs, sprayGroups());
    if (missing.length) {
      const first = missing[0];
      showError(
        first.input._uses
          ? `${first.input.name}: ${first.group.name}の作物名と使い方・適用病害虫を選んでください。登録されている作物名に当てはまるものがなければ、この農薬は使えません。`
          : `${first.input.name}: 使用基準を読み込んでいます。少し待ってから保存してください。`
      );
      return;
    }
  }
  const button = dialog.querySelector('[data-act="save"]');
  button.disabled = true;
  ctx.setStatus("実績を入力しています…");
  try {
    await state().store.saveLog({ ...log, targets, inputs });
    await reload();
    dialog.close();
    ctx.setStatus("実績を入力しました");
  } catch (error) {
    button.disabled = false;
    showError(`入力できませんでした: ${error.message}`);
    ctx.setStatus("");
  }
}

// ---- 管理作業の計画（5.2） ----

// 計画の作業を付ける先（作付か区画）
const workOwner = (item) => (item.bed_id ? { planting_id: item.planting_id, block_id: null } : { block_id: item.block_id, planting_id: null });

// 窓の内容から、計画の作業の値（日付、メモ、予定の中身）を作る。shift 日だけ後ろにずらせる（コピー）
function planFields(shift = 0) {
  const { log, inputs } = buildLog();
  const end = log.end_date || draft.date;
  return {
    work_type: draft.work_type,
    plan_start: addDays(draft.date, shift),
    plan_end: addDays(end, shift),
    note: log.note,
    detail: { spec: log.spec, inputs },
  };
}

// 選んだ対象ごとに、計画の作業を 1 件ずつ足す。同じ時に足した作業には、同じまとまりの印を付ける
async function addPlanWorks(items, fields, batchId) {
  const plan = activePlan();
  const rows = items.map((item) => {
    const owner = workOwner(item);
    const own = data.works.filter((work) => (owner.planting_id ? work.planting_id === owner.planting_id : work.block_id === owner.block_id));
    return {
      id: crypto.randomUUID(),
      plan_id: plan.id,
      ...owner,
      seq: Math.max(0, ...own.map((work) => work.seq || 0)) + 1,
      ...fields,
      batch_id: batchId,
      cancelled_on: null,
      cancel_note: "",
    };
  });
  await state().store.upsert("works", rows);
  data.works.push(...rows);
  return rows;
}

// 入力した計画を保存する。新しく入れるときは、選んだ対象ごとに 1 件ずつ作る。直すときは、一緒に入力した全部か、この畝だけを直す
async function savePlan() {
  if (!isManagement(draft.work_type)) {
    showError("計画で入力できるのは、管理作業（防除、追肥、除草、灌水、株の手入れ、その他）です。");
    return;
  }
  const items = pickedItems();
  if (!items.length) {
    showError("対象の畝か区画を選んでください。");
    return;
  }
  const fields = planFields();
  const name = workName(typeLabel(draft.work_type), fields.detail.spec);
  const days = fields.plan_start === fields.plan_end ? formatDay(fields.plan_start) : `${formatDay(fields.plan_start)}〜${formatDay(fields.plan_end)}`;
  const button = dialog.querySelector('[data-act="save"]');
  button.disabled = true;
  try {
    if (!draft.planWorks.length) {
      await addPlanWorks(items, fields, crypto.randomUUID());
      record({ kind: "work.plan", target: ["work", null], plan: activePlan(), text: `${name}の計画を ${items.length} か所に入力（${days}）` });
    } else if (draft.onlyThis) {
      // この畝だけ: 一緒に入力したまとまりから外して、別の計画にする
      const row = { ...draft.planWork, ...fields, batch_id: draft.planWorks.length > 1 ? crypto.randomUUID() : draft.planWork.batch_id };
      await state().store.upsert("works", [row]);
      Object.assign(data.works.find((work) => work.id === row.id), row);
      record({ kind: "work.plan", target: ["work", row.id], plan: activePlan(), text: `${name}の計画を直した（${targetForWork(row, draft.date).label}、${days}）` });
    } else {
      // 一緒に入力した全部: 残す対象は直し、外した対象の計画は消し、足した対象には計画を足す
      const batchId = draft.planWork.batch_id || crypto.randomUUID();
      const keep = draft.planWorks.filter((work) => items.some((item) => ownsWork(item, work)));
      const drop = draft.planWorks.filter((work) => !keep.includes(work));
      const add = items.filter((item) => !keep.some((work) => ownsWork(item, work)));
      const rows = keep.map((work) => ({ ...work, ...fields, batch_id: batchId }));
      await state().store.upsert("works", rows);
      rows.forEach((row) => Object.assign(data.works.find((work) => work.id === row.id), row));
      await removePlanWorks(drop);
      if (add.length) {
        await addPlanWorks(add, fields, batchId);
      }
      record({ kind: "work.plan", target: ["work", draft.planWork.id], plan: activePlan(), text: `${name}の計画を直した（${keep.length + add.length} か所、${days}）` });
    }
    dialog.close();
    ctx.setStatus("計画を入力しました");
    ctx.onLogsChanged?.();
  } catch (error) {
    button.disabled = false;
    showError(`計画を入力できませんでした: ${error.message}`);
  }
}

async function removePlanWorks(works) {
  if (!works.length) {
    return;
  }
  await state().store.remove("works", works.map((work) => work.id));
  for (const work of works) {
    const i = data.works.findIndex((row) => row.id === work.id);
    if (i >= 0) {
      data.works.splice(i, 1);
    }
  }
}

// 計画を消す（この畝だけ、または一緒に入力した全部）。実績がつながっていれば、実績は残り、計画にない実績になる
async function deletePlan() {
  const scope = draft.onlyThis ? [draft.planWork] : draft.planWorks;
  const linked = (state().logs || []).filter((log) => log.targets.some((target) => scope.some((work) => work.id === target.work_id)));
  const ok = await confirmDelete(
    `この計画を消します。${linked.length ? `つながっている実績 ${linked.length} 件は残り、計画にない実績になります。` : ""}`,
    `${workName(typeLabel(draft.planWork.work_type), draft.planWork.detail?.spec)}の計画（${scope.length} か所）`
  );
  if (!ok || !draft) {
    return;
  }
  try {
    await removePlanWorks(scope);
    record({ kind: "work.plan", target: ["work", draft.planWork.id], plan: activePlan(), text: `${typeLabel(draft.planWork.work_type)}の計画を ${scope.length} か所消した` });
    dialog.close();
    ctx.setStatus("計画を消しました");
    ctx.onLogsChanged?.();
  } catch (error) {
    showError(`計画を消せませんでした: ${error.message}`);
  }
}

// 窓の内容の計画を、何日か後ろに足す（繰り返しの計画）。足した計画は、新しいまとまりになる
async function copyPlan() {
  const items = draft.onlyThis ? pickedItems().filter((item) => ownsWork(item, draft.planWork)) : pickedItems();
  if (!items.length || !draft.work_type) {
    showError("対象の畝か区画を選んでください。");
    return;
  }
  const fields = planFields(draft.copyDays);
  try {
    await addPlanWorks(items, fields, crypto.randomUUID());
    record({
      kind: "work.plan",
      target: ["work", null],
      plan: activePlan(),
      text: `${workName(typeLabel(draft.work_type), fields.detail.spec)}の計画を ${draft.copyDays} 日後（${formatDay(fields.plan_start)}）に ${items.length} か所コピー`,
    });
    dialog.close();
    ctx.setStatus(`${draft.copyDays} 日後に計画を足しました`);
    ctx.onLogsChanged?.();
  } catch (error) {
    showError(`計画を足せませんでした: ${error.message}`);
  }
}

// 管理作業の計画を、窓で開いて直す（工程表の帯、今週やることから）
export function openPlanEditor(work) {
  return openLogEditor(null, { planWork: work });
}

// 管理作業の計画を、何日か後ろ（前）にコピーする（工程表で Ctrl を押しながら帯を動かしたとき）。コピーした計画は、新しいまとまりになる
export async function copyPlanWorks(works, days) {
  if (!(await loadData()) || !days) {
    return false;
  }
  const source = works.map((work) => data.works.find((row) => row.id === work.id)).filter(Boolean);
  if (!source.length) {
    notify("管理作業の計画は、実際に使うプランのものだけをコピーできます。");
    return false;
  }
  const batchId = crypto.randomUUID();
  const rows = source.map((row) => ({
    ...row,
    id: crypto.randomUUID(),
    plan_start: row.plan_start && addDays(row.plan_start, days),
    plan_end: row.plan_end && addDays(row.plan_end, days),
    batch_id: batchId,
    cancelled_on: null,
    cancel_note: "",
  }));
  try {
    await state().store.upsert("works", rows);
    data.works.push(...rows);
    const label = typeLabel(source[0].work_type);
    const way = days > 0 ? `${days} 日後` : `${-days} 日前`;
    record({ kind: "work.plan", target: ["work", null], plan: activePlan(), text: `${label}の計画を ${way}に ${rows.length} か所コピー` });
    ctx.setStatus(`${label}の計画を ${way}にコピーしました`);
    ctx.onLogsChanged?.();
    return true;
  } catch (error) {
    notify(`計画をコピーできませんでした: ${error.message}`);
    return false;
  }
}

async function remove() {
  const log = (state().logs || []).find((item) => item.id === draft.id);
  if (!log) {
    return;
  }
  const ok = await confirmDelete("この実績を削除します。", `${logDays(log)} ${typeLabel(log.work_type)}（${targetSummary(log.targets)}）`);
  if (!ok) {
    return;
  }
  try {
    await state().store.deleteLog(log.id);
    await reload();
    dialog.close();
    ctx.setStatus("実績を削除しました");
  } catch (error) {
    showError(`削除できませんでした: ${error.message}`);
  }
}

async function reload() {
  state().logs = await state().store.loadLogs(state().field.id);
  renderLogs();
  ctx.onLogsChanged?.();
}

export function initLogs(context) {
  ctx = context;
  famic.initPesticide({
    state: context.state,
    draftId: () => draft?.id || null,
    // 使用基準を読み終えたら、窓を描き直す（入れかけの文字は draft に入っている）
    refresh: () => {
      if (draft && dialog?.open) {
        renderDialog();
        updateTotals();
      }
    },
  });
  $("logToggle").addEventListener("click", () => {
    showAll = !showAll;
    renderLogs();
  });
  $("logList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-log]");
    const log = row && (state().logs || []).find((item) => item.id === row.dataset.log);
    if (log) {
      openLogEditor(log);
    }
  });
  $("logAddBtn").addEventListener("click", () => openLogEditor());
  renderLogs();
}

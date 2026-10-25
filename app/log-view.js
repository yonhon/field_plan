// 作業の記録の画面。日程の画面の「最近の記録」の欄と「記録する」のボタン、記録を入れる窓。
// 記録は、実際に使うプランの区画・畝・作付・作業につなぐ。計画はスマホでは直せないが、記録はスマホでも入れられる。
import { WORK_COLORS, localToday } from "./schedule.js";
import { confirmDelete, notify } from "./dialog.js";
import { matchWork, productAmount, splitByArea, targetChoices, targetSummary, workActuals } from "./logs.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const RECENT = 5; // 「最近の記録」に出す件数
const QUICK_TYPES = ["water", "spray", "weed", "plant", "topdress"]; // 大きめのボタンで並べる種類
// 作業の種類ごとの仕様の欄。[spec のキー, 見出し, 種類（省くと数）]
const SPEC_FIELDS = {
  plant: [
    ["plant_gap_cm", "株間（cm）"],
    ["row_gap_cm", "条間（cm）"],
    ["row_count", "条数"],
    ["seeds", "1 か所の粒数"],
    ["depth_cm", "植える深さ（cm）"],
    ["staggered", "千鳥", "check"],
  ],
  nursery_sow: [
    ["tray", "トレイ（例: 128 穴）", "text"],
    ["trays", "枚数"],
    ["seeds", "1 穴の粒数"],
  ],
  ridge: [
    ["bed_width_cm", "実畦の幅（cm）"],
    ["aisle_width_cm", "通路の幅（cm）"],
    ["height_cm", "畝の高さ（cm）"],
  ],
  mulch: [
    ["mulch", "マルチの種類", "text"],
    ["width_cm", "幅（cm）"],
  ],
  harvest: [["harvest_kg", "収穫量（kg）"]],
};
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

const activePlan = () => state().plans.find((plan) => plan.id === state().field.active_plan_id) || null;

// ---- 最近の記録 ----

function inputText(input) {
  if (input.kind === "pesticide") {
    return [input.name || "農薬", input.dilution ? `${input.dilution} 倍` : "", input.method].filter(Boolean).join(" ");
  }
  return [input.name, input.amount !== null && input.amount !== undefined ? `${input.amount} ${input.unit}` : ""].filter(Boolean).join(" ");
}

export function renderLogs() {
  if (!ctx) {
    return;
  }
  const logs = state().logs || [];
  const shown = showAll ? logs : logs.slice(0, RECENT);
  $("logTitle").textContent = showAll ? `記録（${logs.length} 件）` : "最近の記録";
  $("logToggle").hidden = logs.length <= RECENT;
  $("logToggle").textContent = showAll ? "最近だけ" : "すべて";
  const active = activePlan();
  const note = !active
    ? "記録を入れるには、圃場図の「プラン」の欄で、実際に使うプランを決めてください。"
    : active.id !== state().plan.id
      ? `記録は、実際に使うプラン「${active.name}」の畝につなぎます（いま開いているのはプラン「${state().plan.name}」です）。`
      : "";
  $("logNote").textContent = note;
  $("logNote").hidden = !note;
  $("logList").innerHTML = shown.length
    ? shown
        .map((log) => {
          const details = [targetSummary(log.targets || []), ...(log.inputs || []).map(inputText), log.note].filter(Boolean).join(" / ");
          return (
            `<li data-log="${log.id}"><span class="week-date">${formatDay(log.date)}</span>` +
            `<span class="week-work"><span class="swatch" style="background:${WORK_COLORS[log.work_type] || "#888"}"></span>` +
            `${escapeHtml(typeLabel(log.work_type))}${log.finishes ? '<span class="log-done">完了</span>' : ""}</span>` +
            `<span class="muted">${escapeHtml(details)}</span></li>`
          );
        })
        .join("")
    : '<li class="muted">まだ記録はありません</li>';
}

// ---- 記録を入れる窓 ----

// 窓を開く。log を渡すとその記録を直す
export async function openLogEditor(log = null) {
  if (!state().field.active_plan_id) {
    notify("記録を入れるには、先に圃場図の「プラン」の欄で、実際に使うプランを決めてください。");
    return;
  }
  try {
    data = await ctx.activePlanData();
  } catch (error) {
    notify(`実際に使うプランを読み込めませんでした: ${error.message}`);
    return;
  }
  const type = log?.work_type || "";
  draft = {
    id: log?.id || null,
    date: log?.date || localToday(),
    work_type: type,
    finishes: log ? log.finishes : true,
    spec: { ...(log?.spec || {}) },
    note: log?.note || "",
    mode: log ? (log.targets.some((target) => target.bed_id || target.planting_id) || !log.targets.length ? "crops" : "blocks") : "crops",
    beds: new Set(),
    blocks: new Set(),
    orphans: [], // いまのプランにない対象（畝や区画を消した記録）。そのまま残す
    spray: {}, // 品目のまとまり（または区画）ごとの散布液の量（L）
    inputs: (log?.inputs || []).map((input) => ({ ...input })),
  };
  if (log) {
    const choices = currentChoices();
    const bedIds = new Set(choices.crops.flatMap((group) => group.items.map((item) => item.bed_id)));
    const blockIds = new Set(choices.blocks.map((item) => item.block_id));
    for (const target of log.targets) {
      if (target.bed_id && bedIds.has(target.bed_id)) {
        draft.beds.add(target.bed_id);
      } else if (!target.bed_id && target.block_id && blockIds.has(target.block_id)) {
        draft.blocks.add(target.block_id);
      } else {
        draft.orphans.push(target);
      }
    }
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
}

function defaultInputs(type) {
  const kind = inputKind(type);
  return kind === "material" ? [] : [blankInput(kind)];
}

function blankInput(kind) {
  return { kind, name: "", method: kind === "pesticide" ? METHODS[0] : "", dilution: null, amount: null, unit: kind === "pesticide" ? "mL" : "kg", fertilizer_id: null };
}

function currentChoices() {
  return targetChoices(data, draft.date || localToday());
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

function linkedWorks(items) {
  if (!draft.work_type) {
    return [];
  }
  const actuals = otherActuals();
  return items
    .map((item) => matchWork(data.works, item.bed_id ? { planting_id: item.planting_id } : { block_id: item.block_id }, draft.work_type, actuals))
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
    `<div class="log-head"><h2 id="logDialogTitle">${draft.id ? "記録を直す" : "記録を入れる"}</h2>` +
    `<button type="button" class="text-btn" data-act="close" aria-label="閉じる">閉じる</button></div>` +
    `<div class="log-body">` +
    `<p class="muted">プラン「${escapeHtml(plan?.name || "")}」の畝につなぎます。</p>` +
    `<label>作業をした日<input type="date" data-f="date" value="${draft.date}" required /></label>` +
    typeSection() +
    targetSection(choices, area) +
    specSection() +
    inputSection(items) +
    linkSection(items) +
    `<label>メモ<textarea data-f="note" rows="2">${escapeHtml(draft.note)}</textarea></label>` +
    `<p class="error" id="logError" role="alert"></p>` +
    `</div>` +
    `<div class="log-foot">${draft.id ? '<button type="button" class="text-btn danger" data-act="delete">この記録を削除</button>' : ""}` +
    `<span class="log-spacer"></span><button type="button" class="text-btn" data-act="close">キャンセル</button>` +
    `<button type="button" class="primary-btn" data-act="save">記録する</button></div>`;
  // 品目の一部の畝だけを選んでいるときは、品目のチェックを「一部」の表示にする
  dialog.querySelectorAll('[data-act="group"]').forEach((box) => {
    const group = choices.crops.find((item) => item.key === box.dataset.key);
    const count = group.items.filter((item) => draft.beds.has(item.bed_id)).length;
    box.checked = count === group.items.length;
    box.indeterminate = count > 0 && count < group.items.length;
  });
}

function typeSection() {
  const quick = QUICK_TYPES.filter((code) => allTypes().some((type) => type.code === code));
  const others = allTypes().filter((type) => !quick.includes(type.code));
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
  return `<div class="log-section"><h3>作業の種類</h3><div class="log-types">${buttons}${select}</div></div>`;
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
    ? `<p class="muted">いまのプランにない対象（そのまま残します）: ${draft.orphans
        .map((target, i) => `${escapeHtml(target.label)} <button type="button" class="text-btn danger" data-act="orphan" data-i="${i}">外す</button>`)
        .join("、")}</p>`
    : "";
  return (
    `<div class="log-section"><div class="log-section-head"><h3>対象</h3>${modes}</div>${list}${orphans}` +
    `<p class="muted">${draft.mode === "blocks" ? "選んだ区画の面積" : "選んだ畝の面積（畝＋通路）"}: ${fmt(area)} ㎡</p></div>`
  );
}

function specSection() {
  const fields = SPEC_FIELDS[draft.work_type];
  if (!fields) {
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
  return `<div class="log-section"><h3>実際の仕様</h3><div class="form-grid">${inputs}</div></div>`;
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
    const methods = METHODS.map((method) => `<option${input.method === method ? " selected" : ""}>${method}</option>`).join("");
    return (
      `<div class="log-input"><div class="form-grid">` +
      field("name", "農薬の名前", input.name, 'type="text"') +
      `<label>使い方<select data-in="${i}" data-k="method">${methods}</select></label>` +
      field("dilution", "希釈倍率（倍）", input.dilution, numberAttrs) +
      field("amount", "製品の量", input.amount, numberAttrs) +
      unitSelect(["mL", "g"]) +
      `</div><p class="muted" data-hint="${i}"></p>${remove}</div>`
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
  return `<div class="log-section"><h3>実際に散布した液の量</h3>${rows}<p class="muted" id="logSprayTotal"></p></div>`;
}

function sprayGroupName(key) {
  const group = currentChoices().crops.find((item) => item.key === key);
  return group ? `${group.name}${group.mulch ? "（マルチ）" : ""}` : key;
}

function linkSection(items) {
  const works = linkedWorks(items);
  if (!works.length) {
    return "";
  }
  return (
    `<div class="log-section log-link"><p>計画の作業 ${works.length} 件（${escapeHtml(typeLabel(draft.work_type))}）につなぎます。</p>` +
    `<label class="check"><input type="checkbox" data-f="finishes"${draft.finishes ? " checked" : ""} />この日で終わり（計画の作業を完了にする）</label></div>`
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

function onClick(event) {
  const button = event.target.closest("[data-act]");
  if (!button || button.tagName === "INPUT") {
    return;
  }
  const act = button.dataset.act;
  if (act === "close") {
    dialog.close();
  } else if (act === "type") {
    setType(button.dataset.code);
  } else if (act === "mode") {
    draft.mode = button.dataset.mode;
    renderDialog();
    updateTotals();
  } else if (act === "bed") {
    const id = button.dataset.id;
    draft.beds.has(id) ? draft.beds.delete(id) : draft.beds.add(id);
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
  }
}

function onChange(event) {
  const el = event.target;
  if (el.dataset.f === "date") {
    if (el.value) {
      draft.date = el.value;
      // その日にない畝や区画は、選びから外れる
      const choices = currentChoices();
      const beds = new Set(choices.crops.flatMap((group) => group.items.map((item) => item.bed_id)));
      const blocks = new Set(choices.blocks.map((item) => item.block_id));
      draft.beds = new Set([...draft.beds].filter((id) => beds.has(id)));
      draft.blocks = new Set([...draft.blocks].filter((id) => blocks.has(id)));
      renderDialog();
      updateTotals();
    }
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
  } else if (el.dataset.act === "block") {
    el.checked ? draft.blocks.add(el.dataset.id) : draft.blocks.delete(el.dataset.id);
    renderDialog();
    updateTotals();
  } else if (el.dataset.spec && el.type === "checkbox") {
    draft.spec[el.dataset.spec] = el.checked;
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
  if (el.dataset.f === "note") {
    draft.note = el.value;
  } else if (el.dataset.spec && el.type !== "checkbox") {
    draft.spec[el.dataset.spec] = el.value;
  } else if (el.dataset.in !== undefined && el.tagName === "INPUT") {
    const input = draft.inputs[Number(el.dataset.in)];
    input[el.dataset.k] = el.type === "number" ? num(el.value) : el.value;
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
  const actuals = otherActuals();
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
      const work = matchWork(data.works, item.bed_id ? { planting_id: item.planting_id } : { block_id: item.block_id }, draft.work_type, actuals);
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
  const inputs = draft.inputs
    .filter((input) => (input.name || "").trim() || input.fertilizer_id || input.amount !== null || input.dilution !== null)
    .map((input, seq) => {
      const fertilizer = state().fertilizers.find((item) => item.id === input.fertilizer_id);
      return {
        seq,
        kind: input.kind,
        reg_no: input.reg_no || null,
        standard: input.standard || null,
        fertilizer_id: fertilizer?.id || null,
        name: fertilizer ? fertilizer.name : (input.name || "").trim(),
        method: input.method || "",
        dilution: num(input.dilution),
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
    showError("作業をした日を入れてください。");
    return;
  }
  if (!draft.work_type) {
    showError("作業の種類を選んでください。");
    return;
  }
  const { log, targets, inputs } = buildLog();
  if (!targets.length) {
    showError("対象の畝か区画を選んでください。");
    return;
  }
  const button = dialog.querySelector('[data-act="save"]');
  button.disabled = true;
  ctx.setStatus("記録を保存中…");
  try {
    await state().store.saveLog({ ...log, targets, inputs });
    await reload();
    dialog.close();
    ctx.setStatus("記録を保存しました");
  } catch (error) {
    button.disabled = false;
    showError(`保存できませんでした: ${error.message}`);
    ctx.setStatus("");
  }
}

async function remove() {
  const log = (state().logs || []).find((item) => item.id === draft.id);
  if (!log) {
    return;
  }
  const ok = await confirmDelete("この記録を削除します。", `${formatDay(log.date)} ${typeLabel(log.work_type)}（${targetSummary(log.targets)}）`);
  if (!ok) {
    return;
  }
  try {
    await state().store.deleteLog(log.id);
    await reload();
    dialog.close();
    ctx.setStatus("記録を削除しました");
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

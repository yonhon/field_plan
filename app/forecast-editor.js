// 入力の窓の「収量と単価」のタブ。作付ごとの収量と単価の見込みを、見直すたびに 1 件ずつ記録する（field.planting_forecasts）。
// 上に「いま使っている値」（項目ごとに、いちばん新しい記録の値。なければ品目の値。revenue.js の effectiveForecast）、
// その下に新しく記録する欄、いちばん下に履歴（新しい順。直す、削除）を出す。
// 記録する・直す・削除は、押したときにすぐ保存する（工程の計画のように、窓の「保存する」でまとめて送らない）。どれも「元に戻す」で戻せる
import { confirmDelete, notify } from "./dialog.js";
import { record } from "./journal.js";
import { escapeHtml } from "./html.js";
import { effectiveForecast } from "./revenue.js";
import { localToday } from "./schedule.js";

let ctx = null; // { state, persist, sendPendingSaves, refresh }
// 書きかけ。plantingId は相手の作付。form は新しく記録する欄、editing は直している記録の ID、edit はその書きかけ
let fd = null;

const state = () => ctx.state;
const bySeq = (a, b) => a.seq - b.seq;

// [列の名前, 見出し, 単位]
const FIELDS = [
  ["yield_kg_per_10a", "収量（kg/10a）", "kg/10a"],
  ["yield_g_per_plant", "収量（g/株）", "g/株"],
  ["shippable_pct", "出荷率（%）", "%"],
  ["price_yen_per_kg", "単価（円/kg・税抜き）", "円/kg"],
];
const blankForm = () => ({ set_on: localToday(), yield_kg_per_10a: "", yield_g_per_plant: "", shippable_pct: "", price_yen_per_kg: "", note: "" });

export function initForecastEditor(context) {
  ctx = context;
}

// プランの作付の並び（区画、畝、作付の順）と、その呼び名
function plantingChoices() {
  const s = state();
  return s.blocks.flatMap((block) =>
    s.beds
      .filter((bed) => bed.block_id === block.id)
      .sort(bySeq)
      .flatMap((bed) => {
        const list = s.plantings.filter((planting) => planting.bed_id === bed.id).sort(bySeq);
        return list.map((planting) => ({
          id: planting.id,
          label: `${block.name} 畝${bed.seq} ${planting.crop_name || "品目なし"}${list.length > 1 ? `（作付 ${planting.seq}）` : ""}`,
        }));
      })
  );
}

// タブを開く。相手は、作付があればその作付、畝ならその畝の最後の作付、区画ならその区画の最初の作付、なければプランの最初の作付
export function startForecast({ plantingId = null, bedId = null, blockId = null } = {}) {
  const s = state();
  const choices = plantingChoices();
  const ofBed = (id) => s.plantings.filter((planting) => planting.bed_id === id).sort(bySeq).at(-1)?.id;
  const ofBlock = (id) => choices.find((choice) => s.beds.find((bed) => bed.id === s.plantings.find((planting) => planting.id === choice.id)?.bed_id)?.block_id === id)?.id;
  const chosen =
    (plantingId && choices.some((choice) => choice.id === plantingId) && plantingId) || (bedId && ofBed(bedId)) || (blockId && ofBlock(blockId)) || choices[0]?.id || null;
  fd = { plantingId: chosen, form: blankForm(), editing: null, edit: null };
}

// ほかのタブへ移るときに引き継ぐ相手
export function forecastPreset() {
  return fd?.plantingId ? { plantingId: fd.plantingId } : {};
}

// 書きかけ（新しく記録する欄か、直している記録に入れた値）があるか
export function forecastDirty() {
  if (!fd) {
    return false;
  }
  const typed = (form) => FIELDS.some(([key]) => String(form[key] ?? "").trim() !== "") || String(form.note || "").trim() !== "";
  return typed(fd.form) || Boolean(fd.editing && fd.edit && fd.edit.changed);
}

const entriesOf = (plantingId) => (state().planting_forecasts || []).filter((entry) => entry.planting_id === plantingId);
const shortDay = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const number = (value) => Number(value).toLocaleString("ja-JP", { maximumFractionDigits: 2 });

// 記録で変えた値の文。例: 出荷率 70 %・単価 300 円/kg
function changedText(entry) {
  return FIELDS.filter(([key]) => entry[key] !== null && entry[key] !== undefined && entry[key] !== "")
    .map(([key, label, unit]) => `${label.replace(/（.*）/, "")} ${number(entry[key])} ${unit}`)
    .join("・");
}

export function forecastHtml() {
  const choices = plantingChoices();
  if (!fd?.plantingId) {
    return '<p class="muted">このプランには、まだ作付がありません。「工程の計画」のタブで作付を足すと、ここで収量と単価の見込みを記録できます。</p>';
  }
  const s = state();
  const planting = s.plantings.find((item) => item.id === fd.plantingId);
  const crop = s.crops.find((item) => item.id === planting?.crop_id) || null;
  const entries = entriesOf(fd.plantingId);
  const effective = effectiveForecast(entries);
  const select =
    `<label class="fc-target">作付<select data-fc="planting" aria-label="見込みを記録する作付">` +
    choices.map((choice) => `<option value="${escapeHtml(choice.id)}"${choice.id === fd.plantingId ? " selected" : ""}>${escapeHtml(choice.label)}</option>`).join("") +
    "</select></label>";
  // いま使っている値。項目ごとに、どの記録の値か、品目の値か
  const current = FIELDS.map(([key, label, unit]) => {
    const own = effective.values[key];
    const base = crop && crop[key] !== null && crop[key] !== undefined && crop[key] !== "" ? Number(crop[key]) : null;
    const value = own ? `${number(own.value)} ${unit}` : base !== null ? `${number(base)} ${unit}` : key === "shippable_pct" ? "100 %" : "－";
    const from = own ? `${shortDay(own.set_on)} の記録` : base !== null ? "品目の値" : key === "shippable_pct" ? "値がないので 100 %" : key === "price_yen_per_kg" ? "市況から推す（品目に市況での品目名があれば）" : "値なし";
    return `<tr><td>${label}</td><td class="num">${escapeHtml(value)}</td><td class="muted">${escapeHtml(from)}</td></tr>`;
  }).join("");
  const input = (scope, key, value, placeholder = "") =>
    `<input type="number" min="0"${key === "shippable_pct" ? ' max="100"' : ""} step="any" inputmode="decimal" data-fc-scope="${scope}" data-fc-field="${key}" value="${escapeHtml(value ?? "")}"${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ""} />`;
  const placeholder = (key) => {
    const own = effective.values[key];
    const base = crop?.[key];
    return own ? `いま ${number(own.value)}` : base !== null && base !== undefined && base !== "" ? `品目 ${number(base)}` : "";
  };
  const form =
    '<section class="fc-section"><h3>見込みを記録する</h3><div class="fc-grid">' +
    `<label>日付<input type="date" data-fc-scope="form" data-fc-field="set_on" value="${escapeHtml(fd.form.set_on)}" /></label>` +
    FIELDS.map(([key, label]) => `<label>${label}${input("form", key, fd.form[key], placeholder(key))}</label>`).join("") +
    "</div>" +
    `<label>メモ（なぜ見直したか。例: 発芽が 7 割だった）<textarea data-fc-scope="form" data-fc-field="note" rows="2">${escapeHtml(fd.form.note)}</textarea></label>` +
    '<p class="muted">変える項目だけを入れます。空の項目は、前の記録か品目の値のままです。</p>' +
    '<div class="fc-actions"><button type="button" class="primary-btn" data-fc-act="add">記録する</button></div></section>';
  // 履歴。新しい順
  const sorted = [...entries].sort((a, b) => b.set_on.localeCompare(a.set_on) || String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const rows = sorted
    .map((entry) => {
      const id = escapeHtml(entry.id);
      if (fd.editing === entry.id) {
        const edit = fd.edit;
        return (
          `<li class="fc-entry is-editing" data-forecast="${id}"><div class="fc-grid">` +
          `<label>日付<input type="date" data-fc-scope="edit" data-fc-field="set_on" value="${escapeHtml(edit.set_on)}" /></label>` +
          FIELDS.map(([key, label]) => `<label>${label}${input("edit", key, edit[key])}</label>`).join("") +
          "</div>" +
          `<label>メモ<textarea data-fc-scope="edit" data-fc-field="note" rows="2">${escapeHtml(edit.note)}</textarea></label>` +
          `<div class="fc-actions"><button type="button" class="text-btn" data-fc-act="cancel-edit">取りやめる</button>` +
          `<button type="button" class="chip-btn" data-fc-act="save-edit" data-id="${id}">保存する</button></div></li>`
        );
      }
      return (
        `<li class="fc-entry" data-forecast="${id}"><div class="fc-head"><strong>${escapeHtml(shortDay(entry.set_on))}</strong>` +
        `<span>${escapeHtml(changedText(entry) || "（値なし）")}</span>` +
        `<span class="fc-buttons"><button type="button" class="text-btn" data-fc-act="edit" data-id="${id}">直す</button>` +
        `<button type="button" class="text-btn danger" data-fc-act="delete" data-id="${id}">削除</button></span></div>` +
        (entry.note ? `<p class="fc-note">${escapeHtml(entry.note)}</p>` : "") +
        "</li>"
      );
    })
    .join("");
  return (
    `<div class="fc">${select}` +
    '<section class="fc-section"><h3>いま使っている値</h3><table class="usage-table fc-current"><tbody>' +
    current +
    "</tbody></table></section>" +
    form +
    `<section class="fc-section"><h3>履歴</h3>${rows ? `<ol class="fc-history">${rows}</ol>` : '<p class="muted">まだ記録がありません。</p>'}</section></div>`
  );
}

// 入れた値を書きかけに写す（描き直さない。打っている欄を作り直さないため）
export function forecastInput(event) {
  const el = event.target;
  const scope = el.dataset.fcScope;
  const key = el.dataset.fcField;
  if (!fd || !scope || !key) {
    return false;
  }
  const target = scope === "edit" ? fd.edit : fd.form;
  if (target) {
    target[key] = el.value;
    if (scope === "edit") {
      fd.edit.changed = true;
    }
  }
  return true;
}

export function forecastChange(event, rerender) {
  if (!fd) {
    return false;
  }
  if (event.target.dataset.fc === "planting") {
    fd = { plantingId: event.target.value, form: blankForm(), editing: null, edit: null };
    rerender();
    return true;
  }
  return forecastInput(event);
}

// 書きかけの値を、保存する行の値にする。数でない値、負の値、100 を超える出荷率は、知らせる文を返す
function parseValues(form) {
  const values = {};
  for (const [key, label] of FIELDS) {
    const text = String(form[key] ?? "").trim();
    if (text === "") {
      values[key] = null;
      continue;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0 || (key === "shippable_pct" && value > 100)) {
      return { error: `${label}には、${key === "shippable_pct" ? "0 から 100 まで" : "0 以上"}の数を入れてください。` };
    }
    values[key] = value;
  }
  if (!form.set_on) {
    return { error: "日付を入れてください。" };
  }
  return { values };
}

// 作付の呼び名（変更の記録に書く）
const plantingLabel = (id) => plantingChoices().find((choice) => choice.id === id)?.label || "作付";

export function forecastClick(event, rerender) {
  const button = event.target.closest("[data-fc-act]");
  if (!button || !fd) {
    return false;
  }
  const act = button.dataset.fcAct;
  const s = state();
  if (act === "add") {
    const parsed = parseValues(fd.form);
    if (parsed.error) {
      notify(parsed.error);
      return true;
    }
    if (FIELDS.every(([key]) => parsed.values[key] === null)) {
      notify("収量、出荷率、単価のどれかを入れてください。");
      return true;
    }
    const row = {
      id: crypto.randomUUID(),
      plan_id: s.plan.id,
      planting_id: fd.plantingId,
      set_on: fd.form.set_on,
      ...parsed.values,
      note: String(fd.form.note || "").trim(),
      created_at: new Date().toISOString(),
    };
    s.planting_forecasts = [...(s.planting_forecasts || []), row];
    record({ kind: "forecast.add", target: ["planting", row.planting_id], text: `${plantingLabel(row.planting_id)}の収量と単価の見込みを記録（${changedText(row)}）` });
    ctx.persist(async () => {
      await ctx.sendPendingSaves(); // 親の作付が、まだ送られていないことがある
      await s.store.upsert("planting_forecasts", [row]);
    });
    fd.form = blankForm();
    rerender();
    ctx.refresh();
    return true;
  }
  if (act === "edit") {
    const entry = entriesOf(fd.plantingId).find((item) => item.id === button.dataset.id);
    if (entry) {
      fd.editing = entry.id;
      fd.edit = { ...Object.fromEntries(FIELDS.map(([key]) => [key, entry[key] ?? ""])), set_on: entry.set_on, note: entry.note || "", changed: false };
      rerender();
    }
    return true;
  }
  if (act === "cancel-edit") {
    fd.editing = null;
    fd.edit = null;
    rerender();
    return true;
  }
  if (act === "save-edit") {
    const entry = entriesOf(fd.plantingId).find((item) => item.id === button.dataset.id);
    if (!entry) {
      return true;
    }
    const parsed = parseValues(fd.edit);
    if (parsed.error) {
      notify(parsed.error);
      return true;
    }
    if (FIELDS.every(([key]) => parsed.values[key] === null)) {
      notify("収量、出荷率、単価のどれかを入れてください。値をすべて消すときは、削除してください。");
      return true;
    }
    const row = { ...entry, set_on: fd.edit.set_on, ...parsed.values, note: String(fd.edit.note || "").trim() };
    s.planting_forecasts = s.planting_forecasts.map((item) => (item.id === row.id ? row : item));
    record({
      kind: "forecast.edit",
      target: ["planting", row.planting_id],
      text: `${plantingLabel(row.planting_id)}の収量と単価の見込み（${shortDay(entry.set_on)} の記録）を直した`,
      before: changedText(entry),
      after: changedText(row),
    });
    ctx.persist(() => s.store.upsert("planting_forecasts", [row]));
    fd.editing = null;
    fd.edit = null;
    rerender();
    ctx.refresh();
    return true;
  }
  if (act === "delete") {
    const entry = entriesOf(fd.plantingId).find((item) => item.id === button.dataset.id);
    if (entry) {
      deleteEntry(entry, rerender);
    }
    return true;
  }
  return false;
}

async function deleteEntry(entry, rerender) {
  if (!(await confirmDelete("この見込みの記録を削除します。", `${shortDay(entry.set_on)} の記録（${changedText(entry) || "値なし"}）`))) {
    return;
  }
  const s = state();
  s.planting_forecasts = s.planting_forecasts.filter((item) => item.id !== entry.id);
  record({ kind: "forecast.delete", target: ["planting", entry.planting_id], text: `${plantingLabel(entry.planting_id)}の収量と単価の見込み（${shortDay(entry.set_on)} の記録）を削除` });
  await ctx.persist(() => s.store.remove("planting_forecasts", [entry.id]));
  if (fd?.editing === entry.id) {
    fd.editing = null;
    fd.edit = null;
  }
  rerender();
  ctx.refresh();
}

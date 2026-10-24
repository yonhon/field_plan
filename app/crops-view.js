// 「品目」の画面。品目ごとの設定値と、肥料の銘柄を登録する。どちらもすべてのプランで共通。
import { confirmDelete, notify } from "./dialog.js";
import { record } from "./journal.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// [列の名前, 見出し, 入力の種類]。int は整数、number は小数、check はチェック、fertilizer は肥料の選択
const CROP_FIELDS = [
  ["name", "品目", "text"],
  ["variety", "品種", "text"],
  ["bed_width_cm", "畝幅（cm）", "int"],
  ["aisle_width_cm", "隙間（cm）", "int"],
  ["row_count", "条数", "int"],
  ["row_gap_cm", "条間（cm）", "int"],
  ["plant_gap_cm", "株間（cm）", "number"],
  ["staggered", "千鳥", "check"],
  ["mulch", "マルチ", "check"],
  ["n_kg_per_10a", "窒素（kg/10a）", "number"],
  ["fertilizer_id", "肥料", "fertilizer"],
  ["grow_days", "定植・播種から収穫開始まで（日）", "int"],
  ["harvest_days", "収穫の日数", "int"],
  ["note", "メモ", "text"],
];
const FERTILIZER_FIELDS = [
  ["name", "銘柄", "text"],
  ["n_pct", "窒素（%）", "number"],
  ["p_pct", "リン酸（%）", "number"],
  ["k_pct", "カリ（%）", "number"],
];

let ctx = null; // { state, setStatus }

async function run(action) {
  ctx.setStatus("保存中…");
  try {
    await action();
    ctx.setStatus("保存しました");
  } catch (error) {
    ctx.setStatus(`保存に失敗しました: ${error.message}`);
  }
  renderCrops();
}

function cell(row, [key, , kind]) {
  const value = row[key];
  if (kind === "check") {
    return `<input type="checkbox" data-field="${key}"${value ? " checked" : ""} />`;
  }
  if (kind === "fertilizer") {
    const options = ctx.state.fertilizers
      .map((item) => `<option value="${item.id}"${item.id === value ? " selected" : ""}>${escapeHtml(item.name)}</option>`)
      .join("");
    return `<select data-field="${key}"><option value="">なし</option>${options}</select>`;
  }
  if (kind === "text") {
    return `<input type="text" data-field="${key}" value="${escapeHtml(value)}" />`;
  }
  return `<input type="number" min="0" step="${kind === "int" ? 1 : "any"}" data-field="${key}" value="${value ?? ""}" />`;
}

function table(fields, rows, empty) {
  const head = fields.map(([, label]) => `<th>${label}</th>`).join("");
  const body = rows.length
    ? rows
        .map((row) => `<tr data-id="${row.id}">${fields.map((field) => `<td>${cell(row, field)}</td>`).join("")}<td><button class="text-btn danger" data-action="delete">削除</button></td></tr>`)
        .join("")
    : `<tr><td colspan="${fields.length + 1}" class="muted">${empty}</td></tr>`;
  return `<thead><tr>${head}<th></th></tr></thead><tbody>${body}</tbody>`;
}

export function renderCrops() {
  if (!ctx) {
    return;
  }
  $("cropTable").innerHTML = table(CROP_FIELDS, ctx.state.crops, "品目がまだありません。「品目を追加」で登録してください。");
  $("fertilizerTable").innerHTML = table(FERTILIZER_FIELDS, ctx.state.fertilizers, "肥料がまだありません。");
}

// 入力欄の値を、列に入れる値にする。数の欄が空なら null
function parse(input, kind) {
  if (kind === "check") {
    return input.checked;
  }
  if (kind === "text") {
    return input.value.trim();
  }
  if (kind === "fertilizer") {
    return input.value || null;
  }
  if (input.value.trim() === "") {
    return null;
  }
  const value = Number(input.value);
  return Number.isFinite(value) && value >= 0 ? (kind === "int" ? Math.round(value) : value) : undefined;
}

function unusedName(rows, base) {
  let name = base;
  for (let n = 2; rows.some((row) => row.name === name); n += 1) {
    name = `${base} ${n}`;
  }
  return name;
}

function bind(tableId, storeTable, fields, rowsOf, afterDelete) {
  $(tableId).addEventListener("change", (event) => {
    const row = rowsOf().find((item) => item.id === event.target.closest("tr[data-id]")?.dataset.id);
    const field = fields.find(([key]) => key === event.target.dataset.field);
    if (!row || !field) {
      return;
    }
    const value = parse(event.target, field[2]);
    if (value === undefined || (field[0] === "name" && !value)) {
      notify(field[0] === "name" ? "名前を入れてください。" : "0 以上の数を入れてください。");
      renderCrops();
      return;
    }
    // 記録には、変える前の名前と、読める形の値を書く
    const shown = (item) =>
      field[2] === "check" ? (item ? "あり" : "なし") : field[2] === "fertilizer" ? ctx.state.fertilizers.find((entry) => entry.id === item)?.name || "なし" : item === null || item === "" ? "空" : item;
    const what = storeTable === "crops" ? "品目" : "肥料";
    record({
      kind: `${storeTable}.${field[0]}`,
      target: [storeTable === "crops" ? "crop" : "fertilizer", row.id],
      plan: false,
      text: field[0] === "name" ? `${what}の名前を変更` : `${what}「${row.name}」の${field[1]}を変更`,
      before: shown(row[field[0]]),
      after: shown(value),
    });
    row[field[0]] = value;
    run(async () => {
      await ctx.state.store.upsert(storeTable, [row]);
      // 品目の名前を変えたら、作付に写してある名前も合わせる
      if (storeTable === "crops" && field[0] === "name") {
        const plantings = ctx.state.plantings.filter((planting) => planting.crop_id === row.id);
        plantings.forEach((planting) => {
          planting.crop_name = value;
        });
        await ctx.state.store.upsert("plantings", plantings);
      }
    });
  });
  $(tableId).addEventListener("click", (event) => {
    const id = event.target.closest("tr[data-id]")?.dataset.id;
    if (id && event.target.dataset.action === "delete") {
      afterDelete(rowsOf().find((item) => item.id === id));
    }
  });
}

export function initCrops(context) {
  ctx = context;
  const { state } = ctx;

  bind("cropTable", "crops", CROP_FIELDS, () => state.crops, async (crop) => {
    const used = state.plantings.filter((planting) => planting.crop_id === crop.id);
    if (!(await confirmDelete(`この品目を削除します。${used.length ? `このプランの作付 ${used.length} 件は、名前だけが残ります。` : ""}`, `品目「${crop.name}」`))) {
      return;
    }
    run(async () => {
      used.forEach((planting) => {
        planting.crop_id = null;
      });
      await state.store.upsert("plantings", used);
      record({ kind: "crops.delete", plan: false, text: `品目「${crop.name}」を削除` });
      await state.store.remove("crops", [crop.id]);
      state.crops = state.crops.filter((item) => item.id !== crop.id);
    });
  });
  bind("fertilizerTable", "fertilizers", FERTILIZER_FIELDS, () => state.fertilizers, async (fertilizer) => {
    const used = state.crops.filter((crop) => crop.fertilizer_id === fertilizer.id);
    if (!(await confirmDelete(`この肥料を削除します。${used.length ? `これを使っている品目 ${used.length} 件は、肥料なしになります。` : ""}`, `肥料「${fertilizer.name}」`))) {
      return;
    }
    run(async () => {
      used.forEach((crop) => {
        crop.fertilizer_id = null;
      });
      await state.store.upsert("crops", used);
      record({ kind: "fertilizers.delete", plan: false, text: `肥料「${fertilizer.name}」を削除` });
      await state.store.remove("fertilizers", [fertilizer.id]);
      state.fertilizers = state.fertilizers.filter((item) => item.id !== fertilizer.id);
    });
  });

  $("addCropBtn").addEventListener("click", () => {
    const crop = {
      id: crypto.randomUUID(),
      name: unusedName(state.crops, "新しい品目"),
      variety: "",
      bed_width_cm: 70,
      aisle_width_cm: 60,
      row_count: null,
      row_gap_cm: null,
      plant_gap_cm: null,
      staggered: false,
      mulch: false,
      n_kg_per_10a: null,
      fertilizer_id: null,
      grow_days: null,
      harvest_days: null,
      note: "",
    };
    run(async () => {
      await state.store.upsert("crops", [crop]);
      state.crops.push(crop);
      record({ kind: "crops.add", target: ["crop", crop.id], plan: false, text: `品目「${crop.name}」を追加` });
    });
  });
  $("addFertilizerBtn").addEventListener("click", () => {
    const fertilizer = { id: crypto.randomUUID(), name: unusedName(state.fertilizers, "新しい肥料"), n_pct: 0, p_pct: 0, k_pct: 0 };
    run(async () => {
      await state.store.upsert("fertilizers", [fertilizer]);
      state.fertilizers.push(fertilizer);
      record({ kind: "fertilizers.add", target: ["fertilizer", fertilizer.id], plan: false, text: `肥料「${fertilizer.name}」を追加` });
    });
  });
}

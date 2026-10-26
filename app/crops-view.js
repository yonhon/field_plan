// 「品目」の画面。品目ごとの設定値と、肥料の銘柄を登録する。どちらもすべてのプランで共通。
import { confirmDelete, notify } from "./dialog.js";
import { record } from "./journal.js";
import { famicEnabled } from "./pesticide.js";

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
// 農薬の使用基準（FAMIC）を使うときだけ出す欄。品目に対応する FAMIC の作物名（複数）。
// 作物名には「野菜類(レタス、キャベツ、…を除く)」や「稲、麦類、果樹類、…」のように「、」を含むものがあるので、
// 文字を区切って読むのではなく、候補から 1 つずつ選んで足す
const FAMIC_FIELD = ["famic_crops", "FAMIC の作物名", "list"];
const MAX_SUGGEST = 40; // 候補の一覧に出す数
const cropFields = () => (famicEnabled() ? [...CROP_FIELDS.slice(0, -1), FAMIC_FIELD, CROP_FIELDS.at(-1)] : CROP_FIELDS);
const FERTILIZER_FIELDS = [
  ["name", "銘柄", "text"],
  ["n_pct", "窒素（%）", "number"],
  ["p_pct", "リン酸（%）", "number"],
  ["k_pct", "カリ（%）", "number"],
];

let ctx = null; // { state, setStatus }
let famicNames = []; // FAMIC の作物名の候補（適用部にある作物名）
let suggestFor = null; // 候補の一覧を出している検索欄

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
  if (kind === "list") {
    const chips = (value || [])
      .map((name) => `<span class="famic-chip">${escapeHtml(name)}<button type="button" class="famic-chip-x" data-famic-remove="${escapeHtml(name)}" aria-label="${escapeHtml(name)} を外す">×</button></span>`)
      .join("");
    return `<div class="famic-crops" data-list="${key}">${chips}<input type="text" class="famic-search" placeholder="作物名を探して足す（例: レタス）" autocomplete="off" /></div>`;
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
  $("cropTable").innerHTML = table(cropFields(), ctx.state.crops, "品目がまだありません。「品目を追加」で登録してください。");
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

// 1 つの欄の値を保存する。変更の記録には、変える前と後の値を、読める形で書く
function saveValue(storeTable, row, field, value) {
  const shown = (item) =>
    field[2] === "check"
      ? item ? "あり" : "なし"
      : field[2] === "fertilizer"
        ? ctx.state.fertilizers.find((entry) => entry.id === item)?.name || "なし"
        : field[2] === "list"
          ? (item || []).join(" ／ ") || "空"
          : item === null || item === "" ? "空" : item;
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
}

// ---- FAMIC の作物名の選択 ----
// 選んだ名前はチップで並べ、× で外す。検索欄に入れた文字を含む作物名を、候補の一覧に出す。
// 候補の一覧は表の外（body の直下）に置き、長い名前も折り返して全部見せる

const suggestBox = () => $("famicSuggest");

function matches(query) {
  const q = query.trim().normalize("NFKC");
  if (!q) {
    return [];
  }
  const hits = famicNames.filter((name) => name.includes(q));
  // 同じ名前、その文字で始まる名前、短い名前の順
  const rank = (name) => (name === q ? 0 : name.startsWith(q) ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b, "ja"));
}

function hideSuggest() {
  suggestFor = null;
  suggestBox().hidden = true;
}

function showSuggest(input) {
  const crop = ctx.state.crops.find((item) => item.id === input.closest("tr[data-id]")?.dataset.id);
  const chosen = new Set(crop?.famic_crops || []);
  const hits = matches(input.value).filter((name) => !chosen.has(name));
  const box = suggestBox();
  if (!input.value.trim()) {
    hideSuggest();
    return;
  }
  suggestFor = input;
  box.innerHTML = hits.length
    ? hits
        .slice(0, MAX_SUGGEST)
        .map((name, i) => `<li role="option" data-famic-pick="${escapeHtml(name)}"${i === 0 ? ' class="is-active"' : ""}>${escapeHtml(name)}</li>`)
        .join("") + (hits.length > MAX_SUGGEST ? `<li class="muted famic-more">ほかに ${hits.length - MAX_SUGGEST} 件。文字を足して絞ってください。</li>` : "")
    : `<li class="muted famic-more">${famicNames.length ? "合う作物名がありません。" : "作物名の一覧を読めていません。"}</li>`;
  box.hidden = false;
  placeSuggest();
}

// 候補の一覧を、検索欄のすぐ下に置く。検索欄が画面から外れたら閉じる
function placeSuggest() {
  const box = suggestBox();
  if (!suggestFor || box.hidden) {
    return;
  }
  const rect = suggestFor.getBoundingClientRect();
  if (!suggestFor.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) {
    hideSuggest();
    return;
  }
  const width = Math.min(Math.max(rect.width, 360), window.innerWidth - 16);
  box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  box.style.top = `${rect.bottom + 2}px`;
  box.style.width = `${width}px`;
  box.style.maxHeight = `${Math.max(160, window.innerHeight - rect.bottom - 16)}px`;
}

function changeFamicCrops(input, change) {
  const row = ctx.state.crops.find((item) => item.id === input.closest("tr[data-id]")?.dataset.id);
  if (!row) {
    return;
  }
  const next = change([...(row.famic_crops || [])]);
  saveValue("crops", row, FAMIC_FIELD, next);
}

function pick(name) {
  const input = suggestFor;
  hideSuggest();
  if (input) {
    changeFamicCrops(input, (list) => (list.includes(name) ? list : [...list, name]));
  }
}

function moveActive(step) {
  const items = [...suggestBox().querySelectorAll("[data-famic-pick]")];
  if (!items.length) {
    return;
  }
  const now = items.findIndex((item) => item.classList.contains("is-active"));
  const next = items[(now + step + items.length) % items.length];
  items.forEach((item) => item.classList.toggle("is-active", item === next));
  next.scrollIntoView({ block: "nearest" });
}

function initFamicPicker() {
  const table = $("cropTable");
  table.addEventListener("input", (event) => {
    if (event.target.classList.contains("famic-search")) {
      showSuggest(event.target);
    }
  });
  table.addEventListener("focusin", (event) => {
    if (event.target.classList.contains("famic-search") && event.target.value.trim()) {
      showSuggest(event.target);
    }
  });
  table.addEventListener("focusout", (event) => {
    if (event.target === suggestFor) {
      hideSuggest();
    }
  });
  table.addEventListener("keydown", (event) => {
    if (event.target !== suggestFor || suggestBox().hidden) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const active = suggestBox().querySelector("[data-famic-pick].is-active");
      if (active) {
        pick(active.dataset.famicPick);
      }
    } else if (event.key === "Escape") {
      hideSuggest();
    }
  });
  table.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-famic-remove]");
    if (remove) {
      changeFamicCrops(remove, (list) => list.filter((name) => name !== remove.dataset.famicRemove));
    }
  });
  // 押した時点で検索欄からフォーカスが外れて一覧が閉じないよう、mousedown で選ぶ
  suggestBox().addEventListener("mousedown", (event) => {
    const item = event.target.closest("[data-famic-pick]");
    event.preventDefault();
    if (item) {
      pick(item.dataset.famicPick);
    }
  });
  // 表を横に送ったり、画面を動かしたりしたら、一覧を検索欄に付いていかせる（候補の中のスクロールは除く）
  window.addEventListener("scroll", (event) => event.target !== suggestBox() && placeSuggest(), true);
  window.addEventListener("resize", placeSuggest);
}

function bind(tableId, storeTable, fields, rowsOf, afterDelete) {
  $(tableId).addEventListener("change", (event) => {
    const row = rowsOf().find((item) => item.id === event.target.closest("tr[data-id]")?.dataset.id);
    // fields は欄の並び（品目の欄は、FAMIC を使うかで変わるので、関数で渡す）
    const field = (typeof fields === "function" ? fields() : fields).find(([key]) => key === event.target.dataset.field);
    if (!row || !field) {
      return;
    }
    const value = parse(event.target, field[2]);
    if (value === undefined || (field[0] === "name" && !value)) {
      notify(field[0] === "name" ? "名前を入れてください。" : "0 以上の数を入れてください。");
      renderCrops();
      return;
    }
    saveValue(storeTable, row, field, value);
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

  // FAMIC の作物名の候補（適用部にある作物名）
  if (famicEnabled()) {
    state.store
      .famicCropNames()
      .then((names) => {
        famicNames = names;
      })
      .catch(() => {});
    initFamicPicker();
  }
  bind("cropTable", "crops", cropFields, () => state.crops, async (crop) => {
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

// 「圃場とプラン」の窓。ヘッダーのメニューの「圃場とプランを選ぶ…」で開く。
// 左（スマホでは上）に圃場、右（下）に選んだ圃場のプランを並べる。
// 圃場とプランの行の「…」で、名前の変更・削除など（プランは、コピーと「実際に使うプランにする」も）を出す。
// 名前の変更・コピー・削除などは、押したときに保存する（書きかけにしない）。データを変える処理は app.js が持ち、ctx.ops で受け取る
import { draw } from "./draw.js";
import { lastChangeAt } from "./journal.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let ctx = null; // { state, notify, ops: { openPlan, newField, renameField, deleteField, newPlan, renamePlan, copyPlan, activatePlan, deletePlan, loadPlans, planStats } }
let dialog = null;
let shownFieldId = null; // 窓で選んでいる圃場
let menuFor = null; // 「…」のメニューを開いている相手。"field:ID" か "plan:ID"
const plansOf = new Map(); // 開いていない圃場のプラン。窓を開いているあいだだけ覚える
const stats = new Map(); // プランの規模 { blocks, beds }。窓を開いているあいだだけ覚える

const state = () => ctx.state;
const fieldOf = (id) => state().fields.find((field) => field.id === id);

export function initFieldPlans(context) {
  ctx = context;
}

// 窓を開く。初めは、開いている圃場を選ぶ
export function openFieldPlans() {
  if (!dialog) {
    build();
  }
  shownFieldId = state().field.id;
  menuFor = null;
  plansOf.clear();
  stats.clear();
  render();
  dialog.showModal();
  dialog.querySelector("#fieldPlansTitle")?.focus({ preventScroll: true });
}

// 開いているとき、描き直す（圃場やプランを変えたあと、app.js からも呼ぶ）
export function refreshFieldPlans() {
  if (dialog?.open) {
    render();
  }
}

function build() {
  dialog = document.createElement("dialog");
  dialog.className = "field-plans";
  dialog.setAttribute("aria-labelledby", "fieldPlansTitle");
  document.body.append(dialog);
  dialog.addEventListener("click", onClick);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menuFor) {
      // Esc は、まずメニューだけを閉じる
      event.preventDefault();
      closeMenu();
    }
  });
  dialog.addEventListener("close", () => {
    menuFor = null;
    dialog.replaceChildren();
  });
}

// 開いていない圃場のプランは、初めて選んだときに読む
function plansFor(fieldId) {
  if (fieldId === state().field.id) {
    return state().plans;
  }
  if (!plansOf.has(fieldId)) {
    plansOf.set(fieldId, null);
    ctx.ops
      .loadPlans(fieldId)
      .then((plans) => {
        plansOf.set(fieldId, plans);
        refreshFieldPlans();
      })
      .catch((error) => {
        plansOf.delete(fieldId);
        ctx.notify(`プランを読み込めませんでした: ${error.message}`);
      });
  }
  return plansOf.get(fieldId);
}

// プランの規模（区画と畝の数）。開いているプランはいまの値、ほかは読んでから出す
function statsFor(plan) {
  if (plan.id === state().plan.id) {
    return { blocks: state().blocks.length, beds: state().beds.length };
  }
  if (!stats.has(plan.id)) {
    stats.set(plan.id, null);
    ctx.ops
      .planStats(plan.id)
      .then((value) => {
        stats.set(plan.id, value);
        refreshFieldPlans();
      })
      .catch(() => stats.delete(plan.id));
  }
  return stats.get(plan.id);
}

function shortDate(iso) {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function render() {
  const s = state();
  if (!fieldOf(shownFieldId)) {
    shownFieldId = s.field.id;
  }
  const busy = Boolean(s.planBusy);
  const field = fieldOf(shownFieldId);
  const plans = plansFor(shownFieldId);
  const fieldRows = s.fields
    .map((item) => {
      const count = item.id === s.field.id ? s.plans.length : plansOf.get(item.id)?.length;
      return (
        `<div class="fp-field${item.id === shownFieldId ? " is-on" : ""}" data-field="${item.id}" role="button" tabindex="0">` +
        `<strong>${escapeHtml(item.name || "（名前なし）")}</strong>` +
        `${count === undefined || count === null ? "" : `<span class="muted fp-count">${count} 個のプラン</span>`}` +
        `<button type="button" class="text-btn fp-more" data-act="more" data-menu="field:${item.id}" aria-label="圃場のほかの操作" aria-haspopup="menu"${busy ? " disabled" : ""}>…</button></div>`
      );
    })
    .join("");
  let planRows;
  if (!plans) {
    planRows = '<p class="muted">プランを読み込んでいます…</p>';
  } else {
    planRows = plans
      .map((plan) => {
        const isOpen = plan.id === s.plan.id;
        const isActive = plan.id === field.active_plan_id;
        const size = statsFor(plan);
        const changed = shortDate(lastChangeAt(plan.id));
        const meta = [size ? `区画 ${size.blocks}・畝 ${size.beds}` : "…", changed ? `最後の変更 ${changed}` : ""].filter(Boolean).join("・");
        return (
          `<div class="fp-plan${isOpen ? " is-open" : ""}" data-plan="${plan.id}">` +
          `<div class="fp-plan-name">${escapeHtml(plan.name)}${isActive ? '<span class="fp-badge is-active">実際に使う</span>' : ""}${isOpen ? '<span class="fp-badge is-open">開いている</span>' : ""}</div>` +
          `<div class="fp-plan-meta muted">${escapeHtml(meta)}</div>` +
          `<div class="fp-plan-acts">${isOpen ? "" : `<button type="button" class="chip-btn" data-act="open" data-id="${plan.id}"${busy ? " disabled" : ""}>開く</button>`}` +
          `<button type="button" class="text-btn fp-more" data-act="more" data-menu="plan:${plan.id}" aria-label="プランのほかの操作" aria-haspopup="menu"${busy ? " disabled" : ""}>…</button></div></div>`
        );
      })
      .join("");
  }
  draw(
    dialog,
    `<div class="fp-head"><h2 id="fieldPlansTitle" tabindex="-1">圃場とプラン</h2><button type="button" class="text-btn" data-act="close">閉じる</button></div>` +
    `<div class="fp-body">` +
    `<div class="fp-col fp-fields"><h3>圃場</h3><div class="fp-field-list">${fieldRows}</div>` +
    `<button type="button" class="text-btn fp-add" data-act="newField"${busy ? " disabled" : ""}>＋ 新しい圃場</button></div>` +
    `<div class="fp-col fp-plans"><h3>${escapeHtml(field.name || "")} のプラン</h3>` +
    (field.active_plan_id ? "" : '<p class="fp-note">この圃場には、実際に使うプランがまだありません（実績と管理作業の計画は、実際に使うプランに入れます）。</p>') +
    `<div class="fp-plan-list">${planRows}</div>` +
    `<button type="button" class="text-btn fp-add" data-act="newPlan"${busy || !plans ? " disabled" : ""}>＋ 新しいプラン</button></div>` +
    `</div>` +
    `<div class="fp-menu" role="menu" hidden></div>`
  );
  renderMenu();
}

// 「…」のメニュー。窓のスクロールの外（窓のいちばん上の層）に出し、押したボタンの右下に置く。下に空きがなければ上に開く
function renderMenu() {
  const menu = dialog.querySelector(".fp-menu");
  const button = menuFor && dialog.querySelector(`[data-menu="${menuFor}"]`);
  if (!button) {
    menu.hidden = true;
    return;
  }
  const [kind, id] = menuFor.split(":");
  const item = (act, icon, label, disabled = false, danger = false) =>
    `<button type="button" role="menuitem" class="${danger ? "danger" : ""}" data-act="${act}" data-id="${id}"${disabled ? " disabled" : ""}><span class="fp-icon" aria-hidden="true">${icon}</span>${label}</button>`;
  if (kind === "field") {
    draw(menu, item("renameField", "✎", "名前を変更") + '<hr />' + item("deleteField", "🗑", "削除", state().fields.length <= 1, true));
  } else {
    const field = fieldOf(shownFieldId);
    const plans = plansFor(shownFieldId) || [];
    const isActive = field.active_plan_id === id;
    draw(
      menu,
      item("renamePlan", "✎", "名前を変更") +
        item("copyPlan", "⧉", "コピー") +
        item("activatePlan", "★", "実際に使うプランにする", isActive) +
        '<hr />' +
        item("deletePlan", "🗑", "削除", plans.length <= 1 || isActive, true)
    );
  }
  menu.hidden = false;
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  menu.style.top = `${rect.bottom + 4 + height <= window.innerHeight - 8 ? rect.bottom + 4 : Math.max(8, rect.top - 4 - height)}px`;
}

function closeMenu() {
  menuFor = null;
  renderMenu();
}

async function onClick(event) {
  const button = event.target.closest("[data-act]");
  const fieldRow = event.target.closest("[data-field]");
  if (!button) {
    if (menuFor && !event.target.closest(".fp-menu")) {
      closeMenu();
      return;
    }
    if (fieldRow) {
      shownFieldId = fieldRow.dataset.field;
      render();
    }
    return;
  }
  const act = button.dataset.act;
  if (act === "more") {
    menuFor = menuFor === button.dataset.menu ? null : button.dataset.menu;
    renderMenu();
    return;
  }
  menuFor = null;
  renderMenu();
  if (act === "close") {
    dialog.close();
    return;
  }
  const field = fieldOf(shownFieldId);
  const plan = (plansFor(shownFieldId) || []).find((item) => item.id === button.dataset.id);
  const ops = ctx.ops;
  if (act === "open") {
    dialog.close();
    await ops.openPlan(field, plan);
    return;
  }
  if (act === "newField") {
    const created = await ops.newField();
    if (created) {
      shownFieldId = created.id;
    }
  } else if (act === "renameField") {
    await ops.renameField(fieldOf(button.dataset.id));
  } else if (act === "deleteField") {
    await ops.deleteField(fieldOf(button.dataset.id));
  } else if (act === "newPlan") {
    await ops.newPlan(field, plansFor(shownFieldId));
  } else if (act === "renamePlan") {
    await ops.renamePlan(field, plan);
  } else if (act === "copyPlan") {
    const copy = await ops.copyPlan(field, plan, plansFor(shownFieldId));
    if (copy) {
      stats.delete(copy.id);
    }
  } else if (act === "activatePlan") {
    await ops.activatePlan(field, plan);
  } else if (act === "deletePlan") {
    await ops.deletePlan(field, plan, plansFor(shownFieldId));
  }
  refreshFieldPlans();
}

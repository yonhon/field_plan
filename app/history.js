// 元に戻す（Ctrl+Z）と、やり直す（Ctrl+Y）。
// 操作ごとに逆の手順を書くのではなく、操作の前後で計画のデータの写しを取っておき、戻すときはその写しに合わせる。
// 対象は、いまのプランの区域・区画・畝・作付・作業と、圃場の外形、品目、肥料、作業の種類の目安。
// プランの切り替え・作成・削除と、縮尺・向きの合わせ直しは対象外で、行うと履歴が空になる。
// 戻すと多くの行が消えるときは、先に確かめる。
import { confirmDelete } from "./dialog.js";
import { record } from "./journal.js";

const $ = (id) => document.getElementById(id);

const PLAN_TABLES = ["zones", "blocks", "beds", "plantings", "works"];
const SHARED_TABLES = ["fertilizers", "crops"];
const MAX_STEPS = 50;
const SETTLE_MS = 250; // 操作のあと、データが落ち着くのを待つ時間
const LATE_MS = 1500; // 保存を待ってから変わるデータ（プランの作成など）を拾うための、遅い確認

let ctx = null; // { state, busy, flush, refresh, setStatus }
const undoStack = [];
const redoStack = [];
let last = null; // 最後に確かめたときの写し
let busy = false;
let timers = [];

function snapshot() {
  const { state } = ctx;
  const data = { planId: state.plan.id, outline: state.field.outline, viewDirs: state.field.view_dirs ?? null, workTypes: state.workTypes };
  for (const table of [...PLAN_TABLES, ...SHARED_TABLES]) {
    data[table] = state[table];
  }
  return JSON.stringify(data);
}

const planOf = (text) => /^\{"planId":"([^"]*)"/.exec(text)?.[1];

// 文字を打っている途中か。そのあいだは、ブラウザーの入力欄の「元に戻す」に任せる
function typing() {
  const element = document.activeElement;
  if (!element) {
    return false;
  }
  if (element.tagName === "TEXTAREA") {
    return true;
  }
  return element.tagName === "INPUT" && ["text", "number", "email", "password", "search", ""].includes(element.type);
}

function renderButtons() {
  $("undoBtn").disabled = !undoStack.length;
  $("redoBtn").disabled = !redoStack.length;
}

// データが変わっていたら、変わる前の写しを「元に戻す」の履歴に積む
function check() {
  if (busy || !ctx || ctx.busy()) {
    return;
  }
  if (typing()) {
    schedule(); // 入力が確定してから、まとめて 1 回ぶんにする
    return;
  }
  const now = snapshot();
  if (now === last) {
    return;
  }
  if (planOf(now) === planOf(last)) {
    undoStack.push(last);
    if (undoStack.length > MAX_STEPS) {
      undoStack.shift();
    }
  } else {
    undoStack.length = 0; // プランを切り替えたら、前のプランの履歴は使えない
  }
  redoStack.length = 0;
  last = now;
  renderButtons();
}

function schedule() {
  timers.forEach(clearTimeout);
  timers = [setTimeout(check, SETTLE_MS), setTimeout(check, LATE_MS)];
}

// 履歴を空にして、いまの状態から数え直す（縮尺の合わせ直しなど、戻せない操作のあと）
export function resetHistory() {
  if (!ctx) {
    return;
  }
  undoStack.length = 0;
  redoStack.length = 0;
  last = snapshot();
  renderButtons();
}

// データを写しの内容に合わせ、DB も同じ内容にする
async function restore(text) {
  const { state } = ctx;
  const store = state.store;
  const target = JSON.parse(text);
  const before = JSON.parse(snapshot());
  const tables = [...SHARED_TABLES, ...PLAN_TABLES]; // 親から子の順

  state.field.outline = target.outline;
  state.field.view_dirs = target.viewDirs ?? null;
  state.workTypes = target.workTypes;
  for (const table of tables) {
    state[table] = target[table];
  }

  if (JSON.stringify([before.outline, before.viewDirs]) !== JSON.stringify([target.outline, target.viewDirs ?? null])) {
    await store.saveField(state.field);
  }
  // 写しにない行を消す。子から先に消す（親を消すと、DB の側で子も消える）
  for (const table of [...tables].reverse()) {
    const kept = new Set(target[table].map((row) => row.id));
    await store.remove(table, before[table].filter((row) => !kept.has(row.id)).map((row) => row.id));
  }
  // 写しと違う行、いまはない行を入れる。親から先に入れる
  for (const table of tables) {
    const current = new Map(before[table].map((row) => [row.id, JSON.stringify(row)]));
    await store.upsert(table, target[table].filter((row) => current.get(row.id) !== JSON.stringify(row)));
  }
  const types = new Map(before.workTypes.map((type) => [type.code, JSON.stringify(type)]));
  for (const type of target.workTypes.filter((item) => types.get(item.code) !== JSON.stringify(item))) {
    await store.saveWorkType(type);
  }
}

// 写しに合わせたときに消える行の数。表ごとに、消える行のある表だけを返す
export function removedRows(currentText, targetText) {
  const current = JSON.parse(currentText);
  const target = JSON.parse(targetText);
  const removed = {};
  for (const table of [...SHARED_TABLES, ...PLAN_TABLES]) {
    const kept = new Set(target[table].map((row) => row.id));
    const count = current[table].filter((row) => !kept.has(row.id)).length;
    if (count) {
      removed[table] = count;
    }
  }
  return removed;
}

// 先に確かめてから消す行。区域・区画・品目・肥料は 1 件でも、畝・作付・作業はふだんの 1 回ぶん
// （畝 1 本、作付 1 つとその作業）より多いとき
const CONFIRM_FROM = { zones: 1, blocks: 1, crops: 1, fertilizers: 1, beds: 2, plantings: 2, works: 11 };
const TABLE_NAMES = { zones: "区域", blocks: "区画", beds: "畝", plantings: "作付", works: "作業", crops: "品目", fertilizers: "肥料" };

export function needsConfirm(removed) {
  return Object.entries(removed).some(([table, count]) => count >= CONFIRM_FROM[table]);
}

async function step(from, to, label) {
  if (busy || !from.length || ctx.busy()) {
    return;
  }
  busy = true;
  timers.forEach(clearTimeout);
  ctx.setStatus(`${label}しています…`);
  try {
    await ctx.flush(); // まだ送っていない保存を先に済ませる
    const current = snapshot();
    const target = from[from.length - 1];
    // 別のプランの写しには戻さない（そのプランの中身を消してしまう）
    if (planOf(target) !== planOf(current)) {
      from.length = 0;
      throw new Error("別のプランの記録なので、戻しません");
    }
    const removed = removedRows(current, target);
    if (needsConfirm(removed)) {
      const list = Object.entries(removed).map(([table, count]) => `${TABLE_NAMES[table]} ${count} 件`).join("、");
      if (!(await confirmDelete(`${label}すと、次のものが消えます。`, list))) {
        ctx.setStatus(`${label}すのをやめました`);
        busy = false;
        renderButtons();
        return;
      }
    }
    from.pop();
    to.push(current);
    await restore(target);
    last = snapshot();
    record({ kind: label === "元に戻" ? "history.undo" : "history.redo", text: label === "元に戻" ? "直前の操作を元に戻した" : "元に戻した操作をやり直した" });
    ctx.refresh();
    ctx.setStatus(`${label}しました（あと ${from.length} 回${label}せます）`);
  } catch (error) {
    ctx.setStatus(`${label}せませんでした: ${error.message}`);
    last = snapshot();
  }
  busy = false;
  renderButtons();
}

export const undo = () => step(undoStack, redoStack, "元に戻");
export const redo = () => step(redoStack, undoStack, "やり直");

export function initHistory(context) {
  ctx = context;
  last = snapshot();
  $("undoBtn").hidden = false;
  $("redoBtn").hidden = false;
  renderButtons();

  // どの操作でデータが変わるかを 1 つずつ数えず、操作が終わるたびに確かめる。
  // ドラッグは、離したときに 1 回ぶんになる
  for (const type of ["pointerup", "keyup", "change", "click"]) {
    document.addEventListener(type, schedule, true);
  }
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || (key !== "z" && key !== "y") || typing()) {
      return;
    }
    event.preventDefault();
    check(); // 直前の操作がまだ履歴に積まれていなければ、先に積む
    if (key === "y" || event.shiftKey) {
      redo();
    } else {
      undo();
    }
  });
  $("undoBtn").addEventListener("click", () => {
    check();
    undo();
  });
  $("redoBtn").addEventListener("click", redo);
}

// 元に戻す（Ctrl+Z）と、やり直す（Ctrl+Y）。
// 操作ごとに逆の手順を書くのではなく、操作の前後で計画のデータの写しを取っておき、戻すときはその写しに合わせる。
// 実績だけが変わった操作は、写しではなく、DB の変更の記録で戻す（store.undoOp。DB の関数 field.undo_op）。
// 書き込みに付けた操作の ID（store.js の onQueuedWrite）を覚えておき、その ID の変更を DB の側で戻して、実績を読み直す。
// 監査ログの方式への切り替えの 1 段目（Issue #3）。計画の操作は、まだ写しで戻す。
// 対象は、いまのプランの区域・区画・畝・作付・作業と、圃場の外形、品目、肥料、作業の種類の目安、圃場の実績。
// プランの切り替え・作成・削除と、縮尺・向きの合わせ直しは対象外で、行うと履歴が空になる。
// 戻すと多くの行が消えるときは、先に確かめる。
import { confirmDelete } from "./dialog.js";
import { record } from "./journal.js";
import { onQueuedWrite } from "./store.js";

const $ = (id) => document.getElementById(id);

const PLAN_TABLES = ["zones", "blocks", "beds", "plantings", "works"];
const SHARED_TABLES = ["fertilizers", "crops"];
const MAX_STEPS = 50;
const SETTLE_MS = 250; // 操作のあと、データが落ち着くのを待つ時間
const LATE_MS = 1500; // 保存を待ってから変わるデータ（プランの作成など）を拾うための、遅い確認

let ctx = null; // { state, busy, flush, refresh, reload, setStatus }
// 履歴の 1 回ぶんは { snap, ops }。snap は、その 1 回ぶんの前の写し。ops は、DB の変更の記録で戻す操作の ID（写しで戻すときは空）
const undoStack = [];
const redoStack = [];
let last = null; // 最後に確かめたときの写し
let queuedOps = []; // 最後に履歴に積んだあとに、実績を書いた操作の ID
const LOG_WRITES = new Set(["saveLog", "deleteLog"]);
let busy = false;
let timers = [];

function snapshot() {
  const { state } = ctx;
  const data = { planId: state.plan.id, outline: state.field.outline, viewDirs: state.field.view_dirs ?? null, workTypes: state.workTypes, logs: state.logs };
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
    const ops = logsOnly(last, now) && queuedOps.length ? [...new Set(queuedOps)] : [];
    undoStack.push({ snap: last, ops });
    if (undoStack.length > MAX_STEPS) {
      undoStack.shift();
    }
  } else {
    undoStack.length = 0; // プランを切り替えたら、前のプランの履歴は使えない
  }
  redoStack.length = 0;
  queuedOps = [];
  last = now;
  renderButtons();
}

// 2 つの写しの違いが、実績だけか
function logsOnly(before, after) {
  const { logs: a, ...restA } = JSON.parse(before);
  const { logs: b, ...restB } = JSON.parse(after);
  return JSON.stringify(a) !== JSON.stringify(b) && JSON.stringify(restA) === JSON.stringify(restB);
}

// 保存を待ってから変わるデータは、変わった時点で確かめる（操作から時間がたつと、次の操作と 1 回ぶんになる）
export const noteChange = () => check();

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
  queuedOps = [];
  last = snapshot();
  renderButtons();
}

// DB の変更の記録で、操作を新しい順に戻す。戻す処理の操作の ID を、戻した順に返す（やり直すときは、それを新しい順に戻す）
async function undoOps(ops) {
  const { state } = ctx;
  const applied = [];
  try {
    for (const op of [...ops].reverse()) {
      const result = await state.store.undoOp(op);
      if (result?.status === "conflict") {
        throw Object.assign(new Error("ほかの画面や端末で、あとから変わっているので、戻せません"), { conflict: true });
      }
      if (result?.status === "done") {
        applied.push(result.op_id);
      }
    }
  } catch (error) {
    // 途中まで戻したなら、画面と DB がずれている
    throw Object.assign(error, { partial: applied.length > 0 });
  }
  try {
    state.logs = await state.store.loadLogs(state.field.id);
  } catch (error) {
    throw Object.assign(error, { partial: true }); // DB は戻したが、画面は戻す前のまま
  }
  return applied;
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
  state.logs = target.logs;
  for (const table of tables) {
    state[table] = target[table];
  }

  if (JSON.stringify([before.outline, before.viewDirs]) !== JSON.stringify([target.outline, target.viewDirs ?? null])) {
    await store.saveField(state.field);
  }
  // 実績は計画の行を指すので、計画より先に消し、計画より後に入れる
  const keptLogs = new Set(target.logs.map((log) => log.id));
  for (const log of before.logs.filter((item) => !keptLogs.has(item.id))) {
    await store.deleteLog(log.id);
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
  const currentLogs = new Map(before.logs.map((log) => [log.id, JSON.stringify(log)]));
  for (const log of target.logs.filter((item) => currentLogs.get(item.id) !== JSON.stringify(item))) {
    await store.saveLog(log);
  }
  // 保存し直すと変わる列（作った日時）があるので、読み直して DB とそろえる
  state.logs = await store.loadLogs(state.field.id);
}

// 写しに合わせたときに消える行の数。表ごとに、消える行のある表だけを返す
export function removedRows(currentText, targetText) {
  const current = JSON.parse(currentText);
  const target = JSON.parse(targetText);
  const removed = {};
  for (const table of [...SHARED_TABLES, ...PLAN_TABLES, "logs"]) {
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
const CONFIRM_FROM = { zones: 1, blocks: 1, crops: 1, fertilizers: 1, beds: 2, plantings: 2, works: 11, logs: 2 };
const TABLE_NAMES = { zones: "区域", blocks: "区画", beds: "畝", plantings: "作付", works: "作業", crops: "品目", fertilizers: "肥料", logs: "実績" };

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
    const entry = from[from.length - 1];
    const target = entry.snap;
    // 別のプランの写しには戻さない（そのプランの中身を消してしまう）
    if (planOf(target) !== planOf(current)) {
      from.length = 0;
      throw new Error("別のプランの変更なので、戻しません");
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
    if (entry.ops.length) {
      let applied;
      try {
        applied = await undoOps(entry.ops);
      } catch (error) {
        if (!error.partial && !error.conflict) {
          from.push(entry); // 何も変わっていない（回線が切れていた、など）。もう一度試せるよう、履歴に残す
        }
        throw error;
      }
      if (applied.length) {
        to.push({ snap: current, ops: applied });
      }
    } else {
      to.push({ snap: current, ops: [] });
      try {
        await restore(target);
      } catch (error) {
        throw Object.assign(error, { partial: true });
      }
    }
    last = snapshot();
    record({ kind: label === "元に戻" ? "history.undo" : "history.redo", text: label === "元に戻" ? "直前の操作を元に戻した" : "元に戻した操作をやり直した" });
    ctx.refresh();
    ctx.setStatus(`${label}しました（あと ${from.length} 回${label}せます）`);
  } catch (error) {
    if (error.partial) {
      // 書き込みの途中で失敗した。画面は戻したあとの内容、DB は途中まで戻した状態で、履歴は戻し終えた扱いになっている。
      // そのまま続けると、画面に見えている計画と DB の計画が違うままになる。DB から読み直して画面を DB にそろえ、履歴を空にする
      ctx.setStatus(`${label}せなかったので、DB から読み直しています…`);
      await ctx.reload();
      resetHistory();
      ctx.setStatus(`DB の内容を読み直しました。${label}せませんでした: ${error.message}`);
    } else {
      ctx.setStatus(`${label}せませんでした: ${error.message}`);
      last = snapshot();
    }
  }
  busy = false;
  renderButtons();
}

export const undo = () => step(undoStack, redoStack, "元に戻");
export const redo = () => step(redoStack, undoStack, "やり直");

export function initHistory(context) {
  ctx = context;
  last = snapshot();
  // 元に戻す処理そのものの書き込み（busy のあいだ）は、覚えない
  onQueuedWrite((name, op) => {
    if (!busy && LOG_WRITES.has(name)) {
      queuedOps.push(op);
    }
  });
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

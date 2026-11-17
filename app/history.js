// 元に戻す（Ctrl+Z）と、やり直す（Ctrl+Y）。
// 履歴の 1 回ぶんは、書き込みをした操作 1 つ（押す、キーを打つ、の始まりで作る操作の ID。store.js）。
// 書き込みを列に入れるとき（store.js の onQueuedWrite）に、その操作の ID を積む。戻すときは、DB の変更の記録
// （field.audit_log）から、その操作の ID で変わった行を DB の側で操作の前に戻し（store.undoOp。DB の関数 field.undo_op）、
// 戻した行の今の中身を画面に当てる（ctx.apply。読み直さない）。戻す処理も操作の ID 付きで記録されるので、
// その ID を戻すと、やり直しになる。
// そのあとにほかの画面や端末で同じ行が変わっていたら、戻さずに知らせ、その 1 回ぶんを履歴から外す。
// 図の編集の書きかけ（まだ DB に送っていない変更）は、図の編集が持つ書きかけの履歴（ctx.draft）で、画面の中だけで行き来する。
// プランの切り替え・作成・削除、縮尺・向きの合わせ直しなどは対象外で、行うと履歴が空になる（resetHistory）。
import { confirmDelete } from "./dialog.js";
import { record } from "./journal.js";
import { currentOperation, onQueuedWrite } from "./store.js";

const $ = (id) => document.getElementById(id);

const MAX_STEPS = 50;
// 履歴に積む書き込み。DB の変更の記録の対象の表に書くもの
const UNDOABLE_WRITES = new Set(["upsert", "remove", "saveField", "saveLog", "deleteLog", "saveWorkType"]);
// 先に確かめてから消す行。区域・区画・品目・肥料は 1 件でも、畝・作付・作業・実績はふだんの 1 回ぶん
// （畝 1 本、作付 1 つとその作業、記録 1 件）より多いとき。DB の関数に上限として渡す
export const CONFIRM_FROM = { zones: 1, blocks: 1, crops: 1, fertilizers: 1, beds: 2, plantings: 2, works: 11, logs: 2 };
// 元に戻した行（field.undo_op が返す行）を、画面のどこに当てるか（app.js の applyUndo）。
// plan はいまのプランの行、shared はプランをまたいで共通の行、logs は作業の記録（記録・対象・資材をまとめて当てる）。
// DB の変更の記録の対象の表は、ここか UNDO_NOT_APPLIED のどちらかに入れる（tests/undo-tables.test.mjs が確かめる）
export const UNDO_APPLY = {
  zones: "plan",
  blocks: "plan",
  beds: "plan",
  plantings: "plan",
  works: "plan",
  crops: "shared",
  fertilizers: "shared",
  fields: "field",
  work_types: "workTypes",
  work_logs: "logs",
  work_log_targets: "logs",
  work_log_inputs: "logs",
};
// 画面に当て方を決めていない表と、そこに書く操作。どれも、行ったあとに履歴を空にする（resetHistory）ので、戻すことはない。
// 当てる行が返ったら、applyUndo は当てずに断り、DB から読み直す（Issue #3 の 3 段目で、当て方を足す）
export const UNDO_NOT_APPLIED = {
  backdrops: "下絵の読み込みと位置合わせ（圃場の設定の窓）",
  plans: "プランの作成・コピー・削除・名前の変更、実際に使うプランの切り替え",
};
const TABLE_NAMES = { zones: "区域", blocks: "区画", beds: "畝", plantings: "作付", works: "作業", crops: "品目", fertilizers: "肥料", logs: "実績" };

// ctx = { state, busy, lock, flush, apply, reload, setStatus, draft }
let ctx = null;
const undoStack = []; // 操作の ID
const redoStack = []; // 戻す処理の操作の ID
const ignored = new Set(); // 履歴を空にした操作の ID。そのあとに書いても積まない
let busy = false;

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
  const draft = ctx.draft?.();
  $("undoBtn").disabled = busy || !(draft?.canUndo || undoStack.length);
  $("redoBtn").disabled = busy || !(draft?.canRedo || redoStack.length);
}

// 図の編集の書きかけの履歴が変わったときに、ボタンを描き直す
export function renderHistoryButtons() {
  if (ctx) {
    renderButtons();
  }
}

// 書き込みを列に入れた。元に戻す処理そのものの書き込み（busy のあいだ）は積まない
function written(name, op) {
  if (busy || !UNDOABLE_WRITES.has(name) || ignored.has(op)) {
    return;
  }
  if (undoStack.at(-1) !== op) {
    undoStack.push(op);
    if (undoStack.length > MAX_STEPS) {
      undoStack.shift();
    }
  }
  redoStack.length = 0;
  renderButtons();
}

// 履歴を空にする（プランの切り替え、縮尺の合わせ直しなど、戻せない操作のあと）。その操作がこのあと書いても、積まない
export function resetHistory() {
  if (!ctx) {
    return;
  }
  undoStack.length = 0;
  redoStack.length = 0;
  ignored.add(currentOperation());
  renderButtons();
}

async function step(from, to, label) {
  if (busy || !ctx || ctx.busy()) {
    return;
  }
  const draft = ctx.draft?.();
  if (draft && (label === "元に戻" ? draft.canUndo : draft.canRedo)) {
    if (label === "元に戻") {
      draft.undo();
    } else {
      draft.redo();
    }
    ctx.setStatus(`図の編集の書きかけを${label}しました`);
    renderButtons();
    return;
  }
  // まだ送っていない保存を先に送る。その操作が履歴に積まれ、戻す処理は、その書き込みのあとに並ぶ
  await ctx.flush();
  if (busy || !from.length) {
    return;
  }
  busy = true;
  renderButtons();
  ctx.lock(true);
  ctx.setStatus(`${label}しています…`);
  const op = from.pop();
  let result = null;
  try {
    result = await ctx.state.store.undoOp(op, CONFIRM_FROM);
    if (result?.status === "confirm") {
      const list = Object.entries(result.removed).map(([table, count]) => `${TABLE_NAMES[table] ?? table} ${count} 件`).join("、");
      if (!(await confirmDelete(`${label}すと、次のものが消えます。`, list))) {
        from.push(op);
        ctx.setStatus(`${label}すのをやめました`);
        result = null;
      } else {
        result = await ctx.state.store.undoOp(op);
      }
    }
  } catch (error) {
    // DB の関数は 1 つのトランザクションなので、何も変わっていない（回線が切れていた、など）。もう一度試せるよう、履歴に残す
    from.push(op);
    ctx.setStatus(`${label}せませんでした: ${error.message}`);
    result = null;
  }
  if (result?.status === "conflict") {
    ctx.setStatus(`${label}せませんでした: ほかの画面や端末で、あとから変わっているので、戻せません`);
  } else if (result?.status === "empty") {
    ctx.setStatus(`${label}すものがありませんでした`);
  } else if (result?.status === "done") {
    to.push(result.op_id);
    try {
      ctx.apply(result);
      record({ kind: label === "元に戻" ? "history.undo" : "history.redo", text: label === "元に戻" ? "直前の操作を元に戻した" : "元に戻した操作をやり直した" });
      ctx.setStatus(`${label}しました（あと ${from.length} 回${label}せます）`);
    } catch (error) {
      // DB は戻したが、画面に当てられなかった。DB から読み直して画面を DB にそろえ、履歴を空にする
      ctx.setStatus(`${label}したあと、画面に反映できなかったので、DB から読み直しています…`);
      await ctx.reload();
      resetHistory();
      ctx.setStatus(`DB の内容を読み直しました（${error.message}）`);
    }
  }
  ctx.lock(false);
  busy = false;
  renderButtons();
}

export const undo = () => step(undoStack, redoStack, "元に戻");
export const redo = () => step(redoStack, undoStack, "やり直");

export function initHistory(context) {
  ctx = context;
  $("undoBtn").hidden = false;
  $("redoBtn").hidden = false;
  onQueuedWrite(written);
  renderButtons();

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || (key !== "z" && key !== "y") || typing()) {
      return;
    }
    event.preventDefault();
    if (key === "y" || event.shiftKey) {
      redo();
    } else {
      undo();
    }
  });
  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);
}

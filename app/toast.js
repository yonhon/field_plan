// お知らせ（トースト）。ヘッダーの真下に重ねて出し、ヘッダーや下の画面の形を変えない。
// 保存の状態の欄（#saveStatus。目に見えない記録の欄）に書かれた文を見張り、種類ごとに出し方を変える。
//   保存中…        1 秒たっても終わらないときだけ出す
//   保存しました    出さない（「保存中…」を消すだけ）
//   …を含む文      進み具合（実績を入力しています…、画像を保存中… 45% など）。次の文が来るまで出し続ける
//   失敗           「…に失敗しました: 」「…ませんでした: 」の形。自然には消さず、× で閉じる。誤りの内容は「詳しく」で窓に出す
//   それ以外        操作の結果。2 秒で消す
// 新しい版のお知らせ（#updateToast）は index.html が出し、押すまで残る
import { notify } from "./dialog.js";

const $ = (id) => document.getElementById(id);
const SAVING = "保存中…";
const SAVED = "保存しました";
const SAVING_DELAY_MS = 1000;
const INFO_MS = 2000;
const ERROR = /^(.*?(?:失敗しました|ませんでした))[:：]\s*(.*)$/s;

let transient = null; // いま出している、消えるお知らせ（進み具合も）
let hideTimer = null;
let savingTimer = null;

function removeTransient() {
  clearTimeout(hideTimer);
  transient?.remove();
  transient = null;
}

function toast(kind, text) {
  const item = document.createElement("div");
  item.className = `toast toast-${kind}`;
  const message = document.createElement("span");
  message.className = "toast-text";
  message.textContent = text;
  item.append(message);
  return item;
}

// 消えるお知らせを、前のものと置き換えて出す。ms を渡すと、その時間で消す
function showTransient(kind, text, ms) {
  removeTransient();
  transient = toast(kind, text);
  transient.setAttribute("role", "status");
  $("toasts").append(transient);
  if (ms) {
    hideTimer = setTimeout(removeTransient, ms);
  }
}

// 失敗のお知らせ。閉じるまで残す。誤りの内容は「詳しく」で窓に出す
function showError(text, detail) {
  const item = toast("error", text);
  item.setAttribute("role", "alert");
  if (detail) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "toast-btn";
    more.textContent = "詳しく";
    more.addEventListener("click", () => notify(`${text}\n${detail}`));
    item.append(more);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "閉じる");
  close.textContent = "×";
  close.addEventListener("click", () => item.remove());
  item.append(close);
  // 失敗は、消えるお知らせより上に並べる
  $("toasts").insertBefore(item, $("toasts").querySelector(".toast:not(.toast-error):not(.toast-update)"));
}

// 保存の状態の文を、お知らせにする（テストからも呼べるよう export する）
export function showStatus(text) {
  clearTimeout(savingTimer);
  if (!text || text === SAVED) {
    removeTransient();
    return;
  }
  if (text === SAVING) {
    // ふだんの保存は一瞬で終わるので、すぐには出さない。前のお知らせは残す
    savingTimer = setTimeout(() => showTransient("progress", SAVING), SAVING_DELAY_MS);
    return;
  }
  const error = ERROR.exec(text);
  if (error) {
    removeTransient();
    showError(error[1], error[2]);
  } else if (text.includes("…")) {
    showTransient("progress", text);
  } else {
    showTransient("info", text, INFO_MS);
  }
}

// 保存の状態の欄を見張り始める。書かれるたびに、お知らせに出す
export function initToasts() {
  const status = $("saveStatus");
  if (!status || !$("toasts")) {
    return;
  }
  new MutationObserver(() => showStatus(status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
}

// スマホの「元に戻す・やり直す」の小さな窓。ロゴのメニューの押しピンで出し、× で閉じるまで出しておく。
// 画面の下の真ん中に、↶（元に戻す）・↷（やり直す）・×（閉じる）を並べる。見た目は「新しい版があります」のお知らせにそろえる。
// 窓（showModal で開く窓）が開くと、その外は押せなくなり、窓の下に隠れる。そこで、いちばん上に開いている窓の中に
// この小さな窓を移す。固定の位置（position: fixed）で出すので、窓の中に移っても、画面の同じ所に同じ姿で出る。
// 窓が閉じたら、元の場所（body）に戻す。どの窓が開いたかは、ページの変化を見張って拾う（MutationObserver）。
// パソコンの幅では出さない（ヘッダーに「元に戻す」「やり直す」がある。styles.css）
import { draw } from "./draw.js";
import { historyState, redo, undo } from "./history.js";

let pad = null;
let watcher = null;

// 押しピンの形。線の太さをほかの印にそろえる
export const PIN_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M9 3h6"/><path d="M10 3v6l-3 4h10l-3-4V3"/><path d="M12 13v8"/></svg>';

function build() {
  pad = document.createElement("div");
  pad.className = "undo-pad";
  pad.setAttribute("role", "toolbar");
  pad.setAttribute("aria-label", "元に戻す・やり直す");
  draw(
    pad,
    '<button type="button" class="undo-pad-btn" data-history="undo" title="元に戻す" aria-label="元に戻す">↶</button>' +
    '<button type="button" class="undo-pad-btn" data-history="redo" title="やり直す" aria-label="やり直す">↷</button>' +
    '<button type="button" class="undo-pad-btn undo-pad-close" data-act="close" title="閉じる" aria-label="閉じる">×</button>'
  );
  pad.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) {
      return;
    }
    if (button.dataset.history === "undo") {
      undo();
    } else if (button.dataset.history === "redo") {
      redo();
    } else if (button.dataset.act === "close") {
      hideUndoPad();
    }
  });
}

// 矢印を、いま元に戻せるか・やり直せるかに合わせる。ふだんは history.js が合わせるが、窓の描き直しで小さな窓が
// 一度外れているあいだに履歴が変わると、そのときは合わせられないので、置き直すたびにも合わせる
function sync() {
  const { canUndo, canRedo } = historyState();
  pad.querySelector('[data-history="undo"]').disabled = !canUndo;
  pad.querySelector('[data-history="redo"]').disabled = !canRedo;
}

// いちばん上に開いている窓（showModal で開いた窓）の中か、body に置く。移すと、押していたボタンの選びが外れるので戻す。
// 窓の中身を描き直すと（draw）、窓の中に置いた小さな窓も外れるので、そのときも置き直す
function place() {
  if (!pad?.dataset.shown) {
    return;
  }
  const modal = [...document.querySelectorAll("dialog[open]")].filter((dialog) => dialog.matches(":modal")).at(-1);
  const home = modal || document.body;
  document.querySelectorAll("dialog.has-undo-pad").forEach((dialog) => dialog !== modal && dialog.classList.remove("has-undo-pad"));
  if (pad.parentElement === home) {
    return;
  }
  const focused = pad.contains(document.activeElement) ? document.activeElement : null;
  home.append(pad);
  modal?.classList.add("has-undo-pad"); // 窓の下の方が、小さな窓に隠れないように余白を足す
  focused?.focus({ preventScroll: true });
  sync();
}

export function showUndoPad() {
  if (!pad) {
    build();
  }
  pad.dataset.shown = "1";
  place();
  sync();
  if (!watcher) {
    watcher = new MutationObserver(place);
    watcher.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
  }
}

export function hideUndoPad() {
  watcher?.disconnect();
  watcher = null;
  if (pad) {
    delete pad.dataset.shown;
    pad.remove();
  }
  document.querySelectorAll("dialog.has-undo-pad").forEach((dialog) => dialog.classList.remove("has-undo-pad"));
}

export const undoPadShown = () => Boolean(pad?.dataset.shown);

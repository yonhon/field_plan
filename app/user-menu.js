// ヘッダーの左上（ロゴと、開いている圃場とプランの名前）と、そこを押すと開くメニュー。
// メニューには、上から、開いている圃場とプラン、スマホだけの「元に戻す」「やり直す」と押しピン（小さな窓を出す）、
// 「圃場とプランを選ぶ…」「圃場の設定…」（PC だけ）、
// ログインしているアカウントとログアウトを並べる。
// 閉じるのは、メニューの外を押したとき、Esc を押したとき、ロゴと名前をもう一度押したとき。
// ログインする前は開かない。DB を使わないモード（?local=1）では、ログアウトの代わりに、そのことを出す
import { draw } from "./draw.js";
import { escapeHtml } from "./html.js";
import { PIN_ICON, REDO_ICON, UNDO_ICON } from "./undo-pad.js";

const $ = (id) => document.getElementById(id);
const TITLE = "圃場計画"; // 圃場を開く前（ログインの画面など）に出す名前
const MIN_NAME_PX = 80; // 名前の欄の幅の下限。前に出していた題「圃場計画」（20px の 4 文字）と同じ

let account = null; // { email, local, logout }。null のあいだは開かない
let place = null; // { field, plan, trial, activeName }。開いている圃場とプラン
let actions = {}; // { choose, settings, undo, redo, undoPad, historyState }。メニューの項目を押したときに呼ぶ

// ログインが済んだら呼ぶ。logout は、ログアウトを押したときに呼ぶ関数
export function setUserMenu({ email = "", local = false, logout = null }) {
  account = { email, local, logout };
}

// 「圃場とプランを選ぶ…」「圃場の設定…」、スマホの「元に戻す」「やり直す」と押しピンを押したときに呼ぶ関数。
// historyState は、いま元に戻せるか・やり直せるか（{ canUndo, canRedo }）を返す
export function setPlaceActions({ choose, settings, undo = null, redo = null, undoPad = null, historyState = null }) {
  actions = { choose, settings, undo, redo, undoPad, historyState };
}

// スマホの幅だけに出す、元に戻す・やり直すと押しピンの並び。押すと、メニューを閉じてから 1 回だけ戻す。
// 押しピンは、元に戻す・やり直すの小さな窓を出し、× で閉じるまで出しておく（undo-pad.js）
function historyHtml() {
  if (!actions.undo) {
    return "";
  }
  const { canUndo = false, canRedo = false } = actions.historyState?.() || {};
  return (
    '<div class="user-menu-history phone-only">' +
    `<button type="button" class="user-menu-icon" data-action="undo" data-history="undo" title="元に戻す" aria-label="元に戻す"${canUndo ? "" : " disabled"}>${UNDO_ICON}</button>` +
    `<button type="button" class="user-menu-icon" data-action="redo" data-history="redo" title="やり直す" aria-label="やり直す"${canRedo ? "" : " disabled"}>${REDO_ICON}</button>` +
    `<button type="button" class="user-menu-icon" data-action="undoPad" title="元に戻す・やり直すの窓を出したままにする" aria-label="元に戻す・やり直すの窓を出したままにする">${PIN_ICON}</button>` +
    "</div>" +
    '<hr class="user-menu-sep phone-only" />'
  );
}

// 開いている圃場とプランを、ヘッダーに出す。trial は、実際に使うプランでないとき true
// fieldId と planId は、開いている圃場とプランの ID（ロゴの欄の data-field / data-plan に書く。確かめるときに読む）
export function setPlace({ field, plan, trial, activeName = "", fieldId = "", planId = "" }) {
  place = { field, plan, trial, activeName };
  $("brandMenu").dataset.field = fieldId;
  $("brandMenu").dataset.plan = planId;
  $("brandField").textContent = field || TITLE;
  $("brandField").title = field || "";
  $("brandPlan").textContent = plan ? `${plan}${trial ? " ⚠" : ""}` : "";
  $("brandPlan").title = plan || "";
  $("brandPlan").classList.toggle("is-trial", Boolean(plan && trial));
  $("brandPlan").hidden = !plan;
  $("brandMenu").classList.toggle("is-place", Boolean(field));
  fitBrand();
}

// 名前の欄の幅を決める。ヘッダーが 1 段に収まる空きの幅まで名前を出し、足りなければ「…」で省く。
// 省いても下限（80px）も入らないなら、2 段に折り返し、1 段目の幅いっぱいまで出す。
// 右側（元に戻す・やり直す）が出ているとき（PC）は、タブを真ん中に保つため、左半分の空きまでにする
export function fitBrand() {
  const header = document.querySelector(".page-header");
  const name = $("brandName");
  const tabs = $("viewTabs");
  if (!header || !name) {
    return;
  }
  if (!place?.field || !tabs || tabs.hidden) {
    name.style.width = "";
    return;
  }
  const style = getComputedStyle(header);
  const content = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const tabsStyle = getComputedStyle(tabs);
  const tabsOuter = tabs.getBoundingClientRect().width + parseFloat(tabsStyle.marginLeft) + parseFloat(tabsStyle.marginRight);
  const brand = $("brandMenu");
  const fixed = brand.querySelector(".brand-logo").getBoundingClientRect().width + parseFloat(getComputedStyle(brand).columnGap || "0");
  const rightShown = [...header.querySelector(".header-right").children].some((element) => element.offsetParent !== null);
  const room = Math.floor((rightShown ? (content - tabsOuter) / 2 : content - tabsOuter) - fixed);
  // 名前を省かずに出したときの幅。幅の決まりのない写しを作って測る
  const probe = name.cloneNode(true);
  probe.removeAttribute("id");
  probe.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  Object.assign(probe.style, { position: "absolute", visibility: "hidden", width: "auto" });
  brand.append(probe);
  const natural = Math.ceil(probe.getBoundingClientRect().width) + 1;
  probe.remove();
  const width = room >= Math.min(natural, MIN_NAME_PX) ? Math.min(natural, room) : Math.min(natural, Math.floor(content - fixed));
  name.style.width = `${Math.max(width, 0)}px`;
}

function isOpen() {
  return !$("userMenu").hidden;
}

// いま動いている版（boot.js の fieldPlanVersion）。版の印がなければ（手元の開発）出さない。
// この起動の確かめで、サーバーと同じだったら「最新の版です」、新しい版を入れ替え済みなら、読み込み直すボタンを出す
function versionHtml() {
  const version = globalThis.fieldPlanVersion;
  if (!version?.label) {
    return "";
  }
  const latest = version.status === "latest" ? '<span class="user-menu-latest">最新の版です</span>' : "";
  const update =
    version.status === "update"
      ? '<button type="button" class="user-menu-item user-menu-update" role="menuitem" data-action="reload">新しい版があります — 読み込み直す</button>'
      : "";
  return `<p class="user-menu-version">版 ${escapeHtml(version.label)}${latest}</p>${update}<hr class="user-menu-sep" />`;
}

function close() {
  $("userMenu").hidden = true;
  $("brandMenu").setAttribute("aria-expanded", "false");
}

function open() {
  if (!account) {
    return;
  }
  const accountHtml = account.local
    ? '<p class="user-menu-account">このブラウザーの中だけに保存しています</p>'
    : `<p class="user-menu-account">${escapeHtml(account.email)}</p>` +
      '<button type="button" class="user-menu-item" role="menuitem" data-action="logout">ログアウト</button>';
  const placeHtml = place?.field
    ? `<div class="user-menu-place"><strong>${escapeHtml(place.field)}</strong>` +
      `<span${place.trial ? ' class="is-trial"' : ""}>${escapeHtml(place.plan)}${place.trial ? "（実際に使うプランではありません）" : "（実際に使うプラン）"}</span></div>` +
      '<hr class="user-menu-sep" />' +
      historyHtml() +
      '<button type="button" class="user-menu-item" role="menuitem" data-action="choose">圃場とプランを選ぶ…</button>' +
      // 圃場の設定は PC だけ（下絵の調整と気象の設定。スマホの幅では出さない）
      (actions.settings ? '<button type="button" class="user-menu-item edit-only" role="menuitem" data-action="settings">圃場の設定…</button>' : "") +
      '<hr class="user-menu-sep" />'
    : "";
  draw($("userMenu"), placeHtml + versionHtml() + accountHtml);
  $("userMenu").hidden = false;
  $("brandMenu").setAttribute("aria-expanded", "true");
}

function toggle() {
  if (isOpen()) {
    close();
  } else {
    open();
  }
}

if (typeof document !== "undefined" && $("brandMenu")) {
  $("brandMenu").addEventListener("click", toggle);
  $("brandMenu").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
  $("userMenu").addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) {
      return;
    }
    close();
    if (action === "logout") {
      await account?.logout?.();
    } else if (action === "reload") {
      // 知らせの「読み込み直す」と同じ（送り残しを送ってから読み込み直す。boot.js）
      $("updateBtn")?.click();
    } else {
      actions[action]?.();
    }
  });
  // メニューの外を押したら閉じる。ロゴと名前を押したときは、上の toggle が閉じる
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (isOpen() && !event.target.closest("#userMenu, #brandMenu")) {
        close();
      }
    },
    true
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      close();
      $("brandMenu").focus();
    }
  });
  // 版や更新の確かめの結果が分かったら、開いているメニューを描き直す
  document.addEventListener("app-version", () => {
    if (isOpen()) {
      open();
    }
  });
  // 画面の幅が変わったら、名前の欄の幅を決め直す。書体を読み終えたときも（文字の幅が変わる。boot.js）
  window.addEventListener("resize", fitBrand);
  document.fonts?.addEventListener("loadingdone", () => fitBrand());
}

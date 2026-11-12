// ヘッダーの左上（ロゴと、開いている圃場とプランの名前）と、そこを押すと開くメニュー。
// メニューには、上から、開いている圃場とプラン、「圃場とプランを選ぶ…」「圃場の設定…」（PC だけ）、
// ログインしているアカウントとログアウトを並べる。
// 閉じるのは、メニューの外を押したとき、Esc を押したとき、ロゴと名前をもう一度押したとき。
// ログインする前は開かない。DB を使わないモード（?local=1）では、ログアウトの代わりに、そのことを出す
import { draw } from "./draw.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const TITLE = "圃場計画"; // 圃場を開く前（ログインの画面など）に出す名前
const MIN_NAME_PX = 80; // 名前の欄の幅の下限。前に出していた題「圃場計画」（20px の 4 文字）と同じ

let account = null; // { email, local, logout }。null のあいだは開かない
let place = null; // { field, plan, trial, activeName }。開いている圃場とプラン
let actions = {}; // { choose, settings }。メニューの項目を押したときに呼ぶ

// ログインが済んだら呼ぶ。logout は、ログアウトを押したときに呼ぶ関数
export function setUserMenu({ email = "", local = false, logout = null }) {
  account = { email, local, logout };
}

// 「圃場とプランを選ぶ…」「圃場の設定…」を押したときに呼ぶ関数
export function setPlaceActions({ choose, settings }) {
  actions = { choose, settings };
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
      '<button type="button" class="user-menu-item" role="menuitem" data-action="choose">圃場とプランを選ぶ…</button>' +
      // 圃場の設定は PC だけ（下絵の調整と気象の設定。スマホの幅では出さない）
      (actions.settings ? '<button type="button" class="user-menu-item edit-only" role="menuitem" data-action="settings">圃場の設定…</button>' : "") +
      '<hr class="user-menu-sep" />'
    : "";
  draw($("userMenu"), placeHtml + accountHtml);
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
  // 画面の幅が変わったら、名前の欄の幅を決め直す
  window.addEventListener("resize", fitBrand);
}

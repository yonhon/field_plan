// 利用者のメニュー。左上のロゴと「圃場計画」を押すと開き、ログインしているアカウントとログアウトを出す。
// 閉じるのは、メニューの外を押したとき、Esc を押したとき、ロゴと「圃場計画」をもう一度押したとき。
// ログインする前は開かない。DB を使わないモード（?local=1）では、ログアウトの代わりに、そのことを出す
import { draw } from "./draw.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let account = null; // { email, local, logout }。null のあいだは開かない

// ログインが済んだら呼ぶ。logout は、ログアウトを押したときに呼ぶ関数
export function setUserMenu({ email = "", local = false, logout = null }) {
  account = { email, local, logout };
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
  draw(
    $("userMenu"),
    account.local
      ? '<p class="user-menu-account">このブラウザーの中だけに保存しています</p>'
      : `<p class="user-menu-account">${escapeHtml(account.email)}</p>` +
          '<button type="button" class="user-menu-item" role="menuitem" data-action="logout">ログアウト</button>'
  );
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
    if (event.target.closest("[data-action]")?.dataset.action === "logout") {
      close();
      await account?.logout?.();
    }
  });
  // メニューの外を押したら閉じる。ロゴと「圃場計画」を押したときは、上の toggle が閉じる
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
}

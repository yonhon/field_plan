// 変更の記録と、「記録」の画面。
// 計画を変えるたびに、何を変えたかを 1 行ずつ残す。記録はプランから独立していて、番号は全体の通し番号。
// 日ごとに、なぜそうしたかを書くメモを 1 つ持てる。
// アプリそのものの更新（updates.json）も、同じ日の欄に並べる。こちらの番号は A12 のように A を付ける。
import { localToday } from "./schedule.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const MERGE_MINUTES = 30; // 同じ相手への同じ操作が、この時間のうちに続いたら 1 行にまとめる
const SAVE_DELAY_MS = 800;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

let ctx = null; // { state, setStatus, openTarget }
let updates = []; // アプリの更新（updates.json の中身）
const unsaved = new Set(); // まだ保存していない記録
let saveTimer = null;
let saving = false;

// 変更を 1 件記録する。
//   kind    操作の種類（例: "bed.width"）。まとめるときの見分けに使う
//   target  [相手の種類, ID]。記録の行をクリックしたときに開く相手。なければ省く
//   text    何をしたか。その時点の名前で書く（あとで名前を変えても、記録の文は変わらない）
//   before, after  変える前と後の値（あれば）。まとめたときは、最初の before と最後の after が残る
//   plan    どのプランでの変更か。省くといまのプラン。false なら、プランによらない変更（品目、縮尺など）
export function record({ kind, target = [], text, before = null, after = null, plan }) {
  if (!ctx) {
    return;
  }
  const { state } = ctx;
  const owner = plan === false ? null : plan || state.plan;
  const now = new Date();
  const [targetKind = null, targetId = null] = target;
  const recent = state.changes.find(
    (entry) =>
      entry.kind === kind &&
      entry.target_kind === targetKind &&
      entry.target_id === targetId &&
      entry.plan_id === (owner?.id || null) &&
      now - new Date(entry.last_at) < MERGE_MINUTES * 60000
  );
  if (recent) {
    // 続けて同じ操作をした: 文と「後」の値を新しくして、同じ行にまとめる
    Object.assign(recent, { text, after: after === null ? recent.after : String(after), last_at: now.toISOString() });
    queue(recent);
    return;
  }
  const entry = {
    id: crypto.randomUUID(),
    field_id: state.field.id,
    no: null, // 保存するときに振られる
    at: now.toISOString(),
    last_at: now.toISOString(),
    day: localToday(now),
    plan_id: owner?.id || null,
    plan_name: owner?.name || "",
    kind,
    target_kind: targetKind,
    target_id: targetId,
    text,
    before: before === null ? null : String(before),
    after: after === null ? null : String(after),
  };
  state.changes.unshift(entry);
  queue(entry);
}

function queue(entry) {
  unsaved.add(entry);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

// たまった記録を保存する。番号は保存の順に振られるので、古いものから 1 件ずつ送る
async function flush() {
  if (saving) {
    saveTimer = setTimeout(flush, SAVE_DELAY_MS);
    return;
  }
  saving = true;
  const entries = [...unsaved].sort((a, b) => a.at.localeCompare(b.at));
  unsaved.clear();
  try {
    for (const entry of entries) {
      if (entry.no === null) {
        entry.no = await ctx.state.store.addChange(entry);
      } else {
        await ctx.state.store.saveChange(entry);
      }
    }
  } catch (error) {
    entries.forEach((entry) => unsaved.add(entry));
    ctx.setStatus(`変更の記録を保存できませんでした: ${error.message}`);
  }
  saving = false;
  if (!$("journalView").hidden) {
    renderJournal();
  }
}

// ---- 「記録」の画面 ----

function dayTitle(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${year}/${month}/${day}（${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}）`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });

// 記録の文。値の変化があれば、後ろに「（前 → 後）」を付ける。新しく作ったものは、後の値だけを付ける
export function changeText(entry) {
  if (entry.before !== null) {
    return `${entry.text}（${entry.before} → ${entry.after ?? "なし"}）`;
  }
  return entry.after !== null ? `${entry.text}（${entry.after}）` : entry.text;
}

// メモの中の「#41」（計画の変更）や「A12」（アプリの更新）のような番号。その行へ飛ぶボタンにする。
// 戻り値は、行の ID に使う "41" や "A12" の形
const references = (body) => [
  ...new Set([...body.matchAll(/[#＃](\d+)|(?<![A-Za-z])[AＡ](\d+)/g)].map((match) => (match[1] ? match[1] : `A${match[2]}`))),
];

export function renderJournal() {
  if (!ctx) {
    return;
  }
  const { state } = ctx;
  const notes = new Map(state.notes.map((note) => [note.day, note.body]));
  // 今日は、変更がなくてもメモを書けるように必ず出す
  const days = [
    ...new Set([
      localToday(),
      ...state.changes.map((entry) => entry.day),
      ...state.notes.filter((note) => note.body).map((note) => note.day),
      ...updates.map((update) => update.date),
    ]),
  ]
    .sort()
    .reverse();
  const numbers = new Set([...state.changes.map((entry) => String(entry.no)), ...updates.map((update) => `A${update.no}`)]);
  $("journalDays").innerHTML = days
    .map((day) => {
      const entries = state.changes.filter((entry) => entry.day === day);
      const body = notes.get(day) || "";
      const links = references(body)
        .map((no) => `<button class="chip-btn ref-btn" data-ref="${no}"${numbers.has(no) ? "" : " disabled"}>${no.startsWith("A") ? no : `#${no}`}</button>`)
        .join("");
      const rows = entries.length
        ? entries
            .map(
              (entry) =>
                `<li id="change-${entry.no ?? entry.id}" data-id="${entry.id}">` +
                `<span class="change-no">${entry.no === null ? "#…" : `#${entry.no}`}</span>` +
                `<span class="change-time">${clock(entry.at)}</span>` +
                `<span class="change-plan">${escapeHtml(entry.plan_name || "共通")}</span>` +
                `<span class="change-text">${escapeHtml(changeText(entry))}</span></li>`
            )
            .join("")
        : '<li class="muted">計画の変更はありません</li>';
      // アプリの更新は、時刻が分からないので、その日の欄の下にまとめて出す
      const released = updates
        .filter((update) => update.date === day)
        .sort((a, b) => b.no - a.no)
        .map(
          (update) =>
            `<li id="change-A${update.no}" class="update-row"><span class="change-no">A${update.no}</span>` +
            `<span class="change-plan is-app">アプリ</span><span class="change-text"><strong>${escapeHtml(update.title)}</strong>` +
            `<span class="update-body">${escapeHtml(update.body)}</span>` +
            `${update.reason ? `<span class="update-body">きっかけ: ${escapeHtml(update.reason)}</span>` : ""}</span></li>`
        )
        .join("");
      return (
        `<section class="panel journal-day" data-day="${day}"><h2>${dayTitle(day)}</h2>` +
        `<label>メモ（なぜそうしたか。記録の番号は #41 のように書くと、その行へ飛べます）` +
        `<textarea data-note="${day}" rows="${Math.min(Math.max(body.split("\n").length, 2), 10)}">${escapeHtml(body)}</textarea></label>` +
        `${links ? `<div class="row journal-refs"><span class="muted">メモが触れている記録:</span>${links}</div>` : ""}` +
        `<ul class="change-list">${rows}</ul>` +
        `${released ? `<h3>アプリの更新</h3><ul class="change-list">${released}</ul>` : ""}</section>`
      );
    })
    .join("");
}

export async function initJournal(context) {
  ctx = context;
  const { state } = ctx;
  state.changes = await state.store.listChanges(state.field.id);
  state.notes = await state.store.listNotes(state.field.id);
  // アプリの更新の一覧は、読めなくても画面は使える
  updates = await fetch("./updates.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : []))
    .catch(() => []);

  $("journalDays").addEventListener("change", (event) => {
    const day = event.target.dataset.note;
    if (!day) {
      return;
    }
    const body = event.target.value;
    const note = state.notes.find((item) => item.day === day);
    if (note) {
      note.body = body;
    } else {
      state.notes.push({ field_id: state.field.id, day, body });
    }
    ctx.setStatus("保存中…");
    state.store
      .saveNote({ field_id: state.field.id, day, body })
      .then(() => ctx.setStatus("保存しました"))
      .catch((error) => ctx.setStatus(`メモを保存できませんでした: ${error.message}`));
    renderJournal();
  });
  $("journalDays").addEventListener("click", (event) => {
    const reference = event.target.closest("[data-ref]");
    const row = event.target.closest("li[data-id]");
    if (reference) {
      // メモが触れている記録の行へ動かして、少しのあいだ色を付ける
      const line = document.getElementById(`change-${reference.dataset.ref}`);
      line.scrollIntoView({ block: "center", behavior: "smooth" });
      line.classList.add("is-marked");
      setTimeout(() => line.classList.remove("is-marked"), 2500);
    } else if (row) {
      ctx.openTarget(state.changes.find((entry) => entry.id === row.dataset.id));
    }
  });
  // 画面を閉じる前に、まだ送っていない記録を送る
  window.addEventListener("pagehide", () => {
    if (unsaved.size) {
      clearTimeout(saveTimer);
      flush();
    }
  });
}

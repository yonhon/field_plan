// 変更の記録と、「記録」の画面（アプリの開発日誌）。
// 計画を変えるたびに、何を変えたかを 1 行ずつ残す。記録はプランから独立していて、番号は全体の通し番号。
// 画面には、すべての圃場の記録を並べる。日ごとに、なぜそうしたかを書くメモを 1 つ持てる（すべての圃場で共通）。
// アプリそのものの更新（updates.json）も、同じ日の欄に並べる。こちらの番号は A12 のように A を付ける。
import { addDays, localToday } from "./schedule.js";
import { draw } from "./draw.js";
import { escapeHtml } from "./html.js";

const $ = (id) => document.getElementById(id);
const MERGE_MINUTES = 30; // 同じ相手への同じ操作が、この時間のうちに続いたら 1 行にまとめる
const SAVE_DELAY_MS = 800;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

let ctx = null; // { state, setStatus, openTarget, onRecorded }
let updates = []; // アプリの更新（updates.json の中身）
const unsaved = new Set(); // まだ保存していない記録
let saveTimer = null;
let saving = false;
let held = null; // 図の編集のあいだ溜めておく記録（record の引数）。保存したら記録し、捨てたら捨てる

// 記録は増え続けるので、起動のときは最近の分だけ読み、画面にも最近の日だけ描く。
// 起動は、この読み込みを待たない（「元に戻す」の用意やアプリの更新の確認を遅らせない）
const RECENT_DAYS = 14; // 起動のときに読む日数（暦の日）。画面に 1 回に描き足す日数（記録やメモのある日）
const OLDER_LIMIT = 300; // 「さらに前」で 1 回に読む記録の件数の目安（最後の日は、途中で切れないよう、その日の分をすべて読む）
let loading = null; // 起動の読み込み（Promise）。失敗したら null に戻し、次に画面を開いたときに読み直す
let loaded = false;
let loadError = null;
let loadedFrom = null; // この日より前の記録は、まだ読んでいない。null は、すべて読んだ
let loadingOlder = false;
let updatesLoading = null; // アプリの更新の一覧（updates.json）。履歴の画面を初めて開いたときに読む
let updatesReady = false;
let shownDays = RECENT_DAYS; // 画面に描く日の数
let planLast = new Map(); // プランごとの最後の変更の時刻（DB の field.plan_last_changes。読んでいない古い記録の分も入る）

// 図の編集を始めるときに呼ぶ。それからの記録は、releaseRecords まで溜めておく
export function holdRecords() {
  held = [];
}

// 溜めた記録を、commit なら記録し、そうでなければ捨てる。溜めるのはやめる
export function releaseRecords(commit) {
  const list = held || [];
  held = null;
  if (commit) {
    list.forEach((args) => record(args));
  }
}

// 変更を 1 件記録する。
//   kind    操作の種類（例: "bed.width"）。まとめるときの見分けに使う
//   target  [相手の種類, ID]。記録の行をクリックしたときに開く相手。なければ省く
//   text    何をしたか。その時点の名前で書く（あとで名前を変えても、記録の文は変わらない）
//   before, after  変える前と後の値（あれば）。まとめたときは、最初の before と最後の after が残る
//   plan    どのプランでの変更か。省くといまのプラン。false なら、プランによらない変更（品目、縮尺など）
//   field   どの圃場での変更か。省くといまの圃場（「圃場とプラン」の窓で、開いていない圃場を直すときに渡す）
export function record({ kind, target = [], text, before = null, after = null, plan, field }) {
  if (!ctx) {
    return;
  }
  if (held) {
    // 図の編集の書きかけ。どのプラン・圃場の変更かは、いまのものを覚えておく
    held.push({ kind, target, text, before, after, plan: plan === false ? false : plan || ctx.state.plan, field: field || ctx.state.field });
    return;
  }
  const { state } = ctx;
  // 記録した変更を、画面にも知らせる（畝の形を変えたら、今までの記録の面積にも当てはめるかを尋ねる。app.js）
  ctx.onRecorded?.(kind);
  const owner = plan === false ? null : plan || state.plan;
  const fieldId = (field || state.field).id;
  const now = new Date();
  const [targetKind = null, targetId = null] = target;
  const recent = state.changes.find(
    (entry) =>
      entry.kind === kind &&
      entry.field_id === fieldId &&
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
    field_id: fieldId,
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

// そのプランの、最後の変更の時刻（ISO の文字）。記録がなければ空。
// 起動のときに読んだ DB の値と、読んだあとに記録した分の、新しい方
export function lastChangeAt(planId) {
  if (!ctx?.state.changes) {
    return "";
  }
  const times = [planLast.get(planId), ...ctx.state.changes.filter((entry) => entry.plan_id === planId).map((entry) => entry.last_at)].filter(Boolean);
  return times.reduce((last, time) => (!last || Date.parse(time) > Date.parse(last) ? time : last), "");
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
    ctx.setStatus(`変更の履歴を保存できませんでした: ${error.message}`);
  }
  saving = false;
  if (!$("journalView").hidden) {
    renderJournal();
  }
}

// まだ保存していない記録を、いま保存する（圃場を消す前など。消したあとでは、その圃場の記録を保存できない）
export async function saveJournalNow() {
  clearTimeout(saveTimer);
  while (saving) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await flush();
}

// ---- 「記録」の画面 ----

function dayTitle(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${year}/${month}/${day}（${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}）`;
}

// 書式は作るのに時間がかかるので、1 つを使い回す（記録は数百行ある）
const CLOCK = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
const clock = (iso) => CLOCK.format(new Date(iso));

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

const visible = () => !$("journalView").hidden;

// 読んだ古い記録を、並びの後ろに足す。もう持っている記録は足さない
function addOlder(rows) {
  const known = new Set(ctx.state.changes.map((entry) => entry.id));
  ctx.state.changes.push(...rows.filter((entry) => !known.has(entry.id)));
}

// 起動の読み込み。最近 RECENT_DAYS 日の記録、メモ、プランごとの最後の変更
function startLoading() {
  const { state } = ctx;
  const fromDay = addDays(localToday(), -(RECENT_DAYS - 1));
  loading = Promise.all([state.store.listChanges({ fromDay }), state.store.listNotes(), state.store.planLastChanges().catch(() => [])])
    .then(([changes, notes, lasts]) => {
      // 読んでいるあいだに記録した分（読んだものより新しい）は、前に残す
      const kept = new Set(state.changes.map((entry) => entry.id));
      state.changes = [...state.changes, ...changes.filter((entry) => !kept.has(entry.id))];
      state.notes = notes;
      planLast = new Map(lasts.map((row) => [row.plan_id, row.last_at]));
      loadedFrom = fromDay;
      loaded = true;
      loadError = null;
    })
    .catch((error) => {
      loading = null;
      loadError = error;
      ctx.setStatus(`変更の履歴を読み込めませんでした: ${error.message}`);
    })
    .finally(() => {
      if (visible()) {
        renderJournal();
      }
    });
  return loading;
}

// アプリの更新の一覧。読めなくても画面は使える
function loadUpdates() {
  updatesLoading ||= fetch("./updates.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : []))
    .catch(() => [])
    .then((list) => {
      updates = list;
      updatesReady = true;
      if (visible()) {
        renderJournal();
      }
    });
}

// 画面に出せる日（新しい順）。今日は、変更がなくてもメモを書けるように必ず出す。
// まだ記録を読んでいない日は出さない（メモやアプリの更新だけがあっても、その日の記録が抜けて見える）
function journalDays() {
  const { state } = ctx;
  return [
    ...new Set([
      localToday(),
      ...state.changes.map((entry) => entry.day),
      ...state.notes.filter((note) => note.body).map((note) => note.day),
      ...updates.map((update) => update.date),
    ]),
  ]
    .filter((day) => loadedFrom === null || day >= loadedFrom)
    .sort()
    .reverse();
}

// 記録を、day の日の分まで読み足す（day から、読んだいちばん古い日の前まで）
async function loadUntil(day) {
  if (loadedFrom === null || day >= loadedFrom) {
    return;
  }
  addOlder(await ctx.state.store.listChanges({ fromDay: day, beforeDay: loadedFrom }));
  loadedFrom = day;
}

// 「さらに前を見る」。描いていない日があれば描き足す。なければ、前の記録を読み足してから描き足す
async function showOlder() {
  if (loadingOlder) {
    return;
  }
  loadingOlder = true;
  renderJournal();
  try {
    if (journalDays().length <= shownDays && loadedFrom !== null) {
      const rows = await ctx.state.store.listChanges({ beforeDay: loadedFrom, limit: OLDER_LIMIT });
      if (rows.length < OLDER_LIMIT) {
        addOlder(rows);
        loadedFrom = null;
      } else {
        // 件数で切ったので、いちばん古い日は途中までかもしれない。その日の分をすべて読む
        await loadUntil(rows.at(-1).day);
      }
    }
    shownDays += RECENT_DAYS;
  } catch (error) {
    ctx.setStatus(`前の記録を読み込めませんでした: ${error.message}`);
  } finally {
    loadingOlder = false;
    renderJournal();
  }
}

// メモが触れている番号の行へ動かして、少しのあいだ色を付ける。まだ読んでいない・描いていない日の行なら、その日まで読んで描く
async function jumpTo(ref) {
  const { state } = ctx;
  let line = document.getElementById(`change-${ref}`);
  if (!line) {
    try {
      const day = ref.startsWith("A")
        ? updates.find((update) => `A${update.no}` === ref)?.date
        : state.changes.find((entry) => String(entry.no) === ref)?.day ?? (await state.store.changeDay(Number(ref)));
      if (!day) {
        ctx.setStatus(`${ref.startsWith("A") ? ref : `#${ref}`} の記録は見つかりません`);
        return;
      }
      await loadUntil(day);
      shownDays = Math.max(shownDays, journalDays().indexOf(day) + 1);
      renderJournal();
    } catch (error) {
      ctx.setStatus(`記録を読み込めませんでした: ${error.message}`);
      return;
    }
    line = document.getElementById(`change-${ref}`);
    if (!line) {
      return;
    }
  }
  // 画面の外の日は高さを見積もりで置いているので、飛ぶあいだは、描いた日をすべて配置して位置を正しくする
  $("journalDays").classList.add("is-jumping");
  line.scrollIntoView({ block: "center", behavior: "smooth" });
  line.classList.add("is-marked");
  setTimeout(() => {
    line.classList.remove("is-marked");
    $("journalDays").classList.remove("is-jumping");
  }, 2500);
}

// 履歴の画面を描く。隠れているあいだは描かない（開いたときに showView から呼ばれる）
export function renderJournal() {
  if (!ctx || !visible()) {
    return;
  }
  loadUpdates();
  if (!loaded || !updatesReady) {
    if (!loaded && !loading) {
      startLoading(); // 前に失敗していたら、読み直す
    }
    const text = loadError && !loading ? "変更の履歴を読み込めませんでした。" : "変更の履歴を読み込んでいます…";
    draw($("journalDays"), `<p class="muted journal-loading">${text}</p>`);
    return;
  }
  const { state } = ctx;
  const notes = new Map(state.notes.map((note) => [note.day, note.body]));
  // 圃場が 2 つ以上あるときは、どの圃場の記録かも出す
  const fieldName = (entry) => state.fields.find((field) => field.id === entry.field_id)?.name || "（もうない圃場）";
  const where = (entry) => `${state.fields.length > 1 ? `${fieldName(entry)} / ` : ""}${entry.plan_name || "共通"}`;
  const all = journalDays();
  const days = all.slice(0, shownDays);
  const numbers = new Set([...state.changes.map((entry) => String(entry.no)), ...updates.map((update) => `A${update.no}`)]);
  // まだ読んでいない古い記録の番号かもしれないので、読み終えるまでは、知らない #番号も押せるようにする
  const known = (no) => numbers.has(no) || (!no.startsWith("A") && loadedFrom !== null);
  const more =
    all.length > shownDays || loadedFrom !== null
      ? `<div class="journal-more"><button class="chip-btn" data-act="older"${loadingOlder ? " disabled" : ""}>${loadingOlder ? "読み込んでいます…" : `さらに前の ${RECENT_DAYS} 日を見る`}</button></div>`
      : '<p class="muted journal-more">これより前の記録はありません。</p>';
  draw(
    $("journalDays"),
    days
      .map((day) => {
        const entries = state.changes.filter((entry) => entry.day === day);
        const body = notes.get(day) || "";
        const links = references(body)
          .map((no) => `<button class="chip-btn ref-btn" data-ref="${no}"${known(no) ? "" : " disabled"}>${no.startsWith("A") ? no : `#${no}`}</button>`)
          .join("");
        const rows = entries.length
          ? entries
              .map(
                (entry) =>
                  `<li id="change-${entry.no ?? entry.id}" data-id="${entry.id}">` +
                  `<span class="change-no">${entry.no === null ? "#…" : `#${entry.no}`}</span>` +
                  `<span class="change-time">${clock(entry.at)}</span>` +
                  `<span class="change-plan">${escapeHtml(where(entry))}</span>` +
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
          `<label>メモ（なぜそうしたか。変更の番号は #41 のように書くと、その行へ飛べます）` +
          `<textarea data-note="${day}" rows="${Math.min(Math.max(body.split("\n").length, 2), 10)}">${escapeHtml(body)}</textarea></label>` +
          `${links ? `<div class="row journal-refs"><span class="muted">メモが触れている変更:</span>${links}</div>` : ""}` +
          `<ul class="change-list">${rows}</ul>` +
          `${released ? `<h3>アプリの更新</h3><ul class="change-list">${released}</ul>` : ""}</section>`
        );
      })
      .join("") + more
  );
}

// 起動のときに呼ぶ。記録の入れ物を先に空で用意して、読み込みは裏で行う（呼んだ側は待たない）。
// 読んでいるあいだに記録した分は、読み終えたときに合わせる
export function initJournal(context) {
  ctx = context;
  const { state } = ctx;
  state.changes = [];
  state.notes = [];

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
      state.notes.push({ day, body });
    }
    ctx.setStatus("保存中…");
    state.store
      .saveNote({ day, body })
      .then(() => ctx.setStatus("保存しました"))
      .catch((error) => ctx.setStatus(`メモを保存できませんでした: ${error.message}`));
    renderJournal();
  });
  $("journalDays").addEventListener("click", (event) => {
    const reference = event.target.closest("[data-ref]");
    const row = event.target.closest("li[data-id]");
    if (event.target.closest('[data-act="older"]')) {
      showOlder();
    } else if (reference) {
      jumpTo(reference.dataset.ref);
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
  return startLoading();
}

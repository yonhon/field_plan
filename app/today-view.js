// 「今日」のタブと、計測中の帯（作業時間の計測。docs の 4.6）。計算は work-time.js。
// - 計測中の帯: ヘッダーの下に、どの画面でも出す。作業の名前、始めた時刻、経過した時間と、「休憩」「止める」。
//   休憩のあいだは「再開」で同じ作業を始め直せる（休憩の時間は数えない）。
// - 「今日」のタブ: 準備・片付け、移動、計画にない作業を始めるボタンと、今週やること・遅れている作業の欄（圃場図の上の欄を
//   このタブへ移して出す。行の「始める」は schedule-view.js）と、その日の作業時間の一覧（時刻を直す、あとで入れる、消す）。
// - 止め忘れて日をまたいだ計測は、開いたときに、止めた時刻を尋ねる。
// 計測は、ほかの書き込みと同じく state.store を通して保存し、元に戻すの対象にする（history.js の UNDOABLE_WRITES）
import { draw } from "./draw.js";
import { escapeHtml } from "./html.js";
import { notify, notifySaveFailed, confirmDelete } from "./dialog.js";
import { localToday, workName } from "./schedule.js";
import {
  COMMON_KINDS,
  SESSION_KINDS,
  checkTimes,
  clockOf,
  daySessions,
  formatMinutes,
  isStale,
  isoAt,
  localDateOf,
  runningSession,
  runningWorkIds,
  sessionMinutes,
  sessionTotals,
  startWrites,
} from "./work-time.js";
import { askNoticePermission, syncTimerNotice, timerNoticeText } from "./timer-notice.js";

const $ = (id) => document.getElementById(id);
const PAUSE_KEY = "field_plan_paused"; // 休憩中の作業（再開で始め直す中身）。この端末だけ
const TICK_MS = 15 * 1000; // 経過した時間を書き直す間

let ctx = null; // { state, setStatus, refresh, typeLabel, fieldName }
let day = null; // 作業時間の一覧で見ている日。null は今日
let saving = false; // 計測の保存の返事を待っているあいだ true（続けて押しても、二重に始めない）
let ticker = null;
const asked = new Set(); // 止めた時刻をもう尋ねた計測の ID（同じ画面で何度も尋ねない）

const state = () => ctx.state;
const sessions = () => state().sessions || [];
const shownDay = () => day || localToday();

function loadPaused() {
  try {
    return JSON.parse(localStorage.getItem(PAUSE_KEY) || "null");
  } catch {
    return null;
  }
}

function savePaused(value) {
  try {
    if (value) {
      localStorage.setItem(PAUSE_KEY, JSON.stringify(value));
    } else {
      localStorage.removeItem(PAUSE_KEY);
    }
  } catch {
    // 覚えられなくても、休憩はできる（再開のボタンが出ないだけ）
  }
}

// 計測の名前。実績につないだ計測は、その実績の名前（つないだときにも名前を写すが、あとで実績を直したら、その名前に合わせる）。
// 計画の作業なら始めたときの名前、共通の時間（観察、準備・片付け、移動）はその名前
export function sessionLabel(session) {
  if (session.kind !== "work") {
    return SESSION_KINDS[session.kind];
  }
  const log = session.log_id && (state().logs || []).find((item) => item.id === session.log_id);
  if (log) {
    return logName(log);
  }
  return session.label || ctx.typeLabel(session.work_type) || "作業";
}

// 計測した行を、画面の計測の一覧に当てる
function put(row) {
  const list = sessions().filter((item) => item.id !== row.id);
  list.push(row);
  state().sessions = list.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

// 計測を保存する。rows は保存する行の並び。失敗したら知らせ、DB の中身に戻すため読み直しを頼む
async function save(rows, done) {
  if (saving) {
    return false;
  }
  saving = true;
  try {
    for (const row of rows) {
      put(await state().store.saveSession(row));
    }
    ctx.setStatus(done);
    return true;
  } catch (error) {
    ctx.setStatus(`作業時間を保存できませんでした: ${error.message}`);
    notifySaveFailed(error);
    return false;
  } finally {
    saving = false;
    refresh();
  }
}

function refresh() {
  ctx.refresh();
  renderToday();
}

// 作業を始める。start は { kind, work_type, work_ids, label }。計測中の作業があれば、同じ時刻で止める
export async function startSession(start) {
  if (!state().field) {
    return;
  }
  // 通知の許しは、押した操作の続きでしか尋ねられないので、保存を待つ前に尋ねる
  askNoticePermission(renderToday);
  savePaused(null);
  const row = { field_id: state().field.id, ...start };
  const name = sessionLabel(row);
  await save(startWrites(sessions(), row), `${name}を始めました`);
}

// 今週やることの行の「始める」。works は、その行の計画の作業
export function startWorks(works, label) {
  return startSession({ kind: "work", work_type: works[0].work_type, work_ids: works.map((work) => work.id), label });
}

// 計測中の作業を止める。pause なら、再開できるように中身を覚える
export async function stopRunning({ pause = false } = {}) {
  const running = runningSession(sessions());
  if (!running) {
    return;
  }
  const at = new Date().toISOString();
  const saved = await save([{ ...running, stopped_at: at < running.started_at ? running.started_at : at }], pause ? "休憩にしました" : `${sessionLabel(running)}を止めました`);
  if (saved && pause) {
    const { kind, work_type, work_ids, label, field_id } = running;
    savePaused({ kind, work_type, work_ids, label, field_id, at });
    renderToday();
  }
}

// 「完了」を押した作業が計測中なら、止める（完了にしたあとまで測り続けない）
export async function stopIfRunning(workIds) {
  const running = runningSession(sessions());
  if (running && (running.work_ids || []).some((id) => workIds.includes(id))) {
    await stopRunning();
  }
}

// 計測中の作業の、計画の作業の ID（今週やることの行に「計測中」と出す）
export const runningIds = () => runningWorkIds(sessions());

// ---- 計測中の帯 ----

function renderBar() {
  const bar = $("timerBar");
  if (!bar || !ctx || !state().field) {
    return;
  }
  const running = runningSession(sessions());
  const paused = running ? null : loadPaused();
  const where = running && running.field_id !== state().field.id ? `（${ctx.fieldName(running.field_id)}）` : "";
  // 端末の通知欄にも、計測中の作業を帯と同じ名前で出す（休憩中は出さない）
  syncTimerNotice(running ? timerNoticeText(`${sessionLabel(running)}${where}`, clockOf(running.started_at)) : null);
  if (!running && !paused) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  bar.hidden = false;
  if (running) {
    draw(
      bar,
      `<span class="timer-dot" aria-hidden="true"></span>` +
        `<span class="timer-name">${escapeHtml(sessionLabel(running))}${escapeHtml(where)}</span>` +
        `<span class="timer-time">${clockOf(running.started_at)} から <strong>${formatMinutes(sessionMinutes(running))}</strong></span>` +
        `<span class="timer-actions"><button type="button" class="chip-btn" data-timer="pause">休憩</button>` +
        `<button type="button" class="primary-btn" data-timer="stop">止める</button></span>`
    );
  } else {
    draw(
      bar,
      `<span class="timer-name is-paused">休憩中（${clockOf(paused.at)} から）: ${escapeHtml(paused.label || SESSION_KINDS[paused.kind] || "作業")}</span>` +
        `<span class="timer-actions"><button type="button" class="primary-btn" data-timer="resume">再開</button>` +
        `<button type="button" class="text-btn" data-timer="forget" title="再開しないで、休憩の表示を消します">閉じる</button></span>`
    );
  }
}

async function onBarClick(event) {
  const action = event.target.closest("[data-timer]")?.dataset.timer;
  if (action === "stop") {
    await stopRunning();
  } else if (action === "pause") {
    await stopRunning({ pause: true });
  } else if (action === "resume") {
    const paused = loadPaused();
    if (paused) {
      const { at, ...start } = paused;
      await startSession(start);
    }
  } else if (action === "forget") {
    savePaused(null);
    renderToday();
  }
}

// ---- 「今日」のタブ ----

// 計測中の帯と、「今日」のタブを描く。データが変わったとき、タブを開いたとき、経過した時間を書き直すときに呼ぶ
export function renderToday() {
  if (!ctx || !state().field) {
    return;
  }
  renderBar();
  askStale();
  const running = runningSession(sessions());
  clearInterval(ticker);
  ticker = running ? setInterval(renderToday, TICK_MS) : null;
  if ($("todayView").hidden) {
    return;
  }
  draw(
    $("todayStart"),
    COMMON_KINDS.map((kind) => `<button type="button" class="chip-btn" data-today="${kind}">${SESSION_KINDS[kind]}</button>`).join("") +
      `<button type="button" class="chip-btn" data-today="other">計画にない作業…</button>`
  );
  const date = shownDay();
  const list = daySessions(sessions(), state().field.id, date);
  const totals = sessionTotals(list);
  const rows = list
    .map((session) => {
      const range = `${clockOf(session.started_at)}–${session.stopped_at ? clockOf(session.stopped_at) : ""}`;
      const kind = session.kind === "work" ? "" : " is-common";
      const mark = session.source === "edited" ? '<span class="muted" title="あとで時刻を直したか、入れた時間です">（直した）</span>' : "";
      return (
        `<li class="session-row${kind}" data-session="${escapeHtml(session.id)}">` +
        `<span class="session-range">${range}${session.stopped_at ? "" : '<span class="session-live">計測中</span>'}</span>` +
        `<span class="session-name">${escapeHtml(sessionLabel(session))}${mark}</span>` +
        `<span class="session-minutes">${formatMinutes(sessionMinutes(session))}</span>` +
        `<button type="button" class="text-btn" data-today="edit" data-id="${escapeHtml(session.id)}">直す</button></li>`
      );
    })
    .join("");
  const today = localToday();
  draw(
    $("todaySessions"),
    `<div class="panel-heading"><h2>作業時間</h2>` +
      `<span class="seg"><button type="button" class="chip-btn" data-today="prev" aria-label="前の日">‹</button>` +
      `<button type="button" class="chip-btn${date === today ? " is-on" : ""}" data-today="today">${date === today ? "今日" : formatDate(date)}</button>` +
      `<button type="button" class="chip-btn" data-today="next" aria-label="次の日"${date >= today ? " disabled" : ""}>›</button></span>` +
      `<button type="button" class="chip-btn" data-today="add">＋ 時間を入れる</button></div>` +
      (rows ? `<ul class="session-list">${rows}</ul>` : '<p class="muted">この日の計測はありません。</p>') +
      `<p class="session-totals">作業 ${formatMinutes(totals.work)}${COMMON_KINDS.map((kind) => `・${SESSION_KINDS[kind]} ${formatMinutes(totals[kind])}`).join("")}` +
      `<strong>合計 ${formatMinutes(totals.total)}</strong></p>` +
      '<details class="note-fold"><summary>測り方</summary><p class="muted">次の作業の「始める」を押すと、前の作業は止まります。休憩と、その日の最後の作業のあとは「止める」を押してください。押し忘れたときは「直す」で時刻を直すか、「＋ 時間を入れる」で入れます。</p></details>'
  );
}

function formatDate(iso) {
  const [, month, date] = iso.split("-").map(Number);
  return `${month}/${date}`;
}

function shiftDay(iso, days) {
  const [year, month, date] = iso.split("-").map(Number);
  return localToday(new Date(year, month - 1, date + days));
}

async function onTodayClick(event) {
  const button = event.target.closest("[data-today]");
  if (!button) {
    return;
  }
  const action = button.dataset.today;
  if (COMMON_KINDS.includes(action)) {
    await startSession({ kind: action });
  } else if (action === "other") {
    chooseType();
  } else if (action === "prev" || action === "next") {
    const next = shiftDay(shownDay(), action === "prev" ? -1 : 1);
    day = next >= localToday() ? null : next;
    renderToday();
  } else if (action === "today") {
    day = null;
    renderToday();
  } else if (action === "edit") {
    const session = sessions().find((item) => item.id === button.dataset.id);
    if (session) {
      editSession(session);
    }
  } else if (action === "add") {
    editSession(null);
  }
}

// 計画にない作業の種類を選んで始める
function chooseType() {
  const types = [...(state().allWorkTypes || state().workTypes)].sort((a, b) => a.sort - b.sort);
  const box = document.createElement("dialog");
  box.className = "notice today-types";
  draw(
    box,
    '<p class="notice-text">始める作業の種類を選んでください。</p><div class="today-type-list">' +
      types.map((type) => `<button type="button" class="chip-btn" data-type="${escapeHtml(type.code)}">${escapeHtml(type.label)}</button>`).join("") +
      '</div><div class="row"><button type="button" class="text-btn" data-type="">キャンセル</button></div>'
  );
  box.addEventListener("click", async (event) => {
    const code = event.target.closest("[data-type]")?.dataset.type;
    if (code === undefined) {
      return;
    }
    box.close();
    if (code) {
      await startSession({ kind: "work", work_type: code, work_ids: [], label: ctx.typeLabel(code) });
    }
  });
  box.addEventListener("close", () => box.remove());
  document.body.append(box);
  box.showModal();
}

// その日の作業の記録（計画にない作業の計測をつなぐ先）
function dayLogs(date) {
  return (state().logs || []).filter((log) => log.field_id === state().field.id && log.date <= date && (log.end_date || log.date) >= date);
}

// 実績の名前。例: 株の手入れ（摘葉・誘引） 区画A 畝1 試験菜、区画A 畝2 試験菜
function logName(log) {
  const places = (log.targets || []).map((target) => target.label).filter(Boolean);
  const where = places.length > 3 ? `${places.slice(0, 3).join("、")} ほか ${places.length - 3} か所` : places.join("、");
  return `${workName(ctx.typeLabel(log.work_type), log.spec)}${where ? ` ${where}` : ""}`;
}

// 計測の時刻を直す窓（session が null なら、あとで時間を入れる）。message は、窓の上に出す文
function editSession(session, message = "") {
  const date = session ? localDateOf(session.started_at) : shownDay();
  const running = session && !session.stopped_at;
  const logs = dayLogs(date);
  const kindChoices = session
    ? ""
    : '<label>中身<select data-field="what">' +
      (logs.length ? `<optgroup label="この日の実績">${logs.map((log) => `<option value="log:${escapeHtml(log.id)}">${escapeHtml(logName(log))}</option>`).join("")}</optgroup>` : "") +
      `<optgroup label="共通の時間">${COMMON_KINDS.map((kind) => `<option value="kind:${kind}">${SESSION_KINDS[kind]}</option>`).join("")}</optgroup>` +
      `<optgroup label="計画にない作業">${[...(state().allWorkTypes || state().workTypes)]
        .sort((a, b) => a.sort - b.sort)
        .map((type) => `<option value="type:${escapeHtml(type.code)}">${escapeHtml(type.label)}</option>`)
        .join("")}</optgroup></select></label>`;
  // 計画にない作業の計測は、その日の実績につなげる（実績の作業時間になる）
  const linkChoice =
    session && session.kind === "work" && !(session.work_ids || []).length
      ? '<label>つなぐ実績<select data-field="log"><option value="">つながない</option>' +
        logs.map((log) => `<option value="${escapeHtml(log.id)}"${log.id === session.log_id ? " selected" : ""}>${escapeHtml(logName(log))}</option>`).join("") +
        "</select></label>"
      : "";
  const box = document.createElement("dialog");
  box.className = "notice session-dialog";
  draw(
    box,
    `<form method="dialog" class="session-form">` +
      (message ? `<p class="notice-text">${escapeHtml(message)}</p>` : "") +
      (session ? `<p class="session-dialog-name">${escapeHtml(sessionLabel(session))}</p>` : '<p class="session-dialog-name">時間を入れる</p>') +
      kindChoices +
      `<label>日付<input type="date" data-field="date" value="${date}" /></label>` +
      `<div class="session-times"><label>始めた<input type="time" data-field="start" value="${session ? clockOf(session.started_at).padStart(5, "0") : ""}" required /></label>` +
      `<label>止めた<input type="time" data-field="stop" value="${session?.stopped_at ? clockOf(session.stopped_at).padStart(5, "0") : ""}"${running ? "" : " required"} /></label></div>` +
      (running ? '<p class="muted">止めた時刻を空のままにすると、計測を続けます。</p>' : "") +
      linkChoice +
      '<p class="error" data-field="error" role="alert"></p>' +
      '<div class="row"><button type="submit" class="primary-btn" data-act="save">保存</button>' +
      (session ? '<button type="button" class="text-btn danger" data-act="delete">消す</button>' : "") +
      '<button type="button" class="text-btn" data-act="cancel">キャンセル</button></div></form>'
  );
  const field = (name) => box.querySelector(`[data-field="${name}"]`);
  box.addEventListener("click", async (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "cancel") {
      box.close();
    } else if (act === "delete") {
      box.close();
      if (await confirmDelete("この計測を消しますか。", sessionLabel(session))) {
        await removeSession(session);
      }
    }
  });
  box.addEventListener("submit", async (event) => {
    event.preventDefault();
    const day = field("date").value;
    // 窓には分までしか出さないので、日付と時:分が元のままなら、元の時刻（秒まで）を使う（時刻を直していないことにする）
    const timeOf = (clock, original) => {
      if (!day || !clock) {
        return original === undefined ? "" : null;
      }
      return original && localDateOf(original) === day && clockOf(original).padStart(5, "0") === clock ? original : isoAt(day, clock);
    };
    const started = timeOf(field("start").value, session?.started_at);
    const stopped = timeOf(field("stop").value, session?.stopped_at || null);
    const error = checkTimes(started, stopped) || (!stopped && !running ? "止めた時刻を入れてください" : null) || (stopped && stopped > new Date().toISOString() ? "止めた時刻が、今より後です" : null);
    if (error) {
      field("error").textContent = error;
      return;
    }
    let row;
    if (session) {
      // 時刻を直したときだけ「直した」の印を付ける（実績につなぐだけなら、測ったままの印）
      const retimed = started !== session.started_at || stopped !== session.stopped_at;
      row = { ...session, started_at: started, stopped_at: stopped, source: retimed ? "edited" : session.source };
      if (field("log")) {
        // つないだ実績の名前と種類を写す。つながないにしたら、作業の種類の名前に戻す
        const log = logs.find((item) => item.id === field("log").value) || null;
        row.log_id = log?.id || null;
        row.work_type = log ? log.work_type : row.work_type;
        row.label = log ? logName(log) : ctx.typeLabel(row.work_type);
      }
    } else {
      const [kind, value] = field("what").value.split(":");
      const log = kind === "log" ? logs.find((item) => item.id === value) : null;
      row = {
        id: crypto.randomUUID(),
        field_id: state().field.id,
        kind: kind === "kind" ? value : "work",
        work_type: log ? log.work_type : kind === "type" ? value : null,
        work_ids: log ? [...new Set((log.targets || []).map((target) => target.work_id).filter(Boolean))] : [],
        log_id: log && !(log.targets || []).some((target) => target.work_id) ? log.id : null,
        label: log ? logName(log) : kind === "type" ? ctx.typeLabel(value) : "",
        started_at: started,
        stopped_at: stopped,
        source: "edited",
      };
    }
    box.close();
    await save([row], "作業時間を保存しました");
  });
  box.addEventListener("close", () => box.remove());
  document.body.append(box);
  box.showModal();
}

async function removeSession(session) {
  if (saving) {
    return;
  }
  saving = true;
  try {
    await state().store.deleteSession(session.id);
    state().sessions = sessions().filter((item) => item.id !== session.id);
    ctx.setStatus("計測を消しました");
  } catch (error) {
    ctx.setStatus(`計測を消せませんでした: ${error.message}`);
    notifySaveFailed(error);
  } finally {
    saving = false;
    refresh();
  }
}

// 止め忘れて日をまたいだ計測があれば、止めた時刻を尋ねる（1 つの計測につき、この画面で 1 回）
function askStale() {
  const running = runningSession(sessions());
  if (!isStale(running, localToday()) || asked.has(running.id) || document.querySelector("dialog[open]")) {
    return;
  }
  asked.add(running.id);
  const [, month, date] = localDateOf(running.started_at).split("-").map(Number);
  editSession(running, `${sessionLabel(running)}を ${month}/${date} ${clockOf(running.started_at)} から計測中です。止めた時刻を入れてください。`);
}

// 圃場を切り替えたとき。見ている日を今日に戻す
export function resetToday() {
  day = null;
}

export function initToday(context) {
  ctx = context;
  $("timerBar").addEventListener("click", (event) => {
    onBarClick(event).catch((error) => notify(error.message));
  });
  $("todayView").addEventListener("click", (event) => {
    onTodayClick(event).catch((error) => notify(error.message));
  });
  renderToday();
}

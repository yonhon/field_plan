// 作業時間の計測の計算。画面は today-view.js。
// 計測（field.work_sessions の行）は、始めた時刻と止めた時刻の組。止めた時刻が空なら計測中。
// 1 人で作業するので、計測中はどの圃場でも 1 つだけにする（次の作業を始めると、前の作業は止まる）

// 計測の種類。準備・片付けと移動は、どの作付にも付かない共通の時間
export const SESSION_KINDS = { work: "作業", prep: "準備・片付け", move: "移動" };

const MINUTE_MS = 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

// 時刻（ISO の文字）の、この端末の日付（YYYY-MM-DD）
export function localDateOf(iso) {
  const time = new Date(iso);
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

// 時刻（ISO の文字）の、この端末の時刻（H:MM）
export function clockOf(iso) {
  const time = new Date(iso);
  return `${time.getHours()}:${pad(time.getMinutes())}`;
}

// この端末の日付（YYYY-MM-DD）と時刻（HH:MM）から、ISO の文字を作る
export function isoAt(date, clock) {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = clock.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes).toISOString();
}

// 計測の長さ（分、小数を含む）。計測中は now までの長さ
export function sessionMinutes(session, now = new Date()) {
  const end = session.stopped_at ? new Date(session.stopped_at) : now;
  return Math.max(0, (end - new Date(session.started_at)) / MINUTE_MS);
}

// 分を「1:05」の形にする（端数は 1 分の単位で四捨五入する。分けた時間の行を足すと、合計の行とそろいやすい）
export function formatMinutes(minutes) {
  const whole = Math.max(0, Math.round(minutes));
  return `${Math.floor(whole / 60)}:${pad(whole % 60)}`;
}

// 計測中の計測。なければ null。いくつもあれば（ほかの端末で同時に始めた）、最後に始めたもの
export function runningSession(sessions) {
  const running = sessions.filter((session) => !session.stopped_at);
  return running.sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1) || null;
}

// 日をまたいで計測中のままの計測か（止め忘れ）。today は、この端末の今日（YYYY-MM-DD）
export function isStale(session, today) {
  return Boolean(session) && !session.stopped_at && localDateOf(session.started_at) < today;
}

// その圃場の、その日（この端末の日付で、始めた日）の計測を、始めた順に
export function daySessions(sessions, fieldId, date) {
  return sessions
    .filter((session) => session.field_id === fieldId && localDateOf(session.started_at) === date)
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}

// 計測の合計（分）。作業（work）と、共通の時間（準備・片付け、移動）に分ける
export function sessionTotals(sessions, now = new Date()) {
  const totals = { work: 0, prep: 0, move: 0, total: 0 };
  for (const session of sessions) {
    const minutes = sessionMinutes(session, now);
    totals[session.kind] = (totals[session.kind] || 0) + minutes;
    totals.total += minutes;
  }
  return totals;
}

// 計画の作業ごとの、計測の時間（分）。1 件の計測が作業をいくつも持つとき（同じ日の同じ作業を何か所かまとめて始めた）は、
// weight（作業 → 重み。畝の面積など）の比で分ける。重みが分からない作業があれば、均等に分ける
export function workMinutes(sessions, weight = () => null, now = new Date()) {
  const result = new Map();
  for (const session of sessions) {
    const ids = session.work_ids || [];
    const minutes = sessionMinutes(session, now);
    const weights = ids.map((id) => weight(id));
    const usable = weights.every((value) => Number.isFinite(value) && value > 0);
    const sum = usable ? weights.reduce((a, b) => a + b, 0) : ids.length;
    ids.forEach((id, index) => {
      const share = minutes * (usable ? weights[index] : 1) / sum;
      result.set(id, (result.get(id) || 0) + share);
    });
  }
  return result;
}

// 計測の時間を、持ち主（作付、区画など）に分ける。ownersOf(session) は [{ key, weight }]（weight は畝の面積など）。
// 重みが 1 つでも分からなければ、均等に分ける。持ち主のない計測（共通の時間、つないでいない作業）は unassigned に足す。
// 返すのは { minutes: Map(key → 分), unassigned: 分 }
export function splitMinutes(sessions, ownersOf, now = new Date()) {
  const minutes = new Map();
  let unassigned = 0;
  for (const session of sessions) {
    const owners = ownersOf(session) || [];
    const length = sessionMinutes(session, now);
    if (!owners.length) {
      unassigned += length;
      continue;
    }
    const usable = owners.every((owner) => Number.isFinite(owner.weight) && owner.weight > 0);
    const sum = usable ? owners.reduce((total, owner) => total + owner.weight, 0) : owners.length;
    for (const owner of owners) {
      minutes.set(owner.key, (minutes.get(owner.key) || 0) + (length * (usable ? owner.weight : 1)) / sum);
    }
  }
  return { minutes, unassigned };
}

// 作業を始めるときの書き込み。計測中の計測があれば、同じ時刻で止める（1 人なので、同時に進む作業は 1 つ）。
// 返すのは、保存する行の並び（止める行が先、始める行があと）
export function startWrites(sessions, start, now = new Date()) {
  const at = now.toISOString();
  const writes = sessions.filter((session) => !session.stopped_at).map((session) => ({ ...session, stopped_at: at < session.started_at ? session.started_at : at }));
  writes.push({ id: start.id || crypto.randomUUID(), kind: "work", work_type: null, work_ids: [], log_id: null, label: "", source: "measured", ...start, started_at: at, stopped_at: null });
  return writes;
}

// 計測中の作業の作業の ID の集まり（今週やることの行に「計測中」と出すのに使う）
export function runningWorkIds(sessions) {
  return new Set(runningSession(sessions)?.work_ids || []);
}

// 時刻を直すときの確かめ。直したあとの行と、誤りの文（なければ null）を返す
export function checkTimes(started, stopped) {
  if (!started) {
    return "始めた時刻を入れてください";
  }
  if (stopped && stopped < started) {
    return "止めた時刻が、始めた時刻より前です";
  }
  return null;
}

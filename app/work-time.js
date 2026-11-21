// 作業時間の計測の計算。画面は today-view.js。
// 計測（field.work_sessions の行）は、始めた時刻と止めた時刻の組。止めた時刻が空なら計測中。
// 1 人で作業するので、計測中はどの圃場でも 1 つだけにする（次の作業を始めると、前の作業は止まる）

// 計測の種類。観察、準備・片付け、移動は、どの作付にも付かない共通の時間
export const SESSION_KINDS = { work: "作業", observe: "観察", prep: "準備・片付け", move: "移動" };

// 共通の時間の種類（画面に並べる順）
export const COMMON_KINDS = ["observe", "prep", "move"];

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

// 計測の合計（分）。作業（work）と、共通の時間（観察、準備・片付け、移動）に分ける
export function sessionTotals(sessions, now = new Date()) {
  const totals = { work: 0, observe: 0, prep: 0, move: 0, total: 0 };
  for (const session of sessions) {
    const minutes = sessionMinutes(session, now);
    totals[session.kind] = (totals[session.kind] || 0) + minutes;
    totals.total += minutes;
  }
  return totals;
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
    for (const [key, share] of shareByWeight(length, owners)) {
      minutes.set(key, (minutes.get(key) || 0) + share);
    }
  }
  return { minutes, unassigned };
}

// 分を、重みの比で分ける。items は [{ key, weight }]。重みが 1 つでも分からなければ（0 以下を含む）、均等に分ける。
// 同じ key が何度出てもよい（足し合わせる）。返すのは Map(key → 分)
export function shareByWeight(minutes, items) {
  const result = new Map();
  const usable = items.every((item) => Number.isFinite(item.weight) && item.weight > 0);
  const sum = usable ? items.reduce((total, item) => total + item.weight, 0) : items.length;
  for (const item of items) {
    result.set(item.key, (result.get(item.key) || 0) + (minutes * (usable ? item.weight : 1)) / sum);
  }
  return result;
}

// 計測の時間を、作付と区画に分ける。区画の時間は、区画全体にした作業（own）と、中の作付でした作業（beds）の合計。
// 作付の時間は、その作付でした作業（direct）と、区画全体にした作業を面積の比で分けた分（fromBlock）の合計。
// 区画の中の作付の時間を足すと、区画の時間とそろう（区画全体の作業を分ける作付がない時期の分だけ、区画にだけ残る）。
// - ownersOf(session) は [{ key: "planting:ID" | "block:ID", weight }]（splitMinutes と同じ）
// - plantingBlock(plantingId) は、作付の区画の ID
// - blockPlantings(blockId, date) は、その日に区画全体の作業を分ける作付 [{ id, weight }]（weight は畝＋通路の面積）
// 返すのは { plantings: Map(ID → { direct, fromBlock, types }), blocks: Map(ID → { own, beds, shared }), unassigned }。
// types は作業の種類 → 分（区画全体の作業から分けた分は "block:種類" の形）。shared は、own のうち作付に分けた分
export function allocateMinutes(sessions, { ownersOf, plantingBlock, blockPlantings }, now = new Date()) {
  const plantings = new Map();
  const blocks = new Map();
  let unassigned = 0;
  const plantingOf = (id) => {
    if (!plantings.has(id)) {
      plantings.set(id, { direct: 0, fromBlock: 0, types: new Map() });
    }
    return plantings.get(id);
  };
  const blockOf = (id) => {
    if (!blocks.has(id)) {
      blocks.set(id, { own: 0, beds: 0, shared: 0 });
    }
    return blocks.get(id);
  };
  const addType = (item, type, minutes) => item.types.set(type, (item.types.get(type) || 0) + minutes);
  for (const session of sessions) {
    const owners = ownersOf(session) || [];
    if (!owners.length) {
      unassigned += sessionMinutes(session, now);
      continue;
    }
    const minutes = shareByWeight(sessionMinutes(session, now), owners);
    const date = localDateOf(session.started_at);
    const type = session.work_type || "";
    for (const [key, share] of minutes) {
      const [kind, id] = key.split(":");
      if (kind === "planting") {
        const item = plantingOf(id);
        item.direct += share;
        addType(item, type, share);
        const block = plantingBlock(id);
        if (block) {
          blockOf(block).beds += share;
        }
        continue;
      }
      const block = blockOf(id);
      block.own += share;
      const targets = blockPlantings(id, date) || [];
      if (!targets.length) {
        continue;
      }
      for (const [plantingId, part] of shareByWeight(share, targets.map((target) => ({ key: target.id, weight: target.weight })))) {
        const item = plantingOf(plantingId);
        item.fromBlock += part;
        addType(item, `block:${type}`, part);
      }
      block.shared += share;
    }
  }
  return { plantings, blocks, unassigned };
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

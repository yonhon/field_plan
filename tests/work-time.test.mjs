// 作業時間の計測の計算（app/work-time.js）。実行: node --test "tests/*.test.mjs"
import { test } from "./test-api.mjs";
import assert from "node:assert/strict";
import {
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
  splitMinutes,
  startWrites,
  workMinutes,
} from "../app/work-time.js";

// この端末の日時から作る（時差によらず、同じ結果にする）
const at = (date, clock) => isoAt(date, clock);
const session = (id, start, stop, extra = {}) => ({ id, field_id: "f1", kind: "work", work_ids: [], started_at: start, stopped_at: stop, ...extra });

test("日付と時刻: この端末の日付と時刻で読み書きする", () => {
  const iso = at("2027-05-12", "07:05");
  assert.equal(localDateOf(iso), "2027-05-12");
  assert.equal(clockOf(iso), "7:05");
  assert.equal(clockOf(at("2027-05-12", "13:40")), "13:40");
  assert.equal(new Date(iso).getHours(), 7);
});

test("計測の長さ: 止めた時刻までの分。計測中は今まで。前後が逆なら 0", () => {
  assert.equal(sessionMinutes(session("a", at("2027-05-12", "08:00"), at("2027-05-12", "09:30"))), 90);
  const now = new Date(at("2027-05-12", "08:20"));
  assert.equal(sessionMinutes(session("a", at("2027-05-12", "08:00"), null), now), 20);
  assert.equal(sessionMinutes(session("a", at("2027-05-12", "08:00"), null), new Date(at("2027-05-12", "07:00"))), 0);
});

test("分の書き方: 時:分。1 分の単位で四捨五入し、負は 0", () => {
  assert.equal(formatMinutes(0), "0:00");
  assert.equal(formatMinutes(5.4), "0:05");
  assert.equal(formatMinutes(5.5), "0:06");
  assert.equal(formatMinutes(65), "1:05");
  assert.equal(formatMinutes(600), "10:00");
  assert.equal(formatMinutes(-3), "0:00");
});

test("計測の種類の名前", () => {
  assert.deepEqual(SESSION_KINDS, { work: "作業", prep: "準備・片付け", move: "移動" });
});

test("計測中の計測: 止めていないもののうち、最後に始めたもの", () => {
  assert.equal(runningSession([]), null);
  const list = [
    session("a", at("2027-05-12", "08:00"), at("2027-05-12", "09:00")),
    session("b", at("2027-05-12", "10:00"), null, { work_ids: ["w2"] }),
    session("c", at("2027-05-12", "09:30"), null, { work_ids: ["w1"] }),
    session("d", at("2027-05-12", "09:00"), null),
    // 止めた計測は、あとに始めていても選ばない
    session("e", at("2027-05-12", "11:00"), at("2027-05-12", "11:30")),
  ];
  assert.equal(runningSession(list).id, "b");
  assert.deepEqual([...runningWorkIds(list)], ["w2"]);
  assert.deepEqual([...runningWorkIds([])], []);
});

test("止め忘れ: 計測中で、始めた日が今日より前", () => {
  assert.equal(isStale(session("a", at("2027-05-11", "14:10"), null), "2027-05-12"), true);
  assert.equal(isStale(session("a", at("2027-05-12", "06:00"), null), "2027-05-12"), false);
  assert.equal(isStale(session("a", at("2027-05-11", "14:10"), at("2027-05-11", "15:00")), "2027-05-12"), false);
  assert.equal(isStale(null, "2027-05-12"), false);
});

test("その日の計測: その圃場の、その日に始めた計測を、始めた順に", () => {
  const list = [
    session("late", at("2027-05-12", "15:00"), null),
    session("early", at("2027-05-12", "07:00"), at("2027-05-12", "08:00")),
    session("other-day", at("2027-05-11", "07:00"), at("2027-05-11", "08:00")),
    { ...session("other-field", at("2027-05-12", "09:00"), null), field_id: "f2" },
  ];
  assert.deepEqual(daySessions(list, "f1", "2027-05-12").map((item) => item.id), ["early", "late"]);
});

test("合計: 作業と、準備・片付けと移動に分ける", () => {
  const list = [
    session("a", at("2027-05-12", "08:00"), at("2027-05-12", "09:00")),
    session("b", at("2027-05-12", "09:00"), at("2027-05-12", "09:15"), { kind: "prep" }),
    session("c", at("2027-05-12", "09:15"), at("2027-05-12", "09:25"), { kind: "move" }),
    session("d", at("2027-05-12", "09:25"), at("2027-05-12", "09:30"), { kind: "prep" }),
  ];
  assert.deepEqual(sessionTotals(list), { work: 60, prep: 20, move: 10, total: 90 });
  assert.deepEqual(sessionTotals([]), { work: 0, prep: 0, move: 0, total: 0 });
});

test("作業ごとの時間: 作業をいくつも持つ計測は、重みの比で分ける。重みが分からなければ均等", () => {
  const list = [
    session("a", at("2027-05-12", "08:00"), at("2027-05-12", "09:00"), { work_ids: ["w1", "w2"] }),
    session("b", at("2027-05-12", "10:00"), at("2027-05-12", "10:30"), { work_ids: ["w1"] }),
    session("c", at("2027-05-12", "11:00"), at("2027-05-12", "11:30"), { kind: "prep" }),
    { ...session("d", at("2027-05-12", "12:00"), at("2027-05-12", "12:30")), work_ids: undefined },
  ];
  const even = workMinutes(list);
  assert.equal(even.get("w1"), 60);
  assert.equal(even.get("w2"), 30);
  assert.equal(even.size, 2);
  const weighted = workMinutes(list, (id) => ({ w1: 30, w2: 10 })[id]);
  assert.equal(weighted.get("w1"), 75);
  assert.equal(weighted.get("w2"), 15);
  // 1 つでも重みが分からなければ、その計測は均等に分ける
  const partial = workMinutes(list, (id) => ({ w1: 30 })[id]);
  assert.equal(partial.get("w2"), 30);
  const zero = workMinutes(list, (id) => ({ w1: 30, w2: 0 })[id]);
  assert.equal(zero.get("w2"), 30);
});

test("持ち主に分ける: 重みの比で分け、持ち主のない計測は unassigned に足す", () => {
  const list = [
    session("a", at("2027-05-12", "08:00"), at("2027-05-12", "09:00"), { owners: [{ key: "p1", weight: 20 }, { key: "p2", weight: 40 }] }),
    session("b", at("2027-05-12", "09:00"), at("2027-05-12", "09:30"), { owners: [{ key: "p1", weight: null }, { key: "p2", weight: 10 }] }),
    session("c", at("2027-05-12", "09:30"), at("2027-05-12", "09:40"), { owners: [] }),
    session("d", at("2027-05-12", "09:40"), at("2027-05-12", "09:45")),
  ];
  const { minutes, unassigned } = splitMinutes(list, (item) => item.owners);
  assert.equal(minutes.get("p1"), 20 + 15);
  assert.equal(minutes.get("p2"), 40 + 15);
  assert.equal(minutes.size, 2);
  assert.equal(unassigned, 15);
  assert.deepEqual(splitMinutes([], () => []), { minutes: new Map(), unassigned: 0 });
  const zero = splitMinutes([list[0]], () => [{ key: "p1", weight: 0 }, { key: "p2", weight: 30 }]);
  assert.equal(zero.minutes.get("p1"), 30);
});

test("始めるときの書き込み: 計測中の計測を同じ時刻で止めてから、新しい計測を始める", () => {
  const now = new Date(at("2027-05-12", "10:00"));
  const list = [
    session("done", at("2027-05-12", "08:00"), at("2027-05-12", "09:00")),
    session("going", at("2027-05-12", "09:00"), null, { work_ids: ["w1"] }),
  ];
  const writes = startWrites(list, { id: "new", field_id: "f1", kind: "prep" }, now);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], { ...list[1], stopped_at: now.toISOString() });
  assert.equal(writes[1].id, "new");
  assert.equal(writes[1].kind, "prep");
  assert.equal(writes[1].started_at, now.toISOString());
  assert.equal(writes[1].stopped_at, null);
  assert.equal(writes[1].source, "measured");
  assert.deepEqual(writes[1].work_ids, []);
  // 計測中がなければ、始める行だけ。ID がなければ作る
  const only = startWrites([list[0]], { field_id: "f1", kind: "work", work_ids: ["w2"], label: "収穫" }, now);
  assert.equal(only.length, 1);
  assert.match(only[0].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(only[0].work_ids, ["w2"]);
  // 種類と名前がなければ、作業と空の名前
  const plain = startWrites([], { field_id: "f1" }, now);
  assert.equal(plain[0].kind, "work");
  assert.equal(plain[0].label, "");
  assert.equal(plain[0].work_type, null);
  assert.equal(plain[0].log_id, null);
  // 端末の時計が戻っていても、止めた時刻を始めた時刻より前にしない
  const ahead = startWrites([session("x", at("2027-05-12", "11:00"), null)], { kind: "move" }, now);
  assert.equal(ahead[0].stopped_at, ahead[0].started_at);
});

test("時刻の確かめ: 始めた時刻がない、止めた時刻が前なら断る", () => {
  assert.equal(checkTimes("", null), "始めた時刻を入れてください");
  assert.equal(checkTimes(at("2027-05-12", "09:00"), at("2027-05-12", "08:00")), "止めた時刻が、始めた時刻より前です");
  assert.equal(checkTimes(at("2027-05-12", "09:00"), at("2027-05-12", "09:00")), null);
  assert.equal(checkTimes(at("2027-05-12", "09:00"), null), null);
});

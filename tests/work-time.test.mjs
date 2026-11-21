// 作業時間の計測の計算（app/work-time.js）。実行: node --test "tests/*.test.mjs"
import { test } from "./test-api.mjs";
import assert from "node:assert/strict";
import {
  SESSION_KINDS,
  allocateMinutes,
  shareByWeight,
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
  assert.deepEqual(SESSION_KINDS, { work: "作業", observe: "観察", prep: "準備・片付け", move: "移動" });
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

test("合計: 作業と、観察、準備・片付け、移動に分ける", () => {
  const list = [
    session("a", at("2027-05-12", "08:00"), at("2027-05-12", "09:00")),
    session("b", at("2027-05-12", "09:00"), at("2027-05-12", "09:15"), { kind: "prep" }),
    session("c", at("2027-05-12", "09:15"), at("2027-05-12", "09:25"), { kind: "move" }),
    session("d", at("2027-05-12", "09:25"), at("2027-05-12", "09:30"), { kind: "prep" }),
    session("e", at("2027-05-12", "09:30"), at("2027-05-12", "09:35"), { kind: "observe" }),
  ];
  assert.deepEqual(sessionTotals(list), { work: 60, observe: 5, prep: 20, move: 10, total: 95 });
  assert.deepEqual(sessionTotals([]), { work: 0, observe: 0, prep: 0, move: 0, total: 0 });
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

test("重みの比で分ける: 重みが分からないか 0 以下なら均等。同じ key は足し合わせる", () => {
  assert.deepEqual([...shareByWeight(60, [{ key: "a", weight: 1 }, { key: "b", weight: 2 }])], [["a", 20], ["b", 40]]);
  assert.deepEqual([...shareByWeight(60, [{ key: "a", weight: 1 }, { key: "b", weight: null }])], [["a", 30], ["b", 30]]);
  assert.deepEqual([...shareByWeight(60, [{ key: "a", weight: 1 }, { key: "b", weight: -1 }])], [["a", 30], ["b", 30]]);
  assert.deepEqual([...shareByWeight(60, [{ key: "a", weight: 1 }, { key: "a", weight: 1 }, { key: "b", weight: 2 }])], [["a", 30], ["b", 30]]);
  assert.equal(shareByWeight(60, []).size, 0);
});

test("作付と区画に分ける: 区画 = 区画全体の作業 + 作付の作業。作付 = 作付の作業 + 区画全体の作業の面積按分", () => {
  const list = [
    // 作付 p1 で 30 分（収穫）
    session("a", at("2027-05-12", "08:00"), at("2027-05-12", "08:30"), { work_type: "harvest", owners: [{ key: "planting:p1", weight: 10 }] }),
    // 区画 B1 全体で 60 分（防除）。その日の作付は p1（10 ㎡）と p2（20 ㎡）
    session("b", at("2027-05-12", "09:00"), at("2027-05-12", "10:00"), { work_type: "spray", owners: [{ key: "block:B1", weight: 30 }] }),
    // 区画 B1 全体で 12 分。その日（5/1）は分ける作付がない
    session("c", at("2027-05-01", "09:00"), at("2027-05-01", "09:12"), { work_type: "rotary", owners: [{ key: "block:B1", weight: 30 }] }),
    // 持ち主のない作業
    session("d", at("2027-05-12", "11:00"), at("2027-05-12", "11:05"), { owners: [] }),
    // 区画のない作付（消えた畝など）
    session("e", at("2027-05-12", "12:00"), at("2027-05-12", "12:10"), { work_type: "weed", owners: [{ key: "planting:gone", weight: 1 }] }),
  ];
  const result = allocateMinutes(list, {
    ownersOf: (item) => item.owners,
    plantingBlock: (id) => ({ p1: "B1", p2: "B1" })[id] || null,
    blockPlantings: (blockId, date) => (blockId === "B1" && date === "2027-05-12" ? [{ id: "p1", weight: 10 }, { id: "p2", weight: 20 }] : []),
  });
  const p1 = result.plantings.get("p1");
  const p2 = result.plantings.get("p2");
  assert.equal(p1.direct, 30);
  assert.equal(p1.fromBlock, 20);
  assert.equal(p2.direct, 0);
  assert.equal(p2.fromBlock, 40);
  assert.deepEqual([...p1.types], [["harvest", 30], ["block:spray", 20]]);
  assert.deepEqual([...p2.types], [["block:spray", 40]]);
  assert.deepEqual(result.blocks.get("B1"), { own: 72, beds: 30, shared: 60 });
  assert.equal(result.plantings.get("gone").direct, 10);
  assert.equal(result.blocks.size, 1);
  assert.equal(result.unassigned, 5);
  // 区画の中の作付の時間の合計は、区画の時間から、分ける作付がなかった分を引いたもの
  assert.equal(p1.direct + p1.fromBlock + p2.direct + p2.fromBlock, 72 + 30 - (72 - 60));
});

test("作付と区画に分ける: 種類のない計測は空の種類。持ち主のない計測は unassigned だけ", () => {
  const result = allocateMinutes(
    [session("a", at("2027-05-12", "08:00"), at("2027-05-12", "08:10"), { work_type: null })],
    { ownersOf: () => [{ key: "planting:p1", weight: 1 }], plantingBlock: () => null, blockPlantings: () => [] }
  );
  assert.deepEqual([...result.plantings.get("p1").types], [["", 10]]);
  assert.equal(result.unassigned, 0);
  const none = allocateMinutes([session("a", at("2027-05-12", "08:00"), at("2027-05-12", "08:10"))], { ownersOf: () => null, plantingBlock: () => null, blockPlantings: () => [] });
  assert.equal(none.unassigned, 10);
  assert.equal(none.plantings.size + none.blocks.size, 0);
});

test("作付と区画に分ける: 同じ作付の同じ種類は足し合わせる。区画の作付が分からなければ区画にだけ残す", () => {
  const result = allocateMinutes(
    [
      session("a", at("2027-05-12", "08:00"), at("2027-05-12", "08:10"), { work_type: "weed", owners: [{ key: "planting:p1", weight: 1 }] }),
      session("b", at("2027-05-12", "09:00"), at("2027-05-12", "09:20"), { work_type: "weed", owners: [{ key: "planting:p1", weight: 1 }] }),
      session("c", at("2027-05-12", "10:00"), at("2027-05-12", "10:15"), { work_type: "rotary", owners: [{ key: "block:B1", weight: 1 }] }),
    ],
    { ownersOf: (item) => item.owners, plantingBlock: () => "B1", blockPlantings: () => undefined }
  );
  assert.deepEqual([...result.plantings.get("p1").types], [["weed", 30]]);
  assert.deepEqual(result.blocks.get("B1"), { own: 15, beds: 30, shared: 0 });
});

// 「今日」のタブと作業時間の計測（today-view.js）を、Chrome で通して確かめる。
// 上のタブ（今日・圃場図・日程・日記）と、ロゴのメニューの台帳・変更の履歴も見る。実行: node --test "tests/e2e/*.test.mjs"
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const pad = (n) => String(n).padStart(2, "0");
const localDay = (time) => `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
const today = localDay(new Date());

// 区画 A に畝を 2 本。どちらにも試験菜を植え、今日の収穫を 1 つずつ（今週やることでは 1 行にまとまる）
const seed = (extra = {}) => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", active_plan_id: "p1", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: [1, 2].map((seq) => ({ id: `bed${seq}`, plan_id: "p1", block_id: "b1", seq, shape: [[seq * 3, 2], [seq * 3 + 1, 2], [seq * 3 + 1, 18], [seq * 3, 18]], start_date: null, removed_on: null })),
  plantings: [1, 2].map((seq) => ({ id: `pl${seq}`, plan_id: "p1", bed_id: `bed${seq}`, seq: 1, crop_id: "c1", crop_name: "試験菜" })),
  works: [1, 2].map((seq) => ({ id: `w${seq}`, plan_id: "p1", planting_id: `pl${seq}`, block_id: null, seq: 1, work_type: "harvest", plan_start: today, plan_end: today })),
  crops: [{ id: "c1", name: "試験菜", mulch: false, bed_width_cm: 100, aisle_width_cm: 60 }],
  ...extra,
});

const options = { skip: findChrome() ? false : "Chrome が見つかりません" };
let page;

before(async () => {
  if (!options.skip) {
    page = await openBrowser();
  }
});

after(async () => {
  await page?.close();
});

const sessions = () => page.run(`JSON.parse(localStorage.getItem("field_plan_local")).workSessions || []`);
const running = async () => (await sessions()).filter((session) => !session.stopped_at);

test("タブ: 今日・圃場図・日程・日記・収支の 5 つ。台帳と変更の履歴は、ロゴのメニューから開く", options, async () => {
  await page.loadApp(seed());
  assert.deepEqual(await page.run(`[...document.querySelectorAll(".tab-btn")].map((button) => button.firstChild.textContent)`), ["今日", "圃場図", "日程", "日記", "収支"]);
  await page.openView("master");
  await page.waitFor(`location.hash.startsWith("#master/") && !document.getElementById("masterView").hidden`, "台帳が開く");
  await page.openView("journal");
  await page.waitFor(`location.hash === "#journal" && !document.getElementById("journalView").hidden`, "変更の履歴が開く");
  assert.equal(await page.run(`document.querySelector(".tab-btn.is-active") === null`), true);
  assert.deepEqual(page.errors, []);
});

test("今日: 今週やることの欄を、今日のタブと圃場図の上の両方で出す", options, async () => {
  await page.loadApp(seed());
  await page.openView("today");
  await page.waitFor(`location.hash === "#today" && document.querySelector(".work-tabs").parentElement.id === "todayWorkSlot"`, "欄が今日のタブへ移る");
  await page.click('.wt-tab[data-wtab="week"]');
  await page.waitFor(`Boolean(document.querySelector('#weekList [data-week="start"]'))`, "今週やることの行に「始める」");
  await page.openView("map");
  await page.waitFor(`document.querySelector(".work-tabs").parentElement.classList.contains("map-overview")`, "欄が圃場図の上に戻る");
  assert.deepEqual(page.errors, []);
});

test("今日: 「始める」で測り始め、次の作業を始めると前の作業が止まる。「止める」で止まり、帯が消える", options, async () => {
  await page.loadApp(seed());
  await page.openView("today");
  await page.click('.wt-tab[data-wtab="week"]');
  await page.click('#weekList [data-week="start"]');
  await page.waitFor(`!document.getElementById("timerBar").hidden && Boolean(document.querySelector("#weekList .week-running"))`, "帯と、行の「計測中」");
  const [first] = await running();
  assert.deepEqual(first.work_ids, ["w1", "w2"]);
  assert.equal(first.kind, "work");
  assert.match(first.label, /収穫/);
  assert.match(await page.run(`document.querySelector("#timerBar .timer-name").textContent`), /収穫/);

  // 準備・片付けを始めると、収穫は同じ時刻で止まる
  await page.click('#todayStart [data-today="prep"]');
  await page.waitFor(`document.querySelector("#timerBar .timer-name")?.textContent === "準備・片付け"`, "帯が準備・片付けになる");
  const all = await sessions();
  assert.equal(all.length, 2);
  const harvest = all.find((session) => session.id === first.id);
  const prep = all.find((session) => session.id !== first.id);
  assert.equal(harvest.stopped_at, prep.started_at);
  assert.equal(prep.kind, "prep");
  assert.equal(await page.run(`document.querySelectorAll("#todaySessions .session-row").length`), 2);
  assert.equal(await page.run(`Boolean(document.querySelector("#weekList .week-running"))`), false);

  await page.click('#timerBar [data-timer="stop"]');
  await page.waitFor(`document.getElementById("timerBar").hidden`, "止めると帯が消える");
  assert.deepEqual(await running(), []);
  // ほかのタブでも、計測中は帯を出す
  await page.click('#todayStart [data-today="move"]');
  await page.openView("schedule");
  await page.waitFor(`!document.getElementById("timerBar").hidden && document.querySelector("#timerBar .timer-name").textContent === "移動"`, "日程の画面でも帯");
  assert.deepEqual(page.errors, []);
});

test("今日: 「休憩」で止め、「再開」で同じ作業を始め直す", options, async () => {
  await page.loadApp(seed());
  await page.openView("today");
  await page.click('.wt-tab[data-wtab="week"]');
  await page.click('#weekList [data-week="start"]');
  await page.waitFor(`!document.getElementById("timerBar").hidden`, "帯");
  await page.click('#timerBar [data-timer="pause"]');
  await page.waitFor(`Boolean(document.querySelector('#timerBar [data-timer="resume"]'))`, "休憩中の帯");
  assert.deepEqual(await running(), []);
  await page.click('#timerBar [data-timer="resume"]');
  await page.waitFor(`Boolean(document.querySelector('#timerBar [data-timer="stop"]'))`, "再開した帯");
  const all = await sessions();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((session) => session.work_ids), [["w1", "w2"], ["w1", "w2"]]);
  assert.equal((await running()).length, 1);
  assert.deepEqual(page.errors, []);
});

test("今日: 測っている作業を「完了」にすると、計測も止まる", options, async () => {
  await page.loadApp(seed());
  await page.openView("today");
  await page.click('.wt-tab[data-wtab="week"]');
  await page.click('#weekList [data-week="start"]');
  await page.waitFor(`Boolean(document.querySelector("#weekList .week-running"))`, "計測中");
  await page.click('#weekList [data-week="done"]');
  await page.waitFor(`(JSON.parse(localStorage.getItem("field_plan_local")).workLogs || []).length === 1`, "実績が入る");
  await page.waitFor(`document.getElementById("timerBar").hidden`, "帯が消える");
  assert.deepEqual(await running(), []);
  assert.deepEqual(page.errors, []);
});

test("今日: 止め忘れて日をまたいだ計測は、止めた時刻を尋ね、入れた時刻で止める", options, async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(14, 10, 0, 0);
  const started = yesterday.toISOString();
  await page.loadApp(seed({ workSessions: [{ id: "s1", field_id: "f1", kind: "work", work_type: "harvest", work_ids: ["w1"], log_id: null, label: "収穫 A 畝1", started_at: started, stopped_at: null, source: "measured", created_at: started }] }));
  await page.waitFor(`document.querySelector("dialog.session-dialog[open] .notice-text")?.textContent.includes("14:10 から計測中です")`, "止めた時刻を尋ねる窓");
  await page.setValue('dialog.session-dialog[open] [data-field="stop"]', "16:30");
  await page.click('dialog.session-dialog[open] [data-act="save"]');
  await page.waitFor(`document.getElementById("timerBar").hidden`, "止まる");
  const [session] = await sessions();
  const stopped = new Date(yesterday);
  stopped.setHours(16, 30, 0, 0);
  assert.equal(session.stopped_at, stopped.toISOString());
  assert.equal(session.source, "edited");
  assert.deepEqual(page.errors, []);
});

test("今日: 「直す」で時刻を直し、「＋ 時間を入れる」で準備の時間を入れる。前の日の一覧も見られる。消せる", options, async () => {
  const start = new Date();
  start.setHours(0, 5, 0, 0);
  const stop = new Date(start);
  stop.setMinutes(35);
  await page.loadApp(seed({ workSessions: [{ id: "s1", field_id: "f1", kind: "move", work_type: null, work_ids: [], log_id: null, label: "", started_at: start.toISOString(), stopped_at: stop.toISOString(), source: "measured", created_at: start.toISOString() }] }));
  await page.openView("today");
  await page.waitFor(`document.querySelector('#todaySessions [data-session="s1"] .session-minutes')?.textContent === "0:30"`, "30 分の計測");
  await page.click('#todaySessions [data-today="edit"][data-id="s1"]');
  await page.setValue('dialog.session-dialog[open] [data-field="stop"]', "00:50");
  await page.click('dialog.session-dialog[open] [data-act="save"]');
  await page.waitFor(`document.querySelector('#todaySessions [data-session="s1"] .session-minutes')?.textContent === "0:45"`, "45 分に直る");
  assert.equal((await sessions())[0].source, "edited");

  // 始めた時刻より前に止めた時刻は、断る
  await page.click('#todaySessions [data-today="edit"][data-id="s1"]');
  await page.setValue('dialog.session-dialog[open] [data-field="stop"]', "00:01");
  await page.click('dialog.session-dialog[open] [data-act="save"]');
  await page.waitFor(`document.querySelector('dialog.session-dialog[open] [data-field="error"]')?.textContent.includes("前です")`, "誤りの文");
  await page.click('dialog.session-dialog[open] [data-act="cancel"]');

  await page.click('#todaySessions [data-today="add"]');
  await page.setValue('dialog.session-dialog[open] [data-field="what"]', "kind:prep");
  await page.setValue('dialog.session-dialog[open] [data-field="start"]', "00:00");
  await page.setValue('dialog.session-dialog[open] [data-field="stop"]', "00:05");
  await page.click('dialog.session-dialog[open] [data-act="save"]');
  await page.waitFor(`document.querySelectorAll("#todaySessions .session-row").length === 2`, "入れた時間が並ぶ");
  assert.match(await page.run(`document.querySelector("#todaySessions .session-totals").textContent`), /合計 0:50/);

  // 前の日は空
  await page.click('#todaySessions [data-today="prev"]');
  await page.waitFor(`document.querySelectorAll("#todaySessions .session-row").length === 0`, "前の日");
  await page.click('#todaySessions [data-today="today"]');
  await page.waitFor(`document.querySelectorAll("#todaySessions .session-row").length === 2`, "今日に戻る");

  await page.click('#todaySessions [data-today="edit"][data-id="s1"]');
  await page.click('dialog.session-dialog[open] [data-act="delete"]');
  await page.click('dialog.notice[open] [data-action="delete"]');
  await page.waitFor(`document.querySelectorAll("#todaySessions .session-row").length === 1`, "消える");
  assert.deepEqual((await sessions()).map((session) => session.kind), ["prep"]);
  assert.deepEqual(page.errors, []);
});

test("今日: 「始める」は元に戻せる（前の作業も、止める前に戻る）", options, async () => {
  await page.loadApp(seed());
  await page.openView("today");
  await page.click('#todayStart [data-today="prep"]');
  await page.waitFor(`document.querySelector("#timerBar .timer-name")?.textContent === "準備・片付け"`, "準備・片付け");
  await page.click('#todayStart [data-today="move"]');
  await page.waitFor(`document.querySelector("#timerBar .timer-name")?.textContent === "移動"`, "移動");
  await page.click("#undoBtn");
  await page.waitFor(`document.querySelector("#timerBar .timer-name")?.textContent === "準備・片付け"`, "準備・片付けの計測中に戻る");
  const all = await sessions();
  assert.equal(all.length, 1);
  assert.equal(all[0].stopped_at, null);
  assert.deepEqual(page.errors, []);
});

test("収支: 測った時間を作付ごとに合計し、まとめて測った時間は面積の比で分ける。行を押すと作付の詳細", options, async () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const iso = (minutes) => new Date(start.getTime() + minutes * 60000).toISOString();
  const row = (id, from, to, extra) => ({ id, field_id: "f1", kind: "work", work_type: "harvest", work_ids: [], log_id: null, label: "", started_at: iso(from), stopped_at: iso(to), source: "measured", created_at: iso(from), ...extra });
  await page.loadApp(seed({
    workSessions: [
      // 2 本の畝をまとめて 60 分、畝 1 だけを 20 分、準備 10 分、つないでいない作業 5 分。
      // 畝＋通路の面積は、畝 1 が幅 4 m（区画の端から畝 2 との間の半分まで）、畝 2 が幅 34 m（区画の反対の端まで）。60 分を 4:34 に分ける
      row("s1", 0, 60, { work_ids: ["w1", "w2"] }),
      row("s2", 60, 80, { work_ids: ["w1"] }),
      row("s3", 80, 90, { kind: "prep", work_type: null }),
      row("s4", 90, 95, { work_type: "weed" }),
      // ほかの圃場の時間は足さない
      row("s5", 0, 120, { field_id: "f2", work_ids: ["w1"] }),
    ],
  }));
  await page.openView("revenue");
  await page.waitFor(`document.querySelectorAll("#revenueBody tbody tr[data-planting]").length === 2`, "作付の行が 2 つ");
  const cells = await page.run(`[...document.querySelectorAll("#revenueBody tbody tr")].map((tr) => [...tr.cells].slice(0, 3).map((td) => td.textContent))`);
  assert.deepEqual(cells, [["A 畝1", "試験菜", "0:26"], ["A 畝2", "試験菜", "0:54"]]);
  const foot = await page.run(`[...document.querySelectorAll("#revenueBody tfoot tr")].map((tr) => tr.querySelector(".num").textContent)`);
  assert.deepEqual(foot, ["1:20", "0:10", "0:00", "0:05"]);
  await page.click('#revenueBody tr[data-planting="pl2"]');
  await page.waitFor(`location.hash === "#detail/planting/pl2"`, "作付の詳細が開く");
  assert.deepEqual(page.errors, []);
});

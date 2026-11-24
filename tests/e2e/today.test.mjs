// 「今日」のタブと作業時間の計測（today-view.js）を、Chrome で通して確かめる。
// 上のタブ（今日・圃場図・日程・日記）と、ロゴのメニューの台帳・変更の履歴も見る。実行: node --test "tests/e2e/*.test.mjs"
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

// 「収支」のタブの「作付ごとの収支」の表の行
const PLANTING_ROWS = "#revenueBody .revenue-table tbody tr";

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

test("今日: 今週やることなどの欄は今日のタブだけに出し、圃場図の上には出さない", options, async () => {
  await page.loadApp(seed());
  await page.openView("today");
  await page.waitFor(`location.hash === "#today" && Boolean(document.querySelector("#todayView .work-tabs"))`, "今日のタブに欄");
  await page.click('.wt-tab[data-wtab="week"]');
  await page.waitFor(`Boolean(document.querySelector('#weekList [data-week="start"]'))`, "今週やることの行に「始める」");
  await page.openView("map");
  await page.waitFor(`location.hash === "#map"`, "圃場図");
  assert.equal(await page.run(`document.querySelectorAll(".work-tabs").length === 1 && !document.querySelector("#appView .work-tabs")`), true);
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

  // 共通の時間のボタンは、観察、準備・片付け、移動の順
  assert.deepEqual(
    await page.run(`[...document.querySelectorAll("#todayStart [data-today]")].map((button) => button.textContent)`),
    ["観察", "準備・片付け", "移動", "計画にない作業…"]
  );
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
  await page.openView("today");
  await page.click('#todayStart [data-today="observe"]');
  await page.waitFor(`document.querySelector("#timerBar .timer-name")?.textContent === "観察"`, "帯が観察になる");
  assert.equal((await running())[0].kind, "observe");
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
  // 作付ごとの表の列: 場所、品目、収量・出荷率・単価・売上の見込み、収穫量、収穫量から見た売上、作業時間（8）、うち区画の作業（9）、内訳
  const cells = await page.run(`[...document.querySelectorAll("${PLANTING_ROWS}")].map((tr) => [0, 1, 8].map((i) => tr.cells[i].textContent))`);
  assert.deepEqual(cells, [["A 畝1", "試験菜", "0:26"], ["A 畝2", "試験菜", "0:54"]]);
  const foot = await page.run(`[...document.querySelectorAll("#revenueBody .revenue-table tfoot tr")].map((tr) => tr.querySelector(".num").textContent)`);
  // 作付と区画の合計、観察、準備・片付け、移動、実績につないでいない作業
  assert.deepEqual(foot, ["1:20", "0:00", "0:10", "0:00", "0:05"]);
  await page.click('#revenueBody tr[data-planting="pl2"]');
  await page.waitFor(`location.hash === "#detail/planting/pl2"`, "作付の詳細が開く");
  assert.deepEqual(page.errors, []);
});

test("起動: URL に画面がなければ、最後に開いていた上のタブを開く。覚えていなければ圃場図。台帳と変更の履歴は覚えない", options, async () => {
  // URL から画面を消して開き直す（location.hash = "" は、開き直す前に戻ると同じ知らせを出し、圃場図を開いてしまう）
  const reopen = () => page.run(`history.replaceState(null, "", location.pathname + location.search); location.reload()`);
  await page.loadApp(seed());
  await page.waitFor(`location.hash === "#map"`, "覚えていなければ圃場図");
  await page.openView("revenue");
  await page.waitFor(`location.hash === "#revenue/plantings"`, "収支（作付ごとの収支のサブタブ）");
  // メニューから開いた台帳は覚えない（その前の収支のまま）
  await page.openView("master");
  await page.waitFor(`location.hash.startsWith("#master/")`, "台帳");
  await reopen();
  await page.waitFor(`document.getElementById("viewTabs")?.hidden === false && location.hash === "#revenue/plantings" && !document.getElementById("revenueView").hidden`, "収支で開く");
  await page.openView("today");
  await reopen();
  await page.waitFor(`document.getElementById("viewTabs")?.hidden === false && location.hash === "#today" && !document.getElementById("todayView").hidden`, "今日で開く");
  // 日程は、最後に見ていた作付の詳細を開く
  await page.run(`location.hash = "#detail/planting/pl2"`);
  await page.waitFor(`location.hash === "#detail/planting/pl2" && !document.getElementById("plantingView").hidden`, "作付の詳細");
  await reopen();
  await page.waitFor(`document.getElementById("viewTabs")?.hidden === false && location.hash === "#detail/planting/pl2" && !document.getElementById("plantingView").hidden`, "作付の詳細で開く");
  assert.deepEqual(page.errors, []);
});

test("今日: 計画にない作業を実績につなぐと、実績の名前で出す。時刻を変えていなければ「直した」を付けない", options, async () => {
  const start = new Date();
  start.setHours(0, 2, 54, 0); // 秒まで入った、押して測った時刻
  const stop = new Date(start.getTime() + 79 * 60000);
  const log = {
    id: "l1", field_id: "f1", date: today, end_date: null, work_type: "care", finishes: true, spec: { items: ["摘葉", "誘引"] }, note: "", created_at: AT,
    targets: [{ id: "t1", log_id: "l1", planting_id: "pl1", bed_id: "bed1", block_id: "b1", work_id: null, label: "A 畝1 試験菜", crop_name: "試験菜", area_m2: 30, spray_l: null }],
    inputs: [],
  };
  await page.loadApp(seed({
    workLogs: [log],
    workSessions: [{ id: "s1", field_id: "f1", kind: "work", work_type: "care", work_ids: [], log_id: null, label: "株の手入れ", started_at: start.toISOString(), stopped_at: stop.toISOString(), source: "measured", created_at: start.toISOString() }],
  }));
  await page.openView("today");
  await page.waitFor(`document.querySelector('#todaySessions [data-session="s1"] .session-name')?.textContent === "株の手入れ"`, "始めたときの名前");
  await page.click('#todaySessions [data-today="edit"][data-id="s1"]');
  await page.setValue('dialog.session-dialog[open] [data-field="log"]', "l1");
  await page.click('dialog.session-dialog[open] [data-act="save"]');
  await page.waitFor(`document.querySelector('#todaySessions [data-session="s1"] .session-name')?.textContent === "株の手入れ（摘葉・誘引） A 畝1 試験菜"`, "実績の名前になる");
  let [saved] = await sessions();
  assert.equal(saved.log_id, "l1");
  assert.equal(saved.label, "株の手入れ（摘葉・誘引） A 畝1 試験菜");
  assert.equal(saved.source, "measured");
  assert.equal(saved.started_at, start.toISOString(), "秒まで元のまま");
  assert.equal(saved.stopped_at, stop.toISOString());

  // 時刻を直すと「直した」
  await page.click('#todaySessions [data-today="edit"][data-id="s1"]');
  await page.setValue('dialog.session-dialog[open] [data-field="stop"]', "01:30");
  await page.click('dialog.session-dialog[open] [data-act="save"]');
  await page.waitFor(`document.querySelector('#todaySessions [data-session="s1"] .session-name')?.textContent.includes("（直した）")`, "直した印");
  [saved] = await sessions();
  assert.equal(saved.source, "edited");
  assert.equal(saved.started_at, start.toISOString(), "直していない始めた時刻は元のまま");
  assert.deepEqual(page.errors, []);
});

test("作業時間: 区画全体の作業は、その日の畝の作付に面積の比で分け、作付の詳細・区画の頭・収支のタブに出す", options, async () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const iso = (minutes) => new Date(start.getTime() + minutes * 60000).toISOString();
  const row = (id, from, to, extra) => ({ id, field_id: "f1", kind: "work", work_type: "harvest", work_ids: [], log_id: null, label: "", started_at: iso(from), stopped_at: iso(to), source: "measured", created_at: iso(from), ...extra });
  const data = seed({
    workSessions: [
      // 区画 A 全体の耕うんを 76 分。畝＋通路の面積は、畝 1 が幅 4 m、畝 2 が幅 34 m なので、8 分と 68 分に分ける
      row("s1", 0, 76, { work_type: "rotary", work_ids: ["wb"] }),
      // 畝 1 の収穫を 20 分
      row("s2", 76, 96, { work_ids: ["w1"] }),
    ],
  });
  data.works.push({ id: "wb", plan_id: "p1", planting_id: null, block_id: "b1", seq: 1, work_type: "rotary", plan_start: today, plan_end: today });
  await page.loadApp(data);
  await page.run(`location.hash = "#detail/planting/pl1"`);
  await page.waitFor(`document.querySelector("#plantingBody .detail-info")?.textContent.includes("作業時間 0:28（うち区画の作業から 0:08）")`, "作付の詳細の頭");
  const panel = await page.run(`[...document.querySelectorAll("#plantingBody .work-time-panel td.num")].map((td) => td.textContent)`);
  assert.deepEqual(panel, ["0:20", "0:08", "0:28"]);
  assert.match(await page.run(`document.querySelector("#plantingBody .work-time-panel p").textContent`), /収穫 0:20、耕うん（区画） 0:08|収穫 0:20、.+（区画） 0:08/);

  await page.run(`location.hash = "#schedule/block/b1"`);
  await page.waitFor(`document.querySelector("#blockHead .block-work-time")?.textContent === "作業時間 1:36（区画全体 1:16・畝 0:20）"`, "区画の頭");

  await page.openView("revenue");
  await page.waitFor(`document.querySelectorAll("#revenueBody tbody tr[data-planting]").length === 2`, "収支の作付の行");
  const cells = await page.run(`[...document.querySelectorAll("${PLANTING_ROWS}")].map((tr) => [0, 1, 8, 9].map((i) => tr.cells[i].textContent))`);
  assert.deepEqual(cells, [["A 畝1", "試験菜", "0:28", "0:08"], ["A 畝2", "試験菜", "1:08", "1:08"]]);
  assert.equal(await page.run(`document.querySelector("#revenueBody .revenue-table tfoot .num").textContent`), "1:36");
  assert.deepEqual(page.errors, []);
});

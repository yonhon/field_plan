// 収量と売上の見込み、収穫量の実績、市況からの単価の推定（revenue.js、revenue-view.js）を、Chrome で通して確かめる。
// 作付の詳細の「収量と売上」の欄、「工程の計画」の作付の値、入力の窓の畝ごとの収穫量、「収支」のタブ、苗・肥料・収量の集計。
// 数字は、すべて説明のために作った値。実行: node --test "tests/e2e/*.test.mjs"
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const DIALOG = "dialog.log-dialog[open]";
const PLANTING_ROWS = "#revenueBody .revenue-table tbody tr";
const pad = (n) => String(n).padStart(2, "0");
const TODAY = ((time) => `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`)(new Date());

// 区画 A に、長さ 16 m の畝を 2 本。株間 40 cm・1 条なので苗は 40 株。1 株 500 g で収量 20 kg、出荷率 80 % で 16 kg、300 円/kg で 4,800 円
const seed = ({ crop = {}, works = null, ...extra } = {}) => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", active_plan_id: "p1", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: [1, 2].map((seq) => ({ id: `bed${seq}`, plan_id: "p1", block_id: "b1", seq, shape: [[seq * 3, 2], [seq * 3 + 1, 2], [seq * 3 + 1, 18], [seq * 3, 18]], start_date: null, removed_on: null })),
  plantings: [1, 2].map((seq) => ({ id: `pl${seq}`, plan_id: "p1", bed_id: `bed${seq}`, seq: 1, crop_id: "c1", crop_name: "試験菜" })),
  works:
    works ||
    [1, 2].map((seq) => ({ id: `w${seq}`, plan_id: "p1", planting_id: `pl${seq}`, block_id: null, seq: 1, work_type: "harvest", plan_start: "2027-06-01", plan_end: "2027-06-10" })),
  crops: [
    {
      id: "c1",
      name: "試験菜",
      mulch: false,
      bed_width_cm: 100,
      aisle_width_cm: 60,
      plant_gap_cm: 40,
      row_count: 1,
      yield_g_per_plant: 500,
      shippable_pct: 80,
      price_yen_per_kg: 300,
      ...crop,
    },
  ],
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

const saved = () => page.run(`JSON.parse(localStorage.getItem("field_plan_local"))`);
// 値を入れて、change（と input）を送る
const setValue = (selector, value, events = ["input", "change"]) =>
  page.run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(value)};
    for (const type of ${JSON.stringify(events)}) el.dispatchEvent(new Event(type, { bubbles: true }));
  })()`);
// 作付の詳細の「収量と売上」の表。[見出し, 見込み, 実績]
const panelRows = () => page.run(`[...document.querySelectorAll("#plantingBody .revenue-panel-table tbody tr")].map((tr) => [...tr.cells].map((td) => td.textContent))`);
const panelNotes = () => page.run(`[...document.querySelectorAll("#plantingBody .revenue-panel p")].map((p) => p.textContent).join("\\n")`);
// 「収支」のタブの行を押して、作付の詳細を開く（窓を閉じた直後に URL を書き換えると、窓を閉じたときの「戻る」とぶつかるので、人と同じく押して開く）
const openFromRevenue = async (id) => {
  await page.click(`#revenueBody tr[data-planting="${id}"]`);
  await page.waitFor(`location.hash === "#detail/planting/${id}" && Boolean(document.querySelector("#plantingBody .revenue-panel"))`, "作付の詳細の収量と売上");
};
const openPlanting = async (id) => {
  await page.run(`location.hash = "#detail/planting/${id}"`);
  await page.waitFor(`location.hash === "#detail/planting/${id}" && Boolean(document.querySelector("#plantingBody .revenue-panel"))`, "作付の詳細の収量と売上");
};

test("収量と売上: 品目の値から見込みを出し、作付の値を優先する。「収支」のタブと集計の窓にも出す", options, async () => {
  await page.loadApp(seed());
  await openPlanting("pl1");
  assert.deepEqual((await panelRows()).slice(0, 4), [
    ["収量（kg）", "20.0", "－"],
    ["出荷量（kg）", "16.0", "－"],
    ["単価（円/kg）", "300（品目）", "－"],
    ["売上（円）", "4,800", "－"],
  ]);
  assert.match(await panelNotes(), /1 株 500 g × 苗 40（品目の値）。出荷率 80 %（品目の値）。金額は税抜きです。/);

  // 「見込みを記録」で、入力の窓の「収量と単価」のタブをこの作付で開き、単価だけを記録する
  await page.click('#plantingBody [data-act="forecast"]');
  await page.waitFor(`document.querySelector('${DIALOG} [data-act="kind"].is-on')?.dataset.kind === "forecast"`, "収量と単価のタブ");
  assert.equal(await page.run(`document.querySelector('${DIALOG} [data-fc="planting"]').value`), "pl1");
  const PRICE = `${DIALOG} [data-fc-scope="form"][data-fc-field="price_yen_per_kg"]`;
  assert.equal(await page.run(`document.querySelector(${JSON.stringify(PRICE)}).placeholder`), "品目 300");
  await setValue(PRICE, "400");
  await setValue(`${DIALOG} [data-fc-scope="form"][data-fc-field="note"]`, "試しに高めにみる");
  await page.click(`${DIALOG} [data-fc-act="add"]`);
  await page.waitFor(`(JSON.parse(localStorage.getItem("field_plan_local")).planting_forecasts || []).some((row) => row.planting_id === "pl1" && row.price_yen_per_kg === 400 && row.shippable_pct === null)`, "見込みの記録が保存される");
  // 記録すると、いま使っている値と履歴に出て、新しく記録する欄は空に戻る
  await page.waitFor(`document.querySelectorAll('${DIALOG} .fc-entry').length === 1`, "履歴に 1 件");
  assert.match(await page.run(`document.querySelector('${DIALOG} .fc-entry').textContent`), /単価 400 円\/kg.*試しに高めにみる/);
  assert.equal(await page.run(`document.querySelector(${JSON.stringify(PRICE)}).value`), "");
  assert.deepEqual(
    await page.run(`[...document.querySelectorAll('${DIALOG} .fc-current tr')].map((tr) => [...tr.cells].map((cell) => cell.textContent))`).then((rows) => rows[3].slice(1)),
    ["400 円/kg", `${Number(TODAY.slice(5, 7))}/${Number(TODAY.slice(8, 10))} の記録`]
  );
  await page.click(`${DIALOG} [data-act="close"]`);
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "閉じる");
  await page.waitFor(
    `[...document.querySelectorAll("#plantingBody .revenue-panel-table tbody tr")].some((tr) => tr.cells[1].textContent === "400（作付）")`,
    "作付の単価を使う"
  );
  assert.deepEqual((await panelRows())[3], ["売上（円）", "6,400", "－"]);
  assert.match(await page.run(`document.querySelector("#plantingBody .revenue-reviewed").textContent`), /見込みを .+ に記録（1 回目）/);

  // 「収支」のタブ: 作付ごとの見込み
  await page.openView("revenue");
  await page.waitFor(`document.querySelectorAll("${PLANTING_ROWS}").length === 2`, "作付の行が 2 つ");
  assert.deepEqual(await page.run(`[...document.querySelectorAll("${PLANTING_ROWS}")].map((tr) => [0, 2, 3, 4, 5].map((i) => tr.cells[i].textContent))`), [
    ["A 畝1", "20.0", "80 %", "400（作付）", "6,400"],
    ["A 畝2", "20.0", "80 %", "300（品目）", "4,800"],
  ]);
  // 「品目ごとの収支」のサブタブ: 品目ごとの合計
  await page.click('#revenueView [data-revenuetab="crops"]');
  await page.waitFor(`location.hash === "#revenue/crops" && !document.querySelector('[data-revenuepanel="crops"]').hidden`, "品目ごとの収支のサブタブ");
  assert.deepEqual(
    await page.run(`[...document.querySelector("#revenueCrops .revenue-crops tfoot tr").cells].map((cell) => cell.textContent)`),
    ["合計", "2", "40.0", "11,200", "0.0"]
  );
  // サブタブは覚えるので、ほかのテストのために「作付ごとの収支」に戻しておく
  await page.click('#revenueView [data-revenuetab="plantings"]');
  await page.waitFor(`location.hash === "#revenue/plantings"`, "作付ごとの収支に戻す");

  // 苗・肥料・収量の集計（日程の区画の頭の面積・畝の行を押すと開く）
  await page.run(`location.hash = "#schedule/block/b1"`);
  await page.click('#blockHead [data-act="summary"]');
  await page.waitFor(`document.getElementById("blockSummary").hidden === false`, "集計の窓");
  assert.deepEqual(await page.run(`[...document.querySelector("#cropSummary tr").cells].slice(5).map((cell) => cell.textContent)`), ["40.0", "11,200"]);
  assert.equal(await page.run(`document.getElementById("revenueSummary").textContent`), "見込みの合計: 収量 40.0 kg・売上 11,200 円（税抜き）");
  // 日程の「全体」でも、窓を出していれば見込みを出す（見込みは、窓を出しているときだけ計算する）
  await page.run(`location.hash = "#schedule/all"`);
  await page.waitFor(`document.getElementById("summaryTitle").textContent === "苗・肥料・収量の集計（全体）" && document.getElementById("blockSummary").hidden === false`, "全体の集計");
  await page.waitFor(`document.getElementById("revenueSummary").textContent === "見込みの合計: 収量 40.0 kg・売上 11,200 円（税抜き）"`, "全体でも見込みの合計");
  assert.deepEqual(page.errors, []);
});

test("区画に入れた収穫の計画は、その日に区画にある作付の収穫の計画として、作付自身の収穫の計画と合わせて売上を出す", options, async () => {
  // 区画 A の収穫（6/1〜6/3）と、畝 1 の作付だけの収穫（6/20〜6/21）。畝 2 は区画の収穫だけで、作付の作業（定植）は 4/1 に終わる
  // （作付の作業が終わったあとも、次の作付が始まるまでは畝にあるので、区画の収穫はその作付の収穫になる）
  const works = [
    { id: "wb", plan_id: "p1", planting_id: null, block_id: "b1", seq: 1, work_type: "harvest", plan_start: "2027-06-01", plan_end: "2027-06-03" },
    { id: "w2", plan_id: "p1", planting_id: "pl2", block_id: null, seq: 1, work_type: "plant", plan_start: "2027-04-01", plan_end: "2027-04-01" },
    { id: "w1", plan_id: "p1", planting_id: "pl1", block_id: null, seq: 1, work_type: "harvest", plan_start: "2027-06-20", plan_end: "2027-06-21" },
  ];
  await page.loadApp(seed({ works }));
  await openPlanting("pl2");
  assert.deepEqual((await panelRows())[3], ["売上（円）", "4,800", "－"]);
  assert.doesNotMatch(await panelNotes(), /収穫の計画（日付の入った収穫の作業）がないので/);
  // 作付の詳細の頭の収穫完了予定日も、区画の収穫の終わり
  assert.match(await page.run(`document.getElementById("plantingBody").textContent`), /6\/3/);
  await openPlanting("pl1");
  assert.deepEqual((await panelRows())[3], ["売上（円）", "4,800", "－"]);
  // 月次: 両方の作付が 6 月に出る
  await page.openView("revenue");
  await page.click('#revenueView [data-revenuetab="monthly"]');
  await page.waitFor(`document.querySelectorAll("#revenueMonthly tbody tr").length === 2`, "月次に 2 つの作付");
  assert.deepEqual(await page.run(`[...document.querySelector("#revenueMonthly tfoot tr").cells].map((cell) => cell.textContent)`), ["合計", "9,600", "9,600"]);
  await page.click('#revenueView [data-revenuetab="plantings"]');
  await page.waitFor(`location.hash === "#revenue/plantings"`, "作付ごとの収支に戻す");
  assert.deepEqual(page.errors, []);
});

test("収穫量: 畝ごとに入れた量はそのまま、残りを面積の比で分ける。合計を超えると保存しない", options, async () => {
  // 入力の窓の対象は、その日にある作付なので、収穫の計画を今日にする
  const works = [1, 2].map((seq) => ({ id: `w${seq}`, plan_id: "p1", planting_id: `pl${seq}`, block_id: null, seq: 1, work_type: "harvest", plan_start: TODAY, plan_end: TODAY }));
  await page.loadApp(seed({ works }));
  await page.click("#logAddBtn");
  await page.click(`${DIALOG} [data-act="kind"][data-kind="actual"]`);
  await setValue(`${DIALOG} [data-f="typeOther"]`, "harvest", ["change"]);
  await page.click(`${DIALOG} [data-act="group"]`);
  await setValue(`${DIALOG} [data-spec="harvest_kg"]`, "30");
  await page.click(`${DIALOG} [data-act="harvestBeds"]`);
  const BED1 = `${DIALOG} [data-harvest="bed1"]`;
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(BED1)}))`, "畝ごとの欄");

  // 2 本の畝は同じ面積なので、量っていない畝 2 には、残り 20 kg がそのまま行く
  await setValue(BED1, "10");
  await page.waitFor(`document.querySelector('${DIALOG} [data-harvest-hint="bed2"]').textContent === "分けた量 20.00 kg"`, "分けた量の文");
  assert.equal(await page.run(`document.querySelector('${DIALOG} [data-harvest-hint="bed1"]').textContent`), "");

  // 畝ごとの量が収穫量を超えると、知らせて保存しない
  await setValue(BED1, "40");
  await page.waitFor(`/超えています/.test(document.getElementById("logHarvestNote").textContent)`, "超えている知らせ");
  await page.click(`${DIALOG} [data-act="save"]`);
  await page.waitFor(`/畝ごとの量の合計（40.00 kg）が、収穫量（30.00 kg）を超えています/.test(document.getElementById("logError").textContent)`, "保存しない");
  assert.deepEqual((await saved()).workLogs || [], []);

  await setValue(BED1, "10");
  await page.click(`${DIALOG} [data-act="save"]`);
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "保存して閉じる");
  const [log] = (await saved()).workLogs;
  assert.equal(log.spec.harvest_kg, 30);
  assert.deepEqual(
    log.targets.map((target) => [target.bed_id, target.harvest_kg]),
    [
      ["bed1", 10],
      ["bed2", null],
    ]
  );

  // 「収支」のタブ: 収穫量と、収穫量から見た売上（収穫量 × 出荷率 80 % × 300 円）
  await page.openView("revenue");
  await page.waitFor(`document.querySelectorAll("${PLANTING_ROWS}").length === 2`, "作付の行");
  assert.deepEqual(await page.run(`[...document.querySelectorAll("${PLANTING_ROWS}")].map((tr) => [6, 7].map((i) => tr.cells[i].textContent))`), [
    ["10.0", "2,400"],
    ["20.0", "4,800"],
  ]);

  // 作付の詳細（収支のタブの行から開く）: 量った畝はそのまま、量っていない畝は分けた値と分かるように
  await openFromRevenue("pl2");
  assert.deepEqual((await panelRows())[0], ["収量（kg）", "20.0", "20.0（1 回）"]);
  assert.match(await panelNotes(), /収穫量のうち 20.0 kg は、何本かの畝をまとめて量った量を、畝＋通路の面積の比で分けた値です。/);
  await page.openView("revenue");
  await openFromRevenue("pl1");
  assert.deepEqual((await panelRows())[0], ["収量（kg）", "20.0", "10.0（1 回）"]);
  assert.doesNotMatch(await panelNotes(), /分けた値です/);
  // 収量の差による売上の差 =（実績の出荷量 8 − 見込み 16）× 300 円。収穫の計画は今日までなので、途中の値
  assert.deepEqual((await panelRows()).at(-1), ["収量の差による売上の差（収穫中）", "－", "−2,400"]);

  // 開き直すと、畝ごとの欄が開いていて、入れた量が入っている
  await page.click(`#plantingBody [data-gantt-mode="both"]`);
  await page.click("#plantingBody a[data-log]");
  await page.waitFor(`document.querySelector('${DIALOG} [data-harvest="bed1"]')?.value === "10"`, "畝ごとの量を開き直せる");
  assert.equal(await page.run(`document.querySelector('${DIALOG} [data-harvest="bed2"]').value`), "");
  await page.click(`${DIALOG} [data-act="close"]`);
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "閉じる");
  // 窓を閉じたときの「戻る」が終わってから、次のテストへ（終わる前に離れると、戻るがアプリの画面へ戻してしまう）
  await page.openView("revenue");
  await page.waitFor(`location.hash === "#revenue/plantings" && !history.state?.fieldPlanDialog`, "収支のタブに戻る");
  assert.deepEqual(page.errors, []);
});

test("単価: 品目にも作付にもなければ、収穫の日ごとにその日の前後 7 日の市況から推す。足りなければ全期間と注記する。月次に月ごとの売上を出す", options, async () => {
  // 畝 1 の収穫は 6/27〜7/2 の 6 日。市況は 6/20〜6/24 に 100 円、7/5〜7/9 に 400 円。日ごとに前後 7 日に入る取引が変わり、
  // 中央値は 6/27〜6/29 が 100 円、6/30〜7/2 が 400 円になる。
  // 畝 2 の収穫は 1 月で、その時期の市況はない（全期間の中央値 = 250 円）。ほかの品目の市況も 1 つ入れておく
  const market = [
    ...["06-20", "06-21", "06-22", "06-23", "06-24"].map((date) => ({ item_name: "しけんな", sale_date: `2026-${date}`, avg_price: 100 })),
    ...["07-05", "07-06", "07-07", "07-08", "07-09"].map((date) => ({ item_name: "しけんな", sale_date: `2026-${date}`, avg_price: 400 })),
    { item_name: "ほかの品目", sale_date: "2026-06-01", avg_price: 50 },
  ];
  const works = [
    { id: "w1", plan_id: "p1", planting_id: "pl1", block_id: null, seq: 1, work_type: "harvest", plan_start: "2027-06-27", plan_end: "2027-07-02" },
    { id: "w2", plan_id: "p1", planting_id: "pl2", block_id: null, seq: 1, work_type: "harvest", plan_start: "2027-01-10", plan_end: "2027-01-20" },
  ];
  await page.loadApp(seed({ crop: { price_yen_per_kg: null, market_item_name: "しけんな" }, works, market }));
  // 出荷量 16 kg を 6 日に均等に分ける。単価は日ごとの単価の平均の 250 円
  await openPlanting("pl1");
  await page.waitFor(
    `[...document.querySelectorAll("#plantingBody .revenue-panel-table tbody tr")].some((tr) => tr.cells[1].textContent === "250（市況・前後 7 日）")`,
    "日ごとの市況からの単価"
  );
  assert.deepEqual((await panelRows())[3], ["売上（円）", "4,000", "－"]);
  assert.match(
    await panelNotes(),
    /単価は、収穫の予定（6\/27〜7\/2）に均等に出荷するとして、市況「しけんな」から推しました。収穫の予定の 6 日それぞれの卸値から推した単価の平均（前後 7 日の中央値 6 日）。手数料などを引く前の卸値です。/
  );

  await openPlanting("pl2");
  await page.waitFor(
    `[...document.querySelectorAll("#plantingBody .revenue-panel-table tbody tr")].some((tr) => tr.cells[1].textContent === "250（市況・全期間）")`,
    "全期間の中央値"
  );
  assert.match(await panelNotes(), /収穫の予定の 11 日それぞれの卸値から推した単価の平均（市況が足りず全期間の中央値 11 日）/);

  // 「収支」のタブ: どこまで広げた市況から推したかを、単価に添える。指すと、日ごとの内訳を出す
  await page.openView("revenue");
  await page.waitFor(`document.querySelectorAll("${PLANTING_ROWS}").length === 2`, "作付の行");
  assert.deepEqual(await page.run(`[...document.querySelectorAll("${PLANTING_ROWS}")].map((tr) => [tr.cells[4].textContent, tr.cells[4].title, tr.cells[5].textContent])`), [
    ["250（市況・前後 7 日）", "収穫の予定の 6 日それぞれの卸値から推した単価の平均（前後 7 日の中央値 6 日）", "4,000"],
    ["250（市況・全期間）", "収穫の予定の 11 日それぞれの卸値から推した単価の平均（市況が足りず全期間の中央値 11 日）", "4,000"],
  ]);

  // 月次: 横に月（売上のない月も並べる）と合計、縦に作付と合計
  await page.click('#revenueView [data-revenuetab="monthly"]');
  await page.waitFor(`location.hash === "#revenue/monthly" && !document.querySelector('[data-revenuepanel="monthly"]').hidden`, "月次のサブタブ");
  assert.equal(await page.run(`document.querySelector('[data-revenuepanel="plantings"]').hidden`), true);
  const table = (part) => page.run(`[...document.querySelectorAll("#revenueMonthly ${part} tr")].map((tr) => [...tr.cells].map((cell) => cell.textContent))`);
  assert.deepEqual(await table("thead"), [["場所", "品目", "2027/1", "2027/2", "2027/3", "2027/4", "2027/5", "2027/6", "2027/7", "合計"]]);
  assert.deepEqual(await table("tbody"), [
    ["A 畝1", "試験菜", "", "", "", "", "", "1,867", "2,133", "4,000"],
    ["A 畝2", "試験菜", "4,000", "", "", "", "", "", "", "4,000"],
  ]);
  assert.deepEqual(await table("tfoot"), [["合計", "4,000", "0", "0", "0", "0", "1,867", "2,133", "8,000"]]);
  // 合計の行は、見出しの欄（場所・品目）にも値の欄と同じ上の線を引く（線が途中で切れない）
  assert.deepEqual(
    await page.run(`[...document.querySelector("#revenueMonthly tfoot tr").cells].slice(0, 2).map((cell) => getComputedStyle(cell).borderTopStyle + " " + getComputedStyle(cell).borderTopWidth)`),
    await page.run(`[...document.querySelector("#revenueMonthly tfoot tr").cells].slice(1, 3).map((cell) => getComputedStyle(cell).borderTopStyle + " " + getComputedStyle(cell).borderTopWidth)`)
  );
  // 再読み込みしても月次で開き、行を押すと作付の詳細を開く
  await page.run(`location.reload()`);
  await page.waitFor(`document.getElementById("viewTabs")?.hidden === false && location.hash === "#revenue/monthly" && document.querySelectorAll("#revenueMonthly tbody tr").length === 2`, "月次で開き直す");
  await page.click('#revenueMonthly tr[data-planting="pl2"]');
  await page.waitFor(`location.hash === "#detail/planting/pl2"`, "作付の詳細を開く");

  // 読んだ市況は端末に取っておき、次の起動では読み直さずに使う（ここでは、DB の側の市況を空にして開き直す）
  const kept = await page.run(`localStorage.getItem("field_plan_market")`);
  assert.match(kept, /しけんな/);
  await page.loadApp(seed({ crop: { price_yen_per_kg: null, market_item_name: "しけんな" }, works, market: [] }), { field_plan_market: kept });
  await openPlanting("pl1");
  await page.waitFor(
    `[...document.querySelectorAll("#plantingBody .revenue-panel-table tbody tr")].some((tr) => tr.cells[1].textContent === "250（市況・前後 7 日）")`,
    "取っておいた市況からの単価"
  );

  // 台帳の品目: 市況の品目名の候補を出す
  await page.openView("master");
  await page.waitFor(`document.querySelectorAll("#cropTable datalist option").length === 2`, "市況の品目名の候補");
  assert.equal(await page.run(`document.querySelector('#cropTable [data-field="market_item_name"]').value`), "しけんな");
  assert.deepEqual(page.errors, []);
});

test("収穫量: 量の入っていない収穫の記録は、実績の収穫量に数えない（0.0 と出さない）。作付の詳細にそのことを書く", options, async () => {
  const log = (id, spec) => ({
    id,
    field_id: "f1",
    date: TODAY,
    end_date: null,
    work_type: "harvest",
    finishes: false,
    spec,
    note: "",
    created_at: AT,
    targets: [{ id: `${id}t`, log_id: id, planting_id: "pl1", bed_id: "bed1", block_id: null, work_id: null, label: "A 畝1 試験菜", crop_name: "試験菜", area_m2: 30, harvest_kg: null }],
    inputs: [],
  });
  await page.loadApp(seed({ workLogs: [log("l1", {})] }));
  await page.openView("revenue");
  await page.waitFor(`document.querySelectorAll("${PLANTING_ROWS}").length === 2`, "作付の行");
  assert.deepEqual(await page.run(`[...document.querySelectorAll("${PLANTING_ROWS}")].map((tr) => [6, 7].map((i) => tr.cells[i].textContent))`), [
    ["", ""],
    ["", ""],
  ]);
  await openFromRevenue("pl1");
  assert.deepEqual((await panelRows())[0], ["収量（kg）", "20.0", "－"]);
  assert.match(await panelNotes(), /収穫の記録 1 回に、収穫量が入っていません。/);
  assert.doesNotMatch(await panelNotes(), /収量の差/);

  // 量の入った記録と混ざっていれば、入った分だけを足し、入っていない回数を添える
  await page.loadApp(seed({ workLogs: [log("l1", {}), log("l2", { harvest_kg: 5 })] }));
  await openPlanting("pl1");
  assert.deepEqual((await panelRows())[0], ["収量（kg）", "20.0", "5.0（1 回）"]);
  assert.match(await panelNotes(), /収穫の記録 2 回のうち 1 回は、収穫量が入っていません（実績の収穫量に数えていません）。/);
  assert.deepEqual(page.errors, []);
});

test("収量と単価の見込み: 履歴を直す・削除する。いま使う値は、項目ごとにいちばん新しい記録の値。削除は元に戻せる", options, async () => {
  // 10/1 に出荷率 90 %・単価 350 円、11/20 に出荷率 70 % を記録してある（単価は 10/1 のまま）
  const planting_forecasts = [
    { id: "fc1", plan_id: "p1", planting_id: "pl1", set_on: "2026-10-01", yield_kg_per_10a: null, yield_g_per_plant: null, shippable_pct: 90, price_yen_per_kg: 350, note: "初めの見込み", created_at: AT },
    { id: "fc2", plan_id: "p1", planting_id: "pl1", set_on: "2026-11-20", yield_kg_per_10a: null, yield_g_per_plant: null, shippable_pct: 70, price_yen_per_kg: null, note: "発芽が 7 割", created_at: AT },
  ];
  const saved = () => page.run(`JSON.parse(localStorage.getItem("field_plan_local")).planting_forecasts.map((row) => [row.id, row.shippable_pct, row.price_yen_per_kg, row.note])`);
  const current = () => page.run(`[...document.querySelectorAll('${DIALOG} .fc-current tr')].map((tr) => [...tr.cells].slice(1).map((cell) => cell.textContent))`);
  await page.loadApp(seed({ planting_forecasts }));
  await openPlanting("pl1");
  // 16 kg ではなく、出荷率 70 % で 14 kg、単価 350 円
  assert.deepEqual((await panelRows()).slice(1, 4), [
    ["出荷量（kg）", "14.0", "－"],
    ["単価（円/kg）", "350（作付）", "－"],
    ["売上（円）", "4,900", "－"],
  ]);
  assert.match(await page.run(`document.querySelector("#plantingBody .revenue-reviewed").textContent`), /見込みを 11\/20 に見直し（2 回目）/);

  await page.click('#plantingBody [data-act="forecast"]');
  await page.waitFor(`document.querySelectorAll('${DIALOG} .fc-entry').length === 2`, "履歴に 2 件");
  assert.deepEqual(await current(), [
    ["－", "値なし"],
    ["500 g/株", "品目の値"],
    ["70 %", "11/20 の記録"],
    ["350 円/kg", "10/1 の記録"],
  ]);
  // 履歴は新しい順
  assert.deepEqual(await page.run(`[...document.querySelectorAll('${DIALOG} .fc-entry')].map((li) => li.dataset.forecast)`), ["fc2", "fc1"]);

  // 10/1 の記録を直す（単価 380 円）
  await page.click(`${DIALOG} [data-fc-act="edit"][data-id="fc1"]`);
  await setValue(`${DIALOG} [data-fc-scope="edit"][data-fc-field="price_yen_per_kg"]`, "380");
  await page.click(`${DIALOG} [data-fc-act="save-edit"][data-id="fc1"]`);
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).planting_forecasts.find((row) => row.id === "fc1").price_yen_per_kg === 380`, "直した値が保存される");
  assert.deepEqual((await current())[3], ["380 円/kg", "10/1 の記録"]);

  // 11/20 の記録を削除すると、出荷率は 10/1 の記録の 90 % に戻る
  await page.click(`${DIALOG} [data-fc-act="delete"][data-id="fc2"]`);
  await page.click('dialog.notice [data-action="delete"]');
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).planting_forecasts.length === 1`, "削除が保存される");
  await page.waitFor(`document.querySelectorAll('${DIALOG} .fc-entry').length === 1`, "履歴に 1 件");
  assert.deepEqual((await current())[2], ["90 %", "10/1 の記録"]);
  await page.click(`${DIALOG} [data-act="close"]`);
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "閉じる");

  // 元に戻すと、削除した記録が戻る
  await page.click("#undoBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).planting_forecasts.length === 2`, "削除を元に戻す");
  assert.deepEqual(await saved(), [
    ["fc1", 90, 380, "初めの見込み"],
    ["fc2", 70, null, "発芽が 7 割"],
  ]);
  await page.waitFor(
    `[...document.querySelectorAll("#plantingBody .revenue-panel-table tbody tr")].some((tr) => tr.cells[1].textContent === "380（作付）")`,
    "作付の詳細も戻る"
  );
  assert.deepEqual((await panelRows())[1], ["出荷量（kg）", "14.0", "－"]);
  assert.deepEqual(page.errors, []);
});

test("入力の窓の上のタブ: 4 つのタブが、PC でもスマホの幅でも 1 行に並び、文字が切れない", options, async () => {
  await page.loadApp(seed());
  for (const width of [1280, 390, 360]) {
    await page.viewport(width);
    await page.click("#logAddBtn");
    await page.waitFor(`document.querySelectorAll('${DIALOG} [data-act="kind"]').length === 4`, `タブが 4 つ（幅 ${width}）`);
    const tabs = await page.run(`[...document.querySelectorAll('${DIALOG} [data-act="kind"]')].map((el) => ({ top: Math.round(el.getBoundingClientRect().top), cut: el.scrollWidth > el.clientWidth }))`);
    assert.equal(new Set(tabs.map((tab) => tab.top)).size, 1, `幅 ${width} で 1 行`);
    assert.deepEqual(tabs.map((tab) => tab.cut), [false, false, false, false], `幅 ${width} で文字が切れない`);
    await page.click(`${DIALOG} .log-head [data-act="close"]`);
    await page.waitFor(`!document.querySelector("${DIALOG}") && history.state?.fieldPlanDialog !== true`, "閉じる");
  }
  await page.viewport();
  assert.deepEqual(page.errors, []);
});

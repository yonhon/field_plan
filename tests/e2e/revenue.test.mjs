// 収量と売上の見込み、収穫量の実績、市況からの単価の推定（revenue.js、revenue-view.js）を、Chrome で通して確かめる。
// 作付の詳細の「収量と売上」の欄、「工程の計画」の作付の値、入力の窓の畝ごとの収穫量、「収支」のタブ、苗・肥料・収量の集計。
// 数字は、すべて説明のために作った値。実行: node --test "tests/e2e/*.test.mjs"
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const DIALOG = "dialog.log-dialog[open]";
const PLANTING_ROWS = "#revenueBody .revenue-table:not(.revenue-crops) tbody tr";
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

  // 「工程の計画」のこの作付で、単価だけを上書きする
  await page.click('#plantingBody [data-act="record"]');
  await page.click(`${DIALOG} [data-act="kind"][data-kind="process"]`);
  await page.click(`${DIALOG} [data-pe-act="values"][data-owner="planting:pl1"]`);
  const PRICE = `${DIALOG} [data-pe="value"][data-key="price_yen_per_kg"][data-owner="planting:pl1"]`;
  await page.waitFor(`document.querySelector(${JSON.stringify(PRICE)})?.placeholder === "品目: 300"`, "空の欄に品目の値");
  await setValue(PRICE, "400", ["change"]);
  await page.click(`${DIALOG} [data-act="save"]`);
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "保存して閉じる");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).plantings.find((item) => item.id === "pl1").price_yen_per_kg === 400`, "作付の単価が保存される");
  await page.waitFor(
    `[...document.querySelectorAll("#plantingBody .revenue-panel-table tbody tr")].some((tr) => tr.cells[1].textContent === "400（作付）")`,
    "作付の単価を使う"
  );
  assert.deepEqual((await panelRows())[3], ["売上（円）", "6,400", "－"]);

  // 「収支」のタブ: 作付ごとの見込みと、品目ごとの合計
  await page.openView("revenue");
  await page.waitFor(`document.querySelectorAll("${PLANTING_ROWS}").length === 2`, "作付の行が 2 つ");
  assert.deepEqual(await page.run(`[...document.querySelectorAll("${PLANTING_ROWS}")].map((tr) => [0, 2, 3, 4, 5].map((i) => tr.cells[i].textContent))`), [
    ["A 畝1", "20.0", "80 %", "400（作付）", "6,400"],
    ["A 畝2", "20.0", "80 %", "300（品目）", "4,800"],
  ]);
  assert.deepEqual(
    await page.run(`[...document.querySelector("#revenueBody .revenue-crops tfoot tr").cells].map((cell) => cell.textContent)`),
    ["合計", "2", "40.0", "11,200", "0.0"]
  );

  // 苗・肥料・収量の集計（日程の区画の頭の面積・畝の行を押すと開く）
  await page.run(`location.hash = "#schedule/block/b1"`);
  await page.click('#blockHead [data-act="summary"]');
  await page.waitFor(`document.getElementById("blockSummary").hidden === false`, "集計の窓");
  assert.deepEqual(await page.run(`[...document.querySelector("#cropSummary tr").cells].slice(5).map((cell) => cell.textContent)`), ["40.0", "11,200"]);
  assert.equal(await page.run(`document.getElementById("revenueSummary").textContent`), "見込みの合計: 収量 40.0 kg・売上 11,200 円（税抜き）");
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
  await page.waitFor(`location.hash === "#revenue" && !history.state?.fieldPlanDialog`, "収支のタブに戻る");
  assert.deepEqual(page.errors, []);
});

test("単価: 品目にも作付にもなければ市況の卸値の中央値。収穫の時期に足りなければ全期間と注記する", options, async () => {
  // 収穫は、畝 1 が 6 月、畝 2 が 1 月。市況は 6 月の 5 日と 9 月の 5 日だけ
  const market = [
    ...[100, 200, 300, 400, 500].map((price, i) => ({ item_name: "しけんな", sale_date: `2026-06-0${i + 1}`, avg_price: price })),
    ...[700, 800, 900, 1000, 1100].map((price, i) => ({ item_name: "しけんな", sale_date: `2026-09-0${i + 1}`, avg_price: price })),
    { item_name: "ほかの品目", sale_date: "2026-06-01", avg_price: 50 },
  ];
  const works = [
    { id: "w1", plan_id: "p1", planting_id: "pl1", block_id: null, seq: 1, work_type: "harvest", plan_start: "2027-06-01", plan_end: "2027-06-10" },
    { id: "w2", plan_id: "p1", planting_id: "pl2", block_id: null, seq: 1, work_type: "harvest", plan_start: "2027-01-10", plan_end: "2027-01-20" },
  ];
  await page.loadApp(seed({ crop: { price_yen_per_kg: null, market_item_name: "しけんな" }, works, market }));
  await openPlanting("pl1");
  await page.waitFor(
    `[...document.querySelectorAll("#plantingBody .revenue-panel-table tbody tr")].some((tr) => tr.cells[1].textContent === "300（市況・収穫期）")`,
    "市況からの単価"
  );
  assert.match(await panelNotes(), /市況「しけんな」の卸値から推しました。収穫の時期（6\/1〜6\/10）の中央値です（5 日分、2026\/06〜2026\/06、幅 200〜400 円）。手数料などを引く前の値です。/);

  await openPlanting("pl2");
  await page.waitFor(
    `[...document.querySelectorAll("#plantingBody .revenue-panel-table tbody tr")].some((tr) => tr.cells[1].textContent === "600（市況・全期間）")`,
    "全期間の中央値"
  );
  assert.match(await panelNotes(), /収穫の時期（1\/10〜1\/20）の市況が足りないため、市況のある全期間の中央値です（10 日分/);

  // 「収支」のタブ: どの期間の市況から推したかを、単価に添える。指すと、日数と幅を出す
  await page.openView("revenue");
  await page.waitFor(`document.querySelectorAll("${PLANTING_ROWS}").length === 2`, "作付の行");
  assert.deepEqual(await page.run(`[...document.querySelectorAll("${PLANTING_ROWS}")].map((tr) => [tr.cells[4].textContent, tr.cells[4].title])`), [
    ["300（市況・収穫期）", "収穫の時期の卸値の中央値（5 日分、2026/06〜2026/06、幅 200〜400 円）"],
    ["600（市況・全期間）", "収穫の時期の市況が足りないため、市況のある全期間の卸値の中央値（10 日分、2026/06〜2026/09、幅 325〜875 円）"],
  ]);

  // 読んだ市況は端末に取っておき、次の起動では読み直さずに使う（ここでは、DB の側の市況を空にして開き直す）
  const kept = await page.run(`localStorage.getItem("field_plan_market")`);
  assert.match(kept, /しけんな/);
  await page.loadApp(seed({ crop: { price_yen_per_kg: null, market_item_name: "しけんな" }, works, market: [] }), { field_plan_market: kept });
  await openPlanting("pl1");
  await page.waitFor(
    `[...document.querySelectorAll("#plantingBody .revenue-panel-table tbody tr")].some((tr) => tr.cells[1].textContent === "300（市況・収穫期）")`,
    "取っておいた市況からの単価"
  );

  // 台帳の品目: 市況の品目名の候補を出す
  await page.openView("master");
  await page.waitFor(`document.querySelectorAll("#cropTable datalist option").length === 2`, "市況の品目名の候補");
  assert.equal(await page.run(`document.querySelector('#cropTable [data-field="market_item_name"]').value`), "しけんな");
  assert.deepEqual(page.errors, []);
});

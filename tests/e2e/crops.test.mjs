// 品目の画面を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 値を変えると保存して表を作り直す。作り直したあとも、Tab で移った先の欄にカーソルが残ることを確かめる
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];

const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [],
  blocks: [],
  beds: [],
  plantings: [],
  works: [],
  crops: [
    { id: "c1", name: "一の菜", variety: "", bed_width_cm: 100, aisle_width_cm: 60 },
    { id: "c2", name: "二の菜", variety: "", bed_width_cm: 100, aisle_width_cm: 60 },
  ],
  fertilizers: [{ id: "fe1", name: "試験の肥料", n_pct: 10, p_pct: 10, k_pct: 10 }],
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

// カーソルのある欄。「行の ID:欄の名前」
const focused = () => page.run(`(() => { const el = document.activeElement; return \`\${el.closest("tr[data-id]")?.dataset.id}:\${el.dataset.field}\`; })()`);

// 保存して、表を作り直すまで待つ（保存の状態を「保存しました」と出したすぐあとに、表を作り直す）
const saved = () => page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "保存");
const clearStatus = () => page.run(`document.getElementById("saveStatus").textContent = ""`);

test("品目の表: 値を変えて Tab を押すと、保存して作り直したあとも、右隣の欄に入っている", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="master"]');
  // 2 行目の品目の名前を変えて、Tab で品種の欄へ
  await page.run(`document.querySelector('#cropTable tr[data-id="c2"] [data-field="name"]').select()`);
  await clearStatus();
  await page.type("三の菜");
  await page.press("Tab");
  await saved();
  assert.equal(await page.run(`document.querySelector('#cropTable tr[data-id="c2"] [data-field="name"]').value`), "三の菜");
  assert.equal(await focused(), "c2:variety");
  // 欄に入ったあとで、ほかの欄の保存が終わって作り直したときも、入っている欄に残る（DB への保存が遅いとき）
  await clearStatus();
  await page.run(`(() => {
    const note = document.querySelector('#cropTable tr[data-id="c1"] [data-field="note"]');
    note.value = "メモ";
    note.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await saved();
  assert.equal(await focused(), "c2:variety");
  // 数の欄でも同じ。畝幅を変えて Tab で隙間の欄へ
  await page.run(`document.querySelector('#cropTable tr[data-id="c1"] [data-field="bed_width_cm"]').select()`);
  await clearStatus();
  await page.type("120");
  await page.press("Tab");
  await saved();
  assert.equal(await focused(), "c1:aisle_width_cm");
  assert.equal((await page.saved()).crops.find((crop) => crop.id === "c1").bed_width_cm, 120);
  assert.deepEqual(page.errors, []);
});

// ---- 台帳のサブタブ ----

const shownPanel = () => page.run(`[...document.querySelectorAll("[data-masterpanel]")].filter((panel) => !panel.hidden).map((panel) => panel.dataset.masterpanel).join()`);
const openOn = (tab) => page.waitFor(`location.hash === "#master/${tab}" && document.querySelector('[data-masterpanel="${tab}"]').hidden === false`, `台帳の ${tab} が開く`);

test("台帳: サブタブごとに URL を持ち、戻るで前のサブタブに戻る。最後に開いたサブタブを、次に台帳を開いたときと開き直したときに開く", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="master"]');
  await openOn("crops");
  assert.equal(await page.run(`document.querySelector(".tab-btn.is-active").textContent`), "台帳");
  assert.deepEqual(await page.run(`[...document.querySelectorAll("[data-mastertab]")].map((tab) => tab.textContent)`), ["品目", "工程作業日数", "肥料"]);

  await page.click('[data-mastertab="fertilizers"]');
  await openOn("fertilizers");
  assert.equal(await shownPanel(), "fertilizers");
  await page.click('[data-mastertab="work-days"]');
  await openOn("work-days");
  assert.ok(await page.run(`document.querySelectorAll("#typeRows tr").length > 0`), "工程作業日数の表");
  await page.run("history.back()");
  await openOn("fertilizers");

  // ほかのタブに移ってから戻ると、最後に開いたサブタブ
  await page.click('.tab-btn[data-view="map"]');
  await page.click('.tab-btn[data-view="master"]');
  await openOn("fertilizers");
  // 開き直したとき（URL がないとき）も
  await page.run(`location.hash = ""; location.reload()`);
  await page.waitFor(`document.getElementById("viewTabs")?.hidden === false`, "開き直す");
  await page.click('.tab-btn[data-view="master"]');
  await openOn("fertilizers");
  assert.deepEqual(page.errors, []);
});

test("台帳: 前の品目の画面の URL（#crops）は、台帳の品目を開く", options, async () => {
  await page.loadApp(seed());
  await page.run(`location.hash = "#crops"; location.reload()`);
  await openOn("crops");
  assert.deepEqual(page.errors, []);
});

test("台帳: 品目の表を横に送っても、品目の名前の列は左に残る。スマホでは工程作業日数を見るだけで出す", options, async () => {
  await page.viewport(390);
  try {
    await page.loadApp(seed());
    await page.click('.tab-btn[data-view="master"]');
    await openOn("crops");
    const left = () => page.run(`Math.round(document.querySelector('#cropTable tr[data-id="c1"] td').getBoundingClientRect().left - document.querySelector("#cropTable").closest(".table-scroll").getBoundingClientRect().left)`);
    // 入力欄の代わりに、名前の文字を出す（欄の幅で切れない）
    assert.equal(await page.run(`getComputedStyle(document.querySelector('#cropTable tr[data-id="c1"] [data-field="name"]')).display`), "none");
    assert.equal(await page.run(`document.querySelector('#cropTable tr[data-id="c1"] .cell-value').textContent`), await page.run(`document.querySelector('#cropTable tr[data-id="c1"] [data-field="name"]').value`));
    assert.ok(await page.run(`document.querySelector('#cropTable tr[data-id="c1"] .cell-value').offsetWidth > 0`));
    const before = await left();
    await page.run(`document.querySelector("#cropTable").closest(".table-scroll").scrollLeft = 300`);
    assert.equal(await page.run(`document.querySelector("#cropTable").closest(".table-scroll").scrollLeft > 0`), true, "横に送れる");
    assert.equal(await left(), before, "名前の列は動かない");

    await page.click('[data-mastertab="work-days"]');
    await openOn("work-days");
    assert.equal(await page.run(`getComputedStyle(document.querySelector("#typeRows input")).pointerEvents`), "none", "スマホでは直せない");
    assert.deepEqual(page.errors, []);
  } finally {
    await page.viewport();
  }
});

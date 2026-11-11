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
  await page.click('.tab-btn[data-view="crops"]');
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

// 左上のロゴと「圃場計画」で開く、利用者のメニューを、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// DB を使わないモード（?local=1）なので、ログアウトの代わりに、ブラウザーの中だけに保存していることを出す
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: [[0, 0], [40, 0], [40, 20], [0, 20]], note: "", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [],
  blocks: [],
  beds: [],
  plantings: [],
  works: [],
  crops: [],
  fertilizers: [],
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

const menuOpen = () => page.run(`!document.getElementById("userMenu").hidden`);

test("利用者のメニュー: ロゴで開き、もう一度押す・Esc・外を押すと閉じる", options, async () => {
  await page.loadApp(seed());
  // ヘッダーにログアウトのボタンはない
  assert.equal(await page.run(`Boolean(document.querySelector(".header-right #logoutBtn"))`), false);
  assert.equal(await menuOpen(), false);

  await page.click("#brandMenu");
  await page.waitFor(`!document.getElementById("userMenu").hidden`, "メニューが開く");
  assert.match(await page.run(`document.getElementById("userMenu").textContent`), /このブラウザーの中だけに保存しています/);
  assert.equal(await page.run(`document.getElementById("brandMenu").getAttribute("aria-expanded")`), "true");

  // もう一度押すと閉じる
  await page.click("#brandMenu");
  await page.waitFor(`document.getElementById("userMenu").hidden`, "もう一度押して閉じる");

  // Esc で閉じる
  await page.click("#brandMenu");
  await page.waitFor(`!document.getElementById("userMenu").hidden`, "メニューが開く");
  await page.press("Escape", "Escape", 27);
  await page.waitFor(`document.getElementById("userMenu").hidden`, "Esc で閉じる");

  // メニューの外を押すと閉じる
  await page.click("#brandMenu");
  await page.waitFor(`!document.getElementById("userMenu").hidden`, "メニューが開く");
  await page.click('.tab-btn[data-view="master"]');
  await page.waitFor(`document.getElementById("userMenu").hidden`, "外を押して閉じる");
  assert.equal(await page.run(`document.getElementById("brandMenu").getAttribute("aria-expanded")`), "false");
  assert.deepEqual(page.errors, []);
});

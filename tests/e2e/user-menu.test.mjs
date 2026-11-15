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

test("書体: CSS は表示を止めない形で読み、読み終えたらヘッダーの名前の幅を測り直す", options, async () => {
  await page.loadApp(seed());
  const link = await page.run(`(() => { const link = document.querySelector('link[href^="https://fonts.googleapis.com/"]'); return link && { priority: link.fetchPriority, inHead: link.parentElement === document.head }; })()`);
  assert.deepEqual(link, { priority: "low", inHead: true });
  const width = () => page.run('parseFloat(document.getElementById("brandName").style.width)');
  const before = await width();
  assert.ok(before > 0, "名前の欄の幅を決めている");
  // 書体が替わって文字が細くなったつもりで、名前の文字を小さくする。知らせが届くまでは、幅は前のまま
  await page.run(`document.head.append(Object.assign(document.createElement("style"), { textContent: ".brand-name * { font-size: 8px !important; }" }))`);
  assert.equal(await width(), before);
  await page.run(`document.fonts.dispatchEvent(new Event("loadingdone"))`);
  assert.ok((await width()) < before, `書体を読み終えたら、幅を測り直す（${before} → ${await width()}）`);
  assert.deepEqual(page.errors, []);
});

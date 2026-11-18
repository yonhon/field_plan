// スマホの「元に戻す・やり直す」（ロゴのメニューの矢印と押しピン、押しピンで出す小さな窓）を、Chrome で通して確かめる。
// 実行: node --test "tests/e2e/*.test.mjs"
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", created_at: AT }],
  plans: [
    { id: "p1", field_id: "f1", name: "プランA" },
    { id: "p2", field_id: "f1", name: "プランB" },
  ],
  zones: [
    { id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT },
    { id: "z2", plan_id: "p2", kind: "tillable", name: "", shape: AREA, created_at: AT },
  ],
  blocks: [],
  beds: [],
  plantings: [],
  works: [],
  crops: [],
});

const options = { skip: findChrome() ? false : "Chrome が見つかりません" };
let page;

before(async () => {
  if (!options.skip) {
    page = await openBrowser();
  }
});

afterEach(async () => {
  await page?.viewport();
});

after(async () => {
  await page?.close();
});

const PLANS = "dialog.field-plans[open]";
const nameOf = (id) => `JSON.parse(localStorage.getItem("field_plan_local")).plans.find((plan) => plan.id === "${id}").name`;
const openMenu = async () => {
  await page.click("#brandMenu");
  await page.waitFor(`!document.getElementById("userMenu").hidden`, "メニューが開く");
};

// 「圃場とプラン」の窓で、プラン B の名前を変えて、窓を閉じる（元に戻すの 1 回ぶんができる）
async function renamePlan(name) {
  await openMenu();
  await page.click('#userMenu [data-action="choose"]');
  await page.waitFor(`Boolean(document.querySelector("${PLANS} .fp-plan"))`, "圃場とプランの窓");
  await page.run(`window.prompt = () => ${JSON.stringify(name)}`);
  await page.click(`${PLANS} [data-menu="plan:p2"]`);
  await page.click(`${PLANS} .fp-menu [data-act="renamePlan"]`);
  await page.waitFor(`${nameOf("p2")} === ${JSON.stringify(name)}`, "名前の保存");
  await page.click(`${PLANS} [data-act="close"]`);
  await page.waitFor(`!document.querySelector("${PLANS}")`, "窓が閉じる");
}

const visible = (selector) => page.run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el) && el.getClientRects().length > 0; })()`);

test("パソコンの幅では、メニューに矢印と押しピンを出さない。スマホの幅では出す", options, async () => {
  await page.loadApp(seed());
  await openMenu();
  assert.equal(await visible('#userMenu [data-action="undo"]'), false, "パソコン");
  await page.click("#brandMenu");
  await page.viewport(390);
  await openMenu();
  assert.equal(await visible('#userMenu [data-action="undo"]'), true, "スマホ");
  assert.equal(await visible('#userMenu [data-action="undoPad"]'), true);
  assert.equal(await page.run(`document.querySelector('#userMenu [data-action="undo"]').disabled`), true, "戻せるものがないと押せない");
  assert.deepEqual(page.errors, []);
});

test("スマホ: メニューの ↶ で 1 回だけ元に戻す。メニューは閉じ、「圃場とプラン」の窓が開いて戻る", options, async () => {
  await page.viewport(390);
  await page.loadApp(seed());
  await renamePlan("名前を変えたプラン");
  await openMenu();
  assert.equal(await page.run(`document.querySelector('#userMenu [data-action="undo"]').disabled`), false);
  await page.click('#userMenu [data-action="undo"]');
  await page.waitFor(`document.getElementById("userMenu").hidden`, "メニューが閉じる");
  await page.waitFor(`Boolean(document.querySelector("${PLANS}"))`, "窓が開く");
  await page.waitFor(`${nameOf("p2")} === "プランB"`, "名前が戻る");
  assert.deepEqual(page.errors, []);
});

test("スマホ: 押しピンで小さな窓を出し、窓が開くと窓の中に移って、そのまま押せる。× で消える", options, async () => {
  await page.viewport(390);
  await page.loadApp(seed());
  await openMenu();
  await page.click('#userMenu [data-action="undoPad"]');
  await page.waitFor(`Boolean(document.querySelector(".undo-pad"))`, "小さな窓が出る");
  assert.equal(await page.run(`document.querySelector('.undo-pad [data-history="undo"]').disabled`), true, "戻せるものがないと押せない");
  const where = () => page.run(`(() => { const r = document.querySelector(".undo-pad").getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; })()`);
  const home = await where();

  await renamePlan("名前を変えたプラン");
  assert.equal(await page.run(`document.querySelector(".undo-pad").parentElement === document.body`), true, "窓を閉じたら、元の場所に戻る");
  await page.waitFor(`!document.querySelector('.undo-pad [data-history="undo"]').disabled`, "押せるようになる");
  await page.click('.undo-pad [data-history="undo"]');
  await page.waitFor(`Boolean(document.querySelector("${PLANS}"))`, "窓が開く");
  await page.waitFor(`${nameOf("p2")} === "プランB"`, "名前が戻る");
  await page.waitFor(`Boolean(document.querySelector("${PLANS} .undo-pad"))`, "小さな窓は、窓の中に移る");
  assert.deepEqual(await where(), home, "窓の中でも、同じ所に同じ大きさで出る");
  // 窓を開いたまま、小さな窓でやり直す
  await page.waitFor(`!document.querySelector('.undo-pad [data-history="redo"]').disabled`, "やり直せる");
  await page.click('.undo-pad [data-history="redo"]');
  await page.waitFor(`${nameOf("p2")} === "名前を変えたプラン"`, "やり直す");
  await page.click(`${PLANS} [data-act="close"]`);
  await page.waitFor(`!document.querySelector("${PLANS}") && document.querySelector(".undo-pad")?.parentElement === document.body`, "窓を閉じると、元の場所に戻る");
  await page.click('.undo-pad [data-act="close"]');
  await page.waitFor(`!document.querySelector(".undo-pad")`, "× で消える");
  assert.deepEqual(page.errors, []);
});

test("幅の狭いスマホ: 圃場図の「＋ 入力する」が出ているときは、小さな窓をその上に上げて、重ならない", options, async () => {
  await page.viewport(360);
  await page.loadApp(seed());
  await page.waitFor(`!document.getElementById("logAddBtn").hidden`, "＋ 入力する");
  await openMenu();
  await page.click('#userMenu [data-action="undoPad"]');
  await page.waitFor(`Boolean(document.querySelector(".undo-pad"))`, "小さな窓が出る");
  const overlap = await page.run(`(() => {
    const a = document.querySelector(".undo-pad").getBoundingClientRect();
    const b = document.getElementById("logAddBtn").getBoundingClientRect();
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  })()`);
  assert.equal(overlap, false);
  assert.deepEqual(page.errors, []);
});

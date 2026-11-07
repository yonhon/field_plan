// お知らせ（app/toast.js）を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 保存の状態の欄（目に見えない記録の欄）に書いた文が、種類ごとの出し方でヘッダーの下に出て、ヘッダーの形が変わらないこと
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

const say = (text) => page.run(`document.getElementById("saveStatus").textContent = ${JSON.stringify(text)}`);
const toasts = () => page.run(`[...document.querySelectorAll("#toasts .toast:not([hidden])")].map((t) => t.className.replace("toast toast-", "") + ":" + t.querySelector(".toast-text").textContent)`);
const headerHeight = () => page.run(`document.querySelector(".page-header").getBoundingClientRect().height`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("お知らせ: 種類ごとに出し方を変え、ヘッダーの形は変えない", options, async () => {
  await page.loadApp(seed());
  await say("");
  const height = await headerHeight();
  // 起動のときに「このブラウザーの中だけに保存します」は出さない
  assert.deepEqual(await toasts(), []);

  // 操作の結果は出して、2 秒で消す
  await say("並べ直しました");
  assert.deepEqual(await toasts(), ["info:並べ直しました"]);
  assert.equal(await headerHeight(), height);
  await page.waitFor(`!document.querySelector("#toasts .toast-info")`, "2 秒で消える");

  // 保存中… は 1 秒たっても終わらないときだけ出し、保存しました は出さずに消す
  await say("保存中…");
  await sleep(300);
  assert.deepEqual(await toasts(), []);
  await say("保存しました");
  await sleep(1000);
  assert.deepEqual(await toasts(), []);
  await say("保存中…");
  await page.waitFor(`document.querySelector("#toasts .toast-progress")?.textContent === "保存中…"`, "時間がかかる保存");
  await say("保存しました");
  assert.deepEqual(await toasts(), []);

  // 進み具合は、次の文が来るまで出し続ける
  await say("画像を保存中… 45%（1.0 / 2.2 MB）");
  await sleep(2300);
  assert.deepEqual(await toasts(), ["progress:画像を保存中… 45%（1.0 / 2.2 MB）"]);

  // 失敗は消えずに残り、誤りの内容は「詳しく」で窓に出し、× で閉じる
  await say("保存に失敗しました: TypeError: Failed to fetch");
  assert.deepEqual(await toasts(), ["error:保存に失敗しました"]);
  await sleep(2300);
  assert.deepEqual(await toasts(), ["error:保存に失敗しました"]);
  await page.click("#toasts .toast-error .toast-btn");
  await page.waitFor(`document.querySelector("dialog[open]")?.textContent.includes("Failed to fetch")`, "詳しく");
  await page.click('dialog[open] [data-action="close"]');
  await page.click("#toasts .toast-error .toast-close");
  assert.deepEqual(await toasts(), []);
  assert.equal(await headerHeight(), height);
  assert.deepEqual(page.errors, []);
});

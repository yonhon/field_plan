// 圃場図の上のタブの「ニュース」を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 未読があればタブに ⚠ と件数が出る。「確認」で既読へ移り、「既読を見る」で既読の一覧に切り替わる
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const news = (key, title, posted, readAt = null) => ({
  key,
  source: "nogyo",
  title,
  url: `https://example.com/${key}.html`,
  posted,
  label: "新着",
  first_seen: AT,
  read_at: readAt,
});

const seed = () => ({
  fields: [{ id: "f1", name: "圃場", outline: AREA, note: "", created_at: AT, active_plan_id: "p1" }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [],
  beds: [],
  plantings: [],
  works: [],
  crops: [],
  news: [news("a", "古い記事", "2026-10-29"), news("b", "新しい記事", "2026-11-10"), news("c", "読んだ記事", "2026-10-01", AT)],
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

const titles = () => page.run(`[...document.querySelectorAll("#newsList .news-title a")].map((a) => a.textContent)`);

test("ニュース: 未読の件数をタブに出し、確認で既読へ移す", options, async () => {
  await page.loadApp(seed());
  await page.waitFor(`document.getElementById("newsBadge").textContent === "⚠2" && !document.getElementById("newsBadge").hidden`, "未読の件数");
  await page.click('[data-wtab="news"]');
  await page.waitFor(`!document.querySelector('[data-wpanel="news"]').hidden`, "ニュースの欄");
  assert.deepEqual(await titles(), ["新しい記事", "古い記事"], "載った日の新しい順");

  await page.click('#newsList [data-news="b"] [data-news-act="read"]');
  await page.waitFor(`document.getElementById("newsBadge").textContent === "⚠1"`, "未読が 1 件に減る");
  assert.deepEqual(await titles(), ["古い記事"]);
  await page.waitFor(`Boolean(JSON.parse(localStorage.getItem("field_plan_local")).news.find((item) => item.key === "b").read_at)`, "確認の保存");

  await page.click("#newsToggle");
  assert.equal(await page.run(`document.getElementById("newsTitle").textContent`), "既読（2 件）");
  assert.deepEqual(await titles(), ["新しい記事", "読んだ記事"], "確認した新しい順");

  // 既読から未読に戻す。最後の 1 件も確認すると、タブの印が消える
  await page.click('#newsList [data-news="b"] [data-news-act="unread"]');
  await page.click("#newsToggle");
  await page.waitFor(`document.querySelectorAll("#newsList li").length === 2`, "未読に戻る");
  await page.click('#newsList [data-news="a"] [data-news-act="read"]');
  await page.click('#newsList [data-news="b"] [data-news-act="read"]');
  await page.waitFor(`document.getElementById("newsBadge").hidden && !document.getElementById("newsEmpty").hidden`, "未読がなくなる");
  assert.deepEqual(page.errors, []);
});

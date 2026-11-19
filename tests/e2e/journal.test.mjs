// 履歴の画面（app/journal.js）。起動のときは最近の記録だけを読み、画面にも最近の日だけを描き、
// 「さらに前」とメモの番号のリンクで、古い記録を読み足すことを、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const DAYS = 60; // 記録のある日の数。今日から 1 日に 1 件ずつ、さかのぼる

// ブラウザーの日付で、今日から offset 日の日付（YYYY-MM-DD）
const day = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

// 記録の番号は、古い日から 1, 2, 3 …。今日の記録が DAYS 番。プラン2 の記録は 40 日前の 1 件だけ
const change = (no, offset, planId = "p1") => ({
  id: `c${no}`,
  field_id: "f1",
  no,
  at: `${day(offset)}T01:00:00.000Z`,
  last_at: `${day(offset)}T01:00:00.000Z`,
  day: day(offset),
  plan_id: planId,
  plan_name: planId === "p1" ? "プラン1" : "プラン2",
  kind: "bed.width",
  target_kind: null,
  target_id: null,
  text: `試験の変更 ${no}`,
  before: null,
  after: null,
});

const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", active_plan_id: "p1", created_at: AT }],
  plans: [
    { id: "p1", field_id: "f1", name: "プラン1" },
    { id: "p2", field_id: "f1", name: "プラン2" },
  ],
  zones: [],
  blocks: [],
  beds: [],
  plantings: [],
  works: [],
  crops: [],
  changes: Array.from({ length: DAYS }, (_, index) => change(DAYS - index, -index, index === 40 ? "p2" : "p1")),
  // 今日のメモが、50 日前の記録（#10）に触れる
  notes: [{ day: day(0), body: "#10 を見直した" }],
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

beforeEach(() => {
  page?.errors.splice(0);
});

const hasDay = (offset) => page.run(`Boolean(document.querySelector('#journalDays .journal-day[data-day="${day(offset)}"]'))`);
const MORE = '#journalDays [data-act="older"]';

async function openJournal() {
  await page.loadApp(seed());
  await page.openView("journal");
  await page.waitFor(`Boolean(document.querySelector('#journalDays .journal-day'))`, "履歴の日が出る");
}

test("履歴: 最初は最近の日だけを描き、「さらに前」で古い日を読み足して描く", options, async () => {
  await openJournal();
  assert.equal(await hasDay(0), true, "今日");
  assert.equal(await hasDay(-13), true, "13 日前");
  assert.equal(await hasDay(-14), false, "14 日前の記録は、まだ読んでいない");
  assert.equal(await page.run(`document.getElementById("change-${DAYS - 13}")?.textContent.includes("試験の変更")`), true);

  // 押すたびに描き足す。いちばん古い日まで出たら、ボタンの代わりに終わりの文を出す
  for (let i = 0; i < 20 && (await page.run(`Boolean(document.querySelector(${JSON.stringify(MORE)}))`)); i += 1) {
    await page.click(MORE);
    await page.waitFor(`!document.querySelector(${JSON.stringify(MORE)})?.disabled`, "読み足す");
  }
  assert.equal(await hasDay(-14), true, "14 日前");
  assert.equal(await hasDay(-(DAYS - 1)), true, "いちばん古い日");
  assert.equal(await page.run('document.getElementById("change-1")?.textContent.includes("試験の変更 1")'), true);
  assert.match(await page.run('document.querySelector("#journalDays .journal-more").textContent'), /これより前の記録はありません/);
  assert.deepEqual(page.errors, []);
});

test("履歴: メモが触れている、まだ読んでいない記録の番号を押すと、その日まで読んで飛ぶ", options, async () => {
  await openJournal();
  const button = '#journalDays .ref-btn[data-ref="10"]';
  assert.equal(await page.run(`document.querySelector(${JSON.stringify(button)}).disabled`), false, "まだ読んでいない番号も押せる");
  assert.equal(await page.run('Boolean(document.getElementById("change-10"))'), false);
  await page.click(button);
  await page.waitFor('document.getElementById("change-10")?.classList.contains("is-marked")', "#10 の行へ飛ぶ");
  assert.equal(await hasDay(-50), true, "50 日前の日を描いた");
  assert.deepEqual(page.errors, []);
});

test("圃場とプラン: 読んでいない古い記録しかないプランにも、最後の変更の日を出す", options, async () => {
  await page.loadApp(seed());
  await page.click("#brandMenu");
  await page.click('#userMenu [data-action="choose"]');
  await page.waitFor(`Boolean(document.querySelector('dialog.field-plans[open] .fp-plan[data-plan="p2"]'))`, "圃場とプランの窓");
  const date = new Date(`${day(-40)}T01:00:00.000Z`);
  const meta = await page.run(`document.querySelector('dialog.field-plans[open] .fp-plan[data-plan="p2"] .fp-plan-meta').textContent`);
  assert.match(meta, new RegExp(`最後の変更 ${date.getMonth() + 1}/${date.getDate()}`));
  assert.deepEqual(page.errors, []);
});

test("履歴: 起動は履歴の読み込みを待たず、読んでいるあいだの変更も履歴に残る", options, async () => {
  // 履歴の読み込みを 1.5 秒遅らせる。画面は、その前に出て操作できる
  await page.loadApp(seed(), { field_plan_local_test: JSON.stringify({ readDelay: 1500 }) });
  await page.openView("master");
  await page.click("#addCropBtn");
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "品目を足す");
  await page.openView("journal");
  assert.match(await page.run('document.getElementById("journalDays").textContent'), /読み込んでいます/);
  // 読み終えると、読んでいるあいだに足した記録と、読んだ記録の両方が出る
  await page.waitFor(`Boolean(document.getElementById("change-${DAYS}"))`, "読んだ記録が出る");
  const texts = await page.run('[...document.querySelectorAll("#journalDays .change-text")].map((el) => el.textContent)');
  assert.ok(texts.some((text) => text.includes("品目「新しい品目」を追加")), "読んでいるあいだの変更が残る");
  assert.ok(texts.includes(`試験の変更 ${DAYS}`));
  assert.deepEqual(page.errors, []);
});

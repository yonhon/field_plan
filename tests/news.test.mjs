// ニュースの読み取り（scripts/news.mjs）。県のページの作りを写した短い HTML で確かめる。実行: node --test tests/news.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fullDate, monthDay, parseNotices, parseUpdates, plainText } from "../scripts/news.mjs";

const NOGYO = "https://www.pref.okinawa.jp/shigoto/nogyo/1010700/index.html";
const KENKYU = "https://www.pref.okinawa.jp/shigoto/kenkyu/1010703/index.html";

const updates = `<div class="news">
<h2>新着更新情報</h2>
<ul>
<li class="box"><span class="date">11月10日（火曜日）</span>
<span class="labelupdate">更新</span>
<span class="newsli"><a href="../../../shigoto/nogyo/1010700/1018771/1032470.html">セグロウリミバエの確認状況について</a></span></li>
<li class="box"><span class="date">10月29日（木曜日）</span>
<span class="labelnew">新着</span>
<span class="newsli"><a href="../../../shigoto/nogyo/1010700/1041799.html">発生予報第8号&amp;（11月予報）</a></span></li>
</ul>
</div>
<ul><li><a href="other.html">ほかの欄</a></li></ul>`;

const notices = `<div id="content"><h2>お知らせ</h2>
<h3>パインアップルの香りに関する研究成果について（2026.11.2）</h3>
<p>本文</p><ul class="objectlink"><li class="pdf">
<a href="../../../_res/a/press.pdf" target="_blank">プレスリリース資料 （PDF 583.2KB）<img src="x.gif" alt="新しいウィンドウで開きます"></a></li></ul>
<h3>リンクのないお知らせ</h3><p>本文</p>
<h2>視察・見学</h2><h3>視察の受け付け</h3></div>`;

test("新着更新情報: 日付・新着か更新か・リンクを読む。ほかの欄は読まない", () => {
  const items = parseUpdates(updates, NOGYO, "2026-11-12");
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    key: "nogyo|2026-11-10|https://www.pref.okinawa.jp/shigoto/nogyo/1010700/1018771/1032470.html",
    source: "nogyo",
    title: "セグロウリミバエの確認状況について",
    url: "https://www.pref.okinawa.jp/shigoto/nogyo/1010700/1018771/1032470.html",
    posted: "2026-11-10",
    label: "更新",
  });
  assert.equal(items[1].title, "発生予報第8号&（11月予報）");
  assert.equal(items[1].label, "新着");
});

test("新着更新情報: 欄が見つからなければ知らせる", () => {
  assert.throws(() => parseUpdates("<div>作りが変わった</div>", NOGYO, "2026-11-12"), /新着更新情報/);
});

test("お知らせ: 次の h2 までの見出しが 1 件ずつ。リンクがなければこのページ", () => {
  const items = parseNotices(notices, KENKYU);
  assert.deepEqual(
    items.map((item) => [item.title, item.url, item.posted]),
    [
      ["パインアップルの香りに関する研究成果について（2026.11.2）", "https://www.pref.okinawa.jp/_res/a/press.pdf", "2026-11-02"],
      ["リンクのないお知らせ", KENKYU, null],
    ]
  );
  assert.equal(items[0].key, "kenkyu|パインアップルの香りに関する研究成果について（2026.11.2）");
  assert.throws(() => parseNotices("<h2>別の欄</h2>", KENKYU), /お知らせ/);
});

test("日付: 年のない日付は、1 か月以上先なら前の年", () => {
  assert.equal(monthDay("11月10日（火曜日）", "2026-11-12"), "2026-11-10");
  assert.equal(monthDay("12月28日（月曜日）", "2027-01-05"), "2026-12-28");
  assert.equal(monthDay("日付なし", "2026-11-12"), null);
  assert.equal(fullDate("成果（2026.1.5）"), "2026-01-05");
  assert.equal(plainText("a&nbsp;<b>b</b>&#65;"), "a bA");
});

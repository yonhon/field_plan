// 日記の画面を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 書く（写真を入れる）→ 保存 → 読む（日・週）→ 探す → 種類を直す → 書きかけを戻す、の流れ。本物の日記は使わない
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

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

const saved = () => page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "保存");
const diary = async () => (await page.saved()).diary;

// 縦長の写真を作って、「写真を入れる」で選んだことにする
const choosePhoto = () =>
  page.run(`(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 30;
    canvas.height = 40;
    canvas.getContext("2d").fillRect(0, 0, 10, 10);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "IMG_0001.JPG", { type: "image/jpeg" }));
    const input = document.getElementById("diaryPhotoInput");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);

test("日記: 写真を入れて書き、保存して読み、探し、種類を直す", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="diary"]');
  await page.waitFor(`location.hash === "#diary"`, "日記の URL");
  await page.click('#diaryMain [data-action="edit"]');
  await page.click("#diaryTitle");
  await page.type("試験の日");
  await page.click("#diaryBody");
  await page.run(`document.getElementById("diaryBody").marked = true`);
  await page.type("オクラ");
  await page.click('#diaryMain [data-action="heading"]');
  await page.type(String.fromCharCode(10));
  await page.type("トマトに追肥した。");
  // 打っているあいだ、入力欄は作り直さない（日本語の変換が切れるため）
  assert.equal(await page.run(`document.getElementById("diaryBody").marked`), true);
  await choosePhoto();
  // 選んですぐ、入れる所に仮の行が入り、ボタンは押せなくなり、お知らせに進み具合が出る（送るのに時間がかかっても、押したことが分かる）
  assert.match(await page.run(`document.getElementById("diaryBody").value`), /（写真を上げています…）/);
  assert.equal(await page.run(`document.getElementById("diaryPhotoInput").disabled`), true);
  assert.equal(await page.run(`document.getElementById("diaryPhotoLabel").textContent`), "上げています 1/1…");
  assert.equal(await page.run(`document.querySelector("#toasts .toast-progress")?.textContent`), "写真を上げています 1/1…");
  // 上げているあいだにプレビューを開いても、上げ終えたら写真が出る
  await page.click('#diaryMain [data-action="preview-mode"]');
  assert.match(await page.run(`document.querySelector("#diaryMain .diary-preview").textContent`), /写真を上げています/);
  await page.waitFor(`Boolean(document.querySelector("#diaryMain .diary-preview .diary-photo"))`, "プレビューを描き直す");
  assert.doesNotMatch(await page.run(`document.querySelector("#diaryMain .diary-preview").textContent`), /写真を上げています/);
  await page.click('#diaryMain [data-action="edit-mode"]');
  assert.equal(await page.run(`document.getElementById("diaryBody").value.includes("![](images/${TODAY}_01.jpg)")`), true);
  assert.equal(await page.run(`document.getElementById("diaryPhotoInput").disabled`), false);
  assert.equal(await page.run(`document.getElementById("diaryPhotoLabel").textContent`), "写真を入れる");
  await page.click('#diaryMain [data-action="save"]');
  await saved();

  const stored = await diary();
  const day = stored.days[TODAY];
  assert.equal(day.title, "試験の日");
  assert.equal(day.body, `## オクラ\nトマトに追肥した。\n\n![](images/${TODAY}_01.jpg)`);
  assert.deepEqual(stored.sections[TODAY].map((section) => [section.path, section.crops]), [[["オクラ"], ["オクラ"]]]);
  const photo = stored.photos[`${TODAY}_01.jpg`];
  assert.equal(photo.original_name, "IMG_0001.JPG");
  assert.deepEqual([photo.width, photo.height], [30, 40]);
  assert.ok(Object.keys(stored.files).some((path) => path.endsWith(`/photos/${TODAY}_01.jpg`)));

  // 日の表示: 写真と、節の作物の札。カレンダーに印
  await page.waitFor(`Boolean(document.querySelector('#diaryMain .diary-photo img'))`, "写真の表示");
  assert.match(await page.run(`document.querySelector("#diaryMain .diary-tags").textContent`), /オクラ/);
  assert.equal(await page.run(`document.querySelector('#diaryCalendar [data-date="${TODAY}"]').classList.contains("has-entry")`), true);

  // 写真を押すと、元のファイル名を添えて大きく開く
  await page.click("#diaryMain .diary-photo");
  await page.waitFor(`document.querySelector("dialog.diary-viewer[open]")?.textContent.includes("IMG_0001.JPG")`, "写真の窓");
  await page.click('dialog.diary-viewer [data-action="close"]');

  // 月の表示にも出る。週の表示はない
  assert.equal(await page.run(`document.querySelectorAll("#diaryModes [data-mode]").length`), 2);
  await page.click('#diaryModes [data-mode="month"]');
  await page.waitFor(`document.querySelector("#diaryMain .diary-day-title")?.textContent.includes("試験の日")`, "月の表示");

  // 語で探す
  await page.run(`document.getElementById("diarySearch").value = "ﾄﾏﾄ"`);
  await page.click('#diarySearchForm button[type="submit"]');
  await page.waitFor(`document.querySelector("#diaryMain .diary-snippet mark")?.textContent === "トマト"`, "検索の結果");
  await page.click('#diaryMain [data-action="open-day"]');
  await page.waitFor(`document.querySelector("#diaryModes .is-on")?.dataset.mode === "day"`, "日の表示へ");

  // 種類を直す: 作物の「オクラ」を外す
  await page.click('#diaryMain [data-action="tags"]');
  await page.click('#diaryMain [data-tag-kind="crops"][data-tag-name="オクラ"]');
  await page.click('#diaryMain [data-action="tags-save"]');
  await saved();
  const fixed = (await diary()).days[TODAY].tags;
  assert.deepEqual(fixed["オクラ"].crops, []);
  await page.waitFor(`document.querySelector("#diaryMain .diary-tags")?.textContent.includes("直した")`, "直した印");
  assert.deepEqual(page.errors, []);
});

test("日記: 年月のリストで、古い日記の月へ移り、検索の欄は「検索ワード」", options, async () => {
  const data = seed();
  data.diary = {
    days: { "2024-05-10": { date: "2024-05-10", title: "古い日", body: "前の年の記録", tags: {}, updated_at: AT } },
    sections: { "2024-05-10": [{ id: "2024-05-10-01", path: [], crops: [], work: [] }] },
    photos: {},
    files: {},
    history: [],
  };
  await page.loadApp(data);
  await page.click('.tab-btn[data-view="diary"]');
  assert.equal(await page.run(`document.getElementById("diarySearch").placeholder`), "検索ワード");
  // リストは、いちばん古い日記の月（2024 年 5 月）まである
  await page.waitFor(`Boolean(document.querySelector('#diaryMonthSelect option[value="2024-05"]'))`, "年月のリスト");
  await page.setValue("#diaryMonthSelect", "2024-05");
  await page.waitFor(`document.querySelector('#diaryCalendar [data-date="2024-05-10"]')?.classList.contains("has-entry")`, "古い月のカレンダー");
  assert.equal(await page.run(`document.getElementById("diaryMonthSelect").value`), "2024-05");
  await page.click('#diaryCalendar [data-date="2024-05-10"]');
  await page.waitFor(`document.querySelector("#diaryMain .diary-day-title")?.textContent.includes("古い日")`, "古い日の日記");
  assert.deepEqual(page.errors, []);
});

test("日記: PC では日記の枠の中だけがスクロールし、日を移るといちばん上に戻る", options, async () => {
  const data = seed();
  const long = Array.from({ length: 120 }, (_, i) => `${i + 1} 行目の記録`).join(String.fromCharCode(10));
  data.diary = {
    days: {
      "2026-10-20": { date: "2026-10-20", title: "長い日", body: long, tags: {}, updated_at: AT },
      "2026-10-21": { date: "2026-10-21", title: "短い日", body: "短い", tags: {}, updated_at: AT },
    },
    sections: {
      "2026-10-20": [{ id: "2026-10-20-01", path: [], crops: [], work: [] }],
      "2026-10-21": [{ id: "2026-10-21-01", path: [], crops: [], work: [] }],
    },
    photos: {},
    files: {},
    history: [],
  };
  await page.loadApp(data);
  await page.click('.tab-btn[data-view="diary"]');
  await page.setValue("#diaryMonthSelect", "2026-10");
  await page.click('#diaryCalendar [data-date="2026-10-20"]');
  await page.waitFor(`document.querySelector("#diaryMain .diary-day-title")?.textContent.includes("長い日")`, "長い日");
  // ページはスクロールせず、日記の枠の中がスクロールする
  const pageScrolls = () => page.run(`document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight`);
  assert.equal(await pageScrolls(), false);
  assert.equal(await page.run(`(() => { const m = document.getElementById("diaryMain"); return m.scrollHeight > m.clientHeight; })()`), true);
  const navTop = await page.run(`document.querySelector(".diary-nav").getBoundingClientRect().top`);
  await page.run(`document.getElementById("diaryMain").scrollTop = 500`);
  await page.run(`document.querySelector('#diaryMain [data-step="1"]').click()`);
  await page.waitFor(`document.querySelector("#diaryMain .diary-day-title")?.textContent.includes("短い日")`, "次の日");
  assert.equal(await page.run(`document.getElementById("diaryMain").scrollTop`), 0);
  assert.equal(await pageScrolls(), false);
  assert.equal(await page.run(`document.querySelector(".diary-nav").getBoundingClientRect().top`), navTop);
  assert.deepEqual(page.errors, []);
});

test("日記: 保存していない書きかけは、読み込み直しても戻る", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="diary"]');
  await page.click('#diaryMain [data-action="edit"]');
  await page.click("#diaryBody");
  await page.type("書きかけの文");
  await page.run(`location.reload()`);
  await page.waitFor(`document.getElementById("viewTabs")?.hidden === false && location.hash === "#diary"`, "読み込み直し");
  await page.click('#diaryMain [data-action="edit"]');
  await page.waitFor(`document.getElementById("diaryBody")?.value === "書きかけの文"`, "書きかけ");
  assert.match(await page.run(`document.querySelector("#diaryMain .diary-note").textContent`), /書きかけを戻しました/);
  // やめると、確かめてから捨てる
  await page.click('#diaryMain [data-action="cancel"]');
  await page.click('dialog[open] [data-action="delete"]');
  await page.waitFor(`!document.getElementById("diaryBody")`, "閉じる");
  assert.equal(await page.run(`localStorage.getItem("field_plan_diary_drafts")`), "{}");
  assert.deepEqual(page.errors, []);
});

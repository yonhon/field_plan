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
  // 語では種類を付けない（Claude Code に頼んだときに付く）
  assert.deepEqual(stored.sections[TODAY].map((section) => [section.path, section.crops, section.tag_source]), [[["オクラ"], [], null]]);
  const photo = stored.photos[`${TODAY}_01.jpg`];
  assert.equal(photo.original_name, "IMG_0001.JPG");
  assert.deepEqual([photo.width, photo.height], [30, 40]);
  assert.ok(Object.keys(stored.files).some((path) => path.endsWith(`/photos/${TODAY}_01.jpg`)));

  // 日の表示: 写真と、節の札（まだ種類なし）。カレンダーに印
  await page.waitFor(`Boolean(document.querySelector('#diaryMain .diary-photo img'))`, "写真の表示");
  assert.match(await page.run(`document.querySelector("#diaryMain .diary-tags").textContent`), /種類なし/);
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

  // 種類を直す: 6 つの種類から選べる。作物の「オクラ」と場所の「露地」を付ける
  await page.click('#diaryMain [data-action="tags"]');
  assert.equal(await page.run(`document.querySelectorAll("#diaryMain .diary-tag-edit .log-chips").length`), 6);
  await page.click('#diaryMain [data-tag-kind="crops"][data-tag-name="オクラ"]');
  await page.click('#diaryMain [data-tag-kind="place"][data-tag-name="露地"]');
  await page.click('#diaryMain [data-action="tags-save"]');
  await saved();
  const fixed = (await diary()).days[TODAY].tags;
  assert.deepEqual([fixed["オクラ"].crops, fixed["オクラ"].place], [["オクラ"], ["露地"]]);
  await page.waitFor(`document.querySelector("#diaryMain .diary-tags")?.textContent.includes("直した")`, "直した印");
  assert.equal(await page.run(`document.querySelector("#diaryMain .diary-tag.is-place").textContent`), "露地");
  // Claude のタグに戻す: 直した内容が外れる
  await page.click('#diaryMain [data-action="tags"]');
  await page.click('#diaryMain [data-action="tags-auto"]');
  await saved();
  assert.deepEqual((await diary()).days[TODAY].tags, {});
  assert.deepEqual(page.errors, []);
});

test("日記: Claude のタグは種類ごとに出し、手で直した節にだけ印を付ける。写真のタグは大きく開いたときに出す", options, async () => {
  const data = seed();
  const day = "2026-10-15";
  data.diary = {
    days: {
      [day]: {
        date: day, title: "", body: "## オクラ\n収穫した。\n\n![](images/2026-10-15_01.jpg)\n\n## 畑\n見回り", updated_at: AT,
        tags: { 畑: { topic: ["講義・研修"] } },
        ai_tags: { オクラ: { crops: ["オクラ"], stage: ["収穫期"], targets: [{ kind: "planting", id: "x1", label: "区画1 畝1 オクラ" }] } },
      },
    },
    sections: {
      [day]: [
        { id: `${day}-01`, path: ["オクラ"], crops: ["オクラ"], work: [], tag_source: "claude",
          labels: { crops: ["オクラ"], stage: ["収穫期"], targets: [{ kind: "planting", id: "x1", label: "区画1 畝1 オクラ" }] } },
        { id: `${day}-02`, path: ["畑"], crops: [], work: [], tag_source: "manual", labels: { topic: ["講義・研修"] } },
      ],
    },
    photos: { "2026-10-15_01.jpg": { name: "2026-10-15_01.jpg", date: day, tags: { crops: ["オクラ"], subject: ["収穫物"], use: "記事向き" } } },
    files: {},
  };
  await page.loadApp(data);
  await page.run(`location.hash = "#diary"`);
  await page.waitFor(`Boolean(document.querySelector('#diaryMonthSelect option[value="2026-10"]'))`, "日記の画面");
  await page.run(`(() => { const select = document.getElementById("diaryMonthSelect"); select.value = "2026-10"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.click(`#diaryCalendar [data-date="${day}"]`);
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-tags").length === 2`, "節の札");
  const tags = await page.run(`[...document.querySelectorAll("#diaryMain .diary-tags")].map((box) => [[...box.querySelectorAll(".diary-tag")].map((t) => t.className.replace("diary-tag is-", "") + ":" + t.textContent), box.textContent.includes("直した")])`);
  assert.deepEqual(tags, [
    [["crops:オクラ", "stage:収穫期", "targets:区画1 畝1 オクラ"], false],
    [["topic:講義・研修"], true],
  ]);
  await page.click("#diaryMain .diary-photo");
  await page.waitFor(`document.querySelector("dialog.diary-viewer[open] .diary-tags")?.textContent === "オクラ収穫物記事向き"`, "写真のタグ");
  await page.click('dialog.diary-viewer [data-action="close"]');
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

test("作付の詳細: 日記の対象から、この作付の日記を出し、日付を押すとその日の日記を開く", options, async () => {
  const area = [[0, 0], [40, 0], [40, 20], [0, 20]];
  const data = {
    ...seed(),
    fields: [{ id: "f1", name: "試験の圃場", outline: area, note: "", active_plan_id: "p1", created_at: AT }],
    zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: area, created_at: AT }],
    blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "区画1", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
    beds: [1, 2].map((seq) => ({ id: `bed${seq}`, plan_id: "p1", block_id: "b1", seq, shape: [[seq * 3, 2], [seq * 3 + 1, 2], [seq * 3 + 1, 18], [seq * 3, 18]], start_date: null, removed_on: null })),
    plantings: [1, 2].map((seq) => ({ id: `pl${seq}`, plan_id: "p1", bed_id: `bed${seq}`, seq: 1, crop_id: "c1", crop_name: "試験菜" })),
    crops: [{ id: "c1", name: "試験菜", mulch: false, bed_width_cm: 100, aisle_width_cm: 60 }],
  };
  const section = (date, n, heading, targets) => ({
    id: `${date}-0${n}`, path: [heading], body: `${heading}の様子を見た。\n\n| a | b |\n| :- | :- |`, crops: [], work: [], tag_source: "claude",
    labels: { targets: targets.map((id) => ({ kind: id.startsWith("pl") ? "planting" : "block", id, label: id })) },
  });
  data.diary = {
    days: {
      "2026-10-02": { date: "2026-10-02", title: "", body: "## 畝1", tags: {}, updated_at: AT },
      "2026-10-05": { date: "2026-10-05", title: "見回り", body: "## 畝1と畝2", tags: {}, updated_at: AT },
    },
    sections: {
      "2026-10-02": [section("2026-10-02", 1, "畝1", ["pl1"])],
      "2026-10-05": [section("2026-10-05", 1, "畝1と畝2", ["pl1", "pl2"])],
    },
    photos: {},
    files: {},
  };
  await page.loadApp(data);
  await page.run(`location.hash = "#detail/planting/pl1"`);
  await page.waitFor(`document.querySelectorAll("#plantingBody .detail-diary li").length === 2`, "この作付の日記");
  assert.deepEqual(await page.run(`[...document.querySelectorAll("#plantingBody .detail-diary li")].map((li) => li.querySelector("span").textContent + "|" + li.querySelector("p").textContent)`), [
    "畝1と畝2|畝1と畝2の様子を見た。",
    "畝1|畝1の様子を見た。",
  ]);
  // 区画の詳細には、区画の中の作付に付いた日記も出る
  await page.run(`location.hash = "#detail/block/b1"`);
  await page.waitFor(`document.querySelector("#plantingBody .panel h2:last-of-type") && [...document.querySelectorAll("#plantingBody h2")].some((h) => h.textContent === "この区画の日記") && document.querySelectorAll("#plantingBody .detail-diary li").length === 2`, "この区画の日記");
  // 日付を押すと、その日の日記を開く
  await page.click('#plantingBody [data-diary-date="2026-10-05"]');
  await page.waitFor(`location.hash === "#diary" && document.querySelector("#diaryMain")?.textContent.includes("見回り")`, "その日の日記");
  assert.deepEqual(page.errors, []);
});

test("日記: 札を押すと、そのタグの付いた節を並べ、札を重ねて絞り、並び順を変え、続きを出す", options, async () => {
  const data = seed();
  const days = {};
  const sections = {};
  // 25 日分。どの日もオクラの節。偶数の日は、ほかに「アブラムシ」も付く
  for (let i = 1; i <= 25; i += 1) {
    const date = `2026-09-${String(i).padStart(2, "0")}`;
    days[date] = { date, title: `${i} 日目`, body: `## オクラ\n${i} 日目の見回り。`, tags: {}, updated_at: AT };
    sections[date] = [{
      id: `${date}-01`, path: ["オクラ"], crops: ["オクラ"], work: [], tag_source: "claude",
      labels: { crops: ["オクラ"], ...(i % 2 ? {} : { issues: ["アブラムシ"] }) },
    }];
  }
  data.diary = { days, sections, photos: {}, files: {} };
  await page.loadApp(data);
  await page.run(`location.hash = "#diary"`);
  await page.waitFor(`Boolean(document.querySelector('#diaryMonthSelect option[value="2026-09"]'))`, "日記の画面");
  await page.run(`(() => { const select = document.getElementById("diaryMonthSelect"); select.value = "2026-09"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.click('#diaryCalendar [data-date="2026-09-10"]');
  await page.waitFor(`Boolean(document.querySelector('#diaryMain [data-tag-filter="crops"]'))`, "札");

  // 作物の札を押すと、新しい順に 20 節を並べ、続きがある
  await page.click('#diaryMain [data-tag-filter="crops"]');
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-day").length === 20`, "タグの一覧");
  const titles = () => page.run(`[...document.querySelectorAll("#diaryMain .diary-day-title")].map((h) => h.textContent.trim())`);
  assert.match((await titles())[0], /25 日目$/);
  assert.match(await page.run(`document.querySelector('#diaryMain [data-action="tag-more"]').textContent`), /残り 5 節/);
  await page.click('#diaryMain [data-action="tag-more"]');
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-day").length === 25 && !document.querySelector('#diaryMain [data-action="tag-more"]')`, "続き");

  // 古い順にすると、1 日目から並ぶ
  await page.click('#diaryMain [data-action="tag-order"][data-oldest="true"]');
  await page.waitFor(`/1 日目$/.test(document.querySelector("#diaryMain .diary-day-title")?.textContent.trim() || "")`, "古い順");

  // 一覧の中の札を押すと、条件に足して絞る（オクラ かつ アブラムシ）
  await page.click('#diaryMain [data-tag-filter="issues"]');
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-day").length === 12`, "札を重ねる");
  assert.deepEqual(await page.run(`[...document.querySelectorAll("#diaryMain .diary-tag-filters .diary-tag")].map((b) => b.textContent)`), ["オクラ ×", "アブラムシ ×"]);
  // × で外すと、オクラだけに戻る
  await page.click('#diaryMain [data-action="tag-remove"][data-index="1"]');
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-day").length === 20`, "札を外す");
  // 日付を押すと、その日を開く
  await page.click('#diaryMain .diary-day-title a[data-date="2026-09-03"]');
  await page.waitFor(`document.querySelector("#diaryMain .diary-day-title")?.textContent.includes("3 日目") && !document.querySelector("#diaryMain .diary-tag-filters")`, "その日");
  assert.deepEqual(page.errors, []);
});

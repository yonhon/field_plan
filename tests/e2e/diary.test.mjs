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

test("作付の詳細: 頭の「日記 n 節（最新 M/D）」で、その作付の日記を、対象の札で絞った一覧として古い順に開く", options, async () => {
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
  const section = (date, heading, targets) => ({
    id: `${date}-01`, path: [heading], crops: [], work: [], tag_source: "claude",
    labels: { targets: targets.map((id) => ({ kind: "planting", id, label: id })) },
  });
  const day = (date, heading) => ({ date, title: "", body: `## ${heading}\n${heading}の様子を見た。`, tags: {}, updated_at: AT });
  data.diary = {
    days: { "2026-10-02": day("2026-10-02", "畝1"), "2026-10-05": day("2026-10-05", "畝1と畝2"), "2026-10-08": day("2026-10-08", "畝2") },
    sections: {
      "2026-10-02": [section("2026-10-02", "畝1", ["pl1"])],
      "2026-10-05": [section("2026-10-05", "畝1と畝2", ["pl1", "pl2"])],
      "2026-10-08": [section("2026-10-08", "畝2", ["pl2"])],
    },
    photos: {},
    files: {},
  };
  await page.loadApp(data);
  await page.run(`location.hash = "#detail/planting/pl1"`);
  // 一番下の一覧はやめ、頭に件数と最新の日のボタンを出す
  await page.waitFor(`document.querySelector('#plantingBody .detail-head [data-act="diary"]')?.textContent === "日記 2 節（最新 10/5）"`, "日記のボタン");
  assert.equal(await page.run(`document.querySelectorAll("#plantingBody .detail-diary").length`), 0);
  // 頭: 「工程表に戻る」はなく、前後の作付は文字だけのボタン。入力のボタンは短い名前
  assert.equal(await page.run(`document.querySelector('#plantingBody [data-act="back"]')`), null);
  assert.equal(await page.run(`document.querySelector('#plantingBody [data-act="record"]').textContent`), "＋ 作業を入力");
  assert.equal(await page.run(`document.querySelector("#plantingBody .detail-side.is-next .detail-go").textContent`), "畝2 試験菜 ›");
  // 押すと、日記の画面で、この作付の対象の札で絞った一覧を、古い順で開く
  await page.click('#plantingBody [data-act="diary"]');
  await page.waitFor(`location.hash === "#diary" && document.querySelectorAll("#diaryMain .diary-day").length === 2`, "この作付の日記の一覧");
  assert.deepEqual(await page.run(`[...document.querySelectorAll("#diaryMain .diary-day")].map((el) => el.dataset.date)`), ["2026-10-02", "2026-10-05"]);
  assert.equal(await page.run(`document.querySelector("#diaryMain .diary-tag-filters").textContent`), "区画1 畝1 試験菜 ×");
  assert.equal(await page.run(`document.querySelector('#diaryMain [data-action="tag-order"].is-on').dataset.oldest`), "true");
  // 戻るで、作付の詳細に戻る
  await page.run(`history.back()`);
  await page.waitFor(`location.hash === "#detail/planting/pl1" && Boolean(document.querySelector('#plantingBody [data-act="diary"]'))`, "作付の詳細に戻る");

  // 区画（前の区画の詳細の URL は、日程の画面でその区画を開く）は、区画の中の作付に付いた日記も数え、一覧にも出す
  await page.run(`location.hash = "#detail/block/b1"`);
  await page.waitFor(`location.hash === "#schedule/block/b1" && !document.getElementById("scheduleView").hidden`, "日程の画面で区画を開く");
  await page.waitFor(`document.querySelector('#blockHead [data-act="diary"]')?.textContent === "日記 3 節（最新 10/8）"`, "区画の日記のボタン");
  await page.click('#blockHead [data-act="diary"]');
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-day").length === 3`, "この区画の日記の一覧");
  assert.equal(await page.run(`document.querySelector("#diaryMain .diary-tag-filters").textContent`), "区画1 ×");
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

test("日記: タグの一覧から修正と種類を直すができ、直したあとは一覧の同じ位置に戻る", options, async () => {
  const data = seed();
  const days = {};
  const sections = {};
  for (let i = 1; i <= 25; i += 1) {
    const date = `2026-09-${String(i).padStart(2, "0")}`;
    days[date] = { date, title: `${i} 日目`, body: `前置き\n## オクラ\n${i} 日目の見回り。`, tags: {}, updated_at: AT, ai_tags: { オクラ: { crops: ["オクラ"] } } };
    sections[date] = [
      { id: `${date}-01`, path: [], crops: [], work: [], tag_source: null, labels: {} },
      { id: `${date}-02`, path: ["オクラ"], crops: ["オクラ"], work: [], tag_source: "claude", labels: { crops: ["オクラ"] } },
    ];
  }
  data.diary = { days, sections, photos: {}, files: {} };
  await page.loadApp(data);
  await page.run(`location.hash = "#diary"`);
  await page.waitFor(`Boolean(document.querySelector('#diaryMonthSelect option[value="2026-09"]'))`, "日記の画面");
  await page.run(`(() => { const select = document.getElementById("diaryMonthSelect"); select.value = "2026-09"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.click('#diaryCalendar [data-date="2026-09-10"]');
  await page.waitFor(`Boolean(document.querySelector('#diaryMain [data-tag-filter="crops"]'))`, "札");
  await page.click('#diaryMain [data-tag-filter="crops"]');
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-day").length === 20`, "タグの一覧");

  // 修正: 押した節の見出しの下にカーソルを置き、保存したら一覧の同じ位置に戻る
  const scrollTo = (date) => page.run(`(() => { const el = document.querySelector('#diaryMain .diary-day[data-date="${date}"]'); document.getElementById("diaryMain").scrollTop = el.offsetTop - 40; window.scrollTo(0, 0); return document.getElementById("diaryMain").scrollTop; })()`);
  await scrollTo("2026-09-12");
  await page.click('#diaryMain .diary-day[data-date="2026-09-12"] [data-action="edit"]');
  await page.waitFor(`Boolean(document.getElementById("diaryBody"))`, "修正の画面");
  assert.equal(await page.run(`document.getElementById("diaryBody").selectionStart`), "前置き\n## オクラ\n".length);
  await page.type("追記した。");
  await page.click('#diaryMain [data-action="save"]');
  await saved();
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-day").length === 20 && document.querySelector('#diaryMain .diary-day[data-date="2026-09-12"]')?.textContent.includes("追記した。")`, "一覧に戻る");
  // 直した節が、日記の枠の中に見えている（一覧の頭に戻っていない）
  const seen = await page.run(`(() => { const main = document.getElementById("diaryMain").getBoundingClientRect(); const el = document.querySelector('#diaryMain .diary-day[data-date="2026-09-12"]').getBoundingClientRect(); return [document.getElementById("diaryMain").scrollTop > 0, el.bottom > main.top && el.top < main.bottom]; })()`);
  assert.deepEqual(seen, [true, true]);
  assert.equal((await diary()).days["2026-09-12"].body, "前置き\n## オクラ\n追記した。12 日目の見回り。");

  // やめても、一覧に戻る
  await page.click('#diaryMain .diary-day[data-date="2026-09-20"] [data-action="edit"]');
  await page.waitFor(`Boolean(document.getElementById("diaryBody"))`, "修正の画面");
  await page.click('#diaryMain [data-action="cancel"]');
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-day").length === 20`, "やめて一覧に戻る");

  // 種類を直す: 一覧のまま直し、札が変わり「（直した）」が付く
  await page.click('#diaryMain .diary-day[data-date="2026-09-15"] [data-action="tags"]');
  await page.click('#diaryMain .diary-day[data-date="2026-09-15"] [data-tag-kind="issues"][data-tag-name="アブラムシ"]');
  await page.click('#diaryMain [data-action="tags-save"]');
  await saved();
  await page.waitFor(`document.querySelector('#diaryMain .diary-day[data-date="2026-09-15"] .diary-tags')?.textContent.includes("（直した）")`, "直した札");
  assert.match(await page.run(`document.querySelector('#diaryMain .diary-day[data-date="2026-09-15"] .diary-tags').textContent`), /アブラムシ/);
  assert.deepEqual((await diary()).days["2026-09-15"].tags["オクラ"].issues, ["アブラムシ"]);
  assert.equal(await page.run(`document.querySelectorAll("#diaryMain .diary-tag-filters .diary-tag").length`), 1);
  assert.deepEqual(page.errors, []);
});

test("日記: 対象の札で絞ると、その作付の作業の記録と予定を、日付の順に差し挟む", options, async () => {
  const area = [[0, 0], [40, 0], [40, 20], [0, 20]];
  const data = {
    ...seed(),
    fields: [{ id: "f1", name: "試験の圃場", outline: area, note: "", active_plan_id: "p1", created_at: AT }],
    zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: area, created_at: AT }],
    blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "区画1", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
    beds: [1, 2].map((seq) => ({ id: `bed${seq}`, plan_id: "p1", block_id: "b1", seq, shape: [[seq * 3, 2], [seq * 3 + 1, 2], [seq * 3 + 1, 18], [seq * 3, 18]], start_date: null, removed_on: null })),
    plantings: [1, 2].map((seq) => ({ id: `pl${seq}`, plan_id: "p1", bed_id: `bed${seq}`, seq: 1, crop_id: "c1", crop_name: "試験菜" })),
    crops: [{ id: "c1", name: "試験菜", mulch: false, bed_width_cm: 100, aisle_width_cm: 60 }],
    // 計画: 収穫はまだ終わっていない。定植は記録で終えた。畝 2 の計画は出さない
    works: [
      { id: "w1", plan_id: "p1", block_id: null, planting_id: "pl1", work_type: "plant", seq: 1, plan_start: "2026-10-01", plan_end: "2026-10-01", note: "", cancelled_on: null, detail: {} },
      { id: "w2", plan_id: "p1", block_id: null, planting_id: "pl1", work_type: "harvest", seq: 2, plan_start: "2026-12-01", plan_end: "2026-12-10", note: "", cancelled_on: null, detail: {} },
      { id: "w3", plan_id: "p1", block_id: null, planting_id: "pl2", work_type: "harvest", seq: 1, plan_start: "2026-12-01", plan_end: "2026-12-10", note: "", cancelled_on: null, detail: {} },
    ],
  };
  const log = (id, date, type, planting, extra = {}) => ({
    id, field_id: "f1", date, end_date: null, work_type: type, finishes: true, spec: {}, note: "", created_at: AT, inputs: [],
    targets: [{ id: `t-${id}`, log_id: id, planting_id: planting, bed_id: planting ? `bed${planting.slice(2)}` : null, block_id: "b1", work_id: extra.work_id ?? null, label: "", crop_name: "試験菜", area_m2: null, spray_l: null }],
    ...extra,
  });
  data.workLogs = [
    log("L1", "2026-09-20", "rotary", null),
    log("L2", "2026-10-01", "plant", "pl1", { work_id: "w1", note: "株間 20cm" }),
    log("L3", "2026-10-05", "spray", "pl1"),
    log("L4", "2026-10-05", "spray", "pl2"),
  ];
  const target = { kind: "planting", id: "pl1", label: "区画1 畝1 試験菜" };
  const section = (date, heading) => ({ id: `${date}-01`, path: [heading], crops: [], work: [], tag_source: "claude", labels: { targets: [target], ...(heading === "防除" ? { work: ["防除"] } : {}) } });
  data.diary = {
    days: {
      "2026-10-02": { date: "2026-10-02", title: "", body: "## 発芽\n芽が出た。", tags: {}, updated_at: AT },
      "2026-10-05": { date: "2026-10-05", title: "", body: "## 防除\n虫がいた。", tags: {}, updated_at: AT },
    },
    sections: { "2026-10-02": [section("2026-10-02", "発芽")], "2026-10-05": [section("2026-10-05", "防除")] },
    photos: {},
    files: {},
  };
  await page.loadApp(data);
  await page.run(`location.hash = "#diary"`);
  await page.waitFor(`Boolean(document.querySelector('#diaryMonthSelect option[value="2026-10"]'))`, "日記の画面");
  await page.run(`(() => { const select = document.getElementById("diaryMonthSelect"); select.value = "2026-10"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.click('#diaryCalendar [data-date="2026-10-02"]');
  await page.waitFor(`Boolean(document.querySelector('#diaryMain [data-tag-filter="targets"]'))`, "対象の札");
  await page.click('#diaryMain [data-tag-filter="targets"]');
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-work").length === 4`, "作業を差し挟む");
  await page.click('#diaryMain [data-action="tag-order"][data-oldest="true"]');
  const order = `[...document.querySelectorAll("#diaryMain .diary-work, #diaryMain .diary-day")].map((el) => el.classList.contains("diary-day") ? "日記 " + el.dataset.date : (el.classList.contains("is-plan") ? "予定 " : "実績 ") + el.querySelector("b").textContent)`;
  await page.waitFor(`document.querySelector("#diaryMain .diary-work b")?.textContent === "ロータリー" && !document.querySelector("#diaryMain .diary-work").previousElementSibling?.classList.contains("diary-day")`, "古い順");
  assert.deepEqual(await page.run(order), ["実績 ロータリー", "実績 定植・播種", "日記 2026-10-02", "実績 防除", "日記 2026-10-05", "予定 収穫"]);
  assert.match(await page.run(`document.querySelector("#diaryMain .diary-tag-order").textContent`), /2 節、作業の記録 3 件、予定 1 件/);
  assert.match(await page.run(`document.querySelector("#diaryMain .diary-work.is-log").textContent`), /区画の作業/);

  // 作業の札（防除）を重ねると、作業も防除だけになる
  await page.click('#diaryMain .diary-day[data-date="2026-10-05"] [data-tag-filter="work"]');
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-day").length === 1`, "防除で絞る");
  assert.deepEqual(await page.run(order), ["実績 防除", "日記 2026-10-05"]);

  // 作業の記録を押すと、作業の記録の窓を開く
  await page.click('#diaryMain .diary-work.is-log');
  await page.waitFor(`Boolean(document.querySelector("dialog.log-dialog[open]"))`, "作業の記録の窓");
  assert.deepEqual(page.errors, []);
});

test("日記: 写真の窓の ‹ › で、同じ見出しの写真を行き来し、端では反対の端に戻る", options, async () => {
  const data = seed();
  const date = "2026-10-10";
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const names = [1, 2, 3, 4].map((n) => `${date}_0${n}.jpg`);
  data.diary = {
    days: { [date]: { date, title: "", body: `## A\n\n| ![](images/${names[0]}) | ![](images/${names[1]}) | ![](images/${names[2]}) |\n| :- | :- | :- |\n\n## B\n\n![](images/${names[3]})`, tags: {}, updated_at: AT } },
    sections: { [date]: [{ id: `${date}-01`, path: ["A"], crops: [], work: [] }, { id: `${date}-02`, path: ["B"], crops: [], work: [] }] },
    photos: Object.fromEntries(names.map((name) => [name, { name, date }])),
    files: Object.fromEntries(names.map((name) => [`2026/photos/${name}`, png])),
  };
  await page.loadApp(data);
  await page.run(`location.hash = "#diary"`);
  await page.waitFor(`Boolean(document.querySelector('#diaryMonthSelect option[value="2026-10"]'))`, "日記の画面");
  await page.run(`(() => { const select = document.getElementById("diaryMonthSelect"); select.value = "2026-10"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.click(`#diaryCalendar [data-date="${date}"]`);
  await page.waitFor(`document.querySelectorAll("#diaryMain .diary-photo img").length === 4`, "写真");
  const shown = () => page.run(`(() => { const d = document.querySelector("dialog.diary-viewer[open]"); const text = d.querySelector("p.muted").textContent; return d.querySelector(".diary-viewer-photo img")?.alt + " " + (text.split("。")[1] || "").split(" 枚目")[0].split("、")[0]; })()`);

  await page.click(`#diaryMain [data-photo="${names[1]}"]`);
  await page.waitFor(`Boolean(document.querySelector("dialog.diary-viewer[open]"))`, "写真の窓");
  assert.equal(await shown(), `${names[1]} 2 / 3`);
  await page.click('dialog.diary-viewer [data-action="next"]');
  assert.equal(await shown(), `${names[2]} 3 / 3`);
  await page.click('dialog.diary-viewer [data-action="next"]');
  assert.equal(await shown(), `${names[0]} 1 / 3`); // 端から反対の端へ
  await page.click('dialog.diary-viewer [data-action="prev"]');
  assert.equal(await shown(), `${names[2]} 3 / 3`);
  await page.press("ArrowLeft", "ArrowLeft", 37);
  assert.equal(await shown(), `${names[1]} 2 / 3`);
  await page.click('dialog.diary-viewer [data-action="close"]');

  // ほかの見出しの写真は 1 枚なので、‹ › は出さない（見出しをまたがない）
  await page.click(`#diaryMain [data-photo="${names[3]}"]`);
  await page.waitFor(`Boolean(document.querySelector("dialog.diary-viewer[open]"))`, "写真の窓");
  assert.equal(await page.run(`document.querySelectorAll("dialog.diary-viewer[open] .diary-viewer-nav").length`), 0);
  await page.click('dialog.diary-viewer [data-action="close"]');
  assert.deepEqual(page.errors, []);
});

test("日記: 小見出しのボタンで ### を付け、小見出しは下げて出し、タグは見出しの節にまとめる。空の行を続けると空白の行になる", options, async () => {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="diary"]');
  await page.click('#diaryMain [data-action="edit"]');
  // 並びは「見出し」「小見出し」「写真を入れる」「やめる」「保存」
  assert.deepEqual(await page.run(`[...document.querySelectorAll("#diaryMain .diary-tools > *")].map((el) => el.textContent.trim())`), ["見出し", "小見出し", "写真を入れる", "やめる", "保存"]);
  await page.click("#diaryBody");
  await page.type("島にんじん");
  await page.click('#diaryMain [data-action="heading"]');
  const NL = String.fromCharCode(10);
  await page.type(`${NL}発芽を見た。${NL}${NL}${NL}${NL}次の段落。${NL}除草`);
  await page.click('#diaryMain [data-action="subheading"]');
  await page.type(`${NL}草を抜いた。`);
  assert.equal(await page.run(`document.getElementById("diaryBody").value`), `## 島にんじん${NL}発芽を見た。${NL}${NL}${NL}${NL}次の段落。${NL}### 除草${NL}草を抜いた。`);
  // プレビュー: 小見出しは下げ、空の行を 3 つ続けたところは空白の行が 2 つ
  await page.click('#diaryMain [data-action="preview-mode"]');
  assert.equal(await page.run(`document.querySelectorAll("#diaryMain .diary-preview .diary-blank").length`), 2);
  assert.equal(await page.run(`document.querySelector("#diaryMain .diary-preview .diary-sub-1 .diary-heading").textContent`), "除草");
  assert.ok((await page.run(`parseFloat(getComputedStyle(document.querySelector("#diaryMain .diary-preview .diary-sub-1")).marginLeft)`)) > 0);
  await page.click('#diaryMain [data-action="save"]');
  await saved();
  // 節は見出しの 1 つだけで、小見出しの行も本文に入る
  const stored = await diary();
  assert.deepEqual(stored.sections[TODAY].map((section) => section.path), [["島にんじん"]]);
  // 日の表示でも、小見出しは下げ、札は見出しのまとまりの一番下に 1 組だけ出す
  await page.waitFor(`Boolean(document.querySelector("#diaryMain .diary-section .diary-sub-1"))`, "日の表示");
  assert.equal(await page.run(`document.querySelectorAll("#diaryMain .diary-section .diary-tags").length`), 1);
  assert.equal(await page.run(`document.querySelector("#diaryMain .diary-section").lastElementChild.classList.contains("diary-tags")`), true);
  assert.deepEqual(page.errors, []);
});

test("日記: 見出し・小見出しのボタンを押しても、入力欄の表示位置は動かず、取り消し（Ctrl+Z）で戻せる", options, async () => {
  const NL = String.fromCharCode(10);
  const body = Array.from({ length: 80 }, (_, i) => (i % 5 === 0 ? `## 見出し${i}` : `${i} 行目の文。それなりに長い文を書いておく。`)).join(NL);
  const data = seed();
  data.diary = { days: { [TODAY]: { date: TODAY, title: "", body, tags: {}, updated_at: AT } }, sections: {}, photos: {}, files: {} };
  await page.loadApp(data);
  await page.click('.tab-btn[data-view="diary"]');
  await page.waitFor(`Boolean(document.querySelector('#diaryMain [data-action="edit"]'))`, "日の表示");
  await page.click('#diaryMain [data-action="edit"]');
  await page.waitFor(`Boolean(document.getElementById("diaryBody"))`, "修正の画面");
  // 41 行目にカーソルを置き、入力欄を中ほどまで送る
  await page.run(`(() => { const a = document.getElementById("diaryBody"); const pos = a.value.indexOf("41 行目"); a.focus(); a.setSelectionRange(pos, pos); a.dispatchEvent(new Event("click", { bubbles: true })); a.scrollTop = 900; })()`);
  const top = await page.run(`document.getElementById("diaryBody").scrollTop`);
  assert.ok(top > 0);
  const line = () => page.run(`(() => { const a = document.getElementById("diaryBody"); const v = a.value; return v.slice(v.lastIndexOf(String.fromCharCode(10), a.selectionStart - 1) + 1, a.selectionStart); })()`);
  await page.click('#diaryMain [data-action="subheading"]');
  assert.equal(await page.run(`document.getElementById("diaryBody").scrollTop`), top);
  assert.equal(await line(), "### 41 行目の文。それなりに長い文を書いておく。");
  await page.click('#diaryMain [data-action="heading"]');
  assert.equal(await page.run(`document.getElementById("diaryBody").scrollTop`), top);
  assert.equal(await line(), "## 41 行目の文。それなりに長い文を書いておく。");
  // 書きかけにも入っている
  assert.match(await page.run(`localStorage.getItem("field_plan_diary_drafts")`), /## 41 行目/);
  // 取り消すと、1 つ前（小見出し）に戻る
  await page.run(`document.execCommand("undo")`);
  assert.match(await page.run(`document.getElementById("diaryBody").value`), new RegExp(`### 41 行目`));
  assert.deepEqual(page.errors, []);
});

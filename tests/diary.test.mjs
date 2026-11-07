// 農作業日記の計算（app/diary.js）と、ローカルの保存の日記の部分（app/store.js）のテスト。実行: node --test "tests/*.test.mjs"
// 本物の日記は使わない。文も写真の名前も、ここで作ったもの。
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyChunks,
  calendarDays,
  exifDateTime,
  fiscalYear,
  insertBlock,
  monthChoices,
  nextPhotoName,
  periodOf,
  photoMarkdown,
  photoNames,
  photoPath,
  photoSize,
  renderMarkdown,
  searchWords,
  sectionTags,
  shiftPeriod,
  snippetHtml,
  splitSections,
  toggleHeading,
} from "../app/diary.js";
import { createLocalStore } from "../app/store.js";

const WORDS = {
  crops: [
    { name: "オクラ", words: ["オクラ"] },
    { name: "トマト", words: ["トマト"] },
  ],
  work: [
    { name: "収穫", words: ["収穫"] },
    { name: "施肥", words: ["追肥", "元肥"] },
  ],
};

test("本文を見出しごとの節に分け、写真を本文から抜く（build_sections.py と同じ）", () => {
  const body = [
    "# 2026-11-08 題の行",
    "朝の見回り。",
    "",
    "## 畑A",
    "### オクラ",
    "収穫した。",
    "![](images/2026-11-08_01.jpg)",
    "",
    "",
    "",
    "まだ実が多い。",
    "### トマト",
    "| ![](images/2026-11-08_02.jpg) | ![](images/2026-11-08_03.jpg) |",
    "| :---- | :---- |",
    "## まとめ",
    "",
  ].join("\n");
  assert.deepEqual(splitSections(body), [
    { path: [], body: "朝の見回り。", images: [] },
    { path: ["畑A", "オクラ"], body: "収穫した。\n\nまだ実が多い。", images: ["images/2026-11-08_01.jpg"] },
    { path: ["畑A", "トマト"], body: "|  |  |\n| :---- | :---- |", images: ["images/2026-11-08_02.jpg", "images/2026-11-08_03.jpg"] },
    // 中身のない見出しでも、下位の節を束ねていなければ節にする
    { path: ["まとめ"], body: "", images: [] },
  ]);
});

test("中身のない最初の節と、束ねるだけの見出しは節にしない", () => {
  assert.deepEqual(splitSections("\n## 親\n### 子\n本文"), [{ path: ["親", "子"], body: "本文", images: [] }]);
  assert.deepEqual(splitSections(""), []);
  // 見出しの階層が戻ったら、上位の見出しを入れ替える
  assert.deepEqual(
    splitSections("## A\n### B\nb\n## C\nc").map((s) => s.path),
    [["A", "B"], ["C"]]
  );
});

test("CRLF の改行でも同じ節になる", () => {
  assert.deepEqual(splitSections("## A\r\nあ\r\n## B\r\nい\r\n"), splitSections("## A\nあ\n## B\nい\n"));
});

test("表示のためのまとまりは、写真と束ねるだけの見出しを残す", () => {
  const chunks = bodyChunks("前\n## 親\n### 子\n![](images/x.jpg)");
  assert.deepEqual(
    chunks.map((c) => [c.path, c.heading, c.level, c.text]),
    [
      [[], null, 0, "前"],
      [["親"], "親", 2, ""],
      [["親", "子"], "子", 3, "![](images/x.jpg)"],
    ]
  );
});

test("作物は見出しにあればそれを優先し、作業の種類は見出しと本文から拾う", () => {
  assert.deepEqual(sectionTags(["オクラ"], "トマトの横で収穫", WORDS), { crops: ["オクラ"], work: ["収穫"] });
  assert.deepEqual(sectionTags(["畑A"], "トマトとオクラに追肥", WORDS), { crops: ["オクラ", "トマト"], work: ["施肥"] });
  assert.deepEqual(sectionTags([], "雨", WORDS), { crops: [], work: [] });
});

test("写真の置き場の場所は、年度（4 月始まり）ごとのフォルダー", () => {
  assert.equal(fiscalYear("2026-04-01"), 2026);
  assert.equal(fiscalYear("2027-03-31"), 2026);
  assert.equal(photoPath("2027-01-05_02.jpg"), "2026/photos/2027-01-05_02.jpg");
  assert.deepEqual(photoNames("a ![](images/2026-11-08_01.jpg) b ![x](images/2026-11-08_02.jpg)"), ["2026-11-08_01.jpg", "2026-11-08_02.jpg"]);
});

test("新しい写真の名前は、その日に使った番号の次", () => {
  assert.equal(nextPhotoName("2026-11-08", []), "2026-11-08_01.jpg");
  assert.equal(nextPhotoName("2026-11-08", ["2026-11-08_01.jpg", "2026-11-08_07.jpg", "2026-11-07_20.jpg"]), "2026-11-08_08.jpg");
});

test("写真は短辺を 1080 px にし、元が小さければ広げない", () => {
  assert.deepEqual(photoSize(4032, 3024), { width: 1440, height: 1080 });
  assert.deepEqual(photoSize(3024, 4032), { width: 1080, height: 1440 });
  assert.deepEqual(photoSize(800, 600), { width: 800, height: 600 });
});

test("何枚かの写真は、1 行に並べた表にする", () => {
  assert.equal(photoMarkdown(["a.jpg"]), "![](images/a.jpg)");
  assert.equal(photoMarkdown(["a.jpg", "b.jpg"]), "| ![](images/a.jpg) | ![](images/b.jpg) |\n| :---- | :---- |");
});

test("写真は段落として差し込み、前後に空の行を入れる", () => {
  assert.deepEqual(insertBlock("", 0, "X"), { body: "X\n", pos: 2 });
  const middle = insertBlock("前の文\n後の文", 4, "X");
  assert.equal(middle.body, "前の文\n\nX\n\n後の文");
  assert.equal(middle.body.slice(middle.pos), "後の文");
  assert.equal(insertBlock("前の文\n\n", 5, "X").body, "前の文\n\nX\n");
});

test("見出しのボタンは、カーソルの行を見出しにし、もう一度押すと戻す", () => {
  const once = toggleHeading("一行目\n二行目\n三行目", 5);
  assert.equal(once.body, "一行目\n## 二行目\n三行目");
  assert.equal(toggleHeading(once.body, 6).body, "一行目\n二行目\n三行目");
});

test("週は月曜から日曜まで、月は 1 日から末日まで", () => {
  assert.deepEqual(periodOf("week", "2026-11-08"), { from: "2026-11-02", to: "2026-11-08" });
  assert.deepEqual(periodOf("week", "2026-11-09"), { from: "2026-11-09", to: "2026-11-15" });
  assert.deepEqual(periodOf("month", "2026-02-14"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(periodOf("day", "2026-11-08"), { from: "2026-11-08", to: "2026-11-08" });
  assert.equal(shiftPeriod("month", "2026-01-31", 1), "2026-02-01");
  assert.equal(shiftPeriod("week", "2026-11-08", -1), "2026-11-01");
  const days = calendarDays("2026-11");
  assert.equal(days[0], "2026-10-26");
  assert.equal(days[days.length - 1], "2026-12-06");
  assert.equal(days.length % 7, 0);
});

test("カレンダーの年月のリストは、新しい月から古い月へ、年をまたいで並ぶ", () => {
  assert.deepEqual(monthChoices("2025-11", "2026-02"), ["2026-02", "2026-01", "2025-12", "2025-11"]);
  assert.deepEqual(monthChoices("2026-11", "2026-11"), ["2026-11"]);
});

test("Markdown の表示: 見出し、箇条書き、写真の表、リンク、太字、取り消し線", () => {
  const photo = (name) => `<img data-photo="${name}">`;
  const html = renderMarkdown(
    ["## 見出し", "- **太字** と ~~消した~~", "  - 下の段", "| ![](images/a.jpg) | 説明 |", "| :---- | :---- |", "[資料](https://example.test/a)", "<script>"].join("\n"),
    photo
  );
  assert.match(html, /<h3 class="diary-heading">見出し<\/h3>/);
  assert.match(html, /<li class="diary-depth-0"><strong>太字<\/strong> と <del>消した<\/del><\/li><li class="diary-depth-1">下の段<\/li>/);
  assert.match(html, /<table><tr><td><img data-photo="a.jpg"><\/td><td>説明<\/td><\/tr><\/table>/);
  assert.match(html, /<a href="https:\/\/example.test\/a" target="_blank" rel="noopener">資料<\/a>/);
  assert.match(html, /&lt;script&gt;/);
  // http(s) でないリンクは、リンクにしない
  assert.doesNotMatch(renderMarkdown("[x](javascript:alert(1))", photo), /<a /);
});

test("検索の語に印を付け、前後の文を切り出す。全角と半角の違いは見ない", () => {
  assert.deepEqual(searchWords("  オクラ　ＡＢ "), ["オクラ", "AB"]);
  const html = snippetHtml("今日はＡＢ区画でオクラを収穫した", ["ab", "オクラ"]);
  assert.match(html, /<mark>ＡＢ<\/mark>区画で<mark>オクラ<\/mark>を収穫した/);
  assert.match(snippetHtml(`${"あ".repeat(100)}オクラ`, ["オクラ"]), /^…あ+<mark>オクラ<\/mark>$/);
});

// EXIF に撮影日時を持つ、最小の JPEG のはじめの部分を作る
function jpegWithDate(text, little) {
  const ascii = [...text].map((c) => c.charCodeAt(0)).concat([0]);
  const tiff = new DataView(new ArrayBuffer(8 + 18 + 18 + ascii.length));
  const u16 = (at, v) => tiff.setUint16(at, v, little);
  const u32 = (at, v) => tiff.setUint32(at, v, little);
  tiff.setUint16(0, little ? 0x4949 : 0x4d4d);
  u16(2, 42);
  u32(4, 8);
  // IFD0: Exif IFD の場所を 1 つだけ持つ
  u16(8, 1);
  u16(10, 0x8769);
  u16(12, 4);
  u32(14, 1);
  u32(18, 26);
  u32(22, 0);
  // Exif IFD: DateTimeOriginal
  u16(26, 1);
  u16(28, 0x9003);
  u16(30, 2);
  u32(32, ascii.length);
  u32(36, 44);
  u32(40, 0);
  ascii.forEach((byte, i) => tiff.setUint8(44 + i, byte));
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...new Uint8Array(tiff.buffer)];
  const size = exif.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, size >> 8, size & 0xff, ...exif, 0xff, 0xda]).buffer;
}

test("JPEG の EXIF から撮影日時を読む。読めなければ null", () => {
  assert.equal(exifDateTime(jpegWithDate("2026:11:08 09:14:32", false)), "2026-11-08 09:14:32");
  assert.equal(exifDateTime(jpegWithDate("2026:11:08 09:14:32", true)), "2026-11-08 09:14:32");
  assert.equal(exifDateTime(jpegWithDate("0000:00:00 00:00:00", true)), null);
  assert.equal(exifDateTime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), null);
  assert.equal(exifDateTime(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]).buffer), null);
});

// ---- ローカルの保存（DB の関数と同じ動き） ----

beforeEach(() => {
  const items = new Map();
  globalThis.localStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key),
  };
});

const save = (store, day) => store.diarySaveDay({ ...day, sections: splitSections(day.body) });

test("日記を保存すると、節と作物・作業の種類ができ、直した種類は見出しごとに残る", async () => {
  const store = createLocalStore();
  const first = await save(store, { date: "2026-11-08", title: "題", body: "## オクラ\n収穫\n## 畑\nトマト", tags: {}, expected: null });
  let [day] = await store.diaryDays("2026-11-01", "2026-11-30");
  assert.equal(day.updated_at, first.updated_at);
  assert.deepEqual(day.sections.map((s) => [s.id, s.crops, s.work]), [
    ["2026-11-08-01", ["オクラ"], ["収穫"]],
    ["2026-11-08-02", ["トマト"], []],
  ]);
  await save(store, { date: "2026-11-08", title: "題", body: day.body, tags: { 畑: { crops: [], work: ["定植"] }, 消えた見出し: { crops: [], work: [] } }, expected: day.updated_at });
  [day] = await store.diaryDays("2026-11-08", "2026-11-08");
  assert.deepEqual(day.tags, { 畑: { crops: [], work: ["定植"] } });
  assert.deepEqual(day.sections[1].work, ["定植"]);
  // 見出しを書き換えた節は、自動に戻る
  await save(store, { date: "2026-11-08", title: "題", body: "## オクラ\n収穫\n## 畑B\nトマト", tags: day.tags, expected: day.updated_at });
  [day] = await store.diaryDays("2026-11-08", "2026-11-08");
  assert.deepEqual(day.tags, {});
  assert.deepEqual(day.sections[1].crops, ["トマト"]);
});

test("ほかの画面で書き換えられていたら、保存を止める", async () => {
  const store = createLocalStore();
  await save(store, { date: "2026-11-08", title: "", body: "一回目", tags: {}, expected: null });
  await assert.rejects(save(store, { date: "2026-11-08", title: "", body: "二回目", tags: {}, expected: null }), { code: "40001" });
  await assert.rejects(save(store, { date: "2026-11-09", title: "", body: "新しい日", tags: {}, expected: "2026-01-01T00:00:00Z" }), { code: "40001" });
});

test("使われなくなった写真を返し、前の版に残る写真は残す。空にした日は消える", async () => {
  const store = createLocalStore();
  for (const name of ["2026-11-08_01.jpg", "2026-11-08_02.jpg", "2026-11-08_03.jpg"]) {
    await store.diaryUploadPhoto(photoPath(name), new Blob(["x"]));
    await store.diaryAddPhoto({ name, date: "2026-11-08", takenAt: "2026-11-08 09:00:00", originalName: "IMG_1.JPG", width: 1440, height: 1080 });
  }
  await assert.rejects(store.diaryUploadPhoto(photoPath("2026-11-08_01.jpg"), new Blob(["y"])), { code: "exists" });
  // 3 枚目は本文に入れないまま保存した
  const first = await save(store, { date: "2026-11-08", title: "", body: "![](images/2026-11-08_01.jpg)\n![](images/2026-11-08_02.jpg)", tags: {}, expected: null });
  assert.deepEqual(first.removed, ["2026-11-08_03.jpg"]);
  // 2 枚目を外しても、前の版に残っているので消さない
  const second = await save(store, { date: "2026-11-08", title: "", body: "![](images/2026-11-08_01.jpg)", tags: {}, expected: first.updated_at });
  assert.deepEqual(second.removed, []);
  assert.deepEqual(await store.diaryPhotoNames("2026-11-08"), ["2026-11-08_01.jpg", "2026-11-08_02.jpg"]);
  const [day] = await store.diaryDays("2026-11-08", "2026-11-08");
  assert.deepEqual(day.photos["2026-11-08_01.jpg"].original_name, "IMG_1.JPG");
  // 題も本文も空にすると、その日を消す
  const cleared = await save(store, { date: "2026-11-08", title: " ", body: "", tags: {}, expected: second.updated_at });
  assert.equal(cleared.updated_at, null);
  assert.deepEqual(await store.diaryDays("2026-11-08", "2026-11-08"), []);
});

test("カレンダーの印と、語での検索", async () => {
  const store = createLocalStore();
  await save(store, { date: "2026-11-02", title: "見回り", body: "ＡＢ区画のオクラ\n![](images/2026-11-02_01.jpg)", tags: {}, expected: null });
  await save(store, { date: "2026-11-05", title: "", body: "トマトの収穫", tags: {}, expected: null });
  assert.deepEqual(await store.diaryCalendar("2026-11-01", "2026-11-30"), [
    { date: "2026-11-02", title: "見回り", photos: 1 },
    { date: "2026-11-05", title: "", photos: 0 },
  ]);
  assert.deepEqual((await store.diarySearch(["ab", "オクラ"])).map((hit) => hit.date), ["2026-11-02"]);
  assert.deepEqual((await store.diarySearch(["の"])).map((hit) => hit.date), ["2026-11-05", "2026-11-02"]);
  assert.deepEqual(await store.diarySearch(["ない語"]), []);
  assert.equal(await store.diaryFirstDate(), "2026-11-02");
});

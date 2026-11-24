// 区画と畝の図の主な操作（畝の削除・表示日・追加、記録の面積、苗数）を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 保存の失敗と送り直しは save-retry.test.mjs、図の編集と元に戻すは edit-undo.test.mjs
// 保存は ?local=1&strict=1 なので、保存の順序を誤ると、DB と同じように失敗する
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";
import { AT, CANCEL, CONFIRM, seed, stripTools } from "./strip-tools.mjs";

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

const { shownBeds, labels, waitBeds, waitNoDialog, openStrip, chooseBed, chooseCrop, widenBed } = stripTools(() => page);


test("選んだ畝を完全に削除: キャンセルなら残り、削除すると図からすぐ消える", options, async () => {
  await openStrip(3);
  await chooseBed("bed1");

  await page.click("#stripDeleteBtn");
  await page.click(CANCEL);
  await waitNoDialog();
  assert.equal(await shownBeds(), "bed1,bed2,bed3");
  assert.equal((await page.saved()).beds.length, 3);

  await page.click("#stripDeleteBtn");
  await page.click(CONFIRM);
  await waitBeds("bed2,bed3");
  assert.equal(await labels(), "1/2", "番号は左から振り直す");
  assert.equal(await page.run(`document.getElementById("stripDeleteBtn").disabled`), true);
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).beds.length === 2`, "削除の保存");
  assert.deepEqual(page.errors, []);
});

test("記録のある畝を削除: 記録の対象から外し、ほかに対象のない記録は消え、元に戻すと両方戻る", options, async () => {
  const DAY = "2026-03-10";
  const data = seed(2);
  data.fields[0].active_plan_id = "p1";
  data.plantings = ["bed1", "bed2"].map((bedId, i) => ({ id: `pl${i + 1}`, plan_id: "p1", bed_id: bedId, seq: 1, crop_id: "c1", crop_name: "試験菜", note: "" }));
  const target = (n) => ({ id: `t${n}`, planting_id: `pl${n}`, bed_id: `bed${n}`, block_id: "b1", work_id: null, label: `A 畝${n} 試験菜`, crop_name: "試験菜", area_m2: 10, spray_l: null });
  const log = (id, targets) => ({ id, field_id: "f1", date: DAY, end_date: null, work_type: "spray", finishes: false, spec: {}, note: "", created_at: AT, inputs: [], targets: targets.map((item) => ({ ...item, id: `${id}-${item.id}`, log_id: id })) });
  data.workLogs = [log("both", [target(1), target(2)]), log("only1", [target(1)])];
  await page.loadApp(data);
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === 2`, "図に畝が 2 本出る");
  await chooseBed("bed1");

  await page.click("#stripDeleteBtn");
  await page.waitFor(`document.querySelector("dialog.notice")?.textContent.includes("作業の記録 2 件")`, "記録の件数を知らせる");
  assert.match(await page.run(`document.querySelector("dialog.notice").textContent`), /ほかに対象のない記録 1 件は、記録ごと消えます/);
  assert.match(await page.run(`document.querySelector("dialog.notice").textContent`), /残る記録の畝の面積は、この畝がないものとして求め直します/);
  await page.click(CONFIRM);
  await waitBeds("bed2");
  const logsSaved = `JSON.parse(localStorage.getItem("field_plan_local")).workLogs`;
  await page.waitFor(`${logsSaved}.length === 1 && ${logsSaved}[0].targets.length === 1`, "記録から畝 1 が外れる");
  const [left] = (await page.saved()).workLogs;
  assert.equal(left.id, "both");
  assert.deepEqual(left.targets.map((item) => item.bed_id), ["bed2"]);
  // 残った畝 2 の面積は、畝 1 のない並びで求め直す（入れておいた 10 ㎡ ではなくなり、区画の畝 1 本ぶんの面積になる）
  const expected = await page.run(`import("./logs.js").then(({ bedAreas }) => Math.round(bedAreas(${JSON.stringify(data.blocks[0])}, ${JSON.stringify(data.beds.filter((bed) => bed.id === "bed2"))}).get("bed2") * 100) / 100)`);
  assert.ok(expected > 10);
  assert.equal(left.targets[0].area_m2, expected);

  await page.waitFor(`!document.getElementById("undoBtn").disabled`, "元に戻すが使える");
  await page.click("#undoBtn");
  await page.waitFor(`${logsSaved}.length === 2`, "消えた記録が戻る");
  const saved = await page.saved();
  assert.equal(saved.beds.length, 2);
  assert.deepEqual(saved.workLogs.find((item) => item.id === "both").targets.map((item) => item.bed_id).sort(), ["bed1", "bed2"]);
  assert.deepEqual(saved.workLogs.find((item) => item.id === "both").targets.map((item) => item.area_m2), [10, 10]);
  assert.deepEqual(saved.workLogs.find((item) => item.id === "only1").targets.map((item) => item.bed_id), ["bed1"]);
  assert.deepEqual(page.errors, []);
});

test("記録のある畝の幅を変える: 今までの記録の面積にも当てはめるかを尋ね、当てはめると隣の畝も求め直す。当てはめなければそのまま", options, async () => {
  const DAY = "2026-03-10";
  const data = seed(2);
  data.fields[0].active_plan_id = "p1";
  data.plantings = ["bed1", "bed2"].map((bedId, i) => ({ id: `pl${i + 1}`, plan_id: "p1", bed_id: bedId, seq: 1, crop_id: "c1", crop_name: "試験菜", note: "" }));
  const target = (n) => ({ id: `t${n}`, log_id: "both", planting_id: `pl${n}`, bed_id: `bed${n}`, block_id: "b1", work_id: null, label: `A 畝${n} 試験菜`, crop_name: "試験菜", area_m2: 10, spray_l: null });
  data.workLogs = [{ id: "both", field_id: "f1", date: DAY, end_date: null, work_type: "spray", finishes: false, spec: {}, note: "", created_at: AT, inputs: [], targets: [target(1), target(2)] }];
  await page.loadApp(data);
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === 2`, "図に畝が 2 本出る");
  const areas = () => page.run(`JSON.parse(localStorage.getItem("field_plan_local")).workLogs[0].targets.map((item) => item.area_m2)`);
  // 今の畝の形で求めた、2 本の畝の面積
  const expected = () =>
    page.run(`import("./logs.js").then(({ bedAreas }) => {
      const local = JSON.parse(localStorage.getItem("field_plan_local"));
      const areas = bedAreas(local.blocks[0], local.beds);
      return ["bed1", "bed2"].map((id) => Math.round(areas.get(id) * 100) / 100);
    })`);
  const ASK = `document.querySelector("dialog.notice[open]")?.textContent.includes("記録にも当てはめる")`;

  // 畝 1 の幅を 150 cm にする。少し待つと、記録 1 件の面積が変わると尋ねる。当てはめると、畝 1 と畝 2 の面積を今の形で求め直す
  // 尋ねるのは、形を変えてから 1.5 秒後。その時間は実際には待たずに進める（app/clock.js）
  await widenBed();
  assert.equal(await page.run(`Boolean(${ASK})`), false, "すぐには尋ねない");
  await page.advance(1500);
  assert.equal(await page.run(`Boolean(${ASK})`), true, "1.5 秒たつと、記録の面積に当てはめるかを尋ねる");
  assert.match(await page.run(`document.querySelector("dialog.notice[open]").textContent`), /今までの作業の記録 1 件（.+）で、畝の面積（畝＋通路）が変わります/);
  await page.click(CONFIRM);
  const applied = await expected();
  await page.waitFor(`JSON.stringify(JSON.parse(localStorage.getItem("field_plan_local")).workLogs[0].targets.map((item) => item.area_m2)) === ${JSON.stringify(JSON.stringify(applied))}`, "記録の面積が求め直される");
  assert.notDeepEqual(applied, [10, 10]);

  // もう一度幅を変えて、当てはめないと、記録の面積はそのまま。そのあと別の畝を触っても、同じ変更で尋ね直さない
  await page.run(`window.prompt = () => "200"`);
  await page.click('[data-dim="width:0"]');
  await page.advance(1500);
  assert.equal(await page.run(`Boolean(${ASK})`), true, "2 回目も尋ねる");
  await page.click('dialog.notice [data-action="cancel"]');
  await page.waitFor(`!document.querySelector("dialog.notice[open]")`, "窓が閉じる");
  await page.advance(2000);
  assert.equal(await page.run(`Boolean(${ASK})`), false);
  assert.deepEqual(await areas(), applied);
  assert.deepEqual(page.errors, []);
});

test("選んだ畝を表示日でなくす: 図からすぐ消える", options, async () => {
  await openStrip(3);
  await chooseBed("bed2");
  await page.click("#stripRemoveBtn");
  await page.click(CONFIRM);
  await waitBeds("bed1,bed3");
  assert.deepEqual(page.errors, []);
});

test("区画の畝をすべて表示日でなくす: 図からすぐ消える", options, async () => {
  await openStrip(2);
  await page.click("#stripRemoveAllBtn");
  await page.click(CONFIRM);
  await waitBeds("");
  assert.deepEqual(page.errors, []);
});

test("品目を選んで右端に足す: 畝と作付と作業が保存される", options, async () => {
  await openStrip(2);
  await chooseCrop("#stripCrop");
  await page.setValue("#stripCount", "2");
  await page.click("#stripAddBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).works.length > 0 && document.getElementById("saveStatus").textContent === "保存しました"`, "作付と作業の保存");
  const data = await page.saved();
  assert.equal(data.beds.length, 4);
  assert.deepEqual(data.plantings.map((planting) => planting.crop_name), ["試験菜", "試験菜"]);
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed-label").length === 4`, "図に 4 本");
  assert.equal(await labels(), "1/2/3 試験菜/4 試験菜");
  assert.deepEqual(page.errors, []);
});

test("品目を選んで図の＋で足す: 畝と作付が保存される", options, async () => {
  await openStrip(2);
  await chooseCrop("#stripCrop");
  await page.click('.strip-insert[data-insert="1"]');
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).plantings.length === 1`, "作付の保存");
  const data = await page.saved();
  assert.equal(data.beds.length, 3);
  assert.equal(data.plantings[0].crop_name, "試験菜");
  await page.waitFor(`document.querySelector("#strip").textContent.includes("2 試験菜")`, "足した畝が左から 2 本目になる");
  assert.deepEqual(page.errors, []);
});

test("品目を決めずに足す: 畝だけが保存される", options, async () => {
  await openStrip(1);
  await page.click("#stripAddBtn");
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === 2`, "図に 2 本");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).beds.length === 2`, "畝の保存");
  assert.equal((await page.saved()).plantings.length, 0);
  assert.deepEqual(page.errors, []);
});

// 作付のない畝の欄を押すと、窓の工程の計画がその畝で開き、そこで作付を足せる
test("畝に作付を追加する: 作付と作業が保存される", options, async () => {
  await openStrip(1);
  await page.click('.strip-column-bed[data-open="bed1"]');
  await page.waitFor(`Boolean(document.querySelector('dialog.log-dialog[open] [data-pe="add-crop"]'))`, "窓の工程の計画");
  await chooseCrop('dialog.log-dialog[open] [data-pe="add-crop"]');
  await page.click('dialog.log-dialog[open] [data-pe-act="add-planting"]');
  await page.click('dialog.log-dialog[open] [data-act="save"]');
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).works.length > 0`, "作付と作業の保存");
  assert.equal((await page.saved()).plantings[0].crop_name, "試験菜");
  assert.deepEqual(page.errors, []);
});

test("株の並びと苗数: 定植の実績に株間と条数があれば、その値で描く", options, async () => {
  const data = seed(2);
  data.fields[0].active_plan_id = "p1";
  Object.assign(data.crops[0], { plant_gap_cm: 15, row_gap_cm: 15, row_count: 4 });
  data.plantings = [1, 2].map((seq) => ({ id: `pl${seq}`, plan_id: "p1", bed_id: `bed${seq}`, seq: 1, crop_id: "c1", crop_name: "試験菜" }));
  // 畝 1 だけ、株間 20 cm・条間 20 cm・3 条で植えた
  data.workLogs = [
    {
      id: "l1",
      field_id: "f1",
      date: "2026-01-02",
      end_date: null,
      work_type: "plant",
      finishes: true,
      spec: { plant_gap_cm: 20, row_gap_cm: 20, row_count: 3 },
      note: "",
      created_at: AT,
      targets: [{ id: "t1", log_id: "l1", planting_id: "pl1", bed_id: "bed1", block_id: "b1", work_id: null, label: "A 畝1 試験菜", crop_name: "試験菜", area_m2: 16, spray_l: null }],
      inputs: [],
    },
  ];
  await page.loadApp(data);
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === 2`, "図に畝が 2 本出る");
  const box = (id) =>
    page.run(`(() => {
      const box = document.querySelector('#strip .strip-bed[data-bed="${id}"]');
      return { plants: box.querySelectorAll(".strip-plant").length, spacing: box.querySelector(".strip-spacing")?.innerHTML };
    })()`);
  // 〇は条の数 × 2 株
  assert.deepEqual(await box("bed1"), { plants: 6, spacing: "条間20cm<br>株間20cm" });
  assert.deepEqual(await box("bed2"), { plants: 8, spacing: "条間15cm<br>株間15cm" });
  // 苗数: 16 m ÷ 0.2 m = 80 株 × 3 条、16 m ÷ 0.15 m = 106 株 × 4 条
  const numbers = await page.run(`[...document.querySelectorAll("#strip .strip-numbers")].map((line) => line.textContent).join("/")`);
  assert.equal(numbers, "苗 240/苗 424");
  assert.deepEqual(page.errors, []);
});

test("日程で開いていた畝を、次に開いたときも開く（URL に区画があるときも）", options, async () => {
  await openStrip(3);
  await chooseBed("bed2");
  const prefs = await page.run(`localStorage.getItem("field_plan_prefs")`);
  assert.equal(JSON.parse(prefs).f1.schedulePlace.p1.target, "bed2");

  await page.loadApp(seed(3), { field_plan_current_field: "f1", field_plan_prefs: prefs });
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`document.querySelector('.strip-bed[data-bed="bed2"]')?.classList.contains("is-selected")`, "前に開いていた bed2 を開く");

  // 再読み込み（URL は #schedule/block/b1）でも、畝に戻す
  await page.run(`location.reload()`);
  await page.waitFor(`document.querySelector('.strip-bed[data-bed="bed2"]')?.classList.contains("is-selected")`, "再読み込みでも bed2 を開く");
  assert.equal(await page.run(`location.hash`), "#schedule/block/b1");
  assert.deepEqual(page.errors, []);
});

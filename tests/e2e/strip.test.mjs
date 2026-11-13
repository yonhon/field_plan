// 区画と畝の図の主な操作を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 保存は ?local=1&strict=1 なので、保存の順序を誤ると、DB と同じように失敗する
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];

const bed = (seq) => ({
  id: `bed${seq}`,
  plan_id: "p1",
  block_id: "b1",
  seq,
  shape: [[seq * 3, 2], [seq * 3 + 1, 2], [seq * 3 + 1, 18], [seq * 3, 18]],
  start_date: null,
  removed_on: null,
});

// 圃場 1 つ、区画 1 つ、畝 count 本
const seed = (count) => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: Array.from({ length: count }, (_, index) => bed(index + 1)),
  plantings: [],
  works: [],
  crops: [{ id: "c1", name: "試験菜", mulch: false, bed_width_cm: 100, aisle_width_cm: 60 }],
});

const CONFIRM = 'dialog.notice [data-action="delete"]';
const CANCEL = 'dialog.notice [data-action="cancel"]';
const openDialog = 'document.querySelector("dialog[open]")';

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

const shownBeds = () => page.run(`[...document.querySelectorAll("#strip .strip-bed")].map((box) => box.dataset.bed).join()`);
const labels = () => page.run(`[...document.querySelectorAll("#strip .strip-bed-label")].map((label) => label.textContent).join("/")`);
const waitBeds = (ids) => page.waitFor(`[...document.querySelectorAll("#strip .strip-bed")].map((box) => box.dataset.bed).join() === ${JSON.stringify(ids)}`, `図の畝が ${ids} になる`);
// 閉じた窓は、少し遅れて取り除かれる。残っているあいだに次の窓を開くと、古いボタンを押してしまう
const waitNoDialog = () => page.waitFor(`!document.querySelector("dialog.notice")`, "窓が閉じる");

async function openStrip(count) {
  await page.loadApp(seed(count));
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === ${count}`, `図に畝が ${count} 本出る`);
}

async function chooseBed(id) {
  await page.click(`.strip-bed[data-bed="${id}"]`);
  await page.waitFor(`document.querySelector('.strip-bed[data-bed="${id}"]').classList.contains("is-selected")`, `${id} を選ぶ`);
}

async function chooseCrop(selector) {
  await page.setValue(selector, "c1");
}

beforeEach(() => {
  page?.errors.splice(0);
});

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
  await page.click(CONFIRM);
  await waitBeds("bed2");
  const logsSaved = `JSON.parse(localStorage.getItem("field_plan_local")).workLogs`;
  await page.waitFor(`${logsSaved}.length === 1 && ${logsSaved}[0].targets.length === 1`, "記録から畝 1 が外れる");
  const [left] = (await page.saved()).workLogs;
  assert.equal(left.id, "both");
  assert.deepEqual(left.targets.map((item) => item.bed_id), ["bed2"]);

  await page.waitFor(`!document.getElementById("undoBtn").disabled`, "元に戻すが使える");
  await page.click("#undoBtn");
  await page.waitFor(`${logsSaved}.length === 2`, "消えた記録が戻る");
  const saved = await page.saved();
  assert.equal(saved.beds.length, 2);
  assert.deepEqual(saved.workLogs.find((item) => item.id === "both").targets.map((item) => item.bed_id).sort(), ["bed1", "bed2"]);
  assert.deepEqual(saved.workLogs.find((item) => item.id === "only1").targets.map((item) => item.bed_id), ["bed1"]);
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

// 保存を失敗させる。when は、書き込む内容を受け取って失敗させるかを返す式。元に戻すときは restoreSaves
const failSaves = (when) =>
  page.run(`(() => {
    const setItem = Storage.prototype.setItem;
    window.restoreSaves = () => (Storage.prototype.setItem = setItem);
    Storage.prototype.setItem = function (key, value) {
      if (key === "field_plan_local" && ((data) => ${when})(JSON.parse(value))) {
        throw new Error("保存の失敗");
      }
      return setItem.call(this, key, value);
    };
  })()`);

const status = () => page.run(`document.getElementById("saveStatus").textContent`);
const savedWidth = async () => {
  const [a, b] = (await page.saved()).beds.find((item) => item.id === "bed1").shape;
  return Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 100);
};

// 畝 1 の幅を 150 cm にする（すぐには送らない自動保存）
async function widenBed() {
  await page.run(`window.prompt = () => "150"`);
  await page.click('[data-dim="width:0"]');
  await page.waitFor(`document.querySelector('[data-dim="width:0"]').textContent === "150cm"`, "畝幅が変わる");
}

const leaving = () => page.run(`(() => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
})()`);

test("畝の保存に失敗したとき: 窓で知らせる", options, async () => {
  await openStrip(2);
  await failSaves("data.beds.length === 3");
  await page.click("#stripAddBtn");
  await page.waitFor(`${openDialog}?.textContent.includes("保存の失敗")`, "失敗の窓");
  assert.match(await status(), /保存に失敗しました/);
});

test("自動保存に失敗したとき: 窓で知らせ、次の保存で送り直し、保存するまで「保存しました」と出さない", options, async () => {
  await openStrip(2);
  await failSaves("true");
  await widenBed();
  await page.waitFor(`${openDialog}?.textContent.includes("保存の失敗")`, "失敗の窓");
  await page.click('dialog.notice [data-action="close"]');
  await page.waitFor(`!${openDialog}`, "窓が閉じる");
  await page.run(`window.restoreSaves()`);
  assert.equal(await savedWidth(), 100);

  await page.click("#stripAddBtn");
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === 3`, "図に 3 本");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).beds.length === 3`, "足した畝の保存");
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "保存の完了");
  assert.equal(await savedWidth(), 150, "「保存しました」と出たら、送り残しは保存されている");
});

test("自動保存に失敗したあと: 回線が戻ると、次の操作を待たずに送り直す。送り直しは窓で知らせない", options, async () => {
  await openStrip(2);
  await failSaves("true");
  await widenBed();
  await page.waitFor(`${openDialog}?.textContent.includes("保存の失敗")`, "失敗の窓");
  await page.click('dialog.notice [data-action="close"]');
  await page.waitFor(`!${openDialog}`, "窓が閉じる");
  // 回線はまだ戻っていない。送り直しても失敗するが、窓は出さない
  await page.run(`window.dispatchEvent(new Event("online"))`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await page.run(`Boolean(${openDialog})`), false, "送り直しの失敗は、窓で知らせない");
  assert.match(await status(), /保存に失敗しました/);
  assert.equal(await savedWidth(), 100);
  // 回線が戻る
  await page.run(`window.restoreSaves(); window.dispatchEvent(new Event("online"))`);
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "送り直しの完了");
  assert.equal(await savedWidth(), 150);
});

test("閉じる前: 保存が終わっていなければ確かめ、終わっていれば確かめない", options, async () => {
  await openStrip(1);
  assert.equal(await leaving(), false);
  await widenBed();
  assert.equal(await leaving(), true);
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "保存の完了");
  assert.equal(await savedWidth(), 150, "確かめるときに、送り残しを送る");
  assert.equal(await leaving(), false);
});

test("区域を作ってすぐ区画にする: 区域の保存を待たずに操作しても、両方保存される", options, async () => {
  await page.loadApp({ ...seed(0), zones: [], blocks: [] });
  await page.click("#mapEditBtn");
  await page.setValue("#sizeAlong", "10");
  await page.setValue("#sizeDepth", "5");
  await page.run(`document.querySelector('.mode-btn[data-mode="size"]').click()`);
  await page.click("#map");
  await page.run(`document.querySelector('.mode-btn[data-mode="block"]').click()`);
  await page.click("#map");
  await page.click("#mapEditSave");
  await page.waitFor(`document.getElementById("mapEditStatus").textContent === "保存しました"`, "図の編集の保存");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).blocks.length === 1`, "区画の保存");
  assert.equal((await page.saved()).zones.length, 1);
  assert.equal(await page.run(`Boolean(${openDialog})`), false);
  assert.deepEqual(page.errors, []);
});

test("実績の日付を動かす: 元に戻すと日付が戻り、やり直すとまた動く", options, async () => {
  // 工程表の表示期間に入る日にする
  const DAY = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const data = seed(2);
  data.plantings = [{ id: "pl1", plan_id: "p1", bed_id: "bed1", seq: 1, crop_id: "c1", crop_name: "試験菜", note: "" }];
  data.works = [{ id: "w1", plan_id: "p1", block_id: null, planting_id: "pl1", work_type: "plant", seq: 1, plan_start: DAY, plan_end: DAY, detail: {}, note: "" }];
  data.fields[0].active_plan_id = "p1";
  data.workLogs = [{
    id: "log1", field_id: "f1", date: DAY, end_date: null, work_type: "plant", finishes: true, spec: {}, note: "", created_at: AT, inputs: [],
    targets: [{ id: "t1", log_id: "log1", planting_id: "pl1", bed_id: "bed1", block_id: null, work_id: "w1", label: "", crop_name: "試験菜", area_m2: null, spray_l: null }],
  }];
  await page.loadApp(data);
  await page.click('.tab-btn[data-view="schedule"]');
  await page.click('#ganttModes [data-gantt-mode="act"]');
  await page.waitFor(`document.querySelector("#gantt .gantt-actual-bar")`, "実績の帯");

  await page.drag("#gantt .gantt-actual-bar", 60);
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).workLogs[0].date !== "${DAY}"`, "実績の移動");
  const moved = (await page.saved()).workLogs[0].date;
  await page.waitFor(`!document.getElementById("undoBtn").disabled`, "元に戻すが使える");

  await page.click("#undoBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).workLogs[0].date === "${DAY}"`, "実績の日付が戻る");
  assert.equal((await page.saved()).works.length, 1, "計画の行は変わらない");

  await page.waitFor(`!document.getElementById("redoBtn").disabled`, "やり直すが使える");
  await page.click("#redoBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).workLogs[0].date === ${JSON.stringify(moved)}`, "やり直し");
  assert.deepEqual(page.errors, []);
});

// 図の中の並び（あとのものほど上に見える）で、id が左から順に並んでいるか
const drawnInOrder = (...ids) => page.run(`(() => {
  const order = [...document.querySelectorAll("#map polygon[data-shape]")].map((shape) => shape.dataset.shape);
  const places = ${JSON.stringify(ids)}.map((id) => order.indexOf(id));
  return places.every((place, i) => place >= 0 && (i === 0 || place > places[i - 1]));
})()`);
const isSelected = (id) => `document.querySelector('#map polygon[data-shape="${id}"]').classList.contains("is-selected")`;

// 区域 z1 に区画 b1 と畝 bed1、区域 z2 は中身なしで、全体が重なっている
async function openGroups() {
  const data = seed(1);
  data.zones.push({ ...data.zones[0], id: "z2", shape: [[2, 2], [38, 2], [38, 18], [2, 18]] });
  await page.loadApp(data);
  await page.click("#mapEditBtn");
}

const shapeX = async (table, id) => (await page.saved())[table].find((row) => row.id === id).shape[0][0];

test("圃場図: 中身のない区域を選ぶと最上段に見え、ドラッグで動き、押しても選んだまま", options, async () => {
  await openGroups();
  const zone = await shapeX("zones", "z2");
  const block = await shapeX("blocks", "b1");
  await page.click('#shapeTree [data-shape="z2"]');
  await page.waitFor(isSelected("z2"), "区域を選ぶ");
  assert.equal(await drawnInOrder("z1", "b1", "bed1", "z2"), true);

  await page.click("#map");
  await page.waitFor(`document.getElementById("deleteShapeBtn").textContent === "区域を削除"`, "選択の表示");
  assert.equal(await page.run(isSelected("z2")), true, "押しても区域を選んだまま");

  await page.drag("#map", 60);
  await page.click("#mapEditSave");
  await page.waitFor(`document.getElementById("mapEditStatus").textContent === "保存しました"`, "図の編集の保存");
  assert.notEqual(await shapeX("zones", "z2"), zone);
  assert.equal(await shapeX("blocks", "b1"), block, "ほかの区域の区画は動かない");
  assert.deepEqual(page.errors, []);
});

test("圃場図: 区域を選ぶと、区域、区画、畝の順で最上段に見え、区画の上からも区域を動かせる", options, async () => {
  await openGroups();
  const zone = await shapeX("zones", "z1");
  const block = await shapeX("blocks", "b1");
  await page.click('#shapeTree [data-shape="z1"]');
  await page.waitFor(isSelected("z1"), "区域を選ぶ");
  assert.equal(await drawnInOrder("z2", "z1", "b1", "bed1"), true);

  await page.drag("#map", 60);
  await page.click("#mapEditSave");
  await page.waitFor(`document.getElementById("mapEditStatus").textContent === "保存しました"`, "図の編集の保存");
  assert.notEqual(await shapeX("zones", "z1"), zone, "区域が動く");
  assert.notEqual(await shapeX("blocks", "b1"), block, "中の区画も一緒に動く");

  await page.click("#map");
  await page.waitFor(isSelected("b1"), "押すと、上に見える区画を選ぶ");
  assert.equal(await drawnInOrder("z2", "z1", "b1", "bed1"), true, "区画を選んでも、区画と畝は最上段のまま");
  assert.deepEqual(page.errors, []);
});

test("作付を保存できないとき: 窓で知らせ、ほかの保存が終わっても消えない", options, async () => {
  await openStrip(1);
  await page.run(`(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "field_plan_local" && JSON.parse(value).plantings.length) {
        throw new Error("作付の保存の失敗");
      }
      return setItem.call(this, key, value);
    };
  })()`);
  await chooseCrop("#stripCrop");
  await page.click("#stripAddBtn");
  await page.waitFor(`${openDialog}?.textContent.includes("作付の保存の失敗")`, "失敗の窓");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).beds.length === 2`, "畝の保存");
  assert.match(await page.run(`document.getElementById("saveStatus").textContent`), /保存に失敗しました/);
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

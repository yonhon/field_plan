// 図の編集と、元に戻す・やり直すを、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
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

const { status, waitNoDialog, openStrip, chooseBed, widenBed, savedWidth } = stripTools(() => page);


// 図の編集の書きかけは、ヘッダーの元に戻す・やり直すで、画面の中だけで行き来する（DB には送らない）
test("図の編集: 書きかけを元に戻す・やり直すで 1 操作ずつ行き来し、保存した操作は DB の記録で戻す。区域を消すときは確かめる", options, async () => {
  await page.loadApp({ ...seed(0), zones: [], blocks: [] });
  await page.click("#mapEditBtn");
  await page.setValue("#sizeAlong", "10");
  await page.setValue("#sizeDepth", "5");
  await page.run(`document.querySelector('.mode-btn[data-mode="size"]').click()`);
  await page.click("#map");
  await page.waitFor(`document.querySelectorAll('#map [data-shape]:not([data-shape^="outline"])').length === 1`, "区域を置く");
  await page.waitFor(`!document.getElementById("undoBtn").disabled`, "書きかけを元に戻せる");

  await page.click("#undoBtn");
  await page.waitFor(`document.querySelectorAll('#map [data-shape]:not([data-shape^="outline"])').length === 0`, "書きかけが消える");
  assert.equal(await page.run(`document.getElementById("mapEditSave").disabled`), true, "保存するものがない");
  await page.click("#redoBtn");
  await page.waitFor(`document.querySelectorAll('#map [data-shape]:not([data-shape^="outline"])').length === 1`, "やり直すと、また出る");
  assert.equal((await page.saved()).zones.length, 0, "書きかけは DB に送らない");

  await page.click("#mapEditSave");
  await page.waitFor(`document.getElementById("mapEditStatus").textContent === "保存しました"`, "図の編集の保存");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).zones.length === 1`, "区域の保存");
  // 保存した操作は、DB の記録で戻す。区域が消えるので、先に確かめる
  await page.click("#undoBtn");
  await page.waitFor(`document.querySelector("dialog.notice")?.textContent.includes("区域 1 件")`, "消える区域を知らせる");
  await page.click(CANCEL);
  await waitNoDialog();
  assert.equal((await page.saved()).zones.length, 1, "やめたら消えない");
  await page.click("#undoBtn");
  await page.click(CONFIRM);
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).zones.length === 0`, "DB の区域が消える");
  await page.waitFor(`document.querySelectorAll('#map [data-shape]:not([data-shape^="outline"])').length === 0`, "画面の区域も消える");
  await page.click("#redoBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).zones.length === 1`, "やり直すと戻る");
  await page.waitFor(`document.querySelectorAll('#map [data-shape]:not([data-shape^="outline"])').length === 1`, "画面にも戻る");
  assert.deepEqual(page.errors, []);
});

// あとの操作を元に戻した記録で、前の操作が「ほかの端末で変わった」とされない（2026-11-17 に実機で見つかった）
test("同じ畝の幅を 2 回変え、元に戻すを 2 回押すと、どちらも戻る", options, async () => {
  await openStrip(1);
  await widenBed();
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "1 回目の保存");
  await page.run(`window.prompt = () => "200"`);
  await page.click('[data-dim="width:0"]');
  await page.waitFor(`document.querySelector('[data-dim="width:0"]').textContent === "200cm"`, "2 回目の幅");
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "2 回目の保存");
  await page.click("#undoBtn");
  await page.waitFor(`document.querySelector('[data-dim="width:0"]').textContent === "150cm"`, "1 回目の元に戻す");
  await page.waitFor(`!document.getElementById("undoBtn").disabled`, "もう 1 回戻せる");
  await page.click("#undoBtn");
  await page.waitFor(`document.querySelector('[data-dim="width:0"]').textContent === "100cm"`, "2 回目の元に戻す");
  assert.equal(await savedWidth(), 100);
  assert.doesNotMatch(await status(), /戻せません/);
  assert.deepEqual(page.errors, []);
});

// 元に戻す・やり直すは、その操作をした画面に移り、戻した行を選んで、少しのあいだ光らせる
test("元に戻す: 別の画面から押すと、操作をした日程の画面に移り、戻した畝を選んで光らせる", options, async () => {
  await openStrip(2);
  await widenBed();
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "保存");
  // 畝 2 を選んでから、圃場図へ移る
  await chooseBed("bed2");
  await page.click('.tab-btn[data-view="map"]');
  await page.waitFor(`!document.getElementById("appView").hidden`, "圃場図");
  await page.click("#undoBtn");
  await page.waitFor(`!document.getElementById("scheduleView").hidden`, "日程の画面に移る");
  await page.waitFor(`document.querySelector('[data-dim="width:0"]')?.textContent === "100cm"`, "畝幅が戻る");
  await page.waitFor(`document.querySelector('.strip-bed[data-bed="bed1"]').classList.contains("is-selected")`, "戻した畝を選ぶ");
  assert.equal(await page.run(`document.querySelector('.strip-bed[data-bed="bed1"]').classList.contains("undo-flash")`), true, "戻した畝を光らせる");
  // 光らせるのは 1.6 秒。時間は app/clock.js で進める
  await page.advance(1600);
  assert.equal(await page.run(`document.querySelector('.strip-bed[data-bed="bed1"]').classList.contains("undo-flash")`), false, "少しあとに消える");
  assert.equal(await savedWidth(), 100);
  assert.deepEqual(page.errors, []);
});

test("やり直す: 別の画面から押すと、操作をした圃場図に移り、区画を選んで光らせる", options, async () => {
  await openStrip(1);
  await page.click('.tab-btn[data-view="map"]');
  await page.click('#shapeTree [data-shape="b1"]');
  await page.waitFor(`document.getElementById("blockName").offsetParent !== null`, "区画の名前の欄");
  await page.run(`(() => { const input = document.getElementById("blockName"); input.value = "北"; input.dispatchEvent(new Event("input", { bubbles: true })); input.blur(); })()`);
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).blocks[0].name === "北"`, "名前の保存");
  await page.click("#undoBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).blocks[0].name === "A"`, "元に戻す");
  // 選びをはずして、日程の画面へ移ってから、やり直す
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`!document.getElementById("scheduleView").hidden`, "日程の画面");
  await page.click("#redoBtn");
  await page.waitFor(`!document.getElementById("appView").hidden`, "圃場図に移る");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).blocks[0].name === "北"`, "やり直す");
  await page.waitFor(`document.querySelector('#map [data-shape="b1"]').classList.contains("is-selected")`, "区画を選ぶ");
  assert.equal(await page.run(`[...document.querySelectorAll('[data-shape="b1"]')].some((element) => element.classList.contains("undo-flash"))`), true, "区画を光らせる");
  assert.deepEqual(page.errors, []);
});

test("畝の幅を変えたあと、ほかの端末で同じ畝が変わったら、元に戻さずに知らせる", options, async () => {
  await openStrip(1);
  await widenBed();
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "保存の完了");
  await page.waitFor(`!document.getElementById("undoBtn").disabled`, "元に戻すが使える");
  // ほかの端末が、同じ畝を変える（変更の記録も残る）
  await page.run(`(() => {
    const data = JSON.parse(localStorage.getItem("field_plan_local"));
    const bed = data.beds[0];
    data.audit.push({ seq: data.audit.at(-1).seq + 1, op: crypto.randomUUID(), table: "beds", id: bed.id, before: structuredClone(bed) });
    bed.seq = 9;
    localStorage.setItem("field_plan_local", JSON.stringify(data));
  })()`);
  const before = JSON.stringify((await page.saved()).beds);
  await page.click("#undoBtn");
  await page.waitFor(`/元に戻せませんでした: ほかの画面や端末で/.test(document.getElementById("saveStatus").textContent)`, "戻せないと知らせる");
  assert.equal(JSON.stringify((await page.saved()).beds), before, "DB は変わらない");
  assert.equal(await page.run(`document.querySelector('[data-dim="width:0"]').textContent`), "150cm", "画面も変わらない");
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
  // 実績だけの操作は、写しではなく、変更の記録で戻す（記録は、動かしたときと戻したときの 2 件。別の操作の ID）
  const audit = (await page.saved()).audit;
  assert.equal(audit.length, 2);
  assert.notEqual(audit[1].op, audit[0].op);

  await page.waitFor(`!document.getElementById("redoBtn").disabled`, "やり直すが使える");
  await page.click("#redoBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).workLogs[0].date === ${JSON.stringify(moved)}`, "やり直し");
  assert.equal((await page.saved()).audit.length, 3, "やり直しも、変更の記録で戻す");
  assert.deepEqual(page.errors, []);
});

test("実績の日付を動かしたあと、ほかの端末で同じ実績が変わったら、元に戻さずに知らせる", options, async () => {
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
  await page.waitFor(`!document.getElementById("undoBtn").disabled`, "元に戻すが使える");
  // ほかの端末が、同じ実績のメモを変える（変更の記録も残る）
  await page.run(`(() => {
    const data = JSON.parse(localStorage.getItem("field_plan_local"));
    const log = data.workLogs[0];
    data.audit.push({ seq: data.audit.at(-1).seq + 1, op: crypto.randomUUID(), table: "workLogs", id: log.id, before: structuredClone(log) });
    log.note = "ほかの端末のメモ";
    localStorage.setItem("field_plan_local", JSON.stringify(data));
  })()`);
  const before = JSON.stringify((await page.saved()).workLogs);
  await page.click("#undoBtn");
  await page.waitFor(`/元に戻せませんでした: ほかの画面や端末で/.test(document.getElementById("saveStatus").textContent)`, "戻せないと知らせる");
  assert.equal(JSON.stringify((await page.saved()).workLogs), before, "実績は変わらない");
  assert.equal(await page.run(`document.getElementById("undoBtn").disabled`), true, "戻せない 1 回ぶんは、履歴から外す");
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

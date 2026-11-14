// 圃場図の、作図の道具が出ていない幅（スマホ、タブレット）での操作と、新しい版へ読み込み直すときの保存を、Chrome で通して確かめる。
// 実行: node --test "tests/e2e/*.test.mjs"
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const BLOCK = [[1, 1], [39, 1], [39, 19], [1, 19]];
const BED = [[3, 2], [4, 2], [4, 18], [3, 18]];
// 区画の中で、畝のない所
const INSIDE = [30, 10];

const seed = () => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: BLOCK, start_date: null, end_date: null, created_at: AT }],
  beds: [{ id: "bed1", plan_id: "p1", block_id: "b1", seq: 1, shape: BED, start_date: null, removed_on: null }],
  plantings: [],
  works: [],
  crops: [],
});

const options = { skip: findChrome() ? false : "Chrome が見つかりません" };
let page;

before(async () => {
  if (!options.skip) {
    page = await openBrowser();
  }
});

afterEach(async () => {
  await page?.viewport();
});

after(async () => {
  await page?.close();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const savedX = async () => {
  const data = await page.saved();
  return { block: data.blocks.find((item) => item.id === "b1").shape[0][0], bed: data.beds.find((item) => item.id === "bed1").shape[0][0] };
};

async function openMap() {
  await page.loadApp(seed());
  await page.click('.tab-btn[data-view="map"]');
  await page.waitFor(`Boolean(document.querySelector('#map [data-shape="b1"]'))`, "圃場図に区画が出る");
}

// 区画を選んでから、区画の中をなぞる
async function selectAndDrag() {
  await page.clickMap(INSIDE);
  await page.waitFor(`document.querySelector('#map [data-shape="b1"]').classList.contains("is-selected")`, "区画を選ぶ");
  await page.dragMap(INSIDE, 80);
}

test("作図の道具が出ていない幅では、選んだ区画をなぞっても、区画は動かない", options, async () => {
  await page.viewport(390);
  await openMap();
  assert.equal(await page.run(`getComputedStyle(document.getElementById("mapEditBtn")).display`), "none", "スマホの幅では「図を編集」を出さない");
  const view = await page.run(`document.getElementById("map").getAttribute("viewBox")`);
  await selectAndDrag();
  // 保存は少し遅れて送るので、送るはずの時間を待ってから見る
  await sleep(900);
  assert.deepEqual(await savedX(), { block: BLOCK[0][0], bed: BED[0][0] });
  // 図は動く
  assert.notEqual(await page.run(`document.getElementById("map").getAttribute("viewBox")`), view);
});

test("PC の幅でも、「図を編集」を押す前は、選んだ区画をなぞっても動かない。角の丸も出さない", options, async () => {
  await openMap();
  await page.clickMap(INSIDE);
  await page.waitFor(`document.querySelector('#map [data-shape="b1"]').classList.contains("is-selected")`, "ふだんの図でも区画を選べる");
  assert.equal(await page.run(`document.querySelectorAll("#map .handle").length`), 0);
  await page.dragMap(INSIDE, 80);
  await sleep(900);
  assert.deepEqual(await savedX(), { block: BLOCK[0][0], bed: BED[0][0] });
});

test("「図を編集」を押すと、選んだ区画をなぞると、区画と畝が動く。「保存する」で保存し、「閉じる」で帯が消える", options, async () => {
  await openMap();
  await page.click("#mapEditBtn");
  assert.equal(await page.run(`document.getElementById("mapBand").hidden`), false);
  assert.equal(await page.run(`document.querySelector('#mapBand .mode-btn[data-mode="select"]').classList.contains("is-active")`), true, "初めは選択・移動");
  await selectAndDrag();
  await page.waitFor(`document.getElementById("mapEditSave").disabled === false`, "書きかけ");
  await sleep(900);
  assert.deepEqual(await savedX(), { block: BLOCK[0][0], bed: BED[0][0] }, "保存するまでは DB は変わらない");
  assert.equal(await page.run(`JSON.parse(localStorage.getItem("field_plan_local")).changes?.length || 0`), 0, "変更の記録も、保存するまで残さない");
  await page.click("#mapEditSave");
  await page.waitFor(`(() => { const data = JSON.parse(localStorage.getItem("field_plan_local")); return data.beds[0].shape[0][0] !== ${BED[0][0]}; })()`, "畝が動いて保存される");
  const moved = await savedX();
  assert.notEqual(moved.block, BLOCK[0][0]);
  assert.ok(Math.abs(moved.block - BLOCK[0][0] - (moved.bed - BED[0][0])) < 1e-9, "区画と畝が同じだけ動く");
  await page.waitFor(`(JSON.parse(localStorage.getItem("field_plan_local")).changes || []).length > 0`, "変更の記録");
  // 保存したあとは、確かめずに閉じる
  await page.click("#mapEditDone");
  assert.equal(await page.run(`document.getElementById("mapBand").hidden`), true);
  assert.equal(await page.run(`document.getElementById("mapEditBtn").hidden`), false);
});

test("図の編集: 保存しないで閉じると、捨ててよいかを確かめ、編集を始める前に戻す。DB は変わらない", options, async () => {
  await openMap();
  await page.click("#mapEditBtn");
  await selectAndDrag();
  await page.waitFor(`document.getElementById("mapEditSave").disabled === false`, "書きかけ");
  const moved = await page.run(`document.querySelector('#map [data-shape="b1"]').getAttribute("points")`);
  // 「編集を続ける」なら、そのまま
  await page.click("#mapEditDone");
  await page.click('dialog.notice [data-action="cancel"]');
  assert.equal(await page.run(`document.getElementById("mapBand").hidden`), false);
  await page.click("#mapEditDone");
  assert.equal(await page.run(`document.querySelector('dialog.notice [data-action="delete"]').textContent`), "捨てて閉じる");
  await page.click('dialog.notice [data-action="delete"]');
  await page.waitFor(`document.getElementById("mapBand").hidden`, "帯を閉じる");
  assert.notEqual(await page.run(`document.querySelector('#map [data-shape="b1"]').getAttribute("points")`), moved, "区画が元の位置に戻る");
  await sleep(900);
  assert.deepEqual(await savedX(), { block: BLOCK[0][0], bed: BED[0][0] });
  assert.deepEqual(page.errors, []);
});

test("区域のメニュー: 種類と描き方を選ぶと、メニューが閉じて、その道具になる", options, async () => {
  await openMap();
  await page.click("#mapEditBtn");
  await page.click('[data-map-menu="zone"]');
  assert.equal(await page.run(`document.getElementById("zoneMenu").hidden`), false);
  await page.click('#zoneMenu input[value="path"]');
  await page.click('#zoneMenu .mode-btn[data-mode="rect"]');
  assert.equal(await page.run(`document.getElementById("zoneMenu").hidden`), true);
  assert.equal(await page.run(`document.querySelector('[data-map-menu="zone"]').classList.contains("is-active")`), true, "区域のボタンを選んだ色にする");
  assert.deepEqual(page.errors, []);
});

test("「読み込み直す」は、送り残しの保存を送り終えてから読み込み直す", options, async () => {
  await openMap();
  await page.click("#mapEditBtn");
  await selectAndDrag();
  await page.waitFor(`document.getElementById("mapEditSave").disabled === false`, "書きかけ");
  await page.click("#mapEditSave");
  // 保存を送り終える前に、新しい版のお知らせの「読み込み直す」を押す
  await page.run(`window.beforeReload = true; document.getElementById("updateToast").hidden = false`);
  await page.click("#updateBtn");
  await page.waitFor(`!window.beforeReload && document.getElementById("viewTabs")?.hidden === false`, "読み込み直す");
  const moved = await savedX();
  assert.notEqual(moved.block, BLOCK[0][0]);
  assert.ok(Math.abs(moved.block - BLOCK[0][0] - (moved.bed - BED[0][0])) < 1e-9, "区画と畝が同じだけ動いて保存される");
});

// ---- ふだんの図の、ホイールとタッチ（ページのスクロールに渡す） ----

const viewWidth = () => page.run(`Number(document.getElementById("map").getAttribute("viewBox").split(" ")[2])`);
const viewBox = () => page.run(`document.getElementById("map").getAttribute("viewBox")`);
const mapCenter = () => page.run(`(() => { const box = document.getElementById("map").getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);

async function wheel(modifiers = 0) {
  const { x, y } = await mapCenter();
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: 120, modifiers });
  await sleep(150);
}

// 指を置き、steps 回に分けて動かして離す。fingers は指ごとの [始めの位置からのずれ, 動かす量]（[[dx, dy], [mx, my]]）
async function touch(fingers) {
  const { x, y } = await mapCenter();
  const at = (t) => fingers.map(([[dx, dy], [mx, my]], id) => ({ x: x + dx + mx * t, y: y + dy + my * t, id }));
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
  for (let step = 1; step <= 6; step += 1) {
    await page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(step / 6) });
  }
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(150);
}

test("ふだんの図: ホイールだけでは拡大・縮小せず、説明を出す。Ctrl + ホイールと ＋・− では拡大・縮小する", options, async () => {
  await page.viewport(1280, 600); // ページがスクロールできる高さ
  await openMap();
  // PC の幅では、左の欄（.map-area）がスクロールする
  const scrollTop = () => page.run(`scrollY + document.querySelector(".map-area").scrollTop`);
  const width = await viewWidth();
  const scrolled = await scrollTop();
  await wheel();
  assert.equal(await viewWidth(), width, "ホイールだけでは変わらない");
  assert.ok((await scrollTop()) > scrolled, "図の外と同じく、欄がスクロールする");
  assert.equal(await page.run(`document.getElementById("mapHint").hidden`), false, "説明が出る");
  assert.match(await page.run(`document.getElementById("mapHint").textContent`), /Ctrl \+ ホイール/);

  await wheel(2); // Ctrl
  assert.ok((await viewWidth()) > width, "Ctrl + ホイール（下へ）で縮小");

  const before = await viewWidth();
  await page.click("#zoomInBtn");
  assert.ok((await viewWidth()) < before, "＋ で拡大");
  await page.click("#zoomOutBtn");
  assert.ok(Math.abs((await viewWidth()) - before) < 1e-6, "− で戻る");
  assert.deepEqual(page.errors, []);
});

test("図の編集中は、これまでどおりホイールだけで拡大・縮小する", options, async () => {
  await openMap();
  await page.click("#mapEditBtn");
  const width = await viewWidth();
  await wheel();
  assert.ok((await viewWidth()) > width);
  assert.equal(await page.run(`document.getElementById("mapHint").hidden`), true, "説明は出さない");
  assert.deepEqual(page.errors, []);
});

test("ふだんの図: 指 1 本では図を動かさず、指 2 本で動かし、広げると拡大する。畝のタップは今までどおり", options, async () => {
  await page.viewport(390);
  await openMap();
  assert.equal(await page.run(`document.getElementById("map").classList.contains("is-cooperative")`), true);
  // 区画を指でタップすると選ぶ
  const point = await page.run(`(() => { document.querySelector(".map-frame").scrollIntoView({ block: "nearest" }); const p = new DOMPoint(${INSIDE[0]}, ${-INSIDE[1]}).matrixTransform(document.getElementById("map").getScreenCTM()); return { x: p.x, y: p.y }; })()`);
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 0 }] });
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitFor(`document.querySelector('#map [data-shape="b1"]').classList.contains("is-selected")`, "タップで区画を選ぶ");
  const box = await viewBox();
  const scrolled = await page.run("scrollY");
  await touch([[[0, 0], [0, -120]]]);
  assert.equal(await viewBox(), box, "指 1 本では動かない");
  assert.ok((await page.run("scrollY")) > scrolled, "指 1 本でページがスクロールする");

  await touch([[[-40, 0], [60, 0]], [[40, 0], [60, 0]]]);
  assert.notEqual(await viewBox(), box, "指 2 本で動く");
  const width = await viewWidth();
  await touch([[[-30, 0], [-40, 0]], [[30, 0], [40, 0]]]);
  assert.ok((await viewWidth()) < width, "2 本の間を広げると拡大");

  assert.deepEqual(page.errors, []);
});

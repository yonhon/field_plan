// 圃場の外形の離れた部分（描き足す、面積、はみ出し、視点、削除）と、圃場図の PDF の紙の分け方を、Chrome で通して確かめる。
// 実行: node --test "tests/e2e/*.test.mjs"
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const zone = (id, shape) => ({ id, plan_id: "p1", kind: "tillable", name: "", shape, created_at: AT });
const seed = (outline, more = {}) => ({
  fields: [{ id: "f1", name: "試験の圃場", outline, note: "", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [],
  blocks: [],
  beds: [],
  plantings: [],
  works: [],
  crops: [],
  fertilizers: [],
  ...more,
});

const CONFIRM = 'dialog.notice [data-action="delete"]';
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

const text = (id) => page.run(`document.getElementById(${JSON.stringify(id)}).textContent`);
const badge = () => page.run(`document.getElementById("mapBadge").hidden ? "" : document.getElementById("mapBadge").textContent`);
const savedOutline = async () => (await page.saved()).fields[0].outline;

// 図の編集の「保存する」を押して、保存を待つ
async function saveEdit() {
  await page.click("#mapEditSave");
  await page.waitFor(`document.getElementById("mapEditStatus").textContent === "保存しました"`, "図の編集の保存");
}

test("外形: 離れた部分を描き足すと、面積は合計になり、区域はどれかの部分に入っていればよい", options, async () => {
  // 外形は、1 つしか持てなかったころの形（多角形 1 つ）で入れておく
  await page.loadApp(seed(rect(0, 0, 40, 20), { zones: [zone("z1", rect(2, 2, 36, 16)), zone("z2", rect(60, 2, 20, 16))] }));
  assert.equal(await badge(), "⚠1"); // 離れた有効圃場は、外形からはみ出している

  // 離れた場所が図に入るよう、縮める
  await page.run(`(() => {
    const map = document.getElementById("map");
    const box = map.getBoundingClientRect();
    for (let i = 0; i < 5; i += 1) {
      map.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, bubbles: true, cancelable: true }));
    }
  })()`);
  // 外形は、「図を編集」の帯の「外形を描く」で描く
  await page.click("#mapEditBtn");
  await page.click('#mapBand .mode-btn[data-mode="outline"]');
  // 描き直しの確認は出さない（いまの外形は置き換えない）
  assert.equal(await page.run(`Boolean(document.querySelector("dialog.notice[open]"))`), false);
  for (const point of [[58, 0], [82, 0], [82, 20], [58, 20], [58, 0]]) {
    await page.clickMap(point);
  }
  await page.waitFor(`document.querySelector('#shapeTree li[data-shape="outline:1"]')`, "2 つ目の部分の行");
  assert.deepEqual(await savedOutline(), rect(0, 0, 40, 20), "保存するまでは DB は変わらない（入れたときの形のまま）");
  await saveEdit();
  await page.click("#mapEditDone");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).fields[0].outline.length === 2`, "外形の保存");
  await page.click('#shapeTree li[data-shape="outline:1"]');
  const outline = await savedOutline();
  assert.deepEqual(outline[0], rect(0, 0, 40, 20));
  assert.equal(outline[1].length, 4);

  assert.equal(await text("areaField"), "1,280 ㎡（12.8 a）"); // 800 + 480
  // 一覧では、区域は入っている部分の下に、1 段下げて並ぶ
  const tree = await page.run(`[...document.querySelectorAll("#shapeTree > li[data-shape]")].map((li) => li.dataset.shape + ":" + li.className.match(/depth-\\d/)[0])`);
  assert.deepEqual(tree, ["outline:0:depth-0", "z1:depth-1", "outline:1:depth-0", "z2:depth-1"]);
  assert.equal(await badge(), "");
  assert.match(await text("selectionTitle"), /圃場の外形 2/);

  // 視点の辺は、どの部分の辺からでも選べる。2 つ目の部分の東の辺に、視点 2 を立てる
  const choices = await page.run(`[...document.getElementById("viewEdge2").options].map((option) => option.value)`);
  assert.ok(choices.includes("0:0") && choices.includes("1:1"), choices.join());
  await page.setValue("#viewEdge2", "1:1");
  await page.waitFor(`JSON.stringify(JSON.parse(localStorage.getItem("field_plan_local")).fields[0].view_dirs) === "[90,180]"`, "視点の保存");
  assert.equal(await page.run(`document.getElementById("viewEdge2").value`), "1:1");

  // 1 つ目の部分を消すと、残った部分だけになり、その中にない有効圃場がはみ出しになる。消すのは、図の編集のあいだだけ
  await page.click('#shapeTree li[data-shape="outline:0"]');
  assert.equal(await page.run(`getComputedStyle(document.getElementById("deleteShapeBtn")).display`), "none", "ふだんは消すボタンを出さない");
  await page.click("#mapEditBtn");
  await page.click("#deleteShapeBtn");
  await page.click(CONFIRM);
  await saveEdit();
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).fields[0].outline.length === 1`, "部分の削除の保存");
  assert.deepEqual((await savedOutline())[0], outline[1]);
  assert.match(await page.run(`document.querySelector('#shapeTree li[data-shape="outline:0"]').textContent`), /^圃場の外形\d/);
  assert.equal(await badge(), "⚠1");
  assert.deepEqual(page.errors, []);
});

test("外形の角は、図の編集のあいだだけ動かせる。保存しないで閉じると元に戻る", options, async () => {
  await page.loadApp(seed([rect(0, 0, 40, 20)], { zones: [zone("z1", rect(2, 2, 36, 16))] }));
  // ふだんの図では、外形を選んでも角の丸を出さない
  await page.click('#shapeTree li[data-shape="outline:0"]');
  assert.equal(await page.run(`document.querySelectorAll("#map .handle").length`), 0);
  await page.click("#mapEditBtn");
  await page.waitFor(`document.querySelectorAll("#map .handle").length > 0`, "外形の角の丸");
  await page.dragMap([40, 0], 40);
  await page.waitFor(`document.getElementById("mapEditSave").disabled === false`, "書きかけ");
  assert.notEqual(await text("areaField"), "800 ㎡（8.0 a）");
  assert.deepEqual(await savedOutline(), [rect(0, 0, 40, 20)], "保存するまでは DB は変わらない");

  // 外形を描き足して選んだまま、保存しないで閉じる: 描いた外形も、動かした角も元に戻る
  await page.click('#mapBand .mode-btn[data-mode="outline"]');
  for (const point of [[5, 5], [15, 5], [15, 10]]) {
    await page.clickMap(point);
  }
  await page.click("#draftDone");
  await page.waitFor(`document.querySelector('#shapeTree li[data-shape="outline:1"]')`, "描いた外形");
  await page.click("#mapEditDone");
  await page.click(CONFIRM);
  await page.waitFor(`document.getElementById("mapBand").hidden`, "捨てて閉じる");
  assert.equal(await page.run(`document.querySelectorAll('#shapeTree li[data-shape^="outline:"]').length`), 1);
  assert.equal(await text("areaField"), "800 ㎡（8.0 a）");
  assert.deepEqual(await savedOutline(), [rect(0, 0, 40, 20)]);
  // 圃場の設定の窓には、外形のタブはない
  assert.equal(await page.run(`Boolean(document.querySelector('[data-fstab="outline"]'))`), false);
  assert.deepEqual(page.errors, []);
});

test("図の編集中は、実績の入力など DB を変える操作を止めて知らせる。編集を閉じれば止めない", options, async () => {
  const data = seed([rect(0, 0, 40, 20)], { zones: [zone("z1", rect(2, 2, 36, 16))] });
  data.fields[0].active_plan_id = "p1";
  await page.loadApp(data);
  await page.click("#mapEditBtn");
  await page.run(`document.getElementById("logAddBtn").hidden = false`);
  await page.click("#logAddBtn");
  await page.waitFor(`document.querySelector("dialog.notice[open]")?.textContent.includes("図の編集中です")`, "知らせ");
  assert.equal(await page.run(`Boolean(document.querySelector("dialog.log-dialog[open]"))`), false, "実績の窓は開かない");
  await page.run(`document.querySelector("dialog.notice[open] button").click()`);
  // 編集を閉じれば、止めない
  await page.click("#mapEditDone");
  await page.click("#logAddBtn");
  await page.waitFor(`Boolean(document.querySelector("dialog.log-dialog[open]"))`, "実績の窓");
  assert.deepEqual(page.errors, []);
});

test("PDF: 全体の紙のあとに、外形の部分ごとに 1 枚ずつ。部分は分けない", options, async () => {
  // 部分 2 は 120 m × 60 m に幅 70 cm の畝があるが、1 枚に収める
  const beds = Array.from({ length: 20 }, (_, i) => ({
    id: `bed${i + 1}`,
    plan_id: "p1",
    block_id: "b2",
    seq: i + 1,
    shape: rect(205 + i * 1.5, 5, 0.7, 50),
    start_date: null,
    removed_on: null,
  }));
  await page.loadApp(
    seed([rect(0, 0, 40, 20), rect(200, 0, 120, 60)], {
      zones: [zone("z1", rect(2, 2, 36, 16)), zone("z2", rect(202, 2, 116, 56))],
      blocks: [{ id: "b2", plan_id: "p1", zone_id: "z2", name: "区画1", shape: rect(203, 3, 114, 54), start_date: null, end_date: null, created_at: AT }],
      beds,
    })
  );
  await page.run(`window.print = () => { window.printed = (window.printed || 0) + 1; }`);
  await page.click("#mapPdfBtn");
  await page.waitFor(`window.printed === 1`, "印刷");
  const sheets = await page.run(`[...document.querySelectorAll("#printArea .print-sheet")].map((sheet) => ({
    title: sheet.querySelector(".print-title").textContent,
    viewBox: sheet.querySelector("svg").getAttribute("viewBox"),
    beds: sheet.querySelectorAll('[data-shape^="bed"]').length,
  }))`);
  assert.deepEqual(
    sheets.map((sheet) => sheet.title.split("　").at(-1)),
    ["全体", "外形 1", "外形 2"]
  );
  // 部分の紙の範囲は、その部分がちょうど入る四角形に 3% の余白を足したもの
  assert.deepEqual(sheets[2].viewBox.split(" ").map(Number), [196.4, -63.6, 127.2, 67.2]);
  assert.equal(sheets[2].beds, 20);
  assert.equal(await page.run(`document.querySelectorAll("#printArea .print-tile").length`), 0);
  assert.deepEqual(page.errors, []);
});

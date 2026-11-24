// 区画と畝の図の保存の失敗・送り直し・保存の順序を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 保存は ?local=1&strict=1 なので、保存の順序を誤ると、DB と同じように失敗する
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";
import { openDialog, seed, stripTools } from "./strip-tools.mjs";

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

const { status, openStrip, chooseCrop, widenBed, savedWidth, failSaves } = stripTools(() => page);


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

// 操作の始まりに、前の操作の送り残しを、その時点の中身で送る。送らずにおくと、前の操作の変更が次の操作の ID で送られ、
// 次の操作を戻すと前の操作まで戻る（field.audit_log の op_id）
test("畝を続けて 2 回動かす: 2 回目を押したときに 1 回目の位置を送り、2 回目の途中の位置は送らない", options, async () => {
  await openStrip(1);
  const shapeOf = async () => JSON.stringify((await page.saved()).beds.find((item) => item.id === "bed1").shape);
  const before = await shapeOf();
  await page.drag('.strip-bed[data-bed="bed1"]', 30);
  let first = null;
  let later = null;
  // 保存を待たず（600 ms より前に）、同じ畝をもう一度動かし、押したまま止まる
  await page.drag('.strip-bed[data-bed="bed1"]', 30, async () => {
    await page.waitFor(`JSON.stringify(JSON.parse(localStorage.getItem("field_plan_local")).beds.find((item) => item.id === "bed1").shape) !== ${JSON.stringify(before)}`, "1 回目の位置の保存");
    first = await shapeOf();
    // 自動保存の時間を過ぎても、押しているあいだの位置は送らない
    await new Promise((resolve) => setTimeout(resolve, 900));
    later = await shapeOf();
  });
  assert.equal(later, first, "押しているあいだは、1 回目の位置のまま");
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "2 回目の保存");
  assert.notEqual(await shapeOf(), first, "離したあとに、2 回目の位置を送る");
  assert.deepEqual(page.errors, []);
});

// 失敗の知らせを、出なくなるまで閉じる（図形の保存と変更の記録の保存は、別々に知らせる）
async function closeNotices() {
  for (let quiet = 0; quiet < 3; ) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await page.run(`Boolean(document.querySelector('dialog.notice[open] [data-action="close"]'))`)) {
      await page.click('dialog.notice[open] [data-action="close"]');
      await page.waitFor(`!document.querySelector("dialog.notice[open]")`, "窓が閉じる");
      quiet = 0;
    } else {
      quiet += 1;
    }
  }
}

// 送り直しは、溜まった予約（区域と畝の 2 件）を 1 回で送る。送り直しの途中に、次の操作の保存が割り込んでも、
// 送り直しの書き込みは、はじめにすべて列に入れるので、次の操作の保存より先に届く。
// 1 件ずつ列に入れると、送り直しの古い写し（畝幅 150 cm）が後から届き、画面と DB がずれる
test("送り直しの途中に次の操作の保存が割り込む: 次の操作の中身が DB に残る", options, async () => {
  await openStrip(1);
  await failSaves("true");
  // 区域の名前を変える（区域の予約）
  await page.click('.tab-btn[data-view="map"]');
  await page.click('#shapeTree [data-shape="z1"]');
  await page.waitFor(`document.getElementById("zoneName").offsetParent !== null`, "区域の名前の欄");
  await page.run(`(() => {
    const input = document.getElementById("zoneName");
    input.value = "北";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await page.waitFor(`${openDialog}?.textContent.includes("保存の失敗")`, "失敗の窓");
  await closeNotices();
  // 畝の幅を変える（畝の予約）。失敗のあとなので、操作の始まりでは送らず、予約が溜まる
  await page.click('.tab-btn[data-view="schedule"]');
  await widenBed();
  await page.waitFor(`/保存に失敗しました/.test(document.getElementById("saveStatus").textContent)`, "畝の保存も失敗");
  await closeNotices();
  // 回線が戻ると送り直す（区域を 400 ms かけて送り、次に畝）。その途中で畝幅を 200 cm にし、すぐ次を押して、その保存を先に送らせる
  await page.run(`window.restoreSaves(); window.prompt = () => "200"; window.dispatchEvent(new Event("online"))`);
  await page.click('[data-dim="width:0"]');
  await page.click(".tab-btn[data-view=\"schedule\"]");
  await page.waitFor(`document.querySelector('[data-dim="width:0"]').textContent === "200cm"`, "画面の畝幅");
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "保存の完了");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await savedWidth(), 200, "DB の畝幅も 200 cm");
  assert.equal((await page.saved()).zones.find((zone) => zone.id === "z1").name, "北", "区域の名前は送り直しで保存される");
  assert.deepEqual(page.errors, []);
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

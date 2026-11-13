// DB から読み直す仕組みを、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 画面に戻ってきたときにほかの端末の変更を拾うことと、「元に戻す」が途中で失敗したら DB の内容にそろえること
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const KEY = "field_plan_local";

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

const shownBeds = () => page.run(`[...document.querySelectorAll("#strip .strip-bed")].map((box) => box.dataset.bed).join()`);
const waitBeds = (ids) => page.waitFor(`[...document.querySelectorAll("#strip .strip-bed")].map((box) => box.dataset.bed).join() === ${JSON.stringify(ids)}`, `図の畝が ${ids} になる`);
const status = () => page.run(`document.getElementById("saveStatus").textContent`);
const undoDisabled = () => page.run(`document.getElementById("undoBtn").disabled`);
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

async function openStrip(count) {
  await page.loadApp(seed(count));
  await page.click('.tab-btn[data-view="schedule"]');
  await page.waitFor(`document.querySelectorAll("#strip .strip-bed").length === ${count}`, `図に畝が ${count} 本出る`);
}

// 畝を 1 本、完全に削除する（「元に戻す」の履歴が 1 つできる）
async function deleteBed(id, left) {
  await page.click(`.strip-bed[data-bed="${id}"]`);
  await page.waitFor(`document.querySelector('.strip-bed[data-bed="${id}"]').classList.contains("is-selected")`, `${id} を選ぶ`);
  await page.click("#stripDeleteBtn");
  await page.click(CONFIRM);
  await waitBeds(left);
  await page.waitFor(`!document.querySelector("dialog.notice")`, "窓が閉じる");
  await page.waitFor(`document.getElementById("undoBtn").disabled === false`, "元に戻すの履歴ができる");
}

// ほかの端末が DB を変えたことにする。change は、DB の中身 data を書き換える文
const changeElsewhere = (change) =>
  page.run(`(() => {
    const data = JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}));
    ${change};
    localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(data));
  })()`);

// 画面を隠し、seconds 秒たってから戻ってきたことにする
const awayFor = (seconds) =>
  page.run(`(() => {
    const now = Date.now;
    const show = (value) => {
      Object.defineProperty(document, "visibilityState", { value, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    show("hidden");
    Date.now = () => now() + ${seconds} * 1000;
    show("visible");
    Date.now = now;
    delete document.visibilityState;
  })()`);

test("1 分より長く隠れてから戻ると、ほかの端末の変更を読み込み、元に戻すの履歴を空にする", options, async () => {
  await openStrip(3);
  await deleteBed("bed3", "bed1,bed2");
  await changeElsewhere(`data.beds.push(${JSON.stringify(bed(4))})`);
  await awayFor(61);
  await waitBeds("bed1,bed2,bed4");
  assert.equal(await undoDisabled(), true, "古い写しに戻すと、ほかの端末の変更を消すので、履歴は空");
  assert.equal(await status(), "ほかの画面での変更を読み込みました");
  assert.deepEqual(page.errors, []);
});

test("戻ってきても、DB が画面と同じなら、何も変えず、元に戻すの履歴も残す", options, async () => {
  await openStrip(3);
  await deleteBed("bed3", "bed1,bed2");
  await page.waitFor(`document.getElementById("saveStatus").textContent === "保存しました"`, "保存の完了");
  await awayFor(61);
  await settle();
  assert.equal(await shownBeds(), "bed1,bed2");
  assert.equal(await undoDisabled(), false);
  assert.equal(await status(), "保存しました");
  await page.click("#undoBtn");
  await waitBeds("bed1,bed2,bed3");
  assert.deepEqual(page.errors, []);
});

test("隠れていたのが 1 分より短ければ、読み直さない", options, async () => {
  await openStrip(2);
  await changeElsewhere(`data.beds.push(${JSON.stringify(bed(3))})`);
  await awayFor(30);
  await settle();
  assert.equal(await shownBeds(), "bed1,bed2");
});

test("窓を開いているあいだは読み直さず、窓を閉じたら、次に戻るのを待たずに読み直す", options, async () => {
  await openStrip(2);
  await page.click('.strip-bed[data-bed="bed2"]');
  await page.click("#stripDeleteBtn");
  await page.waitFor(`Boolean(document.querySelector("dialog[open]"))`, "確かめの窓");
  await changeElsewhere(`data.beds.push(${JSON.stringify(bed(3))})`);
  await awayFor(61);
  await settle();
  assert.equal(await shownBeds(), "bed1,bed2", "窓が開いているあいだは、入れ替えない");
  await page.click('dialog.notice [data-action="cancel"]');
  await waitBeds("bed1,bed2,bed3");
  assert.deepEqual(page.errors, []);
});

test("カーソルが欄にあるだけなら、戻ったときに読み直す（選ぶ欄、打っていない入力欄）", options, async () => {
  await openStrip(2);
  await page.run(`(() => {
    const holder = document.createElement("div");
    holder.innerHTML = '<select id="someSelect"><option>a</option><option>b</option></select>';
    document.body.append(holder);
    document.getElementById("someSelect").focus();
  })()`);
  assert.equal(await page.run(`document.activeElement.id`), "someSelect");
  await changeElsewhere(`data.beds.push(${JSON.stringify(bed(3))})`);
  await awayFor(61);
  await waitBeds("bed1,bed2,bed3");

  // 打っていない文字の欄（中身が、描いたときのまま）
  await page.run(`(() => {
    const holder = document.createElement("div");
    holder.innerHTML = '<input id="cleanText" type="text" value="前のまま" />';
    document.body.append(holder);
    document.getElementById("cleanText").focus();
  })()`);
  await changeElsewhere(`data.beds.push(${JSON.stringify(bed(4))})`);
  await awayFor(61);
  await waitBeds("bed1,bed2,bed3,bed4");
  assert.deepEqual(page.errors, []);
});

test("打ちかけの文字があるあいだは読み直さず、欄を離れたら、次に戻るのを待たずに読み直す", options, async () => {
  await openStrip(2);
  await page.run(`(() => {
    const holder = document.createElement("div");
    holder.innerHTML = '<input id="typedText" type="text" value="前の文字" />';
    document.body.append(holder);
    const input = document.getElementById("typedText");
    input.focus();
    input.value = "打ちかけ";
  })()`);
  await changeElsewhere(`data.beds.push(${JSON.stringify(bed(3))})`);
  await awayFor(61);
  await settle();
  assert.equal(await shownBeds(), "bed1,bed2", "打ちかけがあるあいだは、入れ替えない");
  assert.equal(await page.run(`document.getElementById("typedText").value`), "打ちかけ");
  await page.run(`document.getElementById("typedText").blur()`);
  await waitBeds("bed1,bed2,bed3");
  assert.deepEqual(page.errors, []);
});

test("送り残しがあるあいだは読み直さず、送り終えたら読み直す", options, async () => {
  await openStrip(2);
  // 保存を失敗させて、畝 1 の幅を変える（送り残しができる）
  await page.run(`(() => {
    const setItem = Storage.prototype.setItem;
    window.restoreSaves = () => (Storage.prototype.setItem = setItem);
    Storage.prototype.setItem = function (key, value) {
      if (key === ${JSON.stringify(KEY)}) {
        throw new Error("保存の失敗");
      }
      return setItem.call(this, key, value);
    };
    window.prompt = () => "150";
  })()`);
  await page.click('[data-dim="width:0"]');
  await page.waitFor(`document.querySelector("dialog[open]")?.textContent.includes("保存の失敗")`, "失敗の窓");
  await page.click('dialog.notice [data-action="close"]');
  await page.waitFor(`!document.querySelector("dialog[open]")`, "窓が閉じる");
  // ほかの端末が畝を足す（保存は止めてあるので、じかに書く）
  await page.run(`(() => {
    window.restoreSaves();
    const data = JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}));
    data.beds.push(${JSON.stringify(bed(3))});
    localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(data));
    const setItem = Storage.prototype.setItem;
    window.restoreSaves = () => (Storage.prototype.setItem = setItem);
    Storage.prototype.setItem = function (key, value) {
      if (key === ${JSON.stringify(KEY)}) {
        throw new Error("保存の失敗");
      }
      return setItem.call(this, key, value);
    };
  })()`);
  await awayFor(61);
  await settle();
  assert.equal(await shownBeds(), "bed1,bed2", "送り残しがあるあいだは、入れ替えない");
  // 回線が戻る。送り残しを送り終えたら、読み直す。送った幅は残る
  await page.run(`window.restoreSaves(); window.dispatchEvent(new Event("online"))`);
  await waitBeds("bed1,bed2,bed3");
  const [a, b] = (await page.saved()).beds.find((item) => item.id === "bed1").shape;
  assert.equal(Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 100), 150, "送り残しは、DB に入っている");
  assert.equal(await page.run(`document.querySelector('[data-dim="width:0"]').textContent`), "150cm");
});

test("知らせの出ない書きかけ（図の編集など）が終わったときも、間を空けた試しで拾って読み直す", options, async () => {
  await openStrip(2);
  // 閉じる知らせを出さない窓で、書きかけがある状態にする
  await page.run(`(() => {
    const box = document.createElement("dialog");
    box.id = "quietBox";
    box.setAttribute("open", "");
    document.body.append(box);
  })()`);
  await changeElsewhere(`data.beds.push(${JSON.stringify(bed(3))})`);
  await awayFor(61);
  await settle();
  assert.equal(await shownBeds(), "bed1,bed2");
  await page.run(`document.getElementById("quietBox").removeAttribute("open")`);
  await settle();
  assert.equal(await shownBeds(), "bed1,bed2", "知らせがないので、すぐには読み直さない");
  await waitBeds("bed1,bed2,bed3");
  assert.deepEqual(page.errors, []);
});

test("元に戻すのに途中で失敗したら、DB から読み直して画面を DB にそろえ、履歴を空にする。読み直せるまで操作を止める", options, async () => {
  await openStrip(3);
  await deleteBed("bed3", "bed1,bed2");
  // 書き込みも読み込みもできない（回線が切れた）ことにする
  await page.run(`(() => {
    const { setItem, getItem } = Storage.prototype;
    window.offline = true;
    Storage.prototype.setItem = function (key, value) {
      if (key === ${JSON.stringify(KEY)} && window.offline) {
        throw new Error("回線が切れています");
      }
      return setItem.call(this, key, value);
    };
    Storage.prototype.getItem = function (key) {
      if (key === ${JSON.stringify(KEY)} && window.offline) {
        throw new Error("回線が切れています");
      }
      return getItem.call(this, key);
    };
  })()`);
  await page.click("#undoBtn");
  await page.waitFor(`document.getElementById("saveStatus").textContent.includes("DB から読み直しています")`, "読み直しの知らせ");
  assert.equal(await page.run(`document.body.classList.contains("plan-busy")`), true, "読み直せるまで、図と日程の操作を止める");
  // 回線が戻る
  await page.run(`window.offline = false; window.dispatchEvent(new Event("online"))`);
  await page.waitFor(`document.getElementById("saveStatus").textContent.startsWith("DB の内容を読み直しました。元に戻せませんでした")`, "読み直しの完了");
  assert.equal(await shownBeds(), "bed1,bed2", "画面は、DB の内容（戻す前）になる");
  assert.deepEqual((await page.saved()).beds.map((item) => item.id), ["bed1", "bed2"]);
  assert.equal(await page.run(`document.body.classList.contains("plan-busy")`), false);
  assert.equal(await undoDisabled(), true);
  assert.equal(await page.run(`document.getElementById("redoBtn").disabled`), true);
});

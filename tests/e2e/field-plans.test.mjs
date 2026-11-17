// 「圃場とプラン」の窓（ヘッダーのメニューの「圃場とプランを選ぶ…」）を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 圃場とプランの「…」から、開いていないプランや圃場も、名前の変更・コピー・実際に使うプランにする・削除ができる
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const zone = (id, planId) => ({ id, plan_id: planId, kind: "tillable", name: "", shape: AREA, created_at: AT });

// 圃場 2 つ。圃場 1 はプラン 2 つ（実際に使うプランは決めていない）、圃場 2 はプラン 1 つ
const seed = () => ({
  fields: [
    { id: "f1", name: "一の圃場", outline: AREA, note: "", created_at: AT },
    { id: "f2", name: "二の圃場", outline: AREA, note: "", created_at: "2026-01-02T00:00:00Z" },
  ],
  plans: [
    { id: "p1", field_id: "f1", name: "一のプランA" },
    { id: "p2", field_id: "f1", name: "一のプランB" },
    { id: "p3", field_id: "f2", name: "二のプラン" },
  ],
  zones: [zone("z1", "p1"), zone("z2", "p2"), zone("z3", "p3")],
  blocks: [],
  beds: [],
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

after(async () => {
  await page?.close();
});

const DIALOG = "dialog.field-plans[open]";
const saved = () => page.saved();
// 名前を聞く窓（prompt）に、次に返す答えを決めておく
const answer = (text) => page.run(`window.prompt = () => ${JSON.stringify(text)}`);

async function openDialog() {
  await page.click("#brandMenu");
  await page.click('#userMenu [data-action="choose"]');
  await page.waitFor(`Boolean(document.querySelector("${DIALOG} .fp-plan"))`, "圃場とプランの窓");
}

// 「…」のメニューから選ぶ。menu は "plan:ID" か "field:ID"
async function fromMenu(menu, act) {
  await page.click(`${DIALOG} [data-menu="${menu}"]`);
  await page.click(`${DIALOG} .fp-menu [data-act="${act}"]`);
}

test("圃場とプラン: 開いていないプランの名前を変え、コピーし、実際に使うプランにする", options, async () => {
  await page.loadApp(seed(), { field_plan_current_field: "f1", field_plan_prefs: JSON.stringify({ f1: { plan: "p1" } }) });
  // 実際に使うプランがない圃場では、ヘッダーのプラン名に ⚠ が付く
  assert.equal(await page.run(`document.getElementById("brandPlan").textContent`), "一のプランA ⚠");
  await openDialog();
  assert.ok(await page.run(`Boolean(document.querySelector("${DIALOG} .fp-note"))`), "実際に使うプランがないことを知らせる");

  await answer("一のプランB2");
  await fromMenu("plan:p2", "renamePlan");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).plans.find((plan) => plan.id === "p2").name === "一のプランB2"`, "名前の保存");

  await answer("Bの写し");
  await fromMenu("plan:p2", "copyPlan");
  await page.waitFor(`document.querySelectorAll("${DIALOG} .fp-plan").length === 3`, "写しのプランが一覧に出る");
  const data = await saved();
  const copy = data.plans.find((plan) => plan.name === "Bの写し");
  assert.equal(copy.field_id, "f1");
  assert.equal(data.zones.filter((item) => item.plan_id === copy.id).length, 1, "区域も写る");

  await fromMenu("plan:p2", "activatePlan");
  await page.click('dialog.notice [data-action="delete"]');
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).fields.find((field) => field.id === "f1").active_plan_id === "p2"`, "実際に使うプランの保存");
  await page.waitFor(`Boolean(document.querySelector('${DIALOG} [data-plan="p2"] .fp-badge.is-active'))`, "「実際に使う」の札");
  // 開いているプラン（p1）は、まだ実際に使うプランではない
  assert.equal(await page.run(`document.getElementById("brandMenu").dataset.plan`), "p1");
  assert.deepEqual(page.errors, []);
});

test("圃場とプラン: 開いているプランを消すと、残ったプランを開く。開いていない圃場の名前も変えられる", options, async () => {
  await page.loadApp(seed(), { field_plan_current_field: "f1", field_plan_prefs: JSON.stringify({ f1: { plan: "p1" } }) });
  await openDialog();
  await fromMenu("plan:p1", "deletePlan");
  await page.click('dialog.notice [data-action="delete"]');
  await page.waitFor(`document.getElementById("brandMenu").dataset.plan === "p2"`, "残ったプランを開く");
  assert.ok(!(await saved()).plans.some((plan) => plan.id === "p1"), "プランが消える");

  // 残ったプランが 1 つなら、削除は押せない
  await page.click(`${DIALOG} [data-menu="plan:p2"]`);
  assert.equal(await page.run(`document.querySelector('${DIALOG} .fp-menu [data-act="deletePlan"]').disabled`), true);
  await page.run(`document.querySelector("${DIALOG}").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

  await answer("二の圃場（北）");
  await fromMenu("field:f2", "renameField");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).fields.find((field) => field.id === "f2").name === "二の圃場（北）"`, "圃場の名前の保存");
  // 開いている圃場は変わらない
  assert.equal(await page.run(`document.getElementById("brandMenu").dataset.field`), "f1");
  await page.click(`${DIALOG} .fp-head [data-act="close"]`);
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "窓を閉じる");
  assert.deepEqual(page.errors, []);
});

test("圃場とプラン: コピーが途中で失敗したら、作りかけのプランを残さない", options, async () => {
  await page.loadApp(seed(), { field_plan_current_field: "f1", field_plan_prefs: JSON.stringify({ f1: { plan: "p1" } }) });
  await openDialog();
  // プランの行は保存でき、区域の写しの保存で失敗する
  await page.run(`(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "field_plan_local" && JSON.parse(value).zones.length === 4) {
        throw new Error("保存の失敗");
      }
      return setItem.call(this, key, value);
    };
  })()`);
  await answer("Bの写し");
  await fromMenu("plan:p2", "copyPlan");
  await page.waitFor(`document.querySelector("dialog.notice[open]")?.textContent.includes("保存の失敗")`, "失敗の窓");
  const data = await saved();
  assert.deepEqual(data.plans.map((plan) => plan.id), ["p1", "p2", "p3"], "作りかけのプランは DB に残らない");
  assert.equal(data.zones.length, 3);
  assert.equal(await page.run(`document.querySelectorAll("${DIALOG} .fp-plan").length`), 2, "一覧にも出ない");
});

test("圃場とプラン: 開いているプランをコピーすると、行に新しい ID を付けて写す", options, async () => {
  await page.loadApp(seed(), { field_plan_current_field: "f1", field_plan_prefs: JSON.stringify({ f1: { plan: "p1" } }) });
  await openDialog();
  await answer("Aの写し");
  await fromMenu("plan:p1", "copyPlan");
  await page.waitFor(`document.querySelectorAll("${DIALOG} .fp-plan").length === 3`, "写しのプランが一覧に出る");
  const data = await saved();
  const copy = data.plans.find((plan) => plan.name === "Aの写し");
  const zones = data.zones.filter((item) => item.plan_id === copy.id);
  assert.equal(zones.length, 1);
  assert.notEqual(zones[0].id, "z1", "写した行には、新しい ID が付く");
  assert.deepEqual(Object.keys(copy).sort(), ["field_id", "id", "name"], "プランの行に、余計な列を付けない");
  assert.deepEqual(page.errors, []);
});

// 元に戻す・やり直す（Issue #3 の 3 段目）。プランの操作は、「圃場とプラン」の窓を開いて、目の前で戻す
const closeDialog = async () => {
  await page.click(`${DIALOG} [data-act="close"]`);
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "窓が閉じる");
};
const planNames = () => page.run(`[...document.querySelectorAll("${DIALOG} .fp-plan")].map((row) => row.textContent).join("/")`);

test("元に戻す: プランの名前の変更を戻すと、「圃場とプラン」の窓が開いて、前の名前に戻る。やり直すと、また変わる", options, async () => {
  await page.loadApp(seed(), { field_plan_current_field: "f1", field_plan_prefs: JSON.stringify({ f1: { plan: "p1" } }) });
  await openDialog();
  await answer("名前を変えたプラン");
  await fromMenu("plan:p2", "renamePlan");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).plans.find((plan) => plan.id === "p2").name === "名前を変えたプラン"`, "名前の保存");
  await closeDialog();
  await page.click("#undoBtn");
  await page.waitFor(`Boolean(document.querySelector("${DIALOG}"))`, "窓が開く");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).plans.find((plan) => plan.id === "p2").name === "一のプランB"`, "DB の名前が戻る");
  await page.waitFor(`document.querySelector('${DIALOG} .fp-plan[data-plan="p2"]')?.classList.contains("undo-flash")`, "窓のプランの行が光る");
  await page.waitFor(`/一のプランB/.test(${JSON.stringify("")} + [...document.querySelectorAll("${DIALOG} .fp-plan")].map((row) => row.textContent).join("/"))`, "窓の一覧も戻る");
  await closeDialog();
  await page.click("#redoBtn");
  await page.waitFor(`Boolean(document.querySelector("${DIALOG}"))`, "やり直すでも窓が開く");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).plans.find((plan) => plan.id === "p2").name === "名前を変えたプラン"`, "やり直し");
  assert.match(await planNames(), /名前を変えたプラン/);
  assert.deepEqual(page.errors, []);
});

test("元に戻す: 作って開いたプランを戻すと、確かめてから消し、前のプランを開く。消したプランを戻すと、中身ごと戻る", options, async () => {
  await page.loadApp(seed(), { field_plan_current_field: "f1", field_plan_prefs: JSON.stringify({ f1: { plan: "p1" } }) });
  await openDialog();
  await answer("新しいプラン");
  await page.click(`${DIALOG} [data-act="newPlan"]`);
  await page.waitFor(`document.getElementById("brandPlan").textContent.startsWith("新しいプラン")`, "作ったプランを開く");
  await closeDialog();
  await page.click("#undoBtn");
  await page.waitFor(`document.querySelector("dialog.notice[open]")?.textContent.includes("プラン 1 件")`, "消えるプランを知らせる");
  await page.click('dialog.notice[open] [data-action="delete"]');
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).plans.length === 3`, "作ったプランが消える");
  await page.waitFor(`document.getElementById("brandPlan").textContent.startsWith("一のプランA")`, "前のプランを開く");
  assert.doesNotMatch(await planNames(), /新しいプラン/);
  await closeDialog();

  // 開いていないプランを消して、戻す
  await openDialog();
  await page.run(`window.confirm = () => true`);
  await fromMenu("plan:p2", "deletePlan");
  await page.click('dialog.notice[open] [data-action="delete"]');
  await page.waitFor(`!JSON.parse(localStorage.getItem("field_plan_local")).plans.some((plan) => plan.id === "p2")`, "プランの削除");
  await page.waitFor(`!JSON.parse(localStorage.getItem("field_plan_local")).zones.some((zone) => zone.id === "z2")`, "中身も消える");
  await closeDialog();
  await page.click("#undoBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).zones.some((zone) => zone.id === "z2")`, "中身ごと戻る");
  assert.match(await planNames(), /一のプランB/, "窓の一覧に戻る");
  assert.equal(await page.run(`document.getElementById("brandPlan").textContent`).then((text) => text.startsWith("一のプランA")), true, "開いているプランは変えない");
  assert.deepEqual(page.errors, []);
});

test("元に戻す: 別のプランの操作は、戻さずに知らせ、そのプランに切り替えると戻せる", options, async () => {
  await page.loadApp({ ...seed(), blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: AREA, start_date: null, end_date: null, created_at: AT }] },
    { field_plan_current_field: "f1", field_plan_prefs: JSON.stringify({ f1: { plan: "p1" } }) });
  // プラン A で、区画の名前を変える
  await page.click('#shapeTree [data-shape="b1"]');
  await page.waitFor(`document.getElementById("blockName").offsetParent !== null`, "区画の名前の欄");
  await page.run(`(() => { const input = document.getElementById("blockName"); input.value = "変えた名前"; input.dispatchEvent(new Event("input", { bubbles: true })); input.blur(); })()`);
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).blocks[0].name === "変えた名前"`, "名前の保存");
  // プラン B に切り替える
  await openDialog();
  await page.click(`${DIALOG} [data-act="open"][data-id="p2"]`);
  await page.waitFor(`document.getElementById("brandPlan").textContent.startsWith("一のプランB")`, "プラン B を開く");
  if (await page.run(`Boolean(document.querySelector("${DIALOG}"))`)) {
    await closeDialog();
  }
  await page.click("#undoBtn");
  await page.waitFor(`document.getElementById("saveStatus").textContent === "プラン「一のプランA」の操作です。そのプランに切り替えると、元に戻せます"`, "知らせる");
  assert.equal((await saved()).blocks[0].name, "変えた名前", "戻さない");
  // プラン A に戻すと、戻せる
  await openDialog();
  await page.click(`${DIALOG} [data-act="open"][data-id="p1"]`);
  await page.waitFor(`document.getElementById("brandPlan").textContent.startsWith("一のプランA")`, "プラン A を開く");
  if (await page.run(`Boolean(document.querySelector("${DIALOG}"))`)) {
    await closeDialog();
  }
  await page.click("#undoBtn");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).blocks[0].name === "A"`, "戻る");
  assert.deepEqual(page.errors, []);
});

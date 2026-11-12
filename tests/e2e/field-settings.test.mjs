// 「圃場の設定」の窓（ヘッダーのメニューの「圃場の設定…」）を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 調整は書きかけで、窓の中の「元に戻す・やり直す」で行き来し、「保存する」でまとめて保存する（窓は閉じない）。
// 保存しないまま閉じると、開く前の状態に戻る
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, openBrowser } from "./browser.mjs";

const AT = "2026-01-01T00:00:00Z";
const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
const IMAGE = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#cbd8b4"/></svg>').toString("base64")}`;

// 圃場 1 つ、プラン 2 つ（どちらにも区域が 1 つ）、下絵 1 枚。fitted は、図形に合わせて置いた下絵か
const seed = (fitted) => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", created_at: AT }],
  plans: [
    { id: "p1", field_id: "f1", name: "プラン1" },
    { id: "p2", field_id: "f1", name: "プラン2" },
  ],
  zones: [
    { id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT },
    { id: "z2", plan_id: "p2", kind: "tillable", name: "", shape: AREA, created_at: AT },
  ],
  blocks: [],
  beds: [],
  plantings: [],
  works: [],
  crops: [],
  backdrops: { f1: { id: "bd1", field_id: "f1", storage_path: "local:f1", m_per_px: 0.1, origin_px: [200, 100], rotation_deg: 0, fitted } },
  images: { f1: IMAGE },
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

const DIALOG = "dialog.field-settings[open]";
const savedRotation = () => page.run(`JSON.parse(localStorage.getItem("field_plan_local")).backdrops.f1.rotation_deg`);
const setRotation = (degrees) =>
  page.run(`(() => { const input = document.getElementById("rotation"); input.value = "${degrees}"; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
const status = () => page.run(`document.getElementById("settingsStatus").textContent`);

async function openSettings() {
  await page.click("#brandMenu");
  await page.click('#userMenu [data-action="settings"]');
  await page.waitFor(`Boolean(document.querySelector("${DIALOG} .map-frame"))`, "設定の窓（図が窓の中にある）");
  await page.click(`${DIALOG} [data-fstab="place"]`);
}

test("圃場の設定: 回転は書きかけで、元に戻す・やり直すで行き来し、保存しても窓は閉じない。保存しないで閉じると元に戻る", options, async () => {
  await page.loadApp(seed(true));
  await openSettings();
  assert.equal(await page.run(`document.getElementById("settingsSave").disabled`), true, "何も変えていなければ保存できない");

  await setRotation(10);
  await page.waitFor(`document.getElementById("settingsStatus").textContent.includes("保存していない調整")`, "書きかけの表示");
  assert.equal(await savedRotation(), 0, "保存するまでは DB は変わらない");
  await page.click("#settingsUndo");
  await page.waitFor(`document.getElementById("rotation").value === "0"`, "元に戻す");
  await page.click("#settingsRedo");
  await page.waitFor(`document.getElementById("rotation").value === "10"`, "やり直す");

  await page.click("#settingsSave");
  await page.waitFor(`document.getElementById("settingsStatus").textContent === "保存しました"`, "保存しました");
  assert.equal(await savedRotation(), 10);
  assert.ok(await page.run(`Boolean(document.querySelector("${DIALOG}"))`), "窓は開いたまま");
  assert.equal(await page.run(`document.getElementById("settingsUndo").disabled`), true, "保存したら、元に戻すの履歴は空");

  // もう一度変えて、保存しないで閉じる: 捨ててよいかを確かめ、開いたときの状態（保存した 10 度）に戻る
  await setRotation(25);
  await page.click("#fieldSettingsClose");
  assert.equal(await page.run(`document.querySelector('dialog.notice [data-action="delete"]').textContent`), "破棄");
  await page.click('dialog.notice [data-action="delete"]');
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "閉じる");
  assert.equal(await savedRotation(), 10);
  assert.equal(await page.run(`document.getElementById("rotation").value`), "10", "画面の値も戻る");
  assert.ok(await page.run(`Boolean(document.querySelector("#appView .map-area .map-frame"))`), "図が圃場図に戻る");
  assert.deepEqual(page.errors, []);
});

test("圃場の設定: 図形と一緒に回る下絵を回して保存すると、ほかのプランの図形も回る", options, async () => {
  await page.loadApp(seed(false));
  await openSettings();
  await setRotation(90);
  await page.waitFor(`!document.getElementById("settingsWarn").hidden`, "図形が変わることの注意");
  const before = await page.run(`JSON.parse(localStorage.getItem("field_plan_local")).zones.find((zone) => zone.id === "z2").shape`);
  assert.deepEqual(before, AREA, "保存するまでは、ほかのプランは変わらない");
  await page.click("#settingsSave");
  await page.click('dialog.notice [data-action="delete"]');
  await page.waitFor(`document.getElementById("settingsStatus").textContent === "保存しました"`, "保存しました");
  const data = await page.saved();
  const other = data.zones.find((zone) => zone.id === "z2").shape;
  const open = data.zones.find((zone) => zone.id === "z1").shape;
  assert.notDeepEqual(other, AREA, "ほかのプランの区域も回る");
  assert.deepEqual(other.map((point) => point.map((value) => Math.round(value * 1000) / 1000)), open.map((point) => point.map((value) => Math.round(value * 1000) / 1000)), "開いているプランと同じだけ回る");
  await page.click("#fieldSettingsClose");
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "閉じる（保存済みなので確かめない）");
  assert.deepEqual(page.errors, []);
});

test("圃場の設定: 縮尺のタブで、図の上の 2 点を押して縮尺を合わせ、元に戻せる。気象の欄も元に戻せる", options, async () => {
  await page.loadApp(seed(true));
  await page.click("#brandMenu");
  await page.click('#userMenu [data-action="settings"]');
  await page.waitFor(`Boolean(document.querySelector("${DIALOG} .map-frame"))`, "設定の窓");
  await page.click(`${DIALOG} [data-fstab="scale"]`);
  const scale = () => page.run(`document.getElementById("scaleText").textContent`);
  const before = await scale();

  // 「2 点の距離で合わせる」を押し、図の上の 2 点を押して、実際の距離を入れる
  await page.run(`window.prompt = () => "40"`); // 図の上で 20 m の 2 点を、実際は 40 m とする
  await page.click(`${DIALOG} .mode-btn[data-mode="scale"]`);
  await page.clickMap([5, 10]);
  assert.equal(await page.run(`document.querySelector('${DIALOG} .mode-btn[data-mode="scale"]').classList.contains("is-active")`), true, "1 点目のあとも、道具は選んだまま");
  await page.clickMap([25, 10]);
  await page.waitFor(`document.getElementById("scaleText").textContent !== ${JSON.stringify(before)}`, "縮尺が変わる");
  assert.match(await status(), /保存していない調整/);
  await page.click("#settingsUndo");
  await page.waitFor(`document.getElementById("scaleText").textContent === ${JSON.stringify(before)}`, "元に戻す");

  // 面積を測る: 4 点を押して最初の点で閉じ、今の縮尺での面積を出してから、実際の面積を尋ねる
  let asked = "";
  await page.run(`window.prompt = (message) => { window.askedText = message; return "800"; }`);
  await page.click(`${DIALOG} .mode-btn[data-mode="areaMeasure"]`);
  for (const point of [[5, 5], [25, 5], [25, 15], [5, 15]]) {
    await page.clickMap(point);
  }
  await page.waitFor(`document.querySelectorAll("#map .draft-point.is-mark").length === 4`, "押した 4 点");
  await page.clickMap([5, 5]);
  await page.waitFor(`document.getElementById("scaleText").textContent !== ${JSON.stringify(before)}`, "面積で縮尺が変わる");
  asked = await page.run("window.askedText");
  assert.match(asked, /^今の縮尺では 200\.00 ㎡ です。実際の面積（㎡）は？$/);
  await page.click("#settingsUndo");
  await page.waitFor(`document.getElementById("scaleText").textContent === ${JSON.stringify(before)}`, "元に戻す");

  // 位置と向きのタブ: 「図形に位置を合わせる」で、下絵の上の目印と図形の上の点を押すと、下絵が動く
  await page.click(`${DIALOG} [data-fstab="place"]`);
  await page.click(`${DIALOG} .mode-btn[data-mode="align"]`);
  await page.clickMap([10, 10]);
  await page.clickMap([12, 11]);
  await page.waitFor(`document.getElementById("settingsStatus").textContent.includes("保存していない調整")`, "下絵が動く");
  await page.run(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await page.click("#settingsUndo");
  await page.waitFor(`document.getElementById("settingsStatus").textContent === "変更はありません"`, "元に戻す");

  // 気象: 基準点の緯度を変えて、元に戻す
  await page.click(`${DIALOG} [data-fstab="weather"]`);
  await page.run(`(() => { const input = document.getElementById("baseLat"); input.value = "26.3"; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.waitFor(`!document.getElementById("settingsUndo").disabled`, "気象の変更も元に戻せる");
  await page.click("#settingsUndo");
  await page.waitFor(`document.getElementById("baseLat").value === ""`, "緯度が元に戻る");
  await page.waitFor(`document.getElementById("settingsStatus").textContent === "変更はありません"`, "変更なしに戻る");
  await page.click("#fieldSettingsClose");
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "確かめずに閉じる");
  assert.deepEqual(page.errors, []);
});

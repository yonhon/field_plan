// 「圃場の設定」の窓（ヘッダーのメニューの「圃場の設定…」）を、Chrome で通して確かめる。実行: node --test "tests/e2e/*.test.mjs"
// 調整は書きかけで、窓の中の「元に戻す・やり直す」で行き来し、「保存する」でまとめて保存する（窓は閉じない）。
// 保存しないまま閉じると、開く前の状態に戻る
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.equal(await page.run(`document.querySelector('dialog.notice [data-action="delete"]').textContent`), "捨てて閉じる");
  await page.click('dialog.notice [data-action="delete"]');
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "閉じる");
  assert.equal(await savedRotation(), 10);
  assert.equal(await page.run(`document.getElementById("rotation").value`), "10", "画面の値も戻る");
  assert.ok(await page.run(`Boolean(document.querySelector("#appView .map-row > .map-frame"))`), "図が圃場図に戻る");
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

  // 2 組を合わせると、大きさの差が測れて「図形を下絵の縮尺に合わせる」が押せるようになる。押すと図形の大きさが変わる
  assert.equal(await page.run(`document.getElementById("fitShapesBtn").disabled`), true, "合わせる前は押せない");
  await page.click(`${DIALOG} .mode-btn[data-mode="align"]`);
  for (const point of [[10, 10], [11, 10], [30, 15], [31, 15.5]]) {
    await page.clickMap(point);
  }
  await page.waitFor(`!document.getElementById("fitShapesBtn").disabled`, "押せるようになる");
  assert.match(await page.run(`document.getElementById("hint").textContent`), /図形を下絵の縮尺に合わせる/);
  await page.click("dialog.notice[open] [data-action='close']");
  await page.click("#fitShapesBtn");
  await page.waitFor(`!document.getElementById("settingsWarn").hidden`, "すべてのプランの図形に当てることの注意");
  assert.match(await page.run(`document.getElementById("hint").textContent`), /倍にして、下絵の縮尺に合わせました/);
  // 元に戻すは 3 回ぶん（位置合わせの 1 組目と 2 組目、図形の大きさ）
  for (let i = 0; i < 3; i += 1) {
    await page.click("#settingsUndo");
  }
  await page.waitFor(`document.getElementById("settingsStatus").textContent === "変更はありません"`, "3 回の元に戻すで、開いたときに戻る");

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

// 保存した設定は、ふだんの元に戻すで、保存の前に戻せる（Issue #3 の 3 段目）。すべてのプランの図形と、下絵と、気象の設定が 1 回で戻る
test("圃場の設定: 保存した回転と気象の設定を、窓を閉じたあとの元に戻すで戻し、やり直すとまた当たる", options, async () => {
  await page.loadApp(seed(false));
  const before = await page.saved();
  await openSettings();
  await setRotation(90);
  await page.waitFor(`!document.getElementById("settingsSave").disabled`, "書きかけ");
  await page.click(`${DIALOG} [data-fstab="weather"]`);
  await page.run(`(() => { const input = document.getElementById("baseLat"); input.value = "26.3"; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.click("#settingsSave");
  // すべてのプランに当てることを確かめる窓
  await page.waitFor(`document.querySelector("dialog.notice[open]")?.textContent.includes("すべてのプラン")`, "確かめの窓");
  await page.click('dialog.notice[open] [data-action="delete"]');
  await page.waitFor(`document.getElementById("settingsStatus").textContent === "保存しました"`, "保存");
  const turned = await page.saved();
  assert.equal(turned.backdrops.f1.rotation_deg, 90);
  assert.notDeepEqual(turned.zones.find((zone) => zone.id === "z2").shape, before.zones.find((zone) => zone.id === "z2").shape, "開いていないプランの区域も回る");
  await page.click("#fieldSettingsClose");
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "窓を閉じる");

  // 元に戻すと、圃場の設定の窓が開き、窓の中の欄が変わるところを見せる
  await page.click("#undoBtn");
  await page.waitFor(`Boolean(document.querySelector("${DIALOG}"))`, "窓が開く");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).backdrops.f1.rotation_deg === 0`, "下絵の向きが戻る");
  await page.waitFor(`document.getElementById("rotation").value === "0"`, "窓の欄も戻る");
  await page.waitFor(`document.getElementById("settingsStatus").textContent.startsWith("元に戻しました")`, "窓の中に知らせる");
  assert.equal(await page.run(`document.getElementById("settingsSave").disabled`), true, "戻した内容は、窓の書きかけにしない");
  await page.click(`${DIALOG} [data-fstab="weather"]`);
  assert.equal(await page.run(`document.getElementById("baseLat").value`), "", "気象の欄も戻る");
  const undone = await page.saved();
  assert.deepEqual(undone.zones, before.zones, "どちらのプランの区域も戻る");
  assert.deepEqual(undone.fields[0].outline, before.fields[0].outline, "外形も戻る");
  assert.equal(undone.fields[0].base_lat ?? null, null, "気象の設定も戻る");
  await page.click("#fieldSettingsClose");
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "確かめずに閉じる（書きかけはない）");

  await page.click("#redoBtn");
  await page.waitFor(`Boolean(document.querySelector("${DIALOG}"))`, "やり直すでも窓が開く");
  await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).backdrops.f1.rotation_deg === 90`, "やり直すと、また当たる");
  await page.waitFor(`document.getElementById("rotation").value === "90"`, "窓の欄も変わる");
  assert.deepEqual((await page.saved()).zones, turned.zones);
  await page.click("#fieldSettingsClose");
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "閉じる");
  assert.deepEqual(page.errors, []);
});

// 下絵の読み込みも、保存したあとで戻せる。前の画像のファイルは消していないので、前の下絵に戻る
test("圃場の設定: 読み込んだ下絵を保存したあと、元に戻すで前の下絵に戻り、やり直すと読み込んだ下絵になる", options, async () => {
  await page.loadApp(seed(false));
  const dir = mkdtempSync(join(tmpdir(), "field-plan-backdrop-"));
  const file = join(dir, "square.svg");
  // 前の下絵（400 × 200）と縦横の比が違う画像（引き継ぎを尋ねない）
  writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#b4c8d8"/></svg>');
  try {
    await openSettings();
    const { root } = await page.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#backdropFile" });
    await page.send("DOM.setFileInputFiles", { nodeId, files: [file] });
    await page.waitFor(`!document.getElementById("settingsSave").disabled`, "読み込んだ下絵の書きかけ");
    await page.click("#settingsSave");
    await page.waitFor(`document.getElementById("settingsStatus").textContent === "保存しました"`, "保存");
    const loaded = (await page.saved()).backdrops.f1;
    assert.notEqual(loaded.storage_path, "local:f1", "新しい画像");
    await page.click("#fieldSettingsClose");
    await page.waitFor(`!document.querySelector("${DIALOG}")`, "窓を閉じる");

    await page.click("#undoBtn");
    await page.waitFor(`Boolean(document.querySelector("${DIALOG}"))`, "窓が開く");
    await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).backdrops.f1?.storage_path === "local:f1"`, "前の下絵に戻る");
    await page.waitFor(`document.querySelector("#map image")?.getAttribute("href") === ${JSON.stringify(IMAGE)}`, "窓の図に、前の画像を描く");
    await page.click("#fieldSettingsClose");
    await page.waitFor(`!document.querySelector("${DIALOG}")`, "閉じる");
    await page.click("#redoBtn");
    await page.waitFor(`JSON.parse(localStorage.getItem("field_plan_local")).backdrops.f1?.storage_path === ${JSON.stringify(loaded.storage_path)}`, "やり直すと、読み込んだ下絵");
    assert.deepEqual(page.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 図の画面のほか（日程など）から開いた窓でも、気象の欄を描き直す。元に戻すで戻した値が、窓の欄に出る
// （2026-11-17 に実機で見つかった。図の画面が隠れているときは、気象の欄を描き直していなかった）
test("圃場の設定: 日程の画面から開いた窓でも、保存した気象の設定を元に戻すと、欄の値が戻る", options, async () => {
  await page.loadApp(seed(false));
  await page.click('.tab-btn[data-view="schedule"]');
  await openSettings();
  await page.click(`${DIALOG} [data-fstab="weather"]`);
  await page.run(`(() => { const input = document.getElementById("baseLat"); input.value = "26.3"; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.click("#settingsSave");
  await page.waitFor(`document.getElementById("settingsStatus").textContent === "保存しました"`, "保存");
  await page.click("#fieldSettingsClose");
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "窓を閉じる");

  await page.click("#undoBtn");
  await page.waitFor(`Boolean(document.querySelector("${DIALOG}"))`, "窓が開く");
  await page.waitFor(`(JSON.parse(localStorage.getItem("field_plan_local")).fields[0].base_lat ?? null) === null`, "DB の緯度が戻る");
  await page.click(`${DIALOG} [data-fstab="weather"]`);
  await page.waitFor(`document.getElementById("baseLat").value === ""`, "窓の緯度の欄も戻る");
  await page.click("#fieldSettingsClose");
  await page.waitFor(`!document.querySelector("${DIALOG}")`, "閉じる");
  // 開き直しても、戻した値
  await openSettings();
  await page.click(`${DIALOG} [data-fstab="weather"]`);
  assert.equal(await page.run(`document.getElementById("baseLat").value`), "");
  await page.click("#fieldSettingsClose");
  assert.deepEqual(page.errors, []);
});

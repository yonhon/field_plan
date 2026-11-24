// 区画と畝の図を使う通しテスト（strip、save-retry、edit-undo）の共通の部品。
// テストのファイルではない（node --test "tests/e2e/*.test.mjs" には入らない）
export const AT = "2026-01-01T00:00:00Z";
export const AREA = [[0, 0], [40, 0], [40, 20], [0, 20]];
export const CONFIRM = 'dialog.notice [data-action="delete"]';
export const CANCEL = 'dialog.notice [data-action="cancel"]';
export const openDialog = 'document.querySelector("dialog[open]")';

export const bed = (seq) => ({
  id: `bed${seq}`,
  plan_id: "p1",
  block_id: "b1",
  seq,
  shape: [[seq * 3, 2], [seq * 3 + 1, 2], [seq * 3 + 1, 18], [seq * 3, 18]],
  start_date: null,
  removed_on: null,
});

// 圃場 1 つ、区画 1 つ、畝 count 本
export const seed = (count) => ({
  fields: [{ id: "f1", name: "試験の圃場", outline: AREA, note: "", created_at: AT }],
  plans: [{ id: "p1", field_id: "f1", name: "プラン1" }],
  zones: [{ id: "z1", plan_id: "p1", kind: "tillable", name: "", shape: AREA, created_at: AT }],
  blocks: [{ id: "b1", plan_id: "p1", zone_id: "z1", name: "A", shape: [[1, 1], [39, 1], [39, 19], [1, 19]], start_date: null, end_date: null, created_at: AT }],
  beds: Array.from({ length: count }, (_, index) => bed(index + 1)),
  plantings: [],
  works: [],
  crops: [{ id: "c1", name: "試験菜", mulch: false, bed_width_cm: 100, aisle_width_cm: 60 }],
});

// 画面を操作する部品。page は before で開くので、使うときに getPage() で受け取る
export function stripTools(getPage) {
  const page = () => getPage();
  const waitBeds = (ids) => page().waitFor(`[...document.querySelectorAll("#strip .strip-bed")].map((box) => box.dataset.bed).join() === ${JSON.stringify(ids)}`, `図の畝が ${ids} になる`);
  return {
    shownBeds: () => page().run(`[...document.querySelectorAll("#strip .strip-bed")].map((box) => box.dataset.bed).join()`),
    labels: () => page().run(`[...document.querySelectorAll("#strip .strip-bed-label")].map((label) => label.textContent).join("/")`),
    waitBeds,
    // 閉じた窓は、少し遅れて取り除かれる。残っているあいだに次の窓を開くと、古いボタンを押してしまう
    waitNoDialog: () => page().waitFor(`!document.querySelector("dialog.notice")`, "窓が閉じる"),
    status: () => page().run(`document.getElementById("saveStatus").textContent`),
    async openStrip(count) {
      await page().loadApp(seed(count));
      await page().click('.tab-btn[data-view="schedule"]');
      await page().waitFor(`document.querySelectorAll("#strip .strip-bed").length === ${count}`, `図に畝が ${count} 本出る`);
    },
    async chooseBed(id) {
      await page().click(`.strip-bed[data-bed="${id}"]`);
      await page().waitFor(`document.querySelector('.strip-bed[data-bed="${id}"]').classList.contains("is-selected")`, `${id} を選ぶ`);
    },
    chooseCrop: (selector) => page().setValue(selector, "c1"),
    // 畝 1 の幅を 150 cm にする（すぐには送らない自動保存）
    async widenBed() {
      await page().run(`window.prompt = () => "150"`);
      await page().click('[data-dim="width:0"]');
      await page().waitFor(`document.querySelector('[data-dim="width:0"]').textContent === "150cm"`, "畝幅が変わる");
    },
    // DB に保存された畝 1 の幅（cm）
    async savedWidth() {
      const [a, b] = (await page().saved()).beds.find((item) => item.id === "bed1").shape;
      return Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 100);
    },
    // 保存を失敗させる。when は、書き込む内容を受け取って失敗させるかを返す式。元に戻すときは restoreSaves
    failSaves: (when) =>
      page().run(`(() => {
        const setItem = Storage.prototype.setItem;
        window.restoreSaves = () => (Storage.prototype.setItem = setItem);
        Storage.prototype.setItem = function (key, value) {
          if (key === "field_plan_local" && ((data) => ${when})(JSON.parse(value))) {
            throw new Error("保存の失敗");
          }
          return setItem.call(this, key, value);
        };
      })()`),
  };
}

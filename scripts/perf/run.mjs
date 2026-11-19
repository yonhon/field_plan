// 画面の速さを測る（docs/performance.md）。作り物のデータ（scripts/perf/data.mjs）を ?local=1 の画面に入れ、
// Chrome で、起動とタブの切り替えの時間、配置の計算の回数を測る。
//   node scripts/perf/run.mjs            いまの量と 1 年後の量の両方を測って、結果を出す
//   node scripts/perf/run.mjs --record   結果を docs/perf-runs.md の表に足す
//   node scripts/perf/run.mjs --scale now
// 「スマホ相当」は、CPU を 1/4 に絞り、幅を 390 px にした値。実機の値ではない。
// 測るたびに 1〜2 割揺れ、PC が忙しいと 2 倍ほど揺れる。ほかの重い処理を止めてから測り、前回と大きく違えば測り直す
import { appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "../../tests/e2e/browser.mjs";
import { loadFieldBytes, makeSeed } from "./data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const record = args.includes("--record");
const scales = args.includes("--scale") ? [args[args.indexOf("--scale") + 1]] : ["now", "1y"];
const REPEAT = 7; // それぞれ何回測って中央値を取るか
// 圃場図との行き来を測る画面。今日と収支は、記録の表の列にはなく、結果の JSON にだけ出す
const VIEWS = ["schedule", "master", "diary", "journal", "today", "revenue"];
// ロゴのメニューから開く画面。メニューを開くのは測らず、メニューの項目を押してから次の描画までを測る
const MENU_VIEWS = ["master", "journal"];
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure(page, scale) {
  const seed = makeSeed(scale);
  const stored = {
    field_plan_current_field: seed.fieldId,
    field_plan_prefs: JSON.stringify({ [seed.fieldId]: { plan: seed.planId } }),
  };
  await page.viewport(390, 844);
  await page.loadApp(seed.data, stored);
  await page.send("Performance.enable");
  await page.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  // 起動: 開き直して、画面が出るまで。2 回目からは、端末に取っておいた中身を使う（field-cache.js）
  const startups = [];
  for (let i = 0; i < 5; i += 1) {
    // 開き直す前のページに印を付け、印のない（開き直した）ページで画面が出るのを待つ
    await page.run("window.perfOldPage = true; location.reload()");
    for (let k = 0; k < 600; k += 1) {
      if (await page.run(`!window.perfOldPage && document.getElementById("viewTabs")?.hidden === false`).catch(() => false)) {
        break;
      }
      await sleep(10);
    }
    startups.push(await page.run("new Promise((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(performance.now()), 0)))"));
    await sleep(300);
  }
  // タブの切り替え: 押してから、次の描画まで。あわせて、配置の計算の回数
  const metrics = async () => Object.fromEntries((await page.send("Performance.getMetrics")).metrics.map((item) => [item.name, item.value]));
  const switchTo = (view) =>
    page.run(`(async () => {
      const menu = ${JSON.stringify(MENU_VIEWS)}.includes("${view}");
      if (menu) {
        document.getElementById("brandMenu").click();
      }
      const t = performance.now();
      document.querySelector(menu ? '#userMenu [data-action="${view}"]' : '.tab-btn[data-view="${view}"]').click();
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      return performance.now() - t;
    })()`);
  const tabs = {};
  for (const view of [...VIEWS, "map"]) {
    const times = [];
    const layouts = [];
    for (let i = 0; i < REPEAT; i += 1) {
      await switchTo(view === "map" ? "schedule" : "map");
      const before = await metrics();
      times.push(await switchTo(view));
      layouts.push((await metrics()).LayoutCount - before.LayoutCount);
    }
    tabs[view] = { ms: Math.round(median(times)), layouts: median(layouts) };
  }
  await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  return { scale, startupMs: Math.round(median(startups)), tabs, loadFieldKB: Math.round(loadFieldBytes(seed) / 1024) };
}

const page = await openBrowser();
const results = [];
try {
  for (const scale of scales) {
    results.push(await measure(page, scale));
  }
} finally {
  await page.close();
}

const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
const date = new Date().toISOString().slice(0, 10);
const label = { now: "いまの量", "1y": "1 年後の量" };
const rows = results.map(
  (r) =>
    `| ${date} | ${commit} | ${label[r.scale]} | ${r.startupMs} | ${r.tabs.schedule.ms}（${r.tabs.schedule.layouts}） | ${r.tabs.map.ms}（${r.tabs.map.layouts}） | ` +
    `${r.tabs.master.ms}（${r.tabs.master.layouts}） | ${r.tabs.diary.ms}（${r.tabs.diary.layouts}） | ${r.tabs.journal.ms}（${r.tabs.journal.layouts}） | ${r.loadFieldKB} |  |`
);
console.log(JSON.stringify(results, null, 2));
console.log(rows.join("\n"));
if (record) {
  const file = join(ROOT, "docs", "perf-runs.md");
  const text = readFileSync(file, "utf8");
  appendFileSync(file, `${text.endsWith("\n") ? "" : "\n"}${rows.join("\n")}\n`);
  console.log(`docs/perf-runs.md に ${rows.length} 行を足しました。気づいたことは、最後の欄に書いてください`);
}

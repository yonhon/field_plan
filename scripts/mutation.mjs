// Mutation testing（StrykerJS）を、指定したファイルにかかわる計算のテストだけで動かす。
// ふだんの Mutation testing は mizchi/mutator（mutation/run.mjs）で行う。これは、mutator の結果が正しいかを確かめる検算のために残している。
// 同じファイルを両方で回し、node mutation/summary.mjs --compare で比べる（docs/development.md の「Mutation testing」、docs/mutation-runs.md）
//   node scripts/mutation.mjs app/geometry.js app/schedule.js
//   node scripts/mutation.mjs app/pesticide.js:289-547
//   node scripts/mutation.mjs --list app/logs.js     （動かすテストを出すだけ）
//   node scripts/mutation.mjs                         （stryker.config.json の mutate をすべて）
// 書き換え 1 つごとに、そのファイルを直接・間接に読み込むテストファイルだけを動かす（全部では 1 回 1.6 秒かかる）。
// 読み込みは、app/ と tests/ の import をたどって求める。設定は stryker.config.json を元に、.stryker/config.json に書く
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STRYKER = "@stryker-mutator/core@10.1.1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const posix = (path) => relative(root, path).split("\\").join("/");

// ファイルが import する、手元のファイル（root からの相対の名前）
const IMPORT = /(?:from\s+|import\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
const cache = new Map();
function importsOf(file) {
  if (!cache.has(file)) {
    const text = readFileSync(join(root, file), "utf8");
    cache.set(file, [...text.matchAll(IMPORT)].map((match) => posix(resolve(join(root, dirname(file)), match[1]))).filter((name) => existsSync(join(root, name))));
  }
  return cache.get(file);
}

// ファイルが、直接・間接に読み込むファイルの集まり（自分を含む）
export function dependsOn(file) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    importsOf(name).forEach(visit);
  };
  visit(file);
  return seen;
}

// 変異させるファイルを読み込むテストファイル
export function testsFor(targets) {
  const files = targets.map((target) => target.replace(/:\d+(-\d+)?$/, ""));
  return readdirSync(join(root, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `tests/${name}`)
    .filter((test) => {
      const deps = dependsOn(test);
      return files.some((file) => deps.has(file));
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const base = JSON.parse(readFileSync(join(root, "stryker.config.json"), "utf8"));
  const targets = args.filter((arg) => arg !== "--list");
  const mutate = targets.length ? targets : base.mutate;
  const tests = testsFor(mutate);
  if (!tests.length) {
    console.error(`読み込むテストがありません: ${mutate.join(" ")}`);
    process.exit(1);
  }
  console.log(`動かすテスト（${tests.length} ファイル）: ${tests.join(" ")}`);
  if (listOnly) {
    process.exit(0);
  }
  // lib/ の写しを比べるテストは、app/ を書き換えると必ず失敗するので飛ばす
  const command = `node --test --test-skip-pattern="lib/ の写し" ${tests.join(" ")}`;
  mkdirSync(join(root, ".stryker"), { recursive: true });
  const config = { ...base, mutate, commandRunner: { ...base.commandRunner, command } };
  writeFileSync(join(root, ".stryker", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const result = spawnSync("npx", ["-y", "-p", STRYKER, "stryker", "run", ".stryker/config.json"], { cwd: root, stdio: "inherit", shell: true });
  process.exit(result.status ?? 1);
}

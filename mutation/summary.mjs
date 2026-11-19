// Mutation testing の結果を、ファイルごとの表にする（docs/mutation-runs.md に足す行の材料）。
//   node mutation/summary.mjs            mutator の結果（mutation/report/mutation.json）
//   node mutation/summary.mjs --compare  mutator と StrykerJS（.stryker/report.json）の結果を、同じファイルで比べる
// 「気づかない」は Survived と NoCoverage の合計（StrykerJS の command runner は、この 2 つを分けられない）。
// 比べるときは、どちらかのツールだけで「気づかない」になった行を出す。多ければ、どちらかの不具合を疑う
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DETECTED = ["Killed", "Timeout", "RuntimeError", "CompileError"];
const UNDETECTED = ["Survived", "NoCoverage"];

// mutation-testing-elements の形の報告を、ファイル名（root からの相対、/ 区切り）→ 変異の一覧にする
function load(path) {
  if (!existsSync(join(root, path))) {
    console.error(`結果がありません: ${path}`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(join(root, path), "utf8"));
  return new Map(Object.entries(report.files).map(([file, data]) => [relative(root, join(root, file)).split("\\").join("/"), data.mutants]));
}

const count = (mutants, statuses) => mutants.filter((mutant) => statuses.includes(mutant.status)).length;
const lines = (mutants, statuses) => new Set(mutants.filter((mutant) => statuses.includes(mutant.status)).map((mutant) => mutant.location.start.line));

// 点数は、全体を回した結果のときだけ出す（--since で差分だけを回すと、ほかは Pending のままで、点数にならない）
function row(file, mutants) {
  const detected = count(mutants, DETECTED);
  const undetected = count(mutants, UNDETECTED);
  const pending = count(mutants, ["Pending"]);
  const score = pending || !(detected + undetected) ? "-" : `${((detected / (detected + undetected)) * 100).toFixed(1)}%`;
  return `| ${file} | ${score} | ${mutants.length} | ${count(mutants, ["Killed"])} | ${count(mutants, ["Timeout"])} | ${count(mutants, ["Survived"])} | ${count(mutants, ["NoCoverage"])} | ${pending} |`;
}

const mutator = load("mutation/report/mutation.json");
if (!process.argv.includes("--compare")) {
  console.log("| ファイル | 点数 | 変異 | Killed | Timeout | Survived | NoCoverage | Pending |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const [file, mutants] of mutator) {
    console.log(row(file, mutants));
  }
} else {
  const stryker = load(".stryker/report.json");
  console.log("| ファイル | 気づかない（mutator / Stryker） | mutator だけで気づかない行 | Stryker だけで気づかない行 |");
  console.log("|---|---|---|---|");
  for (const [file, theirs] of stryker) {
    const ours = mutator.get(file);
    if (!ours) {
      console.log(`| ${file} | mutator の結果がない | | |`);
      continue;
    }
    // 両方が変異を作った行だけで比べる（変異の作り方が違う行は比べない）
    const oursAll = lines(ours, [...DETECTED, ...UNDETECTED]);
    const theirsAll = lines(theirs, [...DETECTED, ...UNDETECTED]);
    const oursMissed = lines(ours, UNDETECTED);
    const theirsMissed = lines(theirs, UNDETECTED);
    const onlyOurs = [...oursMissed].filter((line) => !theirsMissed.has(line) && theirsAll.has(line)).sort((a, b) => a - b);
    const onlyTheirs = [...theirsMissed].filter((line) => !oursMissed.has(line) && oursAll.has(line)).sort((a, b) => a - b);
    console.log(`| ${file} | ${count(ours, UNDETECTED)} / ${count(theirs, UNDETECTED)} | ${onlyOurs.join(", ") || "なし"} | ${onlyTheirs.join(", ") || "なし"} |`);
  }
}

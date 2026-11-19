// Mutation testing（mizchi/mutator）を、リポジトリの直下を root にして動かす。
//   node mutation/run.mjs app/geometry.js app/schedule.js   （指定したファイルだけ）
//   node mutation/run.mjs                                    （mutator.config.json の include をすべて）
//   node mutation/run.mjs --since HEAD                       （コミットしていない変更の所だけ。mutator の引数はそのまま渡す）
//   node mutation/run.mjs accept <key> --reason "理由"       （Kill できない変異を記録する。mutator.accepted.json をコミットする）
// 先に一度、npm --prefix mutation ci で mutator と Vitest を入れる。
// 対象は mutator.config.json の include。結果は mutation/report/index.html（Survived は mutation.json にもある）
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(here, "node_modules", "@mizchi", "mutator", "dist", "cli.js");
if (!existsSync(cli)) {
  console.error("mutator が入っていません。先に npm --prefix mutation ci を実行してください。");
  process.exit(1);
}

// - で始まらない引数（と、その前の引数の値でないもの）は、変異させるファイルとみなして --include にする
const VALUED = new Set(["--since", "--include", "--exclude", "--reporter", "--report-dir", "--only", "--critical", "--time-budget", "--threshold-break", "-j", "--concurrency", "--max-workers", "--mutants-per-line", "--shard", "--scope"]);
const args = process.argv.slice(2);
const passed = [];
// accept（Kill できない変異を、理由を付けて mutator.accepted.json に記録する）と select-tests は、そのまま渡す
const SUBCOMMANDS = new Set(["accept", "select-tests"]);
if (SUBCOMMANDS.has(args[0])) {
  passed.push(...args);
  args.length = 0;
}
for (let i = 0; i < args.length; i += 1) {
  if (VALUED.has(args[i])) {
    passed.push(args[i], args[i + 1]);
    i += 1;
  } else if (args[i].startsWith("-")) {
    passed.push(args[i]);
  } else {
    passed.push("--include", args[i]);
  }
}

const common = ["--root", root, "--config-file", "mutation/mutator.config.json"];
const command = SUBCOMMANDS.has(passed[0]) ? [passed[0], ...common, ...passed.slice(1)] : [...common, ...passed];
const result = spawnSync(process.execPath, [cli, ...command], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);

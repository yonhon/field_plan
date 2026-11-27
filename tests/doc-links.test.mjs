// 文書の参照が、あるファイルと、ある見出しを指していることのテスト。実行: node --test "tests/*.test.mjs"
// 確かめる形は 3 つ。
//   [文](file.md)          … リンクの先のファイルがある
//   [文](file.md)の「見出し」 … そのファイルに、その見出しがある
//   docs/x.md の「見出し」、`docs/x.md`, section "見出し" … 文やコメントで書いた参照（リポジトリの直下からのパス）
// 見出しの名前を変えたり、節をほかのファイルへ移したりしたときの、参照の直し漏れに気づくため。
import { test } from "./test-api.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT = /(\.(md|js|mjs|ts|py|sql|yml|yaml|json|html|toml)|(^|\/)\.gitignore)$/;
// 過去の記録は、そのときの名前のまま残すので見ない。このファイルも、書き方の例を持つので見ない
// （コミットの前は git ls-files に入らないので、外し忘れはコミットしたあとで初めて落ちる）
const SKIP = new Set(["docs/e2e-runs.md", "docs/mutation-runs.md", "docs/perf-runs.md", "app/updates.json", "tests/doc-links.test.mjs"]);

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((path) => TEXT.test(path) && !SKIP.has(path) && !path.startsWith("app/vendor/"));
}

function headings(markdown) {
  const out = new Set();
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    else if (!fence && /^#{1,6} /.test(line)) out.add(line.replace(/^#+ /, "").trim());
  }
  return out;
}

// 1 つのファイルの参照を拾う。target はリポジトリの直下からのパス、heading はなければ null
function references(path, text) {
  const refs = [];
  // 書き方の例（空白か ] を含むインラインのコード）は参照ではないので外す。`docs/x.md` のようなパスだけのコードは残す
  if (path.endsWith(".md")) text = text.replace(/(`+)([^`\n]+?(?:`[^`\n]+?)*?)\1(?!`)/g, (span, _, body) => (/[\s\]]/.test(body) ? "" : span));
  if (path.endsWith(".md")) {
    for (const m of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)(?:\s?の\s?「([^」]+)」)?/g)) {
      if (/^[a-z]+:/.test(m[1])) continue;
      refs.push({ target: normalize(join(dirname(path), m[1])).replaceAll("\\", "/"), heading: m[2] ?? null, text: m[0] });
    }
  }
  // Markdown のリンクの中（](docs/…)）は上で拾うので、ここでは外す
  for (const m of text.matchAll(/(?<![\w/.-])(?<!\]\()`?((?:docs\/[\w/.-]+|AGENTS|README|CLAUDE)\.md)`?(?: の「([^」]+)」|, section "([^"]+)")/g)) {
    refs.push({ target: m[1], heading: m[2] ?? m[3], text: m[0] });
  }
  return refs;
}

test("文書の参照は、あるファイルと、そのファイルにある見出しを指す", () => {
  const cache = new Map();
  const headingsOf = (target) => {
    if (!cache.has(target)) cache.set(target, headings(readFileSync(join(ROOT, target), "utf8")));
    return cache.get(target);
  };
  const wrong = [];
  let count = 0;
  for (const path of trackedFiles()) {
    for (const ref of references(path, readFileSync(join(ROOT, path), "utf8"))) {
      count += 1;
      if (!existsSync(join(ROOT, ref.target))) wrong.push(`${path}: ないファイル ${ref.text}`);
      else if (ref.heading && !headingsOf(ref.target).has(ref.heading)) wrong.push(`${path}: ${ref.target} にない見出し「${ref.heading}」`);
    }
  }
  assert.ok(count > 30, `拾えた参照が少ない（${count}）`);
  assert.deepEqual(wrong, []);
});

test("参照の読み取り: リンク、見出し付きのリンク、文の中の参照", () => {
  const md = [
    "[日程](schedule.md)を見る。",
    "[収支](revenue.md)の「収量と売上の見込み」",
    "[外](https://example.com/a.md)",
    "docs/development.md の「jev-lint」に。",
    '(`docs/development.md`, section "Mutation testing")',
    "AGENTS.md の「Checks」",
    '# jev-lint: check (docs/development.md, section "jev-lint").',
    "書き方の例: `[文](file.md)の「見出し」`、`docs/x.md の「見出し」`、`` `docs/x.md`, section \"見出し\" ``",
  ].join("\n");
  assert.deepEqual(
    references("docs/manual/x.md", md).map((r) => [r.target, r.heading]),
    [
      ["docs/manual/schedule.md", null],
      ["docs/manual/revenue.md", "収量と売上の見込み"],
      ["docs/development.md", "jev-lint"],
      ["docs/development.md", "Mutation testing"],
      ["AGENTS.md", "Checks"],
      ["docs/development.md", "jev-lint"],
    ],
  );
  assert.deepEqual([...headings("# A\n\n## B\n```\n## コードの中\n```\n### C\n")], ["A", "B", "C"]);
});

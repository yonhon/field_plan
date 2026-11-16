// アプリの一式の「版の印」（app/version.json）を作る。公開の手順（.github/workflows/deploy_app.yml）が使う。
// Service Worker（app/sw.js）は、まずこのファイルだけを取って、手元の一式と同じ版かを確かめ、
// 違えば、変わったファイルだけを取り直し、どのファイルもここにあるハッシュと照らし合わせてから入れ替える。
//   node scripts/build-version.mjs                    app/version.json を作る（リポジトリにはコミットしない）
//   node scripts/build-version.mjs --verify <URL>     公開中のサイトが、作った version.json と同じ中身を配っているかを確かめる
// 一式の一覧は app/sw.js の FILES。中身は { version, label, no, files: { ファイル: SHA-256 } }。
// version は、ファイルとハッシュの組から作るので、中身が同じなら同じ、1 文字でも違えば違う。
// label は画面に出す版（A199-3f9c2）。番号は更新の一覧（app/updates.json）の最後の番号
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "app");
export const VERSION_FILE = "version.json";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

// app/sw.js の FILES（一式の一覧）
export function appFiles(swSource = readFileSync(join(APP, "sw.js"), "utf8")) {
  const list = swSource.match(/const FILES = (\[[\s\S]*?\]);/)?.[1];
  if (!list) {
    throw new Error("app/sw.js に FILES が見つかりません");
  }
  return JSON.parse(list.replace(/,\s*\]/, "]"));
}

// 一覧のファイル名を、app/ の中のファイルにする（"./" は画面そのもの）
const pathOf = (appDir, file) => join(appDir, file === "./" ? "index.html" : file);

export function buildVersion({ appDir = APP, files = appFiles(), no }) {
  const hashes = {};
  for (const file of files) {
    const path = pathOf(appDir, file);
    if (!existsSync(path)) {
      throw new Error(`一式の一覧（app/sw.js の FILES）にある ${file} がありません`);
    }
    hashes[file] = sha256(readFileSync(path));
  }
  const version = sha256(files.map((file) => `${file}:${hashes[file]}`).join("\n")).slice(0, 12);
  return { version, label: `A${no}-${version.slice(0, 5)}`, no, files: hashes };
}

function lastUpdateNo(appDir = APP) {
  const updates = JSON.parse(readFileSync(join(appDir, "updates.json"), "utf8"));
  return Math.max(...updates.map((update) => update.no));
}

// 公開中のサイトが、info（作った version.json）と同じ中身を配っているか。違うファイルの名前を返す（空なら同じ）。
// 配信の途中のキャッシュを通らないよう、URL に印を付けて取る
export async function differences(baseUrl, info, fetchImpl = fetch) {
  const bust = `v=${info.version}-${Date.now()}`;
  const wrong = [];
  const served = await fetchImpl(new URL(`${VERSION_FILE}?${bust}`, baseUrl)).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  if (served?.version !== info.version) {
    wrong.push(VERSION_FILE);
  }
  await Promise.all(
    Object.entries(info.files).map(async ([file, hash]) => {
      const response = await fetchImpl(new URL(`${file}?${bust}`, baseUrl)).catch(() => null);
      const body = response?.ok ? Buffer.from(await response.arrayBuffer()) : null;
      if (!body || sha256(body) !== hash) {
        wrong.push(file);
      }
    })
  );
  return wrong.sort();
}

async function main() {
  const args = process.argv.slice(2);
  const target = join(APP, VERSION_FILE);
  if (args[0] === "--verify") {
    const baseUrl = args[1];
    if (!baseUrl) {
      throw new Error("--verify には、公開中のサイトの URL を渡します");
    }
    const info = JSON.parse(readFileSync(target, "utf8"));
    // 公開してから配信が切り替わるまで、少し待つことがある。20 秒おきに、5 分まで確かめ直す
    for (let attempt = 1; ; attempt += 1) {
      const wrong = await differences(baseUrl, info);
      if (!wrong.length) {
        console.log(`公開中のサイトは、版 ${info.label}（${Object.keys(info.files).length} 個）を配っています`);
        return;
      }
      if (attempt >= 15) {
        throw new Error(`公開中のサイトの中身が、版 ${info.label} と違います: ${wrong.join(", ")}`);
      }
      console.log(`まだ違います（${attempt} 回目）: ${wrong.join(", ")}`);
      await new Promise((resolve) => setTimeout(resolve, 20000));
    }
  }
  const info = buildVersion({ no: lastUpdateNo() });
  writeFileSync(target, `${JSON.stringify(info, null, 2)}\n`);
  console.log(`app/${VERSION_FILE} を作りました: 版 ${info.label}（${Object.keys(info.files).length} 個）`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

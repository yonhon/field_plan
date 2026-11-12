// 県のページ（scripts/news.mjs の NEWS_SOURCES）を読み、まだ DB の field.news にない記事を足す。
// その出典の記事が DB に 1 件もないとき（初めて読むとき）は、いま載っている記事を確認済みとして入れる
// （それより後に載った記事だけが、画面のニュースの未読に出る）。
//
// 使い方: FIELD_IMPORTER_EMAIL=... FIELD_IMPORTER_PASSWORD=... node scripts/fetch-news.mjs
// 取り込み係の利用者でログインする。GitHub Actions（.github/workflows/news.yml）が 1 日 2 回動かす
import { readFileSync } from "node:fs";
import { localToday } from "../app/schedule.js";
import { NEWS_SOURCES } from "./news.mjs";

const config = readFileSync(new URL("../app/config.js", import.meta.url), "utf8");
const url = /supabaseUrl:\s*"([^"]+)"/.exec(config)[1];
const key = /supabaseAnonKey:\s*"([^"]+)"/.exec(config)[1];

async function call(method, path, body, token, prefer) {
  const response = await fetch(url + path, {
    method,
    headers: {
      apikey: key,
      "Content-Type": "application/json",
      "Accept-Profile": "field",
      "Content-Profile": "field",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path.split("?")[0]}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// 日本時間の今日（GitHub Actions の時計は UTC）
const today = localToday(new Date(Date.now() + 9 * 3600 * 1000 + new Date().getTimezoneOffset() * 60000));

const { access_token: token } = await call("POST", "/auth/v1/token?grant_type=password", {
  email: process.env.FIELD_IMPORTER_EMAIL,
  password: process.env.FIELD_IMPORTER_PASSWORD,
});

let failed = false;
for (const source of NEWS_SOURCES) {
  try {
    const response = await fetch(source.url);
    if (!response.ok) {
      throw new Error(`${response.status}`);
    }
    const items = source.parse(await response.text(), source.url, today);
    const known = new Set(
      (await call("GET", `/rest/v1/news?select=key&source=eq.${source.id}`, undefined, token)).map((row) => row.key)
    );
    const now = new Date().toISOString();
    const first = !known.size;
    const fresh = [...new Map(items.filter((item) => !known.has(item.key)).map((item) => [item.key, item])).values()].map(
      (item) => ({ ...item, first_seen: now, read_at: first ? now : null })
    );
    if (fresh.length) {
      await call("POST", "/rest/v1/news?on_conflict=key", fresh, token, "resolution=ignore-duplicates,return=minimal");
    }
    console.log(`${source.name}: ${items.length} 件を読み、${fresh.length} 件を足しました${first && fresh.length ? "（初めてなので確認済みとして）" : ""}`);
  } catch (error) {
    failed = true;
    console.error(`${source.name}（${source.url}）: ${error.message}`);
  }
}
if (failed) {
  process.exit(1);
}

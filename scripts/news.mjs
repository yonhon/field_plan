// 県のページから、ニュースの記事を読み取る部品。scripts/fetch-news.mjs が使い、tests/news.test.mjs が確かめる。
// ページの作りが変わって読めなくなったときは、見出しが見つからないことを知らせる（黙って 0 件にしない）
export const NEWS_SOURCES = [
  {
    id: "nogyo",
    name: "病害虫防除技術センター",
    url: "https://www.pref.okinawa.jp/shigoto/nogyo/1010700/index.html",
    parse: parseUpdates,
  },
  {
    id: "kenkyu",
    name: "農業研究センター",
    url: "https://www.pref.okinawa.jp/shigoto/kenkyu/1010703/index.html",
    parse: parseNotices,
  },
];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

// HTML の文字の書き方（&amp; など）を、元の文字に戻す
const decode = (text) =>
  String(text).replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (all, name) =>
    ENTITIES[name] ?? (name[0] === "#" ? String.fromCodePoint(name[1] === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : all)
  );

// タグを除いた文。空白はまとめる
export function plainText(html) {
  return decode(String(html).replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

// リンクの href を、URL にする。href の中の &amp; は & に戻す（戻さないと、違う URL になる）。
// http と https のほか（javascript: など）は、画面でリンクにすると押したときに動いてしまうので、null を返す
export function linkUrl(href, pageUrl) {
  try {
    const url = new URL(decode(href).trim(), pageUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const firstLink = (html) => /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(html);
const pad = (n) => String(n).padStart(2, "0");

// 「11月10日（火曜日）」のように年のない日付。today（YYYY-MM-DD）より 1 か月以上先になるなら、前の年
export function monthDay(text, today) {
  const match = /(\d{1,2})月(\d{1,2})日/.exec(text);
  if (!match) {
    return null;
  }
  let year = Number(today.slice(0, 4));
  const date = (y) => `${y}-${pad(match[1])}-${pad(match[2])}`;
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + 31);
  if (date(year) > limit.toISOString().slice(0, 10)) {
    year -= 1;
  }
  return date(year);
}

// 「（2026.11.2）」「2026年11月2日」のように年のある日付
export function fullDate(text) {
  const match = /(\d{4})[.年/](\d{1,2})[.月/](\d{1,2})/.exec(text);
  return match ? `${match[1]}-${pad(match[2])}-${pad(match[3])}` : null;
}

// 病害虫防除技術センターの「新着更新情報」。li ごとに、日付・新着か更新か・リンク。
// 同じページが更新されると、同じリンクが新しい日付で載るので、日付も含めて見分ける
export function parseUpdates(html, pageUrl, today) {
  const start = html.search(/<div class="news">/);
  if (start < 0 || !/新着更新情報/.test(html.slice(start, start + 300))) {
    throw new Error("「新着更新情報」の欄が見つかりません");
  }
  const end = html.indexOf("</ul>", start);
  const items = [];
  for (const [, li] of html.slice(start, end < 0 ? undefined : end).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const link = firstLink(li);
    if (!link) {
      continue;
    }
    const url = linkUrl(link[1], pageUrl);
    if (!url) {
      continue;
    }
    const posted = monthDay(plainText(/class="date"[^>]*>([\s\S]*?)<\/span>/i.exec(li)?.[1] || ""), today);
    items.push({
      key: `nogyo|${posted || ""}|${url}`,
      source: "nogyo",
      title: plainText(link[2]),
      url,
      posted,
      label: plainText(/class="label\w*"[^>]*>([\s\S]*?)<\/span>/i.exec(li)?.[1] || ""),
    });
  }
  return items;
}

// 農業研究センターの「お知らせ」。次の h2 までの h3 が 1 件ずつ。リンクは見出しの下の最初のもの（なければこのページ）
export function parseNotices(html, pageUrl) {
  const head = /<h2[^>]*>\s*お知らせ\s*<\/h2>/i.exec(html);
  if (!head) {
    throw new Error("「お知らせ」の欄が見つかりません");
  }
  const rest = html.slice(head.index + head[0].length);
  const next = rest.search(/<h2[\s>]/i);
  const section = next < 0 ? rest : rest.slice(0, next);
  const items = [];
  for (const part of section.split(/(?=<h3[\s>])/i).filter((chunk) => /^<h3/i.test(chunk))) {
    const close = part.search(/<\/h3>/i);
    const title = plainText(part.slice(0, close));
    if (!title) {
      continue;
    }
    const link = firstLink(part.slice(close));
    items.push({
      key: `kenkyu|${title}`,
      source: "kenkyu",
      title,
      url: (link && linkUrl(link[1], pageUrl)) || pageUrl,
      posted: fullDate(title),
      label: "",
    });
  }
  return items;
}

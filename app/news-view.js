// 圃場図の上のタブの「ニュース」。県のページに載った記事（field.news。scripts/fetch-news.mjs が 1 日 2 回足す）を、
// 未読と既読に分けて出す。未読があれば、タブの名前の後ろに ⚠ と件数を出す。「確認」を押した記事は既読へ移る
import { draw } from "./draw.js";
import { escapeHtml } from "./html.js";

const $ = (id) => document.getElementById(id);
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const SOURCE_NAMES = { nogyo: "病害虫防除技術センター", kenkyu: "農業研究センター" };
const READ_SHOWN = 30; // 既読に出す件数（確認した新しい順）

let ctx = null;
let items = [];
let showRead = false;
let loading = null;

function formatDay(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${month}/${day}（${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}）`;
}

const unread = () => items.filter((item) => !item.read_at);

// 載った日の新しい順。日付のない記事は、見つけた日で並べる
const sortKey = (item) => item.posted || String(item.first_seen || "").slice(0, 10);

export function renderNews() {
  const fresh = unread().sort((a, b) => sortKey(b).localeCompare(sortKey(a)) || a.key.localeCompare(b.key));
  const read = items.filter((item) => item.read_at).sort((a, b) => String(b.read_at).localeCompare(String(a.read_at)));
  $("newsBadge").textContent = `⚠${fresh.length}`;
  $("newsBadge").hidden = !fresh.length;
  $("newsTitle").textContent = showRead ? `既読（${read.length} 件）` : `未読（${fresh.length} 件）`;
  $("newsToggle").textContent = showRead ? "未読を見る" : "既読を見る";
  const shown = showRead ? read.slice(0, READ_SHOWN) : fresh;
  $("newsEmpty").textContent = showRead
    ? "確認したニュースはありません。"
    : "未読のニュースはありません。病害虫防除技術センターの「新着更新情報」と、農業研究センターの「お知らせ」に新しい記事が載ると、ここに出ます。";
  $("newsEmpty").hidden = shown.length > 0;
  draw(
    $("newsList"),
    shown
      .map(
        (item) =>
          `<li data-news="${escapeHtml(item.key)}">` +
          `<span class="week-date news-date">${item.posted ? formatDay(item.posted) : ""}</span>` +
          // リンクにするのは http と https だけ（取り込みでも確かめているが、DB の値をそのまま信じない）
          `<span class="news-title">${
            /^https?:\/\//i.test(item.url)
              ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>`
              : escapeHtml(item.title)
          }` +
          `${item.label ? `<span class="news-label">${escapeHtml(item.label)}</span>` : ""}</span>` +
          `<span class="muted">${escapeHtml(SOURCE_NAMES[item.source] || item.source)}</span>` +
          `<span class="week-actions">${
            item.read_at
              ? `<button class="text-btn" data-news-act="unread">未読に戻す</button>`
              : `<button class="primary-btn" data-news-act="read" title="既読に移します">確認</button>`
          }</span></li>`
      )
      .join("")
  );
}

// DB から読み直す。読めなかったときは、前に読んだ分のまま
export function loadNews() {
  loading ||= (async () => {
    try {
      items = await ctx.state.store.loadNews();
    } catch (error) {
      console.warn("ニュースを読めませんでした", error);
    } finally {
      loading = null;
    }
    renderNews();
  })();
  return loading;
}

async function mark(key, readAt) {
  const item = items.find((entry) => entry.key === key);
  if (!item) {
    return;
  }
  const before = item.read_at;
  item.read_at = readAt;
  renderNews();
  try {
    await ctx.state.store.markNews([key], readAt);
  } catch (error) {
    item.read_at = before;
    renderNews();
    ctx.setStatus(`ニュースの確認を保存できませんでした: ${error.message || error}`);
  }
}

export function initNews(context) {
  ctx = context;
  $("newsToggle").addEventListener("click", () => {
    showRead = !showRead;
    renderNews();
  });
  $("newsList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-news-act]");
    const row = button?.closest("[data-news]");
    if (row) {
      mark(row.dataset.news, button.dataset.newsAct === "read" ? new Date().toISOString() : null);
    }
  });
  // しばらく開いたままの画面に戻ったときも、新しい記事を拾う
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadNews();
    }
  });
  renderNews();
  loadNews();
}

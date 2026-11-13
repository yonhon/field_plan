// 「日記」の画面（docs/actuals-plan.md の 11.1）。農作業日記を 1 日ずつ書き、カレンダーで日か月を選んで読み、語で探す。
// 日記は圃場ごとではなく共通。画面の状態は view に持ち、描くときは view から HTML を作る（docs/implementation-rules.md）。
// 書いている本文は、打つたびに view と端末の中（書きかけ）に入れるだけで、入れ物は描き直さない（日本語の変換が切れるため）。
import { confirmAction, notify, notifySaveFailed } from "./dialog.js";
import { draw } from "./draw.js";
import {
  PHOTO_PLACEHOLDER,
  PHOTO_TAG_KINDS,
  PHOTO_QUALITY,
  WEEKDAYS,
  calendarDays,
  dateLabel,
  monthChoices,
  exifDateTime,
  insertBlock,
  nextPhotoName,
  pathKey,
  periodLabel,
  periodOf,
  photoMarkdown,
  photoNames,
  sectionBlocks,
  photoPath,
  photoSize,
  renderMarkdown,
  replacePlaceholder,
  searchWords,
  shiftPeriod,
  snippetHtml,
  splitSections,
  TAG_KINDS,
  toggleHeading,
} from "./diary.js";
import { WORK_COLORS, localToday, workName } from "./schedule.js";
import { specText } from "./logs.js";
import { inputHtml } from "./pesticide.js";
import { openLogEditor } from "./log-view.js";
import { escapeHtml } from "./html.js";

const $ = (id) => document.getElementById(id);
const DRAFTS_KEY = "field_plan_diary_drafts";
const MODES = [
  ["day", "日"],
  ["month", "月"],
];

let ctx = null; // { state, setStatus }
const view = {
  mode: "day",
  date: null, // 選んでいる日。月は、この日を含む月
  month: null, // カレンダーに出している月（YYYY-MM）
  calendar: new Map(), // 日付 → { title, photos }
  calendarKey: null,
  firstDate: undefined, // いちばん古い日記の日。undefined はまだ読んでいない、null は日記がない
  days: [], // 選んだ期間の日記
  daysKey: null,
  loading: false,
  query: "",
  results: null, // 検索の結果。null なら検索していない
  // タグの一覧（札を押したとき）。null なら出していない。filters は [{ kind, name, id? }]（対象は id で絞る）
  tagView: null, // { filters, oldest, sections, total, loading, error, token }
  tagNames: null, // { crops, work, place, issues, stage, topic }（言葉の一覧）
  tagEdit: null, // { date, key, values: { crops: [...], ... } }
  editing: null, // { date, title, body, tags, expected, preview, cursor, known: [...], note }
  uploading: "",
  urls: {}, // 置き場の中の場所 → 署名付き URL
  asked: new Set(), // URL を頼んだ場所（同じものを何度も頼まない）
  meta: {}, // 写真の名前 → { taken_at, original_name }
};

// ---- 書きかけ（端末の中に残す） ----

function readDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeDraft(date, draft) {
  const drafts = readDrafts();
  if (draft) {
    drafts[date] = draft;
  } else {
    delete drafts[date];
  }
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // 残せなくても、画面の中の内容は保存できる
  }
}

// 保存していない書きかけがあるか（ログアウトの前に確かめる）
export function hasDiaryDrafts() {
  return Object.keys(readDrafts()).length > 0;
}

// 書きかけをすべて消す（ログアウトのとき。日記にはほかの方の名前も入るので、端末に残さない）
export function clearDiaryDrafts() {
  try {
    localStorage.removeItem(DRAFTS_KEY);
  } catch {
    // 消せなくても、ログアウトは続ける
  }
}

function keepDraft() {
  const e = view.editing;
  if (e) {
    writeDraft(e.date, { title: e.title, body: e.body, expected: e.expected, at: new Date().toISOString() });
  }
}

// ---- 読み込み ----

async function loadCalendar() {
  const days = calendarDays(view.month);
  const key = `${days[0]}|${days[days.length - 1]}`;
  const rows = await ctx.state.store.diaryCalendar(days[0], days[days.length - 1]);
  view.calendar = new Map(rows.map((row) => [row.date, row]));
  view.calendarKey = key;
}

async function loadPeriod() {
  const { from, to } = periodOf(view.mode, view.date);
  view.days = await ctx.state.store.diaryDays(from, to);
  view.daysKey = `${from}|${to}`;
  for (const day of view.days) {
    Object.assign(view.meta, day.photos || {});
  }
}

// 足りないものを読み込んでから描く。読み込みの失敗は、画面に出す
async function refresh({ calendar = false, period = false } = {}) {
  if (calendar) {
    view.calendarKey = null;
  }
  if (period) {
    view.daysKey = null;
  }
  renderDiary();
}

let loadingPromise = null;
function ensureLoaded() {
  const days = calendarDays(view.month);
  const calendarKey = `${days[0]}|${days[days.length - 1]}`;
  const { from, to } = periodOf(view.mode, view.date);
  const daysKey = `${from}|${to}`;
  const tasks = [];
  if (view.calendarKey !== calendarKey) {
    tasks.push(loadCalendar());
  }
  if (view.daysKey !== daysKey) {
    tasks.push(loadPeriod());
  }
  if (!view.tagNames) {
    tasks.push(ctx.state.store.diaryTagNames().then((names) => (view.tagNames = names)));
  }
  if (view.firstDate === undefined) {
    tasks.push(ctx.state.store.diaryFirstDate().then((date) => (view.firstDate = date)));
  }
  if (!tasks.length || loadingPromise) {
    return;
  }
  view.loading = true;
  loadingPromise = Promise.all(tasks)
    .catch((error) => {
      ctx.setStatus(`日記を読み込めませんでした: ${error.message}`);
      // 同じ失敗を繰り返さないよう、読んだことにする
      view.calendarKey = calendarKey;
      view.daysKey = daysKey;
      view.tagNames ||= Object.fromEntries(TAG_KINDS.map(([kind]) => [kind, []]));
      if (view.firstDate === undefined) {
        view.firstDate = null;
      }
    })
    .finally(() => {
      view.loading = false;
      loadingPromise = null;
      renderDiary();
    });
}

// 描いた写真のうち、URL がまだないものを頼み、届いたら描き直す
function requestUrls(names) {
  const paths = names.map(photoPath).filter((path) => !view.urls[path] && !view.asked.has(path));
  if (!paths.length) {
    return;
  }
  paths.forEach((path) => view.asked.add(path));
  ctx.state.store
    .diaryPhotoUrls(paths)
    .then((urls) => {
      Object.assign(view.urls, urls);
      if (Object.keys(urls).length) {
        drawMain();
      }
    })
    .catch((error) => ctx.setStatus(`写真を読み込めませんでした: ${error.message}`));
}

// ---- 描く ----

function photoHtml(name, alt) {
  const url = view.urls[photoPath(name)];
  const label = escapeHtml(alt || `写真 ${name}`);
  return url
    ? `<button type="button" class="diary-photo" data-action="photo" data-photo="${escapeHtml(name)}"><img src="${escapeHtml(url)}" alt="${label}" loading="lazy" /></button>`
    : `<button type="button" class="diary-photo is-loading" data-action="photo" data-photo="${escapeHtml(name)}"><span>${label}</span></button>`;
}

function renderModes() {
  draw(
    $("diaryModes"),
    MODES.map(([mode, label]) => `<button type="button" class="chip-btn${view.mode === mode ? " is-on" : ""}" data-mode="${mode}">${label}</button>`).join("")
  );
}

function renderCalendar() {
  const today = localToday();
  const { from, to } = periodOf(view.mode, view.date);
  const head = [1, 2, 3, 4, 5, 6, 0].map((day) => `<span class="diary-weekday${day === 0 ? " is-sunday" : day === 6 ? " is-saturday" : ""}">${WEEKDAYS[day]}</span>`).join("");
  const cells = calendarDays(view.month)
    .map((date) => {
      const entry = view.calendar.get(date);
      const classes = [
        "diary-cell",
        date.slice(0, 7) !== view.month ? "is-other" : "",
        date === today ? "is-today" : "",
        date >= from && date <= to ? "is-picked" : "",
        entry ? "has-entry" : "",
      ].filter(Boolean);
      const label = `${dateLabel(date)}${entry ? `、日記あり${entry.photos ? `、写真 ${entry.photos} 枚` : ""}` : ""}`;
      return (
        `<button type="button" class="${classes.join(" ")}" data-date="${date}" aria-label="${label}">` +
        `<span class="diary-cell-day">${Number(date.slice(8))}</span>` +
        `${entry ? `<span class="diary-cell-mark">${entry.photos ? `●<small>${entry.photos}</small>` : "●"}</span>` : ""}</button>`
      );
    })
    .join("");
  draw(
    $("diaryCalendar"),
    // 「‹ 年月 ›」はカレンダーの幅の中央に、「今日」は右端に置く
    `<div class="diary-month"><div class="diary-month-nav">` +
      `<button type="button" class="text-btn" data-month="-1" aria-label="前の月">‹</button>` +
      monthSelectHtml(today) +
      `<button type="button" class="text-btn" data-month="1" aria-label="次の月">›</button></div>` +
      `<button type="button" class="chip-btn" data-action="today">今日</button>` +
      `</div><div class="diary-grid">${head}${cells}</div>`
  );
}

// 年月を押すと、年月のリストが開く。いちばん古い日記の月から、今月（か、出している月）まで
function monthSelectHtml(today) {
  const months = [view.month, today.slice(0, 7), view.firstDate?.slice(0, 7)].filter(Boolean).sort();
  const groups = new Map();
  for (const month of monthChoices(months[0], months[months.length - 1])) {
    const year = month.slice(0, 4);
    groups.set(year, [...(groups.get(year) || []), month]);
  }
  const options = [...groups]
    .map(
      ([year, list]) =>
        `<optgroup label="${year}年">${list
          .map((month) => `<option value="${month}"${month === view.month ? " selected" : ""}>${year}年${Number(month.slice(5))}月</option>`)
          .join("")}</optgroup>`
    )
    .join("");
  return `<select id="diaryMonthSelect" class="diary-month-select" aria-label="カレンダーの年月">${options}</select>`;
}

// 節のタグ。Claude Code が本文と写真から付けた推定で、本人が直した節にだけ「（直した）」と出す。
// 対象（field_plan の作付か区画）は、表示名で出す（直すのは Claude に頼む）
const sectionLabels = (section) => section.labels || { crops: section.crops || [], work: section.work || [] };

function tagsHtml(day, section, key) {
  const edit = view.tagEdit;
  if (edit && edit.date === day.date && edit.key === key) {
    const chips = (kind) =>
      (view.tagNames?.[kind] || [])
        .map((name) => `<button type="button" class="chip-btn${edit.values[kind].includes(name) ? " is-on" : ""}" data-tag-kind="${kind}" data-tag-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`)
        .join("");
    return (
      `<div class="diary-tag-edit" data-date="${day.date}" data-key="${escapeHtml(key)}">` +
      TAG_KINDS.map(([kind, label]) => `<p class="muted">${label}</p><div class="log-chips">${chips(kind)}</div>`).join("") +
      `<div class="row"><button type="button" class="primary-btn" data-action="tags-save">保存</button>` +
      `<button type="button" class="text-btn" data-action="tags-auto">Claude のタグに戻す</button>` +
      `<button type="button" class="text-btn" data-action="tags-cancel">やめる</button></div></div>`
    );
  }
  const fixed = section.tag_source === "manual" || Boolean(day.tags?.[key]);
  return (
    `<div class="diary-tags" data-date="${day.date}" data-key="${escapeHtml(key)}">` +
    labelChipsHtml(section, fixed) +
    `<button type="button" class="text-btn" data-action="tags">種類を直す</button></div>`
  );
}

// 節の札。押すと、そのタグの付いた節の一覧を出す（対象は作付か区画の ID で絞る）
function labelChipsHtml(section, fixed) {
  const labels = sectionLabels(section);
  const chips = [
    ...TAG_KINDS.flatMap(([kind]) => (labels[kind] || []).map((name) => ({ kind, name, value: name }))),
    ...(labels.targets || []).map((item) => ({ kind: "targets", name: item.label, value: item.id, targetKind: item.kind })),
  ];
  return (
    (chips.length
      ? chips
          .map(
            (chip) =>
              `<button type="button" class="diary-tag is-${chip.kind}" data-tag-filter="${chip.kind}" data-tag-value="${escapeHtml(chip.value)}" data-tag-label="${escapeHtml(chip.name)}"${chip.targetKind ? ` data-tag-target-kind="${chip.targetKind}"` : ""}>${escapeHtml(chip.name)}</button>`
          )
          .join("")
      : '<span class="muted">種類なし</span>') + (fixed ? '<span class="muted">（直した）</span>' : "")
  );
}

// ---- タグの一覧（札を押したとき） ----

const TAG_PAGE = 20;
const TARGET_PAGE = 100;
const targetFilter = (t) => t?.filters.find((filter) => filter.kind === "targets") || null;

// ---- 対象で絞ったときに差し挟む作業（実績と、まだ終わっていない計画） ----

const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const typeLabel = (code) => (ctx.state.allWorkTypes || []).find((type) => type.code === code)?.label || code;

// 作業の札（例: 防除）で絞っているときは、作業も同じ種類だけにする（日記の作業の言葉は、記録の作業の種類とそろえてある）
function workFilterLabels(t) {
  const names = t.filters.filter((filter) => filter.kind === "work").map((filter) => filter.name);
  return names.length ? new Set(names) : null;
}

function workEntries(t) {
  if (!t.works) {
    return [];
  }
  const only = workFilterLabels(t);
  const keep = (type) => !only || only.has(typeLabel(type));
  return [
    ...t.works.logs.filter((log) => keep(log.work_type)).map((log) => ({ date: log.date, rank: 0, html: workLogHtml(log) })),
    ...t.works.works.filter((work) => keep(work.work_type)).map((work) => ({ date: work.plan_start || "9999-12-31", rank: 1, html: workPlanHtml(work) })),
  ];
}

const workRange = (start, end) => (end && end !== start ? `${dateLabel(start)}〜${shortDate(end)}` : dateLabel(start));
const workDot = (type) => `<span class="diary-work-dot" style="background:${WORK_COLORS[type] || "#9e9e9e"}"></span>`;

// 作業の記録。押すと、作業の記録の窓を開く
function workLogHtml(log) {
  const lines = [escapeHtml(specText(log.work_type, log.spec || {})), ...(log.inputs || []).map(inputHtml), escapeHtml(log.note || "")].filter(Boolean);
  return (
    `<button type="button" class="diary-work is-log" data-action="work-log" data-log-id="${log.id}" data-field-id="${log.field_id}">` +
    `<span class="diary-work-head">${workDot(log.work_type)}<span class="diary-work-date">${workRange(log.date, log.end_date)}</span>` +
    `<b>${escapeHtml(workName(typeLabel(log.work_type), log.spec || {}))}</b>${log.block_work ? '<span class="muted">（区画の作業）</span>' : ""}</span>` +
    (lines.length ? `<span class="diary-work-lines">${lines.join("　")}</span>` : "") +
    "</button>"
  );
}

// まだ終わっていない計画（予定）
function workPlanHtml(work) {
  const when = work.plan_start ? workRange(work.plan_start, work.plan_end) : "日付なし";
  return (
    `<div class="diary-work is-plan">` +
    `<span class="diary-work-head">${workDot(work.work_type)}<span class="diary-work-tag">予定</span><span class="diary-work-date">${when}</span>` +
    `<b>${escapeHtml(workName(typeLabel(work.work_type), work.detail || {}))}</b>${work.block_work ? '<span class="muted">（区画の作業）</span>' : ""}</span>` +
    (work.note ? `<span class="diary-work-lines">${escapeHtml(work.note)}</span>` : "") +
    "</div>"
  );
}

// 日記の節と作業を、日付で混ぜて並べる。同じ日は、作業（実績、予定）→ 日記の順（古い順のとき）
function mergedHtml(t) {
  const entries = [...t.sections.map((section) => ({ date: section.date, rank: 2, html: tagSectionHtml(section) })), ...workEntries(t)];
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.rank - b.rank);
  if (!t.oldest) {
    entries.reverse();
  }
  return entries.map((entry) => entry.html).join("");
}

// 作付の詳細（区画の詳細）から、その作付の日記を開く。対象の札で絞った一覧を、一作の流れを追いやすい古い順で出す。
// 開くのは呼んだ側（showView）
export function openDiaryTarget({ kind, id, label }) {
  view.mode = "day";
  view.results = null;
  view.tagEdit = null;
  view.tagView = { filters: [{ kind: "targets", id, name: label, targetKind: kind }], oldest: true, sections: [], total: 0, loading: false, error: "" };
  loadTagView();
}

// 作業の記録が変わったら（作業の記録の窓で直したとき）、差し挟んでいる作業を読み直す
export function refreshDiaryWorks() {
  if (targetFilter(view.tagView)) {
    keepTagScroll();
    loadTagView({ keep: true });
  }
}
const tagViewKey = (t) => `tags:${JSON.stringify(t.filters)}:${t.oldest}`;

// 節の部分を、その日の本文から見出しで切り出して描く（節の本文には写真の書き込みが入らないため）
// 見出し（##）のまとまりを描く。見出しの下の文に続けて、小見出し（### 以下）とその文を、段の深さだけ下げて並べる。
// tags はまとまりの一番下に出す札（節のタグ）。base は ## を画面の何番目の見出しにするか
function blockHtml(block, tags, base = 4) {
  const headingHtml = (chunk) => {
    if (!chunk.heading) {
      return "";
    }
    const level = Math.min(6, base + chunk.level - (block.level || 2));
    return `<h${level} class="diary-heading">${escapeHtml(chunk.heading)}</h${level}>`;
  };
  const [first, ...subs] = block.chunks;
  // 最初の見出しより前に何も書いていなければ、何も出さない
  if (!first.heading && !first.text.trim() && !subs.length && !tags) {
    return "";
  }
  // 節を始めた見出しの段（見出しのない部分は、その下の小見出しを 1 段下げる）
  const top = block.level || 1;
  const subHtml = subs
    .map((chunk) => `<div class="diary-sub diary-sub-${Math.max(1, Math.min(4, chunk.level - top))}">${headingHtml(chunk)}${renderMarkdown(chunk.text, photoHtml, { headingBase: base })}</div>`)
    .join("");
  return `<div class="diary-section">${headingHtml(first)}${renderMarkdown(first.text, photoHtml, { headingBase: base })}${subHtml}${tags}</div>`;
}

function tagSectionHtml(section) {
  const key = pathKey(section.path);
  const block = sectionBlocks(section.day_body || "").find((item) => item.key === key);
  return (
    `<article class="diary-day" data-date="${section.date}">` +
    `<div class="panel-heading"><h3 class="diary-day-title"><a href="#diary" data-action="open-day" data-date="${section.date}">${dateLabel(section.date)}</a> ${escapeHtml(section.title || "")}</h3>` +
    `<button type="button" class="chip-btn" data-action="edit" data-date="${section.date}" data-key="${escapeHtml(key)}">修正</button></div>` +
    (block ? blockHtml(block, "") : "") +
    tagsHtml(tagDay(section.date), section, key) +
    `</article>`
  );
}

// タグの一覧の節から、その日を作る（「種類を直す」で保存するため）。一覧にその日の節がなければ null
function tagDay(date) {
  const rows = view.tagView?.sections.filter((section) => section.date === date) || [];
  if (!rows.length) {
    return null;
  }
  const [first] = rows;
  return { date, title: first.title || "", body: first.day_body || "", tags: first.day_tags || {}, updated_at: first.updated_at, sections: rows };
}

// 札や「種類を直す」の相手の日。タグの一覧を出しているときは、一覧の節から作る
const dayFor = (date) => (view.tagView ? tagDay(date) : null) || dayOf(date);

// タグの一覧から直しに行くとき、いまの見ている位置を覚えておく（直し終えたら、同じ位置に戻る）
function keepTagScroll() {
  if (view.tagView) {
    view.tagView.scroll = { main: $("diaryMain").scrollTop, page: window.scrollY };
  }
}

// 直し終えたあと、タグの一覧を読み直して、覚えておいた位置に戻る
function returnToTagView() {
  if (view.tagView && !view.editing) {
    loadTagView({ keep: true });
  }
}

function worksCount(t) {
  if (!targetFilter(t) || !t.works) {
    return "";
  }
  const only = workFilterLabels(t);
  const keep = (type) => !only || only.has(typeLabel(type));
  return `、作業の記録 ${t.works.logs.filter((log) => keep(log.work_type)).length} 件、予定 ${t.works.works.filter((work) => keep(work.work_type)).length} 件`;
}

function tagViewHtml() {
  const t = view.tagView;
  const filters = t.filters
    .map(
      (filter, i) =>
        `<button type="button" class="diary-tag is-${filter.kind}" data-action="tag-remove" data-index="${i}" aria-label="${escapeHtml(filter.name)} を外す">${escapeHtml(filter.name)} ×</button>`
    )
    .join("");
  const order = (oldest, label) =>
    `<button type="button" class="chip-btn${t.oldest === oldest ? " is-on" : ""}" data-action="tag-order" data-oldest="${oldest}">${label}</button>`;
  let list;
  if (t.error) {
    list = `<p class="muted">日記を読み込めませんでした: ${escapeHtml(t.error)}</p>`;
  } else if (targetFilter(t) && (t.sections.length || workEntries(t).length)) {
    list = mergedHtml(t);
  } else if (!t.sections.length) {
    list = `<p class="muted">${t.loading ? "読み込んでいます…" : "このタグの付いた節はありません。"}</p>`;
  } else {
    const rest = t.total - t.sections.length;
    list =
      t.sections.map(tagSectionHtml).join("") +
      (rest > 0
        ? `<div class="row"><button type="button" class="chip-btn" data-action="tag-more"${t.loading ? " disabled" : ""}>${t.loading ? "読み込んでいます…" : `続きを出す（残り ${rest} 節）`}</button></div>`
        : "");
  }
  return (
    `<div class="panel-heading"><h2 class="diary-tag-filters">${filters}</h2><button type="button" class="text-btn" data-action="tag-clear">一覧をやめる</button></div>` +
    `<div class="row diary-tag-order"><span class="muted">${t.loading && !t.sections.length ? "" : `${t.total} 節${worksCount(t)}。札を押すと、さらに絞れます`}</span>` +
    `<div class="diary-modes seg" role="group" aria-label="並べる順">${order(false, "新しい順")}${order(true, "古い順")}</div></div>` +
    list
  );
}

// タグの一覧を読む。more なら続きを足す。読んでいるあいだに条件が変わったら、古い結果は捨てる
async function loadTagView({ more = false, keep = false } = {}) {
  const t = view.tagView;
  if (!t) {
    return;
  }
  const token = (t.token = (t.token || 0) + 1);
  t.loading = true;
  if (!more && !keep) {
    t.sections = [];
    t.total = 0;
  }
  // 直し終えて読み直すときは、いま出している節を出したまま読む（画面がちらつかず、位置も保てる）。
  // 対象で絞っているときは、作業と日付で混ぜて並べるので、区切らずに全部（100 節まで）読む
  const target = targetFilter(t);
  const limit = target ? TARGET_PAGE : keep ? Math.max(TAG_PAGE, t.sections.length) : TAG_PAGE;
  drawMain();
  if (keep) {
    restoreTagScroll(t);
  }
  try {
    const worksTask = target && ctx.state.store.diaryTargetWorks ? ctx.state.store.diaryTargetWorks(target.targetKind, target.id) : null;
    const result = await ctx.state.store.diaryTagSections({
      filters: t.filters.map(({ kind, name, id, targetKind }) => (kind === "targets" ? { kind, id, target_kind: targetKind } : { kind, name })),
      oldest: t.oldest,
      limit,
      offset: more ? t.sections.length : 0,
    });
    if (view.tagView !== t || t.token !== token) {
      return;
    }
    const works = worksTask ? await worksTask : null;
    if (view.tagView !== t || t.token !== token) {
      return;
    }
    t.works = works;
    Object.assign(view.meta, result.photos || {});
    t.sections = more ? [...t.sections, ...result.sections] : result.sections;
    t.total = result.total;
    t.error = "";
  } catch (error) {
    if (view.tagView === t && t.token === token) {
      t.error = error.message;
    }
  }
  if (view.tagView === t && t.token === token) {
    t.loading = false;
    drawMain();
    if (keep) {
      restoreTagScroll(t);
    }
  }
}

function restoreTagScroll(t) {
  if (t.scroll) {
    $("diaryMain").scrollTop = t.scroll.main;
    window.scrollTo(0, t.scroll.page);
  }
}

// 札を押したとき。一覧を出していなければ出し、出していれば条件に足す（かつ）
function addTagFilter(kind, value, label, targetKind) {
  const filter = kind === "targets" ? { kind, id: value, name: label, targetKind: targetKind || "planting" } : { kind, name: value };
  const t = view.tagView;
  if (t) {
    if (t.filters.some((item) => item.kind === kind && (item.id ?? item.name) === value)) {
      return;
    }
    t.filters = [...t.filters, filter];
  } else {
    view.tagView = { filters: [filter], oldest: false, sections: [], total: 0, loading: false, error: "" };
  }
  view.results = null;
  view.tagEdit = null;
  renderDiary();
  loadTagView();
}

// 1 日分。見出しごとに、本文と、節の作物・作業の種類を並べる
function dayHtml(day, { single }) {
  const sections = [...(day.sections || [])];
  const parts = sectionBlocks(day.body).map((block) => {
    const at = sections.findIndex((section) => pathKey(section.path) === block.key);
    const section = at >= 0 ? sections.splice(at, 1)[0] : null;
    return blockHtml(block, section ? tagsHtml(day, section, block.key) : "");
  });
  const title = `${single ? "" : `<a href="#diary" data-action="open-day" data-date="${day.date}">${dateLabel(day.date)}</a> `}${escapeHtml(day.title)}`;
  const editButton = (extra) => `<button type="button" class="chip-btn${extra}" data-action="edit" data-date="${day.date}">修正</button>`;
  // 日の表示で題がないときは、題の行を作らない。「編集」は右に寄せ、本文はその横から始める
  const head = single && !day.title.trim()
    ? editButton(" diary-edit-float")
    : `<div class="panel-heading"><h3 class="diary-day-title">${title}</h3>${editButton("")}</div>`;
  return `<article class="diary-day" data-date="${day.date}">${head}${parts.join("")}</article>`;
}

function periodHtml() {
  const single = view.mode === "day";
  const heading =
    `<div class="panel-heading diary-period">` +
    `<button type="button" class="text-btn" data-step="-1">‹ 前の${single ? "日" : "月"}</button>` +
    `<h2>${escapeHtml(periodLabel(view.mode, view.date))}</h2>` +
    `<button type="button" class="text-btn" data-step="1">次の${single ? "日" : "月"} ›</button></div>`;
  if (view.loading && !view.days.length) {
    return `${heading}<p class="muted">読み込んでいます…</p>`;
  }
  if (!view.days.length) {
    return single
      ? `${heading}<p class="muted">この日の日記はまだありません。</p><div class="row"><button type="button" class="primary-btn" data-action="edit" data-date="${view.date}">この日の日記を書く</button></div>`
      : `${heading}<p class="muted">この期間の日記はありません。</p>`;
  }
  return heading + view.days.map((day) => dayHtml(day, { single })).join("");
}

function resultsHtml() {
  const words = searchWords(view.query);
  const items = view.results.map(
    (hit) =>
      `<li><a href="#diary" data-action="open-day" data-date="${hit.date}">${dateLabel(hit.date)}${hit.date.slice(0, 4) !== localToday().slice(0, 4) ? `（${hit.date.slice(0, 4)}年）` : ""}</a>` +
      ` <span>${escapeHtml(hit.title)}</span><p class="diary-snippet">${snippetHtml(`${hit.title}\n${hit.body}`, words)}</p></li>`
  );
  return (
    `<div class="panel-heading"><h2>「${escapeHtml(words.join(" "))}」を含む日（${view.results.length} 日${view.results.length >= 200 ? "。新しい 200 日まで" : ""}）</h2>` +
    `<button type="button" class="text-btn" data-action="search-clear">検索をやめる</button></div>` +
    (items.length ? `<ul class="diary-results">${items.join("")}</ul>` : '<p class="muted">見つかりませんでした。語を短くするか、言い換えて探してください。</p>')
  );
}

function editorHtml() {
  const e = view.editing;
  // タブと同じ行の右に、「見出し」「小見出し」「写真を入れる」「やめる」「保存」の順に並べる。
  // 「見出し」「小見出し」「写真を入れる」は、編集のタブのときだけ出す
  const tools =
    `<div class="diary-tools">` +
    (e.preview
      ? ""
      : `<button type="button" class="chip-btn" data-action="heading">見出し</button>` +
        `<button type="button" class="chip-btn" data-action="subheading">小見出し</button>` +
        `<label class="chip-btn diary-photo-btn${view.uploading ? " is-busy" : ""}"><span id="diaryPhotoLabel">${escapeHtml(view.uploading || "写真を入れる")}</span>` +
        `<input id="diaryPhotoInput" type="file" accept="image/*" multiple${view.uploading ? " disabled" : ""} /></label>`) +
    `<button type="button" class="text-btn" data-action="cancel">やめる</button>` +
    `<button type="button" class="primary-btn diary-save-btn" data-action="save">保存</button></div>`;
  // 編集とプレビューは、入力欄の真上につなげたタブ。選んでいるタブは、下の入力欄とつながって見える
  const tab = (action, label, on) =>
    `<button type="button" role="tab" aria-selected="${on}" class="diary-tab${on ? " is-on" : ""}" data-action="${action}">${label}</button>`;
  const bar =
    `<div class="diary-editor-bar"><div class="diary-tabs" role="tablist" aria-label="編集とプレビュー">` +
    tab("edit-mode", "編集", !e.preview) +
    tab("preview-mode", "プレビュー", e.preview) +
    `</div>${tools}</div>`;
  const content = e.preview
    ? `<div class="diary-preview">${e.body.trim() ? sectionBlocks(e.body).map((block) => blockHtml(block, "", 3)).join("") : '<p class="muted">まだ何も書いていません。</p>'}</div>`
    : `<textarea id="diaryBody" data-field="body" rows="16" placeholder="作業の内容を書きます。「見出し」で作物や作業ごとに見出しを付けると、あとで探しやすくなります。">${escapeHtml(e.body)}</textarea>`;
  return (
    `<h2>${escapeHtml(dateLabel(e.date))}の日記</h2>` +
    (e.note ? `<p class="diary-note">${escapeHtml(e.note)}</p>` : "") +
    `<label>題<input id="diaryTitle" type="text" data-field="title" value="${escapeHtml(e.title)}" placeholder="なくてもかまいません" /></label>` +
    bar +
    content +
    `<p class="muted">写真は、スマホのカメラのアプリで撮ってから、「写真を入れる」でアルバムから選んでください（ここから直接撮ると、Google フォトに残らないことがあります）。短辺 1080 px に縮めて保存します。</p>`
  );
}

// いま日記の枠に出しているもの。変わったら、枠のスクロールをいちばん上に戻す（前の日の読んでいた位置を残さない）
let shown = null;

function drawMain() {
  const main = $("diaryMain");
  const now = view.editing
    ? `edit:${view.editing.date}`
    : view.tagView
      ? tagViewKey(view.tagView)
      : view.results
        ? `search:${view.query}`
        : `period:${view.mode}:${periodOf(view.mode, view.date).from}`;
  const moved = shown !== null && now !== shown;
  shown = now;
  $("diaryView").classList.toggle("is-editing", Boolean(view.editing));
  if (view.editing) {
    draw(main, editorHtml());
    if (view.editing.preview) {
      requestUrls(photoNames(view.editing.body));
    }
  } else if (view.tagView) {
    draw(main, tagViewHtml());
    requestUrls(view.tagView.sections.flatMap((section) => photoNames(section.day_body || "")));
  } else if (view.results) {
    draw(main, resultsHtml());
  } else {
    draw(main, periodHtml());
    requestUrls(view.days.flatMap((day) => photoNames(day.body)));
  }
  // 描き直したあとに戻す（draw は、押したボタンの位置を保とうとしてスクロールを動かすことがある）
  if (moved) {
    main.scrollTop = 0;
    // スマホはページごとスクロールするので、日記の枠の頭が画面の上に隠れていたら、見える所まで戻す
    if (main.getBoundingClientRect().top < 0) {
      main.scrollIntoView({ block: "start" });
    }
  }
}

export function renderDiary() {
  if (!ctx) {
    return;
  }
  view.date ||= localToday();
  view.month ||= view.date.slice(0, 7);
  ensureLoaded();
  $("diaryView").classList.toggle("is-editing", Boolean(view.editing));
  renderModes();
  renderCalendar();
  if ($("diarySearch").value !== view.query && document.activeElement !== $("diarySearch")) {
    $("diarySearch").value = view.query;
  }
  drawMain();
}

// ---- 操作 ----

function pick(date) {
  view.date = date;
  view.month = date.slice(0, 7);
  view.results = null;
  view.tagView = null;
  view.tagEdit = null;
  renderDiary();
}

// 本文の中で、見出し（path の最後）の行のすぐ下の位置と、その行の番号。見つからなければ null
function headingPosition(body, key) {
  const heading = key ? key.split(" > ").pop() : "";
  if (!heading) {
    return null;
  }
  const lines = body.split("\n");
  const index = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && line.replace(/^#{1,6}\s+/, "").trim() === heading);
  if (index < 0) {
    return null;
  }
  const pos = lines.slice(0, index + 1).reduce((sum, line) => sum + line.length + 1, 0);
  return { pos: Math.min(pos, body.length), line: index };
}

function openEditor(date, key = "") {
  const saved = view.days.find((day) => day.date === date) || null;
  const draft = readDrafts()[date];
  const base = { title: saved?.title || "", body: saved?.body || "" };
  const restored = draft && (draft.title !== base.title || draft.body !== base.body);
  let note = "";
  if (restored) {
    note = "保存していない書きかけを戻しました。";
    if ((draft.expected || null) !== (saved?.updated_at || null)) {
      note += "書きかけを始めたあとに、別の画面で保存された内容があります。保存すると、書きかけの内容で置き換わります。";
    }
  }
  // 写真を上げている途中で閉じた書きかけには、仮の行が残っている。上げ終えていないので除く
  const body = restored ? (replacePlaceholder(draft.body, "")?.body ?? draft.body) : base.body;
  view.editing = {
    date,
    title: restored ? draft.title : base.title,
    body,
    tags: saved?.tags || {},
    expected: saved?.updated_at || null,
    preview: false,
    cursor: body.length,
    known: Object.keys(saved?.photos || {}),
    note,
  };
  view.tagEdit = null;
  // 本文で使っていない写真の名前も、通し番号に数える（DB から取る）
  ctx.state.store
    .diaryPhotoNames(date)
    .then((names) => {
      if (view.editing?.date === date) {
        view.editing.known = [...new Set([...view.editing.known, ...names])];
      }
    })
    .catch(() => {});
  // タグの一覧から開いたときは、押した節の見出しの下にカーソルを置く
  const at = headingPosition(body, key);
  if (at) {
    view.editing.cursor = at.pos;
  }
  renderDiary();
  // 書く欄を画面の上に出す（スマホではカレンダーが隠れて、上へずれる）
  $("diaryMain").scrollIntoView({ block: "start" });
  const area = $("diaryBody");
  area?.focus({ preventScroll: true });
  if (area && at) {
    area.setSelectionRange(at.pos, at.pos);
    const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 20;
    area.scrollTop = Math.max(0, (at.line - 1) * lineHeight);
  }
}

const changed = (e) => {
  const saved = view.days.find((day) => day.date === e.date);
  return e.title !== (saved?.title || "") || e.body !== (saved?.body || "");
};

async function closeEditor() {
  const e = view.editing;
  if (changed(e) && !(await confirmAction({ message: "書いた内容を保存せずに閉じます。書きかけも消えます。", action: "保存せずに閉じる", cancel: "書き続ける" }))) {
    return;
  }
  writeDraft(e.date, null);
  view.editing = null;
  view.uploading = "";
  renderDiary();
  returnToTagView();
}

function failed(error) {
  ctx.setStatus(`保存に失敗しました: ${error.message}`);
  if (error.code === "40001") {
    notify(error.message);
  } else {
    notifySaveFailed(error);
  }
}

// 置き場の写真を消す。消せなくても日記の保存は済んでいるので、知らせるだけにする
async function removeFiles(names) {
  if (!names?.length) {
    return;
  }
  try {
    await ctx.state.store.diaryRemovePhotos(names.map(photoPath));
  } catch (error) {
    notify(`使わなくなった写真を、置き場から消せませんでした。日記は保存しています。\n${error.message}`);
  }
}

async function saveDay(day) {
  const result = await ctx.state.store.diarySaveDay({ ...day, sections: splitSections(day.body) });
  await removeFiles(result?.removed);
  return result;
}

async function saveEditor() {
  const e = view.editing;
  if (view.uploading) {
    notify("写真を上げ終えてから保存してください。");
    return;
  }
  const day = { date: e.date, title: e.title.trim(), body: e.body.replace(/\s+$/, ""), tags: e.tags, expected: e.expected };
  ctx.setStatus("保存中…");
  try {
    await saveDay(day);
    writeDraft(e.date, null);
    view.editing = null;
    ctx.setStatus("保存しました");
    view.date = e.date;
    view.month = e.date.slice(0, 7);
    view.firstDate = undefined;
    await refresh({ calendar: true, period: true });
    returnToTagView();
  } catch (error) {
    failed(error);
  }
}

async function saveTags(day, key, value) {
  const tags = { ...(day.tags || {}) };
  if (value) {
    tags[key] = value;
  } else {
    delete tags[key];
  }
  ctx.setStatus("保存中…");
  try {
    await saveDay({ date: day.date, title: day.title, body: day.body, tags, expected: day.updated_at });
    view.tagEdit = null;
    ctx.setStatus("保存しました");
    await refresh({ period: true });
    returnToTagView();
  } catch (error) {
    failed(error);
  }
}

async function runSearch() {
  const words = searchWords(view.query);
  if (!words.length) {
    view.results = null;
    renderDiary();
    return;
  }
  try {
    view.results = await ctx.state.store.diarySearch(words);
  } catch (error) {
    ctx.setStatus(`探せませんでした: ${error.message}`);
    return;
  }
  view.tagView = null;
  view.editing = null;
  renderDiary();
}

// 写真を縮めた JPEG にする。向き（EXIF）は画素に反映し、位置情報などの EXIF は描き直しで外れる
async function shrink(file) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    source = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("この形式の写真は読み込めません。JPEG にしてから選んでください。"));
      };
      image.src = url;
    });
  }
  const { width, height } = photoSize(source.width, source.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(source, 0, 0, width, height);
  source.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
  if (!blob) {
    throw new Error("写真を縮められませんでした。");
  }
  return { blob, width, height };
}

// 写真を上げている状態を出す。「写真を入れる」のボタンの文字を変えて押せなくし、お知らせにも出す
function setUploading(text) {
  view.uploading = text;
  const label = $("diaryPhotoLabel");
  if (label) {
    label.textContent = text || "写真を入れる";
    label.parentElement.classList.toggle("is-busy", Boolean(text));
    $("diaryPhotoInput").disabled = Boolean(text);
  }
}

// 本文を書き換える。入力欄があれば値を入れ直し、打っている人のカーソルは、ずれた分だけ動かして保つ。
// プレビューを開いていれば、描き直す
// 入力欄の start〜end を text に入れ替え、カーソルを caret に置く。表示位置（入力欄と日記の枠のスクロール）は動かさない。
// ブラウザーの「文字を打った」扱い（insertText）にして、Ctrl+Z で取り消せるようにする。使えないブラウザーでは setRangeText で入れ替える。
// 入力欄の中身を丸ごと入れ直すと、カーソルが最後に移り、注目を戻したときに一番下まで送られてしまうため
function replaceInArea(area, start, end, text, caret) {
  const top = area.scrollTop;
  const outer = $("diaryMain").scrollTop;
  const page = window.scrollY;
  area.focus({ preventScroll: true });
  area.setSelectionRange(start, end);
  let done = false;
  try {
    done = text ? document.execCommand("insertText", false, text) : start === end || document.execCommand("delete");
  } catch {
    done = false;
  }
  if (!done || area.value.slice(start, start + text.length) !== text) {
    area.setRangeText(text, start, end, "end");
  }
  area.setSelectionRange(caret, caret);
  area.scrollTop = top;
  $("diaryMain").scrollTop = outer;
  window.scrollTo(window.scrollX, page);
}

function changeBody(e, change) {
  // 上げているあいだに書く欄を閉じていたら、本文には入れない（写真は、使っていない写真として保存のときに片付く）
  if (view.editing !== e) {
    return;
  }
  const shift = (pos) => (pos > change.at ? Math.max(change.at, pos + change.delta) : pos);
  e.body = change.body;
  e.cursor = shift(e.cursor);
  keepDraft();
  const area = $("diaryBody");
  if (area) {
    const [start, end] = [shift(area.selectionStart), shift(area.selectionEnd)];
    // 中身を入れ直すとカーソルが最後に移り、表示が動くことがあるので、表示位置を覚えて戻す
    const top = area.scrollTop;
    area.value = e.body;
    area.setSelectionRange(start, end);
    area.scrollTop = top;
  } else if (e.preview) {
    drawMain();
  }
}

// 選んだ写真を縮めて上げ、本文に入れる。選んですぐ、入れる所に仮の行を置き（押したことが分かるように）、
// 上げ終えたら写真に置き換える。上げているあいだは、もう一度は選べない
async function addPhotos(files) {
  const e = view.editing;
  if (!e || !files.length || view.uploading) {
    return;
  }
  const progress = (i) => `上げています ${i}/${files.length}…`;
  setUploading(progress(1));
  ctx.setStatus(`写真を${progress(1)}`);
  const pos = Math.min(e.cursor, e.body.length);
  const start = insertBlock(e.body, pos, PHOTO_PLACEHOLDER);
  changeBody(e, { body: start.body, at: pos, delta: start.body.length - e.body.length });
  e.cursor = start.pos;
  $("diaryBody")?.setSelectionRange(e.cursor, e.cursor);
  const used = new Set([...e.known, ...photoNames(e.body)]);
  const names = [];
  let failure = null;
  try {
    for (const [i, file] of files.entries()) {
      setUploading(progress(i + 1));
      ctx.setStatus(`写真を${progress(i + 1)}`);
      const takenAt = /jpe?g$/i.test(file.type) ? exifDateTime(await file.arrayBuffer()) : null;
      const { blob, width, height } = await shrink(file);
      let name = null;
      for (let tries = 0; tries < 20 && !name; tries += 1) {
        const candidate = nextPhotoName(e.date, [...used]);
        used.add(candidate);
        try {
          await ctx.state.store.diaryUploadPhoto(photoPath(candidate), blob);
          name = candidate;
        } catch (error) {
          if (error.code !== "exists") {
            throw error;
          }
        }
      }
      if (!name) {
        throw new Error("写真の名前を決められませんでした。");
      }
      await ctx.state.store.diaryAddPhoto({ name, date: e.date, takenAt, originalName: file.name, width, height });
      view.meta[name] = { taken_at: takenAt, original_name: file.name || null };
      e.known.push(name);
      names.push(name);
    }
  } catch (error) {
    failure = error;
  } finally {
    setUploading("");
  }
  // 仮の行を写真に置き換える。仮の行を消されていたら、いまのカーソルの所に入れる
  const text = names.length ? photoMarkdown(names) : "";
  const done = replacePlaceholder(e.body, text);
  if (done) {
    changeBody(e, done);
  } else if (text) {
    const at = Math.min(e.cursor, e.body.length);
    const inserted = insertBlock(e.body, at, text);
    changeBody(e, { body: inserted.body, at, delta: inserted.body.length - e.body.length });
  }
  ctx.setStatus(names.length && !failure ? `写真を ${names.length} 枚入れました` : "");
  if (failure) {
    notify(`写真を上げられませんでした。${names.length ? `上げ終えた ${names.length} 枚は、本文に入れました。` : ""}\n${failure.message}`);
  }
}

// 写真を大きく開く。撮影日時と元のファイル名があれば添える（Google フォトで元の写真を探すため）。
// names は同じ見出しの写真の並び。2 枚以上なら、写真の左右の ‹ › と、← → のキー、左右にはらう操作で行き来する（端まで行くと反対の端に戻る）
function openPhoto(name, names = [name]) {
  const list = names.includes(name) ? names : [name];
  let index = list.indexOf(name);
  const dialog = document.createElement("dialog");
  dialog.className = "notice diary-viewer";

  const show = () => {
    const current = list[index];
    const meta = view.meta[current] || {};
    const url = view.urls[photoPath(current)];
    if (!url) {
      requestUrls([current]);
    }
    const facts = [
      list.length > 1 ? `${index + 1} / ${list.length} 枚目` : "",
      meta.taken_at ? `撮影 ${String(meta.taken_at).replace("T", " ").slice(0, 19)}` : "",
      meta.original_name ? `元のファイル名 ${meta.original_name}` : "",
    ].filter(Boolean);
    // 写真のタグ（Claude Code が写真から付けた推定）
    const tags = meta.tags || {};
    const tagNames = [...PHOTO_TAG_KINDS.flatMap(([kind]) => tags[kind] || []), ...(tags.use ? [tags.use] : [])];
    const nav =
      list.length > 1
        ? '<button type="button" class="diary-viewer-nav is-prev" data-action="prev" aria-label="前の写真">‹</button>' +
          '<button type="button" class="diary-viewer-nav is-next" data-action="next" aria-label="次の写真">›</button>'
        : "";
    draw(
      dialog,
      `<div class="diary-viewer-photo">` +
        (url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(current)}" />` : '<p class="muted">写真を読み込んでいます…</p>') +
        nav +
        "</div>" +
        `<p class="muted">${escapeHtml(current)}${facts.length ? `。${escapeHtml(facts.join("、"))}` : ""}</p>` +
        (tagNames.length ? `<div class="diary-tags">${tagNames.map((tag) => `<span class="diary-tag">${escapeHtml(tag)}</span>`).join("")}</div>` : "") +
        `<p class="muted">もっと大きい写真が要るときは、撮影日時か元のファイル名で、Google フォトから探してください。</p>` +
        `<div class="row">${url ? `<a class="chip-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">別のタブで開く</a>` : ""}<button type="button" class="primary-btn" data-action="close">閉じる</button></div>`
    );
  };
  const step = (delta) => {
    if (list.length > 1) {
      index = (index + delta + list.length) % list.length;
      show();
    }
  };

  dialog.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "prev" || action === "next") {
      step(action === "prev" ? -1 : 1);
    } else if (action === "close" || event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    }
  });
  // スマホ: 写真を左右にはらうと、次・前の写真へ
  let startX = null;
  dialog.addEventListener("pointerdown", (event) => {
    startX = event.target.closest(".diary-viewer-photo") ? event.clientX : null;
  });
  dialog.addEventListener("pointerup", (event) => {
    if (startX !== null && Math.abs(event.clientX - startX) > 50) {
      step(event.clientX < startX ? 1 : -1);
    }
    startX = null;
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  show();
  dialog.showModal();
}

function dayOf(date) {
  return view.days.find((day) => day.date === date);
}

export function initDiary(context) {
  ctx = context;
  $("diaryModes").addEventListener("click", (event) => {
    const mode = event.target.closest("[data-mode]")?.dataset.mode;
    if (mode && mode !== view.mode) {
      view.mode = mode;
      view.results = null;
      view.tagView = null;
      view.tagEdit = null;
      renderDiary();
    }
  });
  $("diaryCalendar").addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) {
      return;
    }
    if (target.dataset.date) {
      pick(target.dataset.date);
    } else if (target.dataset.month) {
      view.month = shiftPeriod("month", `${view.month}-01`, Number(target.dataset.month)).slice(0, 7);
      renderDiary();
    } else if (target.dataset.action === "today") {
      pick(localToday());
    }
  });
  $("diaryCalendar").addEventListener("change", (event) => {
    if (event.target.id === "diaryMonthSelect" && event.target.value) {
      view.month = event.target.value;
      renderDiary();
    }
  });
  $("diarySearchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    view.query = $("diarySearch").value;
    runSearch();
  });
  const main = $("diaryMain");
  main.addEventListener("click", async (event) => {
    const target = event.target.closest("button, a");
    if (!target) {
      return;
    }
    const action = target.dataset.action;
    if (action === "open-day") {
      event.preventDefault();
      view.mode = "day";
      pick(target.dataset.date);
    } else if (target.dataset.step) {
      pick(shiftPeriod(view.mode, view.date, Number(target.dataset.step)));
    } else if (action === "edit") {
      if (view.editing && view.editing.date !== target.dataset.date) {
        notify("書きかけの日記があります。保存するか、やめてから開いてください。");
        return;
      }
      keepTagScroll();
      if (view.mode !== "day" || view.date !== target.dataset.date) {
        view.mode = "day";
        view.date = target.dataset.date;
        view.month = view.date.slice(0, 7);
        await loadPeriod().catch((error) => ctx.setStatus(`日記を読み込めませんでした: ${error.message}`));
      }
      openEditor(target.dataset.date, target.dataset.key || "");
    } else if (action === "save") {
      saveEditor();
    } else if (action === "cancel") {
      closeEditor();
    } else if (action === "edit-mode" || action === "preview-mode") {
      view.editing.preview = action === "preview-mode";
      drawMain();
    } else if (action === "heading" || action === "subheading") {
      const e = view.editing;
      const next = toggleHeading(e.body, Math.min(e.cursor, e.body.length), action === "subheading" ? 3 : 2);
      const area = $("diaryBody");
      if (area && area.value === e.body) {
        replaceInArea(area, next.start, next.end, next.line, next.pos);
        e.body = area.value;
      } else {
        e.body = next.body;
      }
      e.cursor = next.pos;
      keepDraft();
    } else if (action === "photo") {
      // 同じ見出しの中の写真を、本文の順に並べて渡す（プレビューでは、本文全体の写真）
      const scope = ".diary-sub, .diary-section, .diary-preview";
      const box = target.closest(scope) || target.parentElement;
      const names = [...new Set([...box.querySelectorAll('[data-action="photo"]')].filter((el) => el.closest(scope) === box).map((el) => el.dataset.photo))];
      openPhoto(target.dataset.photo, names);
    } else if (target.dataset.tagFilter) {
      addTagFilter(target.dataset.tagFilter, target.dataset.tagValue, target.dataset.tagLabel, target.dataset.tagTargetKind);
    } else if (action === "tag-remove") {
      const t = view.tagView;
      t.filters = t.filters.filter((_, i) => i !== Number(target.dataset.index));
      if (!t.filters.length) {
        view.tagView = null;
        renderDiary();
      } else {
        loadTagView();
      }
    } else if (action === "tag-order") {
      view.tagView.oldest = target.dataset.oldest === "true";
      loadTagView();
    } else if (action === "work-log") {
      const field = ctx.state.field;
      const log = field?.id === target.dataset.fieldId ? (ctx.state.logs || []).find((item) => item.id === target.dataset.logId) : null;
      if (log) {
        openLogEditor(log);
      } else {
        const name = (ctx.state.fields || []).find((item) => item.id === target.dataset.fieldId)?.name || "別の圃場";
        notify(`この作業の記録は「${name}」の記録です。圃場図の画面の「圃場」で「${name}」を選ぶと、直せます。`);
      }
    } else if (action === "tag-more") {
      loadTagView({ more: true });
    } else if (action === "tag-clear") {
      view.tagView = null;
      renderDiary();
    } else if (action === "search-clear") {
      view.query = "";
      view.results = null;
      $("diarySearch").value = "";
      renderDiary();
    } else if (action === "tags") {
      const box = target.closest("[data-key]");
      const day = dayFor(box.dataset.date);
      const section = day?.sections.find((item) => pathKey(item.path) === box.dataset.key);
      if (section) {
        const labels = sectionLabels(section);
        view.tagEdit = { date: day.date, key: box.dataset.key, values: Object.fromEntries(TAG_KINDS.map(([kind]) => [kind, [...(labels[kind] || [])]])) };
        drawMain();
      }
    } else if (target.dataset.tagKind) {
      const edit = view.tagEdit;
      const list = edit.values[target.dataset.tagKind];
      const name = target.dataset.tagName;
      edit.values[target.dataset.tagKind] = list.includes(name) ? list.filter((item) => item !== name) : [...list, name];
      drawMain();
    } else if (action === "tags-save" || action === "tags-auto") {
      const edit = view.tagEdit;
      const day = dayFor(edit.date);
      keepTagScroll();
      const order = (kind, names) => (view.tagNames?.[kind] || []).filter((name) => names.includes(name));
      saveTags(day, edit.key, action === "tags-save" ? Object.fromEntries(TAG_KINDS.map(([kind]) => [kind, order(kind, edit.values[kind])])) : null);
    } else if (action === "tags-cancel") {
      view.tagEdit = null;
      drawMain();
    }
  });
  // 打った文字は view と書きかけに入れるだけ。入れ物は描き直さない
  main.addEventListener("input", (event) => {
    const e = view.editing;
    const field = event.target.dataset.field;
    if (!e || !field) {
      return;
    }
    e[field] = event.target.value;
    if (field === "body") {
      e.cursor = event.target.selectionStart;
    }
    keepDraft();
  });
  // 「見出し」と「写真を入れる」は、カーソルのある所に入れる
  for (const type of ["keyup", "click", "select", "focusout"]) {
    main.addEventListener(type, (event) => {
      if (view.editing && event.target.id === "diaryBody") {
        view.editing.cursor = event.target.selectionStart;
      }
    });
  }
  main.addEventListener("change", (event) => {
    if (event.target.id === "diaryPhotoInput") {
      const files = [...event.target.files];
      event.target.value = "";
      addPhotos(files);
    }
  });
  // 日記の画面で再読み込みすると、この準備の前に画面を開く（そのときは描けない）ので、ここで描く
  if (!$("diaryView").hidden) {
    renderDiary();
  }
}

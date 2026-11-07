// 「日記」の画面（docs/actuals-plan.md の 11.1）。農作業日記を 1 日ずつ書き、カレンダーで日か月を選んで読み、語で探す。
// 日記は圃場ごとではなく共通。画面の状態は view に持ち、描くときは view から HTML を作る（docs/implementation-rules.md）。
// 書いている本文は、打つたびに view と端末の中（書きかけ）に入れるだけで、入れ物は描き直さない（日本語の変換が切れるため）。
import { confirmAction, notify, notifySaveFailed } from "./dialog.js";
import { draw } from "./draw.js";
import {
  PHOTO_QUALITY,
  WEEKDAYS,
  bodyChunks,
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
  photoPath,
  photoSize,
  renderMarkdown,
  searchWords,
  shiftPeriod,
  snippetHtml,
  splitSections,
  toggleHeading,
} from "./diary.js";
import { localToday } from "./schedule.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
  tagNames: null, // { crops, work }
  tagEdit: null, // { date, key, crops: [...], work: [...] }
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
      view.tagNames ||= { crops: [], work: [] };
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
    `<div class="diary-month">` +
      `<button type="button" class="text-btn" data-month="-1" aria-label="前の月">‹</button>` +
      monthSelectHtml(today) +
      `<button type="button" class="text-btn" data-month="1" aria-label="次の月">›</button>` +
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

function tagsHtml(day, section, key) {
  const edit = view.tagEdit;
  if (edit && edit.date === day.date && edit.key === key) {
    const chips = (kind, names) =>
      names
        .map((name) => `<button type="button" class="chip-btn${edit[kind].includes(name) ? " is-on" : ""}" data-tag-kind="${kind}" data-tag-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`)
        .join("");
    return (
      `<div class="diary-tag-edit" data-date="${day.date}" data-key="${escapeHtml(key)}">` +
      `<p class="muted">作物</p><div class="log-chips">${chips("crops", view.tagNames?.crops || [])}</div>` +
      `<p class="muted">作業の種類</p><div class="log-chips">${chips("work", view.tagNames?.work || [])}</div>` +
      `<div class="row"><button type="button" class="primary-btn" data-action="tags-save">保存</button>` +
      `<button type="button" class="text-btn" data-action="tags-auto">自動に戻す</button>` +
      `<button type="button" class="text-btn" data-action="tags-cancel">やめる</button></div></div>`
    );
  }
  const names = [...section.crops.map((name) => ["crop", name]), ...section.work.map((name) => ["work", name])];
  const fixed = Boolean(day.tags?.[key]);
  return (
    `<div class="diary-tags" data-date="${day.date}" data-key="${escapeHtml(key)}">` +
    (names.length ? names.map(([kind, name]) => `<span class="diary-tag is-${kind}">${escapeHtml(name)}</span>`).join("") : '<span class="muted">種類なし</span>') +
    `${fixed ? '<span class="muted">（直した）</span>' : ""}` +
    `<button type="button" class="text-btn" data-action="tags">種類を直す</button></div>`
  );
}

// 1 日分。見出しごとに、本文と、節の作物・作業の種類を並べる
function dayHtml(day, { single }) {
  const sections = [...(day.sections || [])];
  const parts = bodyChunks(day.body).map((chunk) => {
    const key = pathKey(chunk.path);
    const at = sections.findIndex((section) => pathKey(section.path) === key);
    const section = at >= 0 ? sections.splice(at, 1)[0] : null;
    const level = Math.min(6, chunk.level + 2);
    const heading = chunk.heading ? `<h${level} class="diary-heading">${escapeHtml(chunk.heading)}</h${level}>` : "";
    return heading + renderMarkdown(chunk.text, photoHtml, { headingBase: 4 }) + (section ? tagsHtml(day, section, key) : "");
  });
  const title = `${single ? "" : `<a href="#diary" data-action="open-day" data-date="${day.date}">${dateLabel(day.date)}</a> `}${escapeHtml(day.title)}`;
  const editButton = (extra) => `<button type="button" class="chip-btn${extra}" data-action="edit" data-date="${day.date}">編集</button>`;
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
  const tools = e.preview
    ? ""
    : `<div class="row diary-tools">` +
      `<button type="button" class="chip-btn" data-action="heading">見出し</button>` +
      `<label class="chip-btn diary-photo-btn">写真を入れる<input id="diaryPhotoInput" type="file" accept="image/*" multiple /></label>` +
      `<span id="diaryUploadStatus" class="muted" role="status">${escapeHtml(view.uploading)}</span></div>`;
  const content = e.preview
    ? `<div class="diary-preview">${e.body.trim() ? renderMarkdown(e.body, photoHtml, { headingBase: 3 }) : '<p class="muted">まだ何も書いていません。</p>'}</div>`
    : `<textarea id="diaryBody" data-field="body" rows="16" placeholder="作業の内容を書きます。「見出し」で作物や作業ごとに見出しを付けると、あとで探しやすくなります。">${escapeHtml(e.body)}</textarea>`;
  return (
    `<div class="panel-heading"><h2>${escapeHtml(dateLabel(e.date))}の日記</h2>` +
    `<div class="log-modes" role="group" aria-label="編集と表示">` +
    `<button type="button" class="chip-btn${e.preview ? "" : " is-on"}" data-action="edit-mode">編集</button>` +
    `<button type="button" class="chip-btn${e.preview ? " is-on" : ""}" data-action="preview-mode">表示</button></div></div>` +
    (e.note ? `<p class="diary-note">${escapeHtml(e.note)}</p>` : "") +
    `<label>題<input id="diaryTitle" type="text" data-field="title" value="${escapeHtml(e.title)}" placeholder="なくてもかまいません" /></label>` +
    tools +
    content +
    `<p class="muted">写真は、スマホのカメラのアプリで撮ってから、「写真を入れる」でアルバムから選んでください（ここから直接撮ると、Google フォトに残らないことがあります）。短辺 1080 px に縮めて保存します。</p>` +
    `<div class="row"><button type="button" class="primary-btn" data-action="save">保存</button>` +
    `<button type="button" class="text-btn" data-action="cancel">やめる</button></div>`
  );
}

function drawMain() {
  const main = $("diaryMain");
  if (view.editing) {
    $("diaryView").classList.add("is-editing");
    draw(main, editorHtml());
    if (view.editing.preview) {
      requestUrls(photoNames(view.editing.body));
    }
    return;
  }
  $("diaryView").classList.remove("is-editing");
  if (view.results) {
    draw(main, resultsHtml());
    return;
  }
  draw(main, periodHtml());
  requestUrls(view.days.flatMap((day) => photoNames(day.body)));
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
  view.tagEdit = null;
  renderDiary();
}

function openEditor(date) {
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
  view.editing = {
    date,
    title: restored ? draft.title : base.title,
    body: restored ? draft.body : base.body,
    tags: saved?.tags || {},
    expected: saved?.updated_at || null,
    preview: false,
    cursor: (restored ? draft.body : base.body).length,
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
  renderDiary();
  // 書く欄を画面の上に出す（スマホではカレンダーが隠れて、上へずれる）
  $("diaryMain").scrollIntoView({ block: "start" });
  $("diaryBody")?.focus({ preventScroll: true });
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

function setUploading(text) {
  view.uploading = text;
  const status = $("diaryUploadStatus");
  if (status) {
    status.textContent = text;
  }
}

async function addPhotos(files) {
  const e = view.editing;
  if (!e || !files.length) {
    return;
  }
  const used = new Set([...e.known, ...photoNames(e.body)]);
  const names = [];
  try {
    for (const [i, file] of files.entries()) {
      setUploading(`写真を縮めて上げています（${i + 1}/${files.length}）`);
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
    notify(`写真を上げられませんでした。${names.length ? `上げ終えた ${names.length} 枚は、本文に入れます。` : ""}\n${error.message}`);
  } finally {
    setUploading("");
  }
  if (!names.length || view.editing !== e) {
    return;
  }
  const inserted = insertBlock(e.body, Math.min(e.cursor, e.body.length), photoMarkdown(names));
  e.body = inserted.body;
  e.cursor = inserted.pos;
  keepDraft();
  const area = $("diaryBody");
  if (area) {
    area.value = e.body;
    area.setSelectionRange(e.cursor, e.cursor);
  }
}

// 写真を大きく開く。撮影日時と元のファイル名があれば添える（Google フォトで元の写真を探すため）
function openPhoto(name) {
  const meta = view.meta[name] || {};
  const url = view.urls[photoPath(name)];
  const dialog = document.createElement("dialog");
  dialog.className = "notice diary-viewer";
  const facts = [
    meta.taken_at ? `撮影 ${String(meta.taken_at).replace("T", " ").slice(0, 19)}` : "",
    meta.original_name ? `元のファイル名 ${meta.original_name}` : "",
  ].filter(Boolean);
  draw(
    dialog,
    (url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" />` : '<p class="muted">写真を読み込めていません。</p>') +
      `<p class="muted">${escapeHtml(name)}${facts.length ? `。${escapeHtml(facts.join("、"))}` : ""}</p>` +
      `<p class="muted">もっと大きい写真が要るときは、撮影日時か元のファイル名で、Google フォトから探してください。</p>` +
      `<div class="row">${url ? `<a class="chip-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">別のタブで開く</a>` : ""}<button type="button" class="primary-btn" data-action="close">閉じる</button></div>`
  );
  dialog.addEventListener("click", (event) => {
    if (event.target.dataset.action === "close" || event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
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
      if (view.mode !== "day" || view.date !== target.dataset.date) {
        view.mode = "day";
        view.date = target.dataset.date;
        view.month = view.date.slice(0, 7);
        await loadPeriod().catch((error) => ctx.setStatus(`日記を読み込めませんでした: ${error.message}`));
      }
      openEditor(target.dataset.date);
    } else if (action === "save") {
      saveEditor();
    } else if (action === "cancel") {
      closeEditor();
    } else if (action === "edit-mode" || action === "preview-mode") {
      view.editing.preview = action === "preview-mode";
      drawMain();
    } else if (action === "heading") {
      const e = view.editing;
      const next = toggleHeading(e.body, Math.min(e.cursor, e.body.length));
      e.body = next.body;
      e.cursor = next.pos;
      keepDraft();
      const area = $("diaryBody");
      area.value = e.body;
      area.focus();
      area.setSelectionRange(e.cursor, e.cursor);
    } else if (action === "photo") {
      openPhoto(target.dataset.photo);
    } else if (action === "search-clear") {
      view.query = "";
      view.results = null;
      $("diarySearch").value = "";
      renderDiary();
    } else if (action === "tags") {
      const box = target.closest("[data-key]");
      const day = dayOf(box.dataset.date);
      const section = day?.sections.find((item) => pathKey(item.path) === box.dataset.key);
      if (section) {
        view.tagEdit = { date: day.date, key: box.dataset.key, crops: [...section.crops], work: [...section.work] };
        drawMain();
      }
    } else if (target.dataset.tagKind) {
      const edit = view.tagEdit;
      const list = edit[target.dataset.tagKind];
      const name = target.dataset.tagName;
      edit[target.dataset.tagKind] = list.includes(name) ? list.filter((item) => item !== name) : [...list, name];
      drawMain();
    } else if (action === "tags-save" || action === "tags-auto") {
      const edit = view.tagEdit;
      const day = dayOf(edit.date);
      const order = (kind, names) => (view.tagNames?.[kind] || []).filter((name) => names.includes(name));
      saveTags(day, edit.key, action === "tags-save" ? { crops: order("crops", edit.crops), work: order("work", edit.work) } : null);
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

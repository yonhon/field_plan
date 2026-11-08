// 農作業日記の計算（docs/actuals-plan.md の 11.1）。画面には触らない。
// 本文は Markdown で、写真は文中に ![](images/<名前>) で書く。見出しごとの節への分け方は、
// inoo_farm の scripts/build_sections.py と同じにする（diary-mcp は節を読むので、分け方が変わると答えが変わる）。

const HEADING = /^(#{1,6})\s+(.*)$/;
const IMAGE = /!\[[^\]]*\]\(([^)]+)\)/g;
// Python の str.splitlines と同じ所で行を分ける
// 改行の文字は、この部品の中にそのまま書かず、番号から作る
const LINE_BREAK = new RegExp(`${String.fromCharCode(13, 10)}|[${String.fromCharCode(10, 13, 11, 12, 28, 29, 30, 133, 8232, 8233)}]`);
const FISCAL_START_MONTH = 4;
export const PHOTO_SHORT_SIDE = 1080;
export const PHOTO_QUALITY = 0.85;
export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function splitLines(text) {
  const lines = String(text ?? "").split(LINE_BREAK);
  // splitlines は、最後の改行のあとに空の行を作らない
  if (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// 節の見出しを、直した種類（diary.days.tags）の鍵にする。見出しのない最初の節は ""
export const pathKey = (path) => path.join(" > ");

// 1 日分の本文を、見出しごとの節 [{path, body, images}] に分ける。path は上位の見出しを含む。
// 本文の写真は images に移し、本文からは抜く。下位の節を束ねるだけの見出しと、空の最初の節は作らない。
// 第 1 階層の見出しは、その日の題として扱い、節にしない（build_sections.py と同じ）
export function splitSections(body) {
  const sections = [{ path: [], lines: [] }];
  let path = [];
  let current = sections[0];
  for (const line of splitLines(body)) {
    const heading = HEADING.exec(line);
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    const level = heading[1].length;
    if (level === 1) {
      continue;
    }
    path = [...path.filter(([depth]) => depth < level), [level, heading[2].trim()]];
    current = { path: path.map(([, text]) => text), lines: [] };
    sections.push(current);
  }
  const result = [];
  sections.forEach((section, i) => {
    const text = section.lines.join("\n");
    const images = [...text.matchAll(IMAGE)].map((match) => match[1]);
    const stripped = text.replace(IMAGE, "").replace(/\n{3,}/g, "\n\n").trim();
    const later = sections[i + 1]?.path || [];
    const hasChildren = later.length > section.path.length && section.path.every((part, k) => later[k] === part);
    if (!stripped && !images.length && (hasChildren || !section.path.length)) {
      return;
    }
    result.push({ path: section.path, body: stripped, images });
  });
  return result;
}

// 表示のために、本文を見出しごとのまとまり [{path, heading, level, text}] に分ける。
// splitSections と違い、写真は本文に残し、束ねるだけの見出しも残す。第 1 階層の見出しは本文の行として扱う
export function bodyChunks(body) {
  const chunks = [{ path: [], heading: null, level: 0, lines: [] }];
  let path = [];
  for (const line of splitLines(body)) {
    const heading = HEADING.exec(line);
    if (!heading || heading[1].length === 1) {
      chunks[chunks.length - 1].lines.push(line);
      continue;
    }
    const level = heading[1].length;
    path = [...path.filter(([depth]) => depth < level), [level, heading[2].trim()]];
    chunks.push({ path: path.map(([, text]) => text), heading: heading[2].trim(), level, lines: [] });
  }
  return chunks.map(({ lines, ...chunk }) => ({ ...chunk, text: lines.join("\n") }));
}

// 節のタグの種類（inoo_farm の docs/diary-tags.md）。Claude Code が本文の意味と写真の中身から付ける（推定）。
// 本人が画面で直した種類は、diary.days.tags に見出しごとに残る
export const TAG_KINDS = [
  ["crops", "作物"],
  ["work", "作業"],
  ["place", "場所"],
  ["issues", "症状・病害虫"],
  ["stage", "生育段階"],
  ["topic", "話題"],
];
// 写真のタグの種類。use（使い道）は 1 つ
export const PHOTO_TAG_KINDS = [
  ["crops", "作物"],
  ["issues", "症状・病害虫"],
  ["stage", "生育段階"],
  ["subject", "写っているもの"],
];

// 節のタグを、手で直したタグ（manual）と Claude のタグ（ai）から決める（DB の diary.apply_labels と同じ）。
// 手で直した種類はそれを、直していない種類は Claude のタグを使う。tag_source は manual / claude / null（まだ付いていない）
export function pickLabels(manual, ai) {
  return {
    labels: { ...(ai || {}), ...(manual || {}) },
    tag_source: manual ? "manual" : ai ? "claude" : null,
  };
}

// 写真の名前を、置き場の中の場所にする。置き場は年度（4 月〜翌年 3 月）ごとのフォルダーに分かれている
export function fiscalYear(date) {
  const [year, month] = date.split("-").map(Number);
  return month >= FISCAL_START_MONTH ? year : year - 1;
}

export function photoPath(name) {
  return `${fiscalYear(name.slice(0, 10))}/photos/${name}`;
}

// 本文に書いた写真（images/<名前>）の名前
export function photoNames(body) {
  return [...String(body ?? "").matchAll(IMAGE)].map((match) => match[1].split("/").pop());
}

// その日の新しい写真の名前。<日付>_<通し番号>.jpg で、使ったことのある番号の次
export function nextPhotoName(date, used) {
  const pattern = new RegExp(`^${date}_(\\d+)\\.`);
  const top = Math.max(0, ...used.map((name) => Number(pattern.exec(name)?.[1] || 0)));
  return `${date}_${String(top + 1).padStart(2, "0")}.jpg`;
}

// 保存する写真の大きさ。短辺を PHOTO_SHORT_SIDE にそろえ、元が小さいときは広げない
export function photoSize(width, height, short = PHOTO_SHORT_SIDE) {
  const scale = Math.min(1, short / Math.min(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// 写真を本文に入れる Markdown。1 枚ならそのまま、何枚かなら、いまの日記と同じく 1 行に並べた表にする
export function photoMarkdown(names) {
  if (names.length === 1) {
    return `![](images/${names[0]})`;
  }
  return `| ${names.map((name) => `![](images/${name})`).join(" | ")} |\n| ${names.map(() => ":----").join(" | ")} |`;
}

// 写真を上げているあいだ、入れる所に置いておく行。上げ終えたら写真に置き換える
export const PHOTO_PLACEHOLDER = "（写真を上げています…）";

// 本文の仮の行を text に置き換える。text が空なら、仮の行を前後の空の行ごと除く。
// 返り値は新しい本文と、仮の行があった位置、ずれた文字数。仮の行がなければ null
export function replacePlaceholder(body, text) {
  const at = body.indexOf(PHOTO_PLACEHOLDER);
  if (at < 0) {
    return null;
  }
  let next;
  if (text) {
    next = body.slice(0, at) + text + body.slice(at + PHOTO_PLACEHOLDER.length);
  } else {
    const before = body.slice(0, at).replace(/\n*$/, "");
    const after = body.slice(at + PHOTO_PLACEHOLDER.length).replace(/^\n*/, "");
    next = before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after;
  }
  return { body: next, at, delta: next.length - body.length };
}

// 本文の pos の位置に、段落として text を差し込む。前後に空の行を入れる。返り値は新しい本文と、差し込んだあとの位置
export function insertBlock(body, pos, text) {
  const before = body.slice(0, pos).replace(/[ \t]*$/, "");
  const after = body.slice(pos).replace(/^[ \t]*/, "");
  const head = before === "" ? "" : before.endsWith("\n\n") ? before : before.endsWith("\n") ? `${before}\n` : `${before}\n\n`;
  const tail = after === "" ? "\n" : after.startsWith("\n\n") ? after : after.startsWith("\n") ? `\n${after}` : `\n\n${after}`;
  return { body: head + text + tail, pos: head.length + text.length + (after === "" ? 1 : 2) };
}

// カーソルのある行を見出しにする。もう見出しなら、見出しの印を外す
export function toggleHeading(body, pos) {
  const start = body.lastIndexOf("\n", pos - 1) + 1;
  const endAt = body.indexOf("\n", pos);
  const end = endAt < 0 ? body.length : endAt;
  const line = body.slice(start, end);
  const heading = /^#{1,6}\s+/.exec(line);
  const next = heading ? line.slice(heading[0].length) : `## ${line}`;
  return { body: body.slice(0, start) + next + body.slice(end), pos: start + next.length };
}

// ---- 日付 ----

const toUtc = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const fromUtc = (time) => new Date(time).toISOString().slice(0, 10);
export const addDays = (iso, days) => fromUtc(toUtc(iso) + days * 864e5);
export const weekdayOf = (iso) => new Date(toUtc(iso)).getUTCDay();

// 期間。週は月曜から日曜まで、月は 1 日から末日まで
export function periodOf(mode, date) {
  if (mode === "week") {
    const from = addDays(date, -((weekdayOf(date) + 6) % 7));
    return { from, to: addDays(from, 6) };
  }
  if (mode === "month") {
    const from = `${date.slice(0, 7)}-01`;
    const next = new Date(toUtc(from));
    next.setUTCMonth(next.getUTCMonth() + 1);
    return { from, to: addDays(fromUtc(next.getTime()), -1) };
  }
  return { from: date, to: date };
}

// 前後の期間へ移る
export function shiftPeriod(mode, date, step) {
  if (mode === "month") {
    const moved = new Date(toUtc(`${date.slice(0, 7)}-01`));
    moved.setUTCMonth(moved.getUTCMonth() + step);
    return fromUtc(moved.getTime());
  }
  return addDays(date, step * (mode === "week" ? 7 : 1));
}

// カレンダーの年月のリスト。新しい月から古い月へ、last から first まで（どちらも YYYY-MM）
export function monthChoices(first, last) {
  const months = [];
  for (let month = last; month >= first; month = shiftPeriod("month", `${month}-01`, -1).slice(0, 7)) {
    months.push(month);
  }
  return months;
}

// 月のカレンダーの日付。月曜から始まる週ごとに、前後の月の日も含めて並べる
export function calendarDays(month) {
  const { from, to } = periodOf("month", `${month}-01`);
  const start = periodOf("week", from).from;
  const end = periodOf("week", to).to;
  const days = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

export function dateLabel(iso) {
  return `${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日（${WEEKDAYS[weekdayOf(iso)]}）`;
}

export function periodLabel(mode, date) {
  const { from, to } = periodOf(mode, date);
  if (mode === "month") {
    return `${from.slice(0, 4)}年${Number(from.slice(5, 7))}月`;
  }
  if (mode === "week") {
    return `${dateLabel(from)}〜${dateLabel(to)}`;
  }
  return `${from.slice(0, 4)}年${dateLabel(from)}`;
}

// ---- 検索 ----

// 検索の語。空白で区切る
export function searchWords(query) {
  return String(query ?? "").normalize("NFKC").trim().split(/\s+/).filter(Boolean);
}

// 語のまわりの文を切り出し、語に印を付けた HTML にする。全角・半角と大文字・小文字の違いは見ない
export function snippetHtml(text, words, around = 40) {
  const plain = String(text ?? "").replace(IMAGE, "").replace(/[#*|~`>]+/g, " ").replace(/\s+/g, " ").trim();
  const folded = plain.normalize("NFKC").toLowerCase();
  // NFKC で文字の数が変わることがあるので、1 文字ずつそろえた写しで探す
  const chars = [...plain];
  const foldedChars = chars.map((c) => c.normalize("NFKC").toLowerCase());
  const joined = foldedChars.join("");
  const offsets = [];
  let acc = 0;
  for (const c of foldedChars) {
    offsets.push(acc);
    acc += c.length;
  }
  const toIndex = (at) => {
    const i = offsets.findIndex((offset) => offset >= at);
    return i < 0 ? chars.length : i;
  };
  const marks = [];
  for (const word of words.map((w) => w.normalize("NFKC").toLowerCase())) {
    for (let at = joined.indexOf(word); at >= 0 && word; at = joined.indexOf(word, at + word.length)) {
      marks.push([toIndex(at), toIndex(at + word.length)]);
    }
  }
  if (!folded || !marks.length) {
    return escapeHtml(chars.slice(0, around * 2).join("")) + (chars.length > around * 2 ? "…" : "");
  }
  marks.sort((a, b) => a[0] - b[0]);
  const first = marks[0][0];
  const start = Math.max(0, first - around);
  const end = Math.min(chars.length, first + around * 2);
  let html = start > 0 ? "…" : "";
  let at = start;
  for (const [from, to] of marks.filter(([from]) => from >= start && from < end)) {
    if (from < at) {
      continue;
    }
    html += escapeHtml(chars.slice(at, from).join("")) + `<mark>${escapeHtml(chars.slice(from, Math.min(to, end)).join(""))}</mark>`;
    at = Math.min(to, end);
  }
  html += escapeHtml(chars.slice(at, end).join("")) + (end < chars.length ? "…" : "");
  return html;
}

// ---- Markdown の表示 ----
// いまの日記で使っている書き方だけを扱う: 見出し、段落、箇条書き、表（写真を並べる）、写真、リンク、太字、斜体、取り消し線。
// photo(name) は写真の <img> の HTML を返す

function inline(text, photo) {
  const tokens = [];
  const keep = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let out = String(text)
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, c) => keep(escapeHtml(c)))
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => keep(photo(src.split("/").pop(), alt)))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`));
  out = escapeHtml(out)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
}

function tableCells(line) {
  const cells = [];
  let cell = "";
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (text[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += text[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

const isSeparator = (cells) => cells.every((cell) => /^:?-+:?$/.test(cell));
const hasPhoto = (text) => /!\[[^\]]*\]\([^)]+\)/.test(text);

// 写真の表のセル。写真と説明の文を、書いた順に縦に並べる。説明は写真と同じ幅で折り返す
function photoCell(text, photo) {
  if (!hasPhoto(text)) {
    // 空のセルは幅を持たせない（Google ドキュメントの表の名残で、写真の列に空のセルがあることがある）
    return text.trim() ? `<td class="diary-side">${inline(text, photo)}</td>` : "<td></td>";
  }
  const parts = [];
  let at = 0;
  for (const match of text.matchAll(/!\[[^\]]*\]\([^)]+\)/g)) {
    const before = text.slice(at, match.index).trim();
    if (before) {
      parts.push(`<span class="diary-caption">${inline(before, photo)}</span>`);
    }
    parts.push(inline(match[0], photo));
    at = match.index + match[0].length;
  }
  const after = text.slice(at).trim();
  if (after) {
    parts.push(`<span class="diary-caption">${inline(after, photo)}</span>`);
  }
  return `<td><div class="diary-figure">${parts.join("")}</div></td>`;
}

// 表。写真が 1 枚でも入っていれば写真の表（枠線なしで並べる。1 行目も見出しにしない）、
// なければ文字の表（枠線を付け、区切りの行の上の行を見出しとして太字にする）
function tableHtml(lines, photo) {
  const rows = [];
  let headerRows = 0;
  for (const line of lines) {
    const cells = tableCells(line);
    if (isSeparator(cells)) {
      headerRows ||= rows.length;
    } else {
      rows.push(cells);
    }
  }
  const width = Math.max(...rows.map((row) => row.length));
  const full = (row) => Array.from({ length: width }, (_, k) => row[k] || "");
  if (rows.some((row) => row.some(hasPhoto))) {
    const body = rows
      .filter((row) => row.some(Boolean))
      .map((row) => `<tr>${full(row).map((cell) => photoCell(cell, photo)).join("")}</tr>`)
      .join("");
    return `<div class="diary-table is-photos"><table>${body}</table></div>`;
  }
  const head = rows
    .slice(0, headerRows)
    .map((row) => `<tr>${full(row).map((cell) => `<th>${inline(cell, photo)}</th>`).join("")}</tr>`)
    .join("");
  const body = rows
    .slice(headerRows)
    .filter((row) => row.some(Boolean))
    .map((row) => `<tr>${full(row).map((cell) => `<td>${inline(cell, photo)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="diary-table is-text"><table>${head ? `<thead>${head}</thead>` : ""}<tbody>${body}</tbody></table></div>`;
}

// headingBase: 本文の見出し（##）を、画面の何番目の見出しにするか
export function renderMarkdown(body, photo, { headingBase = 3 } = {}) {
  const lines = splitLines(body);
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = HEADING.exec(line);
    if (!line.trim()) {
      i += 1;
    } else if (heading) {
      const level = Math.min(6, headingBase + Math.max(0, heading[1].length - 2));
      html.push(`<h${level} class="diary-heading">${inline(heading[2].trim(), photo)}</h${level}>`);
      i += 1;
    } else if (line.trim().startsWith("|")) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        block.push(lines[i]);
        i += 1;
      }
      html.push(tableHtml(block, photo));
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        const depth = Math.min(4, Math.floor(match[1].replace(/\t/g, "    ").length / 2));
        items.push(`<li class="diary-depth-${depth}">${inline(match[3], photo)}</li>`);
        i += 1;
      }
      html.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else {
      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !lines[i].trim().startsWith("|") && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        paragraph.push(inline(lines[i].trim(), photo));
        i += 1;
      }
      html.push(`<p>${paragraph.join("<br />")}</p>`);
    }
  }
  return html.join("");
}

// ---- 写真の撮影日時（EXIF） ----

// JPEG の EXIF から撮影日時（DateTimeOriginal、なければ DateTime）を "YYYY-MM-DD HH:MM:SS" で返す。読めなければ null。
// 位置情報などは読まない（保存する写真は、描き直して EXIF を外す）
export function exifDateTime(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) {
    return null;
  }
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    const size = view.getUint16(offset + 2);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) {
      return null;
    }
    if (marker === 0xffe1 && offset + 10 <= view.byteLength && view.getUint32(offset + 4) === 0x45786966) {
      return readTiffDate(view, offset + 10, Math.min(view.byteLength, offset + 2 + size));
    }
    offset += 2 + size;
  }
  return null;
}

function readTiffDate(view, tiff, limit) {
  try {
    const little = view.getUint16(tiff) === 0x4949;
    const u16 = (at) => view.getUint16(at, little);
    const u32 = (at) => view.getUint32(at, little);
    // IFD の中の、ある番号の項目の値の場所（ASCII の値は 4 バイトより長いので、TIFF の先頭からの位置で指す）
    const entry = (ifd, tag) => {
      if (ifd + 2 > limit) {
        return null;
      }
      const count = u16(ifd);
      for (let k = 0; k < count; k += 1) {
        const at = ifd + 2 + k * 12;
        if (at + 12 > limit) {
          return null;
        }
        if (u16(at) === tag) {
          return { count: u32(at + 4), value: u32(at + 8) };
        }
      }
      return null;
    };
    const ascii = (item) => {
      if (!item || tiff + item.value + item.count > limit) {
        return null;
      }
      let text = "";
      for (let k = 0; k < item.count - 1; k += 1) {
        text += String.fromCharCode(view.getUint8(tiff + item.value + k));
      }
      return text;
    };
    const ifd0 = tiff + u32(tiff + 4);
    const exifPointer = entry(ifd0, 0x8769);
    const original = exifPointer ? ascii(entry(tiff + exifPointer.value, 0x9003)) : null;
    const text = original || ascii(entry(ifd0, 0x0132));
    const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text || "");
    return match && match[1] !== "0000" ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}` : null;
  } catch {
    return null;
  }
}

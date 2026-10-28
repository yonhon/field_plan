// 日程の画面の「区画と畝」。区画を畝の端の側から見た横長の図で、畝の下に、その畝の作業を縦に並べる。
// 横は実寸に比例する。畝はドラッグで左右に動かせ、端をドラッグすると幅が変わる。
import { cropLabel, plantingNumbers } from "./crops.js";
import { notify } from "./dialog.js";
import { bedAngle, edgeAngles, rectSize, viewAxes } from "./geometry.js";
import { record } from "./journal.js";
import { workActuals } from "./logs.js";
import { WORK_COLORS, existsOn, harvestEnd, workName } from "./schedule.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BOX_TOP = 8;
const BOX_HEIGHT = 84; // 畝の名前、株の印（〇）、条間と株間の文字が入る高さ
const DIM_TOP = BOX_TOP + BOX_HEIGHT + 6;
const COLUMN_TOP = DIM_TOP + 22;
const PLANT_ROWS_TOP = 26; // 株の印の 1 段目（畝の上の端から）
const PLANT_STEP = 14; // 株の印の、段の間（株間は実寸ではなく、この間隔で 2 株ぶんを描く）
const MIN_ROW_PX = 9; // 条の印どうしを、これより近づけない
const MIN_BED_PX = 112; // いちばん細い畝でも、下に作業の文字が入る幅にする
const MAX_PX_PER_M = 240;
const MIN_WIDTH_M = 0.1;
const DRAG_TOLERANCE_PX = 3;

// ctx = { state, queueSave, cropColor, plantingOn, selection, open, refresh, flagged,
//         appendBeds, createBeds, renumberBeds, removeBed, deleteBed }
let ctx = null;
let view = null; // いま描いている図の寸法 { block, v, min, max, scale, strips }
let drag = null;

const root = () => $("strip");
const canEdit = () => !window.matchMedia("(max-width: 800px)").matches;
const bySeq = (a, b) => a.seq - b.seq;

function formatDay(iso) {
  const [, month, day] = iso.split("-").map(Number);
  return `${month}/${day}`;
}

function workItems(works) {
  if (!works.length) {
    return '<p class="strip-empty">作業なし</p>';
  }
  // 名前は、管理作業（防除など）も含めたすべての種類から探す。株の手入れ・その他は中身も添える
  const types = ctx.state.allWorkTypes || ctx.state.workTypes;
  const label = (work) => workName(types.find((type) => type.code === work.work_type)?.label || work.work_type, work.detail?.spec);
  // 実際に使うプランなら、終わった作業に済みの印、取りやめた作業に取り消し線を付ける
  const active = ctx.state.field.active_plan_id === ctx.state.plan.id;
  const actuals = active ? workActuals(ctx.state.logs || []) : new Map();
  return `<ul>${works
    .map((work) => {
      const dates = work.plan_start && work.plan_end
        ? work.plan_start === work.plan_end ? formatDay(work.plan_start) : `${formatDay(work.plan_start)}〜${formatDay(work.plan_end)}`
        : "日付なし";
      const done = actuals.get(work.id)?.end ? '<span class="done-mark" title="完了">✓</span>' : "";
      const cancelled = active && work.cancelled_on ? ' class="is-cancelled" title="取りやめ"' : "";
      return `<li${cancelled}><span class="swatch" style="background:${WORK_COLORS[work.work_type] || "#888"}"></span>${escapeHtml(label(work))}${done}<small>${dates}</small></li>`;
    })
    .join("")}</ul>`;
}

// 作付の苗数と肥料の量。品目を登録していない作付には出さない
function numbersLine(bed, planting) {
  const crop = ctx.state.crops.find((item) => item.id === planting.crop_id);
  if (!crop) {
    return "";
  }
  const fertilizer = ctx.state.fertilizers.find((item) => item.id === crop.fertilizer_id);
  const numbers = plantingNumbers(bed.shape, crop, fertilizer);
  const parts = [];
  if (numbers.seedlings !== null) {
    parts.push(`苗 ${numbers.seedlings.toLocaleString("ja-JP")}`);
  }
  if (numbers.fertilizerKg !== null) {
    parts.push(`${escapeHtml(fertilizer.name)} ${numbers.fertilizerKg.toFixed(2)} kg`);
  }
  return parts.length ? `<p class="strip-numbers">${parts.join("<br>")}</p>` : "";
}

// 畝の中に、株の並び方の見本を描く（圃場計画の資料と同じく、〇を条の数 × 2 株ぶん）。
// 条は実寸の条間で横に並べ、株間は印の段の間で表す。千鳥なら、1 つおきの条を半分ずらす。
// 下に「条間」「株間」を cm で書く。品目に条数がなければ描かない
function plantMarks(crop, widthPx, heightPx) {
  const rows = crop?.row_count;
  if (!(rows >= 1) || heightPx < BOX_HEIGHT - 1) {
    return "";
  }
  const gapPx = Math.max(((crop.row_gap_cm || 0) / 100) * view.scale, MIN_ROW_PX);
  const marks = [];
  for (let i = 0; i < rows; i += 1) {
    const left = widthPx / 2 + (i - (rows - 1) / 2) * gapPx;
    const shift = crop.staggered && i % 2 ? PLANT_STEP / 2 : 0;
    for (const step of [0, 1]) {
      marks.push(`<span class="strip-plant" style="left:${left}px;top:${PLANT_ROWS_TOP + shift + step * PLANT_STEP}px"></span>`);
    }
  }
  const lines = [
    rows > 1 && crop.row_gap_cm ? `条間${crop.row_gap_cm}cm` : `${rows}条`,
    crop.plant_gap_cm ? `株間${crop.plant_gap_cm}cm${crop.staggered ? "（千鳥）" : ""}` : "",
  ].filter(Boolean);
  return marks.join("") + `<span class="strip-spacing">${lines.join("<br>")}</span>`;
}

// 畝の並ぶ向き（畝の長い辺に直角な向き）の軸を決め、畝を左から順の「列」にまとめる。
// 同じ列に、前後に並んだ畝が複数入ることがある
function measure(block, beds) {
  // 左右と手前・奥は、圃場の外形で決めた視点から見た向き
  const { d, v } = viewAxes(beds.length ? bedAngle(beds[0].shape) : edgeAngles(block.shape).long, ctx.state.field.view_dirs);
  const range = (points) => {
    const values = points.map((point) => point[0] * v[0] + point[1] * v[1]);
    return { min: Math.min(...values), max: Math.max(...values) };
  };
  const along = (bed) => Math.min(...bed.shape.map((point) => point[0] * d[0] + point[1] * d[1]));
  const strips = [];
  for (const bed of beds.map((item) => ({ bed: item, ...range(item.shape) })).sort((a, b) => a.min - b.min)) {
    const last = strips.at(-1);
    if (last && bed.min < last.max - 0.01) {
      last.beds.push(bed.bed);
      last.max = Math.max(last.max, bed.max);
    } else {
      strips.push({ min: bed.min, max: bed.max, beds: [bed.bed] });
    }
  }
  strips.forEach((strip) => strip.beds.sort((a, b) => along(a) - along(b)));
  return { block, v, ...range(block.shape), strips };
}

export function renderStrip() {
  const { state } = ctx;
  const sel = ctx.selection();
  const block = state.blocks.find((item) => item.id === sel.blockId);
  $("stripDate").value = state.viewDate;
  const chosen = $("stripCrop").value;
  $("stripCrop").innerHTML =
    '<option value="">品目を決めずに足す</option>' +
    state.crops.map((crop) => `<option value="${crop.id}">${escapeHtml(cropLabel(crop))}</option>`).join("");
  $("stripCrop").value = state.crops.some((crop) => crop.id === chosen) ? chosen : "";
  // なくす、消すは、畝を選んでいるときだけ
  const onBed = sel.target !== "block" && state.beds.some((bed) => bed.id === sel.target);
  $("stripRemoveBtn").disabled = !onBed;
  $("stripDeleteBtn").disabled = !onBed;
  if (!block) {
    root().innerHTML = "";
    return;
  }
  const beds = state.beds.filter((bed) => bed.block_id === block.id && existsOn(bed.start_date, bed.removed_on, state.viewDate));
  view = measure(block, beds);
  fillPlacement(sel, beds);
  // 図の左右の端。ふつうは区画の端。畝が区画からはみ出しているときは、その畝まで広げる
  const low = Math.min(view.min, ...view.strips.map((strip) => strip.min));
  const high = Math.max(view.max, ...view.strips.map((strip) => strip.max));
  const span = high - low;
  const narrowest = Math.min(...view.strips.map((strip) => strip.max - strip.min), Infinity);
  // ドラッグの途中で倍率が変わると畝が指からずれるので、そのあいだは始めたときの倍率を使う。
  // 幅を読むと、ブラウザーがその場で配置を計算し直すので、ドラッグ中は読まない
  const available = () => Math.max(root().parentElement.clientWidth - 190, 200);
  view.scale = drag?.scale || Math.min(Math.max(available() / span, Number.isFinite(narrowest) ? MIN_BED_PX / narrowest : 0), MAX_PX_PER_M);
  const x = (value) => (value - low) * view.scale;
  const editable = canEdit();

  const blockWorks = state.works.filter((work) => work.block_id === block.id).sort(bySeq);
  const left =
    `<div class="strip-left${sel.target === "block" ? " is-selected" : ""}" data-open="block">` +
    `<div class="strip-title${ctx.flagged("block", block.id) ? " is-flagged" : ""}">${escapeHtml(block.name)}の作業</div>${workItems(blockWorks)}</div>`;

  const boxes = [];
  const columns = [];
  const dims = [];
  const dim = (from, to, key) => {
    const cm = Math.round((to - from) * 100);
    const clickable = editable && key ? ` data-dim="${key}" title="クリックして cm で指定"` : "";
    dims.push(
      `<span class="strip-dim${cm < 0 ? " is-negative" : ""}${clickable ? " is-clickable" : ""}"${clickable} ` +
        `style="left:${x((from + to) / 2)}px;top:${DIM_TOP}px">${cm}cm</span>`
    );
  };
  // 隙間ごとに、そこへ畝を足すボタンを置く（左端、畝の間、右端）
  const inserts = [];
  const insertButton = (from, to, index) => {
    if (editable) {
      inserts.push(
        `<button class="strip-insert" data-insert="${index}" title="ここに畝を足す" ` +
          `style="left:${x((from + to) / 2)}px;top:${BOX_TOP + BOX_HEIGHT / 2}px">＋</button>`
      );
    }
  };
  view.strips.forEach((strip, index) => {
    insertButton(index ? view.strips[index - 1].max : view.min, strip.min, index);
    dim(index ? view.strips[index - 1].max : view.min, strip.min, `gap:${index}`);
    dim(strip.min, strip.max, `width:${index}`);
    const width = (strip.max - strip.min) * view.scale;
    const sections = [];
    strip.beds.forEach((bed, row) => {
      const plantings = state.plantings.filter((planting) => planting.bed_id === bed.id).sort(bySeq);
      const names = plantings.map((planting) => planting.crop_name).filter(Boolean);
      const shown = ctx.plantingOn(bed);
      const current = shown?.crop_name;
      const height = BOX_HEIGHT / strip.beds.length;
      const marks = plantMarks(state.crops.find((crop) => crop.id === shown?.crop_id), width, height);
      boxes.push(
        `<div class="strip-bed${sel.target === bed.id ? " is-selected" : ""}${marks ? " has-plants" : ""}" data-bed="${bed.id}" ` +
          `style="left:${x(strip.min)}px;width:${width}px;top:${BOX_TOP + row * height}px;height:${height}px;` +
          `background:${current ? ctx.cropColor(current) : "#8a5a2b"}">` +
          `<span class="strip-bed-label">${bed.seq}${names.length ? ` ${escapeHtml(names.join(" → "))}` : ""}</span>` +
          marks +
          (editable ? '<span class="strip-handle min" data-edge="min"></span><span class="strip-handle max" data-edge="max"></span>' : "") +
          `</div>`
      );
      const body = plantings.length
        ? plantings
            .map((planting) => {
              const works = state.works.filter((work) => work.planting_id === planting.id).sort(bySeq);
              const end = harvestEnd(works);
              return (
                `<div class="strip-planting"><div class="strip-crop">${planting.seq}. ${escapeHtml(planting.crop_name || "品目なし")}</div>` +
                `${numbersLine(bed, planting)}` +
                `${workItems(works)}${end ? "" : '<p class="strip-empty">収穫完了は未定</p>'}</div>`
              );
            })
            .join("")
        : '<p class="strip-empty">作付なし</p>';
      sections.push(
        `<div class="strip-column-bed${sel.target === bed.id ? " is-selected" : ""}" data-open="${bed.id}">` +
          `<div class="strip-title${ctx.flagged("bed", bed.id) ? " is-flagged" : ""}">畝${bed.seq}</div>${body}</div>`
      );
    });
    columns.push(`<div class="strip-column" style="margin-left:${x(strip.min)}px;width:${width}px">${sections.join("")}</div>`);
  });
  dim(view.strips.length ? view.strips.at(-1).max : view.min, view.max, null);
  insertButton(view.strips.length ? view.strips.at(-1).max : view.min, view.max, view.strips.length);

  root().innerHTML =
    left +
    `<div class="strip-field" style="width:${span * view.scale}px">` +
    `<div class="strip-frame" style="top:0;height:${BOX_TOP * 2 + BOX_HEIGHT}px;left:${x(view.min)}px;width:${(view.max - view.min) * view.scale}px"></div>` +
    boxes.join("") +
    inserts.join("") +
    dims.join("") +
    // 作業の列は、1 つのマスに重ねて置く。図の高さは、いちばん長い列に合わせてブラウザーが決める
    `<div class="strip-columns" style="padding-top:${COLUMN_TOP}px">${columns.join("")}</div>` +
    (beds.length ? "" : `<p class="strip-empty strip-none" style="top:${COLUMN_TOP}px">この日に畝はありません。圃場図で区画を選び、畝を並べてください。</p>`) +
    `</div>`;
}

// ---- 位置と幅の変更 ----

const acrossOf = (point) => point[0] * view.v[0] + point[1] * view.v[1];
const shifted = (point, delta) => [point[0] + view.v[0] * delta, point[1] + view.v[1] * delta];

// 畝を左右に動かす（edge が null）か、片方の端だけを動かして幅を変える
function reshape(shape, edge, delta) {
  if (!edge) {
    return shape.map((point) => shifted(point, delta));
  }
  const values = shape.map(acrossOf);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // 幅が小さくなりすぎないところで止める
  const limited = edge === "min" ? Math.min(delta, max - min - MIN_WIDTH_M) : Math.max(delta, MIN_WIDTH_M - (max - min));
  const target = edge === "min" ? min : max;
  return shape.map((point) => (Math.abs(acrossOf(point) - target) < 0.005 ? shifted(point, limited) : point));
}

function change(beds, edge, delta) {
  for (const bed of beds) {
    bed.shape = reshape(bed.shape, edge, delta);
    ctx.queueSave(`bed:${bed.id}`);
  }
}

// 幅や隙間を cm で指定する。後ろの列は、隙間を保ったまま一緒にずらす
function setDimension(key) {
  const [kind, text] = key.split(":");
  const index = Number(text);
  const strip = view.strips[index];
  const current = kind === "width" ? strip.max - strip.min : strip.min - (index ? view.strips[index - 1].max : view.min);
  const answer = prompt(kind === "width" ? "畝幅（cm）" : "隙間（cm）", String(Math.round(current * 100)));
  if (answer === null) {
    return;
  }
  const value = Number(answer.replace(/[,，\s]/g, ""));
  if (!Number.isFinite(value) || value < (kind === "width" ? MIN_WIDTH_M * 100 : 0)) {
    notify(kind === "width" ? "10 以上の数を入れてください。" : "0 以上の数を入れてください。");
    return;
  }
  const delta = value / 100 - current;
  if (kind === "width") {
    change(strip.beds, "max", delta);
  }
  const following = view.strips.slice(kind === "width" ? index + 1 : index).flatMap((item) => item.beds);
  change(following, null, delta);
  record({
    kind: kind === "width" ? "bed.width" : "bed.gap",
    target: ["bed", strip.beds[0].id],
    text: `${view.block.name} 畝${strip.beds[0].seq}の${kind === "width" ? "畝幅" : "左の隙間"}を変更${following.length && kind === "width" ? "（後ろの畝もずらした）" : ""}`,
    before: `${Math.round(current * 100)} cm`,
    after: `${value} cm`,
  });
  renderStrip();
}

// ---- 前後の位置と長さ ----
// 畝の長い辺の向きで測る。手前は、圃場の外形で決めた視点に近い側の端

const depthAxis = () => [-view.v[1], view.v[0]];

function depthOf(shape) {
  const d = depthAxis();
  const values = shape.map((point) => point[0] * d[0] + point[1] * d[1]);
  return { min: Math.min(...values), max: Math.max(...values) };
}

// 畝を、区画の手前の端から front（m）あけた所から、長さ length（m）にする
function placeAlong(shape, front, length) {
  const d = depthAxis();
  const base = depthOf(view.block.shape).min;
  const { min, max } = depthOf(shape);
  return shape.map((point) => {
    const near = point[0] * d[0] + point[1] * d[1] < (min + max) / 2;
    const delta = near ? base + front - min : base + front + length - max;
    return [point[0] + d[0] * delta, point[1] + d[1] * delta];
  });
}

let placementKey = null; // 欄に入れてある畝と値。変わったときだけ、欄を入れ直す

function fillPlacement(sel, beds) {
  $("stripSide").disabled = beds.length > 0;
  $("stripSideNote").textContent = beds.length ? "いまある畝の向きに合わせます。" : "畝がまだない区画に、最初の畝を足すときの向きです。";
  const chosen = beds.find((bed) => bed.id === sel.target);
  const bed = chosen || view.strips[0]?.beds[0];
  $("stripPlaceBtn").disabled = !chosen;
  $("stripPlaceAllBtn").disabled = !beds.length;
  $("stripRemoveAllBtn").disabled = !beds.length;
  if (!bed) {
    placementKey = null;
    $("stripFront").value = "";
    $("stripLength").value = "";
    $("stripBack").textContent = "";
    return;
  }
  const base = depthOf(view.block.shape);
  const own = depthOf(bed.shape);
  const key = [bed.id, (own.min - base.min).toFixed(3), (own.max - own.min).toFixed(3)].join("|");
  if (key !== placementKey) {
    placementKey = key;
    $("stripFront").value = Number((own.min - base.min).toFixed(2));
    $("stripLength").value = Number((own.max - own.min).toFixed(2));
  }
  $("stripBack").textContent = `いまの畝${bed.seq}: 奥の隙間 ${(base.max - own.max).toFixed(2)} m`;
}

function placeBeds(all) {
  const front = Number($("stripFront").value);
  const length = Number($("stripLength").value);
  if ($("stripFront").value.trim() === "" || !(front >= 0) || !(length > 0)) {
    notify("手前の隙間には 0 以上の数を、畝の長さには 0 より大きい数を入れてください。");
    return;
  }
  if (all && view.strips.some((strip) => strip.beds.length > 1)) {
    notify("前後に並んだ畝がある区画では、畝を 1 本ずつ選んで入れてください。");
    return;
  }
  const target = ctx.selection().target;
  const beds = view.strips.flatMap((strip) => strip.beds).filter((bed) => all || bed.id === target);
  if (!beds.length) {
    return;
  }
  for (const bed of beds) {
    bed.shape = placeAlong(bed.shape, front, length);
    ctx.queueSave(`bed:${bed.id}`);
  }
  record({
    kind: "bed.place",
    target: all ? ["block", view.block.id] : ["bed", beds[0].id],
    text: `${view.block.name}${all ? "のすべての畝" : ` 畝${beds[0].seq}`}の、前後の位置と長さを変更`,
    after: `手前の隙間 ${front} m、長さ ${length} m`,
  });
  ctx.refresh();
}

// 道具の欄の畝幅と隙間（m）。入力がおかしければ知らせて null を返す
function toolSizes() {
  const width = Number($("stripWidth").value);
  const aisle = Number($("stripAisle").value);
  if (!(width > 0) || !(aisle >= 0)) {
    notify("畝幅には 0 より大きい数を、隙間には 0 以上の数を入れてください。");
    return null;
  }
  return { width: width / 100, aisle: aisle / 100 };
}

// index 番目の隙間（0 は左端、列の数は右端）に畝を 1 列足す。
// 前の畝（または区画の端）から隙間をあけて置き、後ろの畝は、隙間が足りないぶんだけ右へずらす。
// 長さと前後の位置は、隣の畝に合わせる
function insertAt(index) {
  const sizes = toolSizes();
  if (!sizes) {
    return;
  }
  const blockId = view.block.id;
  if (!view.strips.length) {
    ctx.assignCrop(ctx.appendBeds(blockId, sizes.width * 100, sizes.aisle * 100, 1, $("stripSide").value), $("stripCrop").value);
    ctx.refresh();
    return;
  }
  const model = view.strips[index] || view.strips[index - 1];
  const start = (index ? view.strips[index - 1].max : view.min) + sizes.aisle;
  const shapes = model.beds.map((bed) =>
    reshape(reshape(bed.shape, null, start - model.min), "max", sizes.width - (model.max - model.min))
  );
  const following = view.strips.slice(index);
  const short = following.length ? start + sizes.width + sizes.aisle - following[0].min : 0;
  if (short > 0.001) {
    change(following.flatMap((strip) => strip.beds), null, short);
  }
  const created = ctx.createBeds(blockId, shapes);
  ctx.assignCrop(created, $("stripCrop").value);
  const order = [...view.strips.slice(0, index).flatMap((strip) => strip.beds), ...created, ...following.flatMap((strip) => strip.beds)];
  ctx.renumberBeds(order.map((bed) => bed.id));
  ctx.refresh();
}

export function initStrip(context) {
  ctx = context;
  const element = root();

  element.addEventListener("click", (event) => {
    const insert = event.target.closest("[data-insert]");
    if (insert) {
      insertAt(Number(insert.dataset.insert));
    }
  });
  element.addEventListener("pointerdown", (event) => {
    const box = event.target.closest(".strip-bed");
    if (!box) {
      return;
    }
    const bed = ctx.state.beds.find((item) => item.id === box.dataset.bed);
    drag = { bed, edge: event.target.dataset.edge || null, startX: event.clientX, original: bed.shape, scale: view.scale, moved: false };
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointermove", (event) => {
    if (!drag || !canEdit()) {
      return;
    }
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < DRAG_TOLERANCE_PX) {
      return;
    }
    drag.moved = true;
    // 1 cm きざみで動かす
    drag.bed.shape = reshape(drag.original, drag.edge, Math.round((dx / drag.scale) * 100) / 100);
    renderStrip();
  });
  const finish = (event) => {
    if (!drag) {
      return;
    }
    const { bed, moved, edge, original } = drag;
    drag = null;
    if (event.type === "pointercancel") {
      renderStrip();
    } else if (moved) {
      ctx.queueSave(`bed:${bed.id}`);
      const name = `${view.block.name} 畝${bed.seq}`;
      const widthOf = (shape) => `${Math.round(rectSize(shape).width * 100)} cm`;
      if (edge) {
        record({ kind: "bed.width", target: ["bed", bed.id], text: `${name}の畝幅を変更`, before: widthOf(original), after: widthOf(bed.shape) });
      } else {
        record({ kind: "bed.move", target: ["bed", bed.id], text: `${name}を移動` });
      }
      renderStrip();
    } else {
      ctx.open("bed", bed.id);
    }
  };
  element.addEventListener("pointerup", finish);
  element.addEventListener("pointercancel", finish);
  element.addEventListener("click", (event) => {
    const dimension = event.target.closest("[data-dim]");
    const opener = event.target.closest("[data-open]");
    if (dimension) {
      setDimension(dimension.dataset.dim);
    } else if (opener) {
      ctx.open(opener.dataset.open === "block" ? "block" : "bed", opener.dataset.open === "block" ? view.block.id : opener.dataset.open);
    }
  });

  $("stripAddBtn").addEventListener("click", () => {
    const sizes = toolSizes();
    const count = Math.floor(Number($("stripCount").value));
    if (!sizes) {
      return;
    }
    if (!(count >= 1)) {
      notify("本数には 1 以上の数を入れてください。");
      return;
    }
    ctx.assignCrop(ctx.appendBeds(ctx.selection().blockId, sizes.width * 100, sizes.aisle * 100, count, $("stripSide").value), $("stripCrop").value);
    ctx.refresh();
  });
  // 品目を選ぶと、その品目の畝幅と隙間を入れる
  $("stripCrop").addEventListener("change", (event) => {
    const crop = ctx.state.crops.find((item) => item.id === event.target.value);
    if (crop?.bed_width_cm) {
      $("stripWidth").value = crop.bed_width_cm;
    }
    if (crop && crop.aisle_width_cm != null) {
      $("stripAisle").value = crop.aisle_width_cm;
    }
  });
  $("stripRemoveBtn").addEventListener("click", () => {
    ctx.removeBed(ctx.selection().target);
    ctx.refresh();
  });
  $("stripDeleteBtn").addEventListener("click", () => {
    ctx.deleteBed(ctx.selection().target);
    ctx.refresh();
  });
  $("stripRemoveAllBtn").addEventListener("click", () => {
    ctx.removeBlockBeds(ctx.selection().blockId);
    ctx.refresh();
  });
  $("stripPlaceBtn").addEventListener("click", () => placeBeds(false));
  $("stripPlaceAllBtn").addEventListener("click", () => placeBeds(true));

  $("stripDate").addEventListener("change", (event) => {
    // 表示日は圃場図と共通。圃場図の側の入力欄を通して変える
    const input = $("viewDate");
    input.value = event.target.value;
    input.dispatchEvent(new Event("change"));
    ctx.refresh();
  });
}

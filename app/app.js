import {
  DEFAULT_VIEW_DIRS,
  alignBackdrop,
  anchorBackdrop,
  bedAngle,
  viewAxes,
  boundingBox,
  centroid,
  crossRange,
  cutSegment,
  distance,
  edgeAngles,
  edgeLengths,
  gapBetweenPolygons,
  gapToSegment,
  imageToWorld,
  inheritBackdrop,
  layoutBeds,
  nearestEdgeAngle,
  pointInPolygon,
  polygonArea,
  polygonInside,
  polygonsOverlap,
  rectCentered,
  rectFromDiagonal,
  rectSize,
  rotateBackdropAt,
  rotatePoints,
  scaleBackdropAt,
  scalePoints,
  splitPolygon,
  translatePoints,
  worldToImage,
} from "./geometry.js";
import { initCrops, renderCrops } from "./crops-view.js";
import { confirmAction, confirmDelete, notify } from "./dialog.js";
import { initHistory, resetHistory } from "./history.js";
import { initJournal, record, renderJournal, saveJournalNow } from "./journal.js";
import { initLogs, renderLogs } from "./log-view.js";
import { initPlantingView, openPlantingDetail, renderPlantingDetail } from "./planting-view.js";
import { initWeather, renderWeatherSettings, syncWeather } from "./weather-view.js";
import { PAGE_PX, printPage, pxToMm } from "./print.js";
import { existsOn, harvestEnd, isPlannable, localToday, worksRange } from "./schedule.js";
import { initSchedule, openInSchedule, renderSchedule } from "./schedule-view.js";
import { createLocalStore, createSupabaseStore } from "./store.js";

const config = window.FIELD_PLAN_CONFIG;
const $ = (id) => document.getElementById(id);

const ZONE_KINDS = {
  tillable: { label: "有効圃場", color: "#4c9a2a" },
  shed: { label: "物置", color: "#9a6b3f" },
  well: { label: "井戸", color: "#2a56a8" },
  path: { label: "通路", color: "#7a8587" },
  residue: { label: "残渣処理場", color: "#6d4c41" },
  other: { label: "その他", color: "#7d5ba6" },
};
const OUTLINE_COLOR = "#0b6b72";
const BLOCK_COLOR = "#b45309";
const BED_COLOR = "#8a5a2b"; // 品目がまだない畝
const HINTS = {
  select: "図形をクリックで選択。ドラッグか矢印キーで移動。辺の中ほどの丸をドラッグすると大きさが変わります。辺の長さや、隣までの距離の数字をクリックすると、数値で指定できます。",
  outline: "圃場の角を順にクリック。最初の点をクリックするか「確定」で閉じます。",
  zone: "区域の角を順にクリック。最初の点をクリックするか「確定」で閉じます。",
  rect: "対角の 2 点をドラッグ。四角形は、いちばん近い外形の辺に平行になります。",
  size: "寸法を入れて、置く場所をクリック。置いたあとはドラッグで動かせます。",
  scale: "実際の距離が分かっている 2 点を順にクリック。",
  scaleFitted: "下絵の尺度の線の両端など、実際の距離が分かっている 2 点を順にクリック。下絵の縮尺だけが変わり、図形は変わりません。",
  align: "下絵の上の目印（角や杭など）を 1 つクリック。",
  block: "有効圃場をクリックすると、その全体が 1 つの耕起対象区画になります。",
  split: "区画（または有効圃場）の中をクリックすると、その位置で 2 つに分けます。端からの距離は、クリックのあとで数値で直せます。",
  blockrect: "有効圃場の中で、対角の 2 点をドラッグ。表示日に畝がない場所を、新しい区画にします。",
};
const TABLES = { zone: "zones", block: "blocks", bed: "beds" };
const CURRENT_PLAN_KEY = "field_plan_current_plan";
const CURRENT_FIELD_KEY = "field_plan_current_field";
const VIEW_DATE_KEY = "field_plan_view_date";

// 前に開いたときの表示日。覚えていなければ今日
function savedViewDate() {
  try {
    const saved = localStorage.getItem(VIEW_DATE_KEY);
    return /^\d{4}-\d{2}-\d{2}$/.test(saved || "") ? saved : localToday();
  } catch {
    return localToday();
  }
}
const MIN_RECT_PX = 6;
const MAX_FRAME_GAPS = 4;
const MAX_NEIGHBOUR_GAPS = 3;
const GAP_RANGE_M = 20; // これより遠い辺や図形までの距離は出さない
const NUDGE_M = 0.1;
const CLICK_TOLERANCE_PX = 4;
const CLOSE_TOLERANCE_PX = 12;
const SAVE_DELAY_MS = 600;

const state = {
  store: null,
  planBusy: false, // プランの作成・切り替えなどの途中
  client: null,
  fields: [],
  field: null,
  alignment: null, // 最後に下絵を図形に 2 点で合わせたときの、下絵と図形の大きさの比（図形を下絵の縮尺に合わせるときに使う）
  backdrop: null,
  backdropUrl: "",
  backdropVisible: true,
  plans: [],
  plan: null,
  zones: [],
  blocks: [], // 耕起対象区画
  beds: [],
  plantings: [], // 作付（畝ごとの、畝立てから収穫までの 1 回ぶん）
  works: [],
  workTypes: [], // 計画に置ける作業の種類
  allWorkTypes: [], // 記録だけに使う種類（灌水、防除など）も含めた、すべての作業の種類
  logs: [], // 作業の記録（圃場ごと。新しい順）
  crops: [], // 品目の設定値（すべてのプランで共通）
  fertilizers: [],
  changes: [], // 変更の記録（新しい順。プランによらず 1 本）
  notes: [], // 日ごとのメモ
  viewDate: savedViewDate(), // 圃場図に出す日。区画と畝は、この日にあるものだけを描く
  mode: "select",
  selected: null, // "outline" か、区域・区画・畝の ID
  selectedVertex: null,
  draft: [],
  gaps: [], // 選択中の図形から、囲んでいる図形の辺と、隣の図形までのすき間
  view: { x: -40, y: -40, w: 80, h: 80 },
};

const map = $("map");

// ---- 座標 ----
// 図の中は、x が東、y が南（SVG は下向きが正なので、北向きの y を反転して描く）

function zoom() {
  const ctm = map.getScreenCTM();
  return ctm ? ctm.a : 1;
}

function clientToWorld(event) {
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(map.getScreenCTM().inverse());
  return [point.x, -point.y];
}

function setView(view) {
  state.view = view;
  map.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
}

function zoomAt(world, factor) {
  const { x, y, w, h } = state.view;
  const sx = world[0];
  const sy = -world[1];
  setView({ x: sx - (sx - x) * factor, y: sy - (sy - y) * factor, w: w * factor, h: h * factor });
}

function fitView() {
  let points = state.field.outline;
  if (points.length < 2 && state.backdrop && state.backdrop.size) {
    const [width, height] = state.backdrop.size;
    points = [[0, 0], [width, 0], [width, height], [0, height]].map((p) => imageToWorld(state.backdrop, p));
  }
  if (points.length < 2) {
    setView({ x: -40, y: -40, w: 80, h: 80 });
    return;
  }
  const box = boundingBox(points);
  const margin = Math.max(box.maxX - box.minX, box.maxY - box.minY) * 0.12 + 1;
  setView({
    x: box.minX - margin,
    y: -box.maxY - margin,
    w: box.maxX - box.minX + margin * 2,
    h: box.maxY - box.minY + margin * 2,
  });
}

// ---- PDF 出力 ----

// 圃場の全体を、下絵なし、選択の印なしで描いて、印刷に回す。
// 範囲は、圃場の外形（なければ区域）がちょうど入る四角形に、3% の余白を足したもの。向きは画面と同じ（上が北）
function printMap() {
  const points = state.field.outline.length >= 3 ? state.field.outline : state.zones.flatMap((zone) => zone.shape);
  if (points.length < 3) {
    notify("圃場の外形か区域を描くと、PDF にできます。");
    return;
  }
  const box = boundingBox(points);
  const margin = Math.max(box.maxX - box.minX, box.maxY - box.minY) * 0.03;
  const view = { x: box.minX - margin, y: -box.maxY - margin, w: box.maxX - box.minX + margin * 2, h: box.maxY - box.minY + margin * 2 };
  const landscape = view.w >= view.h;
  const [pageWidth, pageHeight] = PAGE_PX[landscape ? "landscape" : "portrait"];
  const z = Math.min(pageWidth / view.w, pageHeight / view.h);

  const kept = { selected: state.selected, vertex: state.selectedVertex, backdrop: state.backdropVisible, draft: state.draft };
  Object.assign(state, { selected: null, selectedVertex: null, backdropVisible: false, draft: [] });
  renderMap(z);
  const shapes = map.innerHTML;
  Object.assign(state, { selected: kept.selected, selectedVertex: kept.vertex, backdropVisible: kept.backdrop, draft: kept.draft });
  renderMap();

  // 縮尺の線と、北の印を、余白の帯に書く
  const meters = [100, 50, 20, 10, 5, 2, 1].find((value) => value <= view.w * 0.2) || 1;
  const bottom = view.y + view.h - margin * 0.4;
  const left = view.x + margin * 0.4;
  const text = (x, y, value, anchor) =>
    `<text class="map-label" x="${x}" y="${y}" font-size="${11 / z}" stroke-width="${3 / z}" style="text-anchor:${anchor}">${value}</text>`;
  const extras =
    `<line class="print-scale" x1="${left}" y1="${bottom}" x2="${left + meters}" y2="${bottom}" />` +
    text(left + meters + 6 / z, bottom, `${meters} m`, "start") +
    text(view.x + view.w - margin * 0.4, view.y + margin * 0.5, "↑ 北", "end");
  printPage({
    name: "圃場図",
    title: `圃場図　${state.field.name}　プラン: ${state.plan.name}　表示日: ${formatDate(state.viewDate)}`,
    body:
      `<svg class="print-map" xmlns="http://www.w3.org/2000/svg" viewBox="${view.x} ${view.y} ${view.w} ${view.h}" ` +
      `style="height:${pxToMm(Math.min(pageHeight, (pageWidth / view.w) * view.h)).toFixed(1)}mm">${shapes}${extras}</svg>`,
    landscape,
  });
}

// ---- 図形 ----

// 区域、区画、畝のどれかを ID で探す
function findShape(id) {
  for (const [kind, list] of [["zone", state.zones], ["block", state.blocks], ["bed", state.beds]]) {
    const item = list.find((entry) => entry.id === id);
    if (item) {
      return { kind, item };
    }
  }
  return null;
}

function shapePoints(key) {
  if (key === "outline") {
    return state.field.outline;
  }
  return findShape(key)?.item.shape || null;
}

function setShapePoints(key, points) {
  if (key === "outline") {
    state.field.outline = points;
    queueSave("field");
    return;
  }
  const { kind, item } = findShape(key);
  item.shape = points;
  queueSave(`${kind}:${key}`);
}

// 図形を動かす。有効圃場を動かせば中の区画と畝も、区画を動かせば中の畝も一緒に動く
function translateShape(key, dx, dy) {
  const move = (kind, item) => {
    item.shape = translatePoints(item.shape, dx, dy);
    queueSave(`${kind}:${item.id}`);
  };
  const { kind, item } = findShape(key);
  move(kind, item);
  const blocks = kind === "zone" ? state.blocks.filter((block) => block.zone_id === key) : kind === "block" ? [item] : [];
  if (kind === "zone") {
    blocks.forEach((block) => move("block", block));
  }
  for (const block of blocks) {
    state.beds.filter((bed) => bed.block_id === block.id).forEach((bed) => move("bed", bed));
  }
}

const blockActive = (block) => existsOn(block.start_date, block.end_date, state.viewDate);
const blockOf = (bed) => state.blocks.find((block) => block.id === bed.block_id);
// ---- 視点 ----
// 畝の手前・奥、左右、番号の順は、圃場の外形の辺で決めた 2 つの視点から見て決める

const COMPASS = ["東", "北東", "北", "北西", "西", "南西", "南", "南東"];
const compassOf = (degrees) => COMPASS[((Math.round(degrees / 45) % 8) + 8) % 8];
const turnGap = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

// 多角形の i 番目の辺（頂点 i から次の頂点）が、外を向いている向き（度。東が 0、北が 90）
function edgeOutward(points, i) {
  const p = points[i];
  const q = points[(i + 1) % points.length];
  const center = centroid(points);
  let normal = [q[1] - p[1], p[0] - q[0]];
  if (normal[0] * ((p[0] + q[0]) / 2 - center[0]) + normal[1] * ((p[1] + q[1]) / 2 - center[1]) < 0) {
    normal = [-normal[0], -normal[1]];
  }
  return (Math.atan2(normal[1], normal[0]) * 180) / Math.PI;
}

const edgeSide = (points, i) => `${compassOf(edgeOutward(points, i))}側`;
const viewDirs = () => (state.field.view_dirs?.length === 2 ? state.field.view_dirs : DEFAULT_VIEW_DIRS);
// 視点 k（0 か 1）が立っている、外形の辺。辺に合っていなければ -1
const viewEdge = (k) => state.field.outline.findIndex((_, i) => turnGap(edgeOutward(state.field.outline, i) + 180, viewDirs()[k]) < 1);

function setViewEdge(k, index) {
  const outline = state.field.outline;
  const dirs = [...viewDirs()];
  dirs[k] = Math.round((((edgeOutward(outline, index) + 180) % 360) + 360) % 360 * 100) / 100;
  state.field.view_dirs = dirs;
  queueSave("field");
  state.blocks.forEach((block) => renumberBlock(block.id));
  record({
    kind: "field.view",
    plan: false,
    text: `視点 ${k + 1} を、圃場の外形の辺 ${index + 1} → ${((index + 1) % outline.length) + 1}（${edgeSide(outline, index)}）に変更。畝の番号は、視点から見て左から順`,
  });
  render();
  renderSchedule();
}

// 畝は、圃場図では選んで見るだけ。追加、移動、削除は日程の画面で行う
const isBed = (id) => state.beds.some((bed) => bed.id === id);
const bedExists = (bed) => blockActive(blockOf(bed)) && existsOn(bed.start_date, bed.removed_on, state.viewDate);
const visibleBlocks = () => state.blocks.filter(blockActive);
const visibleBeds = () => state.beds.filter(bedExists);
const tillableZoneAt = (point) => state.zones.find((zone) => zone.kind === "tillable" && pointInPolygon(point, zone.shape));

// 名前のない有効圃場は、描いた順に番号を付けて呼ぶ
function zoneLabel(zone) {
  if (zone.name) {
    return zone.name;
  }
  if (zone.kind !== "tillable") {
    return ZONE_KINDS[zone.kind].label;
  }
  return `有効圃場${state.zones.filter((z) => z.kind === "tillable").indexOf(zone) + 1}`;
}

function nextBlockName() {
  const numbers = state.blocks.map((block) => /^区画(\d+)$/.exec(block.name)).filter(Boolean).map((match) => Number(match[1]));
  return `区画${Math.max(0, ...numbers) + 1}`;
}

const bedPlantings = (bed) => state.plantings.filter((planting) => planting.bed_id === bed.id).sort((a, b) => a.seq - b.seq);
const plantingWorks = (planting) => state.works.filter((work) => work.planting_id === planting.id);

// 表示日に畝にある作付。その日がどの作付の期間でもなければ、次に来る作付、それもなければ最後の作付
function plantingOn(bed) {
  const plantings = bedPlantings(bed).map((planting) => ({ planting, range: worksRange(plantingWorks(planting)) }));
  const date = state.viewDate;
  const hit =
    plantings.find(({ range }) => range && range.start <= date && date <= range.end) ||
    plantings.find(({ range }) => range && range.start > date) ||
    plantings.at(-1);
  return hit?.planting || null;
}

// 品目の名前から色を決める。同じ品目はいつも同じ色になる
function cropColor(name) {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)) % 360;
  }
  return `hsl(${hash} 55% 42%)`;
}

function formatArea(sqm) {
  return `${sqm.toLocaleString("ja-JP", { maximumFractionDigits: 0 })} ㎡（${(sqm / 100).toFixed(1)} a）`;
}

function formatLength(m) {
  return `${m.toFixed(1)} m`;
}

// 区画がある期間。例: 「2027/4/1 から」「最初から 2027/11/1 まで」
function blockPeriod(block) {
  return `${block.start_date ? formatDate(block.start_date) : "最初"} から${block.end_date ? ` ${formatDate(block.end_date)} まで` : ""}`;
}

function formatDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${year}/${month}/${day}`;
}

// 入れ物からはみ出している図形を探す。圃場の外形 ⊇ 区域 ⊇ 耕起対象区画 ⊇ 畝 の順に入っているはず。
// 区画と畝は、表示日にあるものだけを見る
function findOutside() {
  const outline = state.field.outline;
  const zoneOf = (block) => state.zones.find((zone) => zone.id === block.zone_id);
  return {
    zones: outline.length >= 3 ? state.zones.filter((zone) => !polygonInside(zone.shape, outline)) : [],
    blocks: visibleBlocks().filter((block) => !polygonInside(block.shape, zoneOf(block).shape)),
    beds: visibleBeds().filter((bed) => !polygonInside(bed.shape, blockOf(bed).shape)),
  };
}

// 変更の記録に書く、図形の呼び名と大きさ
function shapeName(key) {
  if (key === "outline") {
    return "圃場の外形";
  }
  const { kind, item } = findShape(key);
  return kind === "zone" ? `区域「${zoneLabel(item)}」` : kind === "block" ? item.name : `${blockOf(item).name} 畝${item.seq}`;
}

const sizeText = (key) => `${polygonArea(shapePoints(key)).toFixed(1)} ㎡`;

function recordMove(key) {
  const { kind } = findShape(key);
  record({ kind: `${kind}.move`, target: [kind, key], text: `${shapeName(key)}を移動` });
}

function recordShape(key, was) {
  const kind = key === "outline" ? "outline" : findShape(key).kind;
  record({
    kind: `${kind}.shape`,
    target: key === "outline" ? [] : [kind, key],
    plan: key === "outline" ? false : undefined,
    text: `${shapeName(key)}の大きさを変更`,
    before: was,
    after: sizeText(key),
  });
}

// 選択中の図形から、それを囲んでいる図形の各辺と、隣の図形までのすき間を求める。
// 区域は圃場の外形とほかの区域、区画は有効圃場とほかの区画、畝は区画とほかの畝が相手
function selectedGaps() {
  const found = state.selected && state.selected !== "outline" ? findShape(state.selected) : null;
  if (!found) {
    return [];
  }
  const { kind, item } = found;
  let frame = state.field.outline;
  let neighbours = state.zones;
  if (kind === "block") {
    frame = state.zones.find((zone) => zone.id === item.zone_id)?.shape || [];
    neighbours = visibleBlocks().filter((block) => block.zone_id === item.zone_id);
  } else if (kind === "bed") {
    frame = blockOf(item).shape;
    neighbours = visibleBeds().filter((bed) => bed.block_id === item.block_id);
  }
  const toFrame = frame.length >= 3 ? frame.map((point, i) => gapToSegment(item.shape, point, frame[(i + 1) % frame.length])) : [];
  const toNeighbours = neighbours.filter((other) => other.id !== item.id).map((other) => gapBetweenPolygons(item.shape, other.shape));
  // 重なっているか接しているものは、線を引けないので出さない
  const nearest = (gaps, count) =>
    gaps
      .filter((gap) => gap.distance >= 0.005 && gap.distance <= GAP_RANGE_M)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, count);
  // 畝は両隣だけを出す（並んだ畝の数字が重なるため）
  return [...nearest(toFrame, MAX_FRAME_GAPS), ...nearest(toNeighbours, kind === "bed" ? 2 : MAX_NEIGHBOUR_GAPS)];
}

// ---- 描画 ----

const svgPoints = (points) => points.map(([x, y]) => `${x},${-y}`).join(" ");
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// scale は、印刷用に描くときの倍率（1 m あたりの px）。ふだんは画面の倍率を使う
function renderMap(scale) {
  const printing = typeof scale === "number";
  const z = printing ? scale : zoom();
  const lengthLabels = []; // PDF に書く、辺の長さ。ほかの図形に隠れないように、最後に足す
  const fontSize = 12 / z;
  const parts = [];

  if (state.backdrop && state.backdropUrl && state.backdropVisible) {
    const { origin_px: origin, m_per_px: scale, rotation_deg: rotation } = state.backdrop;
    parts.push(
      `<image href="${escapeHtml(state.backdropUrl)}" opacity="0.85" ` +
        `transform="rotate(${rotation}) scale(${scale}) translate(${-origin[0]} ${-origin[1]})" />`
    );
  }

  const label = (point, text, size = fontSize, attrs = "") =>
    `<text class="map-label" x="${point[0]}" y="${-point[1]}" font-size="${size}" stroke-width="${size / 4}" ${attrs}>${escapeHtml(text)}</text>`;
  const outside = findOutside();
  const strays = new Set([...outside.zones, ...outside.blocks, ...outside.beds].map((item) => item.id));
  // 選択の印と、入れ物からはみ出している印
  const selectedClass = (id) => `${state.selected === id ? " is-selected" : ""}${strays.has(id) ? " is-outside" : ""}`;

  const outline = state.field.outline;
  if (outline.length >= 3) {
    parts.push(
      `<polygon class="shape${selectedClass("outline")}" data-shape="outline" ` +
        `points="${svgPoints(outline)}" fill="${OUTLINE_COLOR}" fill-opacity="0.08" stroke="${OUTLINE_COLOR}" />`
    );
  }
  // PDF では、圃場の外形と有効圃場の各辺の長さを、辺の外側に、辺に沿って書く
  if (printing) {
    for (const points of [outline, ...state.zones.filter((zone) => zone.kind === "tillable").map((zone) => zone.shape)]) {
      points.forEach((point, i) => {
        const next = points[(i + 1) % points.length];
        const length = distance(point, next);
        if (points.length < 3 || length * z < 48) {
          return;
        }
        const out = (edgeOutward(points, i) * Math.PI) / 180;
        const at = [(point[0] + next[0]) / 2 + Math.cos(out) * (11 / z), (point[1] + next[1]) / 2 + Math.sin(out) * (11 / z)];
        let degrees = (-Math.atan2(next[1] - point[1], next[0] - point[0]) * 180) / Math.PI;
        degrees = degrees > 90 ? degrees - 180 : degrees <= -90 ? degrees + 180 : degrees;
        lengthLabels.push(label(at, formatLength(length), fontSize, `transform="rotate(${degrees} ${at[0]} ${-at[1]})"`));
      });
    }
  }
  const blocks = visibleBlocks();
  const beds = visibleBeds();
  // 表示日にない区画も、一覧で選んだときは場所が分かるように薄く描く
  const ghost = state.blocks.find((block) => block.id === state.selected && !blockActive(block));
  for (const zone of state.zones) {
    const color = ZONE_KINDS[zone.kind].color;
    parts.push(
      `<polygon class="shape${selectedClass(zone.id)}" data-shape="${zone.id}" ` +
        `points="${svgPoints(zone.shape)}" fill="${color}" fill-opacity="0.35" stroke="${color}" />`
    );
    // 区画に分けた有効圃場は、区画の名前を出すので、有効圃場の名前は出さない
    if (!blocks.some((block) => block.zone_id === zone.id)) {
      parts.push(label(centroid(zone.shape), zoneLabel(zone)));
    }
  }
  for (const block of ghost ? [...blocks, ghost] : blocks) {
    parts.push(
      `<polygon class="shape block${selectedClass(block.id)}" data-shape="${block.id}" ` +
        `points="${svgPoints(block.shape)}" fill="${BLOCK_COLOR}" fill-opacity="${block === ghost ? 0.04 : 0.14}" stroke="${BLOCK_COLOR}" />`
    );
    if (!beds.some((bed) => bed.block_id === block.id)) {
      parts.push(label(centroid(block.shape), block.name));
    }
  }
  for (const bed of beds) {
    const name = plantingOn(bed)?.crop_name || "";
    const color = name ? cropColor(name) : BED_COLOR;
    parts.push(
      `<polygon class="shape bed${selectedClass(bed.id)}" data-shape="${bed.id}" ` +
        `points="${svgPoints(bed.shape)}" fill="${color}" fill-opacity="0.8" stroke="${color}" />`
    );
    // 畝の番号と品目は、畝の向きに沿って書く。画面で小さい畝には書かない。
    // 幅の狭い畝（70 cm など）でも読めるように、文字は 9px より小さくしない（畝から少しはみ出してよい）
    const size = rectSize(bed.shape);
    if (size.length * z > 50 && size.width * z > 4) {
      const [a, b] = distance(bed.shape[0], bed.shape[1]) >= distance(bed.shape[1], bed.shape[2]) ? [bed.shape[0], bed.shape[1]] : [bed.shape[1], bed.shape[2]];
      let degrees = (-Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      degrees = degrees > 90 ? degrees - 180 : degrees <= -90 ? degrees + 180 : degrees;
      const center = centroid(bed.shape);
      const text = `${bed.seq}${name ? ` ${name}` : ""}`;
      parts.push(label(center, text, Math.min(fontSize, Math.max(size.width * 0.85, 9 / z)), `transform="rotate(${degrees} ${center[0]} ${-center[1]})"`));
    }
  }

  const selectedPoints = state.selected ? shapePoints(state.selected) : null;
  const selectedKind = state.selected === "outline" ? "outline" : state.selected ? findShape(state.selected)?.kind : null;
  // 畝は四角形のまま扱うので、頂点は動かさない
  if (selectedPoints && selectedKind !== "bed") {
    const lengths = edgeLengths(selectedPoints);
    const center = centroid(selectedPoints);
    const hasBeds = selectedKind === "block" && beds.some((bed) => bed.block_id === state.selected);
    selectedPoints.forEach((point, i) => {
      const next = selectedPoints[(i + 1) % selectedPoints.length];
      // 画面で短い辺は、長さの文字と追加用の丸が頂点に重なるので出さない（拡大すれば出る）
      if (lengths[i] * z < 48) {
        return;
      }
      const mid = [(point[0] + next[0]) / 2, (point[1] + next[1]) / 2];
      // 辺の長さは図形の内側に書く。外側は、隣までの距離の数字が使う。
      // 畝のある区画だけは外側に書く（内側だと、数字が畝に重なって畝をクリックしにくい）
      const inward = distance(mid, center) || 1;
      const offset = hasBeds ? -12 / z : Math.min(14 / z, inward / 2);
      // 長さの数字はクリックできる（数値で長さを決める）
      parts.push(label([mid[0] + ((center[0] - mid[0]) / inward) * offset, mid[1] + ((center[1] - mid[1]) / inward) * offset], formatLength(lengths[i]), fontSize, `data-edge="${i}"`));
      parts.push(`<circle class="handle mid edit-only" data-mid="${i}" cx="${mid[0]}" cy="${-mid[1]}" r="${4.5 / z}" />`);
    });
    selectedPoints.forEach((point, i) => {
      parts.push(
        `<circle class="handle edit-only${state.selectedVertex === i ? " is-selected" : ""}" data-vertex="${i}" ` +
          `cx="${point[0]}" cy="${-point[1]}" r="${6.5 / z}" />`
      );
    });
  }

  // 頂点の番号。右の「辺」の表の「1 → 2」が、どの辺かを見分ける
  if (selectedPoints && selectedKind !== "bed") {
    const center = centroid(selectedPoints);
    selectedPoints.forEach((point, i) => {
      const out = distance(point, center) || 1;
      parts.push(label([point[0] + ((point[0] - center[0]) / out) * (16 / z), point[1] + ((point[1] - center[1]) / out) * (16 / z)], String(i + 1), fontSize * 1.15, 'font-weight="700"'));
    });
  }
  // 視点の矢印。立つ場所から、見る向きへ
  if (selectedKind === "outline") {
    viewDirs().forEach((degrees, k) => {
      const dir = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
      const edge = viewEdge(k);
      const center = centroid(selectedPoints);
      const reach = Math.max(...selectedPoints.map((point) => (center[0] - point[0]) * dir[0] + (center[1] - point[1]) * dir[1]));
      const foot =
        edge >= 0
          ? [(selectedPoints[edge][0] + selectedPoints[(edge + 1) % selectedPoints.length][0]) / 2, (selectedPoints[edge][1] + selectedPoints[(edge + 1) % selectedPoints.length][1]) / 2]
          : [center[0] - dir[0] * reach, center[1] - dir[1] * reach];
      const at = (back, side = 0) => [foot[0] - dir[0] * (back / z) - dir[1] * (side / z), foot[1] - dir[1] * (back / z) + dir[0] * (side / z)];
      const [from, tip, left, right] = [at(54), at(18), at(30, 7), at(30, -7)];
      parts.push(`<line class="view-line" x1="${from[0]}" y1="${-from[1]}" x2="${at(28)[0]}" y2="${-at(28)[1]}" />`);
      parts.push(`<polygon class="view-head" points="${tip[0]},${-tip[1]} ${left[0]},${-left[1]} ${right[0]},${-right[1]}" />`);
      parts.push(label(at(72), `視点${k + 1}`, fontSize * 1.1, 'font-weight="700"'));
    });
  }

  state.gaps = state.mode === "select" ? selectedGaps() : [];
  let bedAxis = null; // 選んだ畝の長い辺の向きに、長さの 35% ぶん
  if (selectedKind === "bed") {
    const [p, q, r] = selectedPoints;
    const [from, to] = distance(p, q) >= distance(q, r) ? [p, q] : [q, r];
    bedAxis = [(to[0] - from[0]) * 0.35, (to[1] - from[1]) * 0.35];
  }
  state.gaps.forEach((gap, i) => {
    // 短いすき間では、数字が頂点の丸に重なるので、線の先（相手の側）に書く
    const beyond = gap.distance * z < 44 ? 1 + 16 / z / gap.distance : 0.5;
    const mid = [gap.from[0] + (gap.to[0] - gap.from[0]) * beyond, gap.from[1] + (gap.to[1] - gap.from[1]) * beyond];
    // 畝では、数字を畝の端のほうへ寄せる（隣の畝の真ん中に重なると、その畝をクリックしにくい）
    if (bedAxis) {
      mid[0] += bedAxis[0];
      mid[1] += bedAxis[1];
    }
    parts.push(`<line class="gap-line" x1="${gap.from[0]}" y1="${-gap.from[1]}" x2="${gap.to[0]}" y2="${-gap.to[1]}" />`);
    parts.push(
      `<text class="map-label gap-label" data-gap="${i}" x="${mid[0]}" y="${-mid[1]}" font-size="${fontSize * 1.1}" ` +
        `stroke-width="${fontSize / 3}">${gap.distance.toFixed(2)} m</text>`
    );
  });

  if (state.draft.length) {
    const open = state.mode === "scale" || state.mode === "split" || state.mode === "align";
    const closing = !open && state.draft.length >= 3 ? ` ${svgPoints([state.draft[0]])}` : "";
    parts.push(`<polyline class="draft" points="${svgPoints(state.draft)}${closing}" />`);
    if (state.mode !== "split") {
      state.draft.forEach((point) => {
        parts.push(`<circle class="draft-point" cx="${point[0]}" cy="${-point[1]}" r="${4 / z}" />`);
      });
    }
  }

  map.innerHTML = parts.join("") + lengthLabels.join("");
  renderScaleBar(z);
}

function renderScaleBar(z) {
  // 画面で 60〜150 px に収まる、切りのよい長さを選ぶ
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  const meters = steps.find((step) => step * z >= 60) || steps[steps.length - 1];
  $("scaleBarLine").style.width = `${meters * z}px`;
  $("scaleBarLabel").textContent = `${meters} m`;
}

// 圃場図の警告。[選ぶ図形, 文] の並び。畝は本数が多いので、区画ごとにまとめる
function mapWarnings(outside = findOutside()) {
  const warnings = [
    ...outside.zones.map((zone) => [zone.id, `${zoneLabel(zone)}が、圃場の外形からはみ出しています。`]),
    ...outside.blocks.map((block) => [
      block.id,
      `${block.name}が、${zoneLabel(state.zones.find((zone) => zone.id === block.zone_id))}からはみ出しています。`,
    ]),
  ];
  for (const block of visibleBlocks()) {
    const strays = outside.beds.filter((bed) => bed.block_id === block.id).sort((a, b) => a.seq - b.seq);
    if (strays.length) {
      warnings.push([strays[0].id, `${block.name}の畝${strays.map((bed) => bed.seq).join("、")}が、区画からはみ出しています。`]);
    }
  }
  return warnings;
}

// 図の上の警告と、「圃場図」のタブの件数。日程の画面で畝を動かしたときも呼ばれる
function renderWarnings(outside = findOutside()) {
  const warnings = mapWarnings(outside);
  $("warnings").hidden = warnings.length === 0;
  $("warnings").innerHTML = warnings.map(([id, text]) => `<li data-shape="${id}">${escapeHtml(text)}</li>`).join("");
  $("mapBadge").hidden = warnings.length === 0;
  $("mapBadge").textContent = `⚠${warnings.length}`;
}

// 右側の木の行。圃場の外形、区域、その中の区画、その中の畝の順。
// 畝は本数が多いので、区画の ▸ を押したときと、その畝を選んでいるときだけ出す
const openBlocks = new Set();

function treeRows(outside, beds) {
  // 畝がはみ出しているときは、その区画の行にも印を付ける
  const strayIds = new Set([...outside.zones, ...outside.blocks, ...outside.beds].map((item) => item.id).concat(outside.beds.map((bed) => bed.block_id)));
  const mark = (id) => (strayIds.has(id) ? '<span class="stray-mark" title="はみ出しています"></span>' : "");
  const rows = [];
  const add = (id, depth, color, name, detail, { away = false, toggle = '<span class="tree-slot"></span>', extra = "" } = {}) =>
    rows.push({
      id,
      className: `depth-${depth}${state.selected === id ? " is-selected" : ""}${away ? " is-away" : ""}`,
      html:
        `<span>${toggle}<span class="swatch" style="background:${color}"></span>${escapeHtml(name)}${extra}${mark(id)}</span>` +
        `<span>${detail}</span>`,
    });
  const outline = state.field.outline;
  if (outline.length >= 3) {
    add("outline", 0, OUTLINE_COLOR, "圃場の外形", `${polygonArea(outline).toFixed(1)} ㎡`);
  }
  for (const zone of state.zones) {
    add(zone.id, 0, ZONE_KINDS[zone.kind].color, zoneLabel(zone), `${polygonArea(zone.shape).toFixed(1)} ㎡`);
    for (const block of state.blocks.filter((item) => item.zone_id === zone.id)) {
      const active = blockActive(block);
      const own = beds.filter((bed) => bed.block_id === block.id).sort((p, q) => p.seq - q.seq);
      const open = own.length > 0 && (openBlocks.has(block.id) || own.some((bed) => bed.id === state.selected));
      add(block.id, 1, BLOCK_COLOR, block.name, active ? `${polygonArea(block.shape).toFixed(1)} ㎡${own.length ? ` / 畝 ${own.length} 本` : ""}` : `表示日にはない（${blockPeriod(block)}）`, {
        away: !active,
        toggle: own.length
          ? `<button type="button" class="tree-toggle" data-toggle="${block.id}" aria-expanded="${open}" title="畝を${open ? "たたむ" : "開く"}">${open ? "▾" : "▸"}</button>`
          : undefined,
      });
      for (const bed of open ? own : []) {
        const size = rectSize(bed.shape);
        const crop = plantingOn(bed)?.crop_name;
        add(bed.id, 2, BED_COLOR, `畝${bed.seq}`, `${Math.round(size.width * 100)} cm × ${size.length.toFixed(1)} m`, {
          extra: crop ? `<span class="tree-crop">${escapeHtml(crop)}</span>` : "",
        });
      }
    }
  }
  if (!rows.length) {
    rows.push({ id: "empty", plain: true, className: "empty", html: "まだありません" });
  }
  return rows;
}

// 木を描く。選んだ行のすぐ下に、内容の枠（selectionPanel）を置く。
// 名前を打っている途中で枠を動かすと入力が切れるので、行は作り直さず、変わったところだけ直す
let shownSelection = null;

function renderTree(rows) {
  const list = $("shapeTree");
  const detail = $("selectionPanel");
  const old = new Map([...list.children].filter((li) => li !== detail).map((li) => [li.dataset.shape ?? li.dataset.key, li]));
  const wanted = [];
  for (const row of rows) {
    const li = old.get(row.id) || document.createElement("li");
    old.delete(row.id);
    li.dataset[row.plain ? "key" : "shape"] = row.id;
    if (li.className !== row.className) {
      li.className = row.className;
    }
    if (li.dataset.html !== row.html) {
      li.innerHTML = row.html;
      li.dataset.html = row.html;
    }
    wanted.push(li);
    if (row.id === state.selected) {
      wanted.push(detail);
    }
  }
  if (!wanted.includes(detail)) {
    wanted.push(detail);
  }
  old.forEach((li) => li.remove());
  let ref = list.firstElementChild;
  for (const li of wanted) {
    if (li === ref) {
      ref = ref.nextElementSibling;
    } else {
      list.insertBefore(li, ref);
    }
  }
}

// 図で図形を選んだときは、右側をその行まで送る。スマホは図から目が離れるので送らない
function revealSelection() {
  if (state.selected === shownSelection) {
    return;
  }
  shownSelection = state.selected;
  const row = [...$("shapeTree").children].find((li) => li.dataset.shape === state.selected);
  if (row && !window.matchMedia("(max-width: 800px)").matches) {
    $("selectionPanel").scrollIntoView({ block: "nearest" });
    row.scrollIntoView({ block: "nearest" });
  }
}

function renderPanel() {
  const outline = state.field.outline;
  const fieldArea = outline.length >= 3 ? polygonArea(outline) : 0;
  const sumArea = (items) => items.reduce((sum, item) => sum + polygonArea(item.shape), 0);
  const tillable = state.zones.filter((zone) => zone.kind === "tillable");
  const others = state.zones.filter((zone) => zone.kind !== "tillable");
  const blocks = visibleBlocks();
  const beds = visibleBeds();
  $("areaField").textContent = fieldArea ? formatArea(fieldArea) : "-";
  $("areaTillable").textContent = tillable.length ? formatArea(sumArea(tillable)) : "-";
  $("areaZones").textContent = others.length ? formatArea(sumArea(others)) : "-";
  $("areaRest").textContent = fieldArea ? formatArea(Math.max(fieldArea - sumArea(state.zones), 0)) : "-";
  $("areaBlocks").textContent = blocks.length ? formatArea(sumArea(blocks)) : "-";
  $("areaBeds").textContent = beds.length ? `${formatArea(sumArea(beds))} / ${beds.length} 本` : "-";

  const outside = findOutside();
  renderWarnings(outside);
  renderTree(treeRows(outside, beds));

  renderSelection();
  revealSelection();

  $("scaleText").textContent = state.backdrop
    ? `1 画素 = ${(state.backdrop.m_per_px * 100).toFixed(2)} cm`
    : "下絵がありません";
  $("rotation").value = state.backdrop ? state.backdrop.rotation_deg : 0;
  $("rotation").disabled = !state.backdrop;
  const fitted = Boolean(state.backdrop?.fitted);
  $("backdropRole").textContent = !state.backdrop
    ? ""
    : fitted
      ? "この下絵は、いまの図形に合わせて置いています。縮尺・向き・位置を変えても、図形は変わりません。"
      : "この下絵の上で図形を描きます。縮尺や向きを変えると、図形も一緒に伸び縮み・回転します。";
  $("alignTools").hidden = !fitted;
  $("fitShapesBtn").disabled = !state.alignment;
}

function renderSelection() {
  const points = state.selected ? shapePoints(state.selected) : null;
  $("selectionPanel").hidden = !points;
  if (!points) {
    return;
  }
  const found = state.selected === "outline" ? { kind: "outline" } : findShape(state.selected);
  const { kind, item } = found;
  $("zoneFields").hidden = kind !== "zone";
  $("outlineFields").hidden = kind !== "outline";
  $("blockFields").hidden = kind !== "block";
  $("bedFields").hidden = kind !== "bed";
  $("edgeTable").hidden = kind === "bed";
  $("deleteVertexBtn").hidden = kind === "bed";
  $("deleteShapeBtn").hidden = kind === "bed";
  $("openScheduleBtn").hidden = kind !== "block" && kind !== "bed";
  $("deleteShapeBtn").textContent = { outline: "外形を削除", zone: "区域を削除", block: "区画を削除", bed: "畝を完全に削除" }[kind];
  $("shapeInfo").textContent = "";

  if (kind === "outline") {
    $("selectionTitle").textContent = "選択中: 圃場の外形";
    [0, 1].forEach((k) => {
      const edge = viewEdge(k);
      const options = points.map((_, i) => `<option value="${i}">辺 ${i + 1} → ${((i + 1) % points.length) + 1}（${edgeSide(points, i)}、${formatLength(edgeLengths(points)[i])}）</option>`);
      if (edge < 0) {
        options.unshift(`<option value="">${compassOf(viewDirs()[k] + 180)}側から（辺を選んでいません）</option>`);
      }
      $(`viewEdge${k + 1}`).innerHTML = options.join("");
      $(`viewEdge${k + 1}`).value = edge < 0 ? "" : String(edge);
    });
    const square = turnGap(viewDirs()[0], viewDirs()[1]);
    $("viewNote").textContent =
      "その辺の外に立って、圃場を見ます。図に矢印が出ます。畝の長い辺が視点 1 の見る向きに近ければ視点 1 から、直角に近ければ視点 2 から見ます。日程の「区画と畝」の図の左右、畝の手前と奥、畝の番号（左から順）が、この視点で決まります。" +
      (square < 45 || square > 135 ? " いまの 2 つの視点は向きが近すぎます。視点 2 には、視点 1 と直角の辺を選んでください。" : "");
  } else if (kind === "zone") {
    $("selectionTitle").textContent = `選択中: ${zoneLabel(item)}`;
    if (document.activeElement !== $("zoneName")) {
      $("zoneName").value = item.name;
    }
    $("zoneKindEdit").value = item.kind;
  } else if (kind === "block") {
    $("selectionTitle").textContent = `選択中: ${item.name}`;
    if (document.activeElement !== $("blockName")) {
      $("blockName").value = item.name;
    }
    $("shapeInfo").textContent =
      `面積 ${polygonArea(item.shape).toFixed(1)} ㎡、畝 ${visibleBeds().filter((bed) => bed.block_id === item.id).length} 本` +
      (blockActive(item) ? "" : "。表示日にはない区画です");
    $("blockStart").value = item.start_date || "";
    $("blockEnd").value = item.end_date || "";
  } else {
    const size = rectSize(item.shape);
    $("selectionTitle").textContent = `選択中: ${blockOf(item).name} 畝${item.seq}`;
    $("shapeInfo").textContent = `幅 ${Math.round(size.width * 100)} cm × 長さ ${size.length.toFixed(1)} m（${polygonArea(item.shape).toFixed(1)} ㎡）`;
    const plantings = bedPlantings(item);
    $("bedPlantings").innerHTML = plantings.length
      ? plantings
          .map((planting) => {
            const range = worksRange(plantingWorks(planting));
            const end = harvestEnd(plantingWorks(planting));
            return (
              `<li><span>作付 ${planting.seq}${planting.crop_name ? `: ${escapeHtml(planting.crop_name)}` : ""}</span>` +
              `<span>${range ? `${formatDate(range.start)}〜${end ? formatDate(end) : "収穫完了は未定"}` : "日付なし"}</span></li>`
            );
          })
          .join("")
      : '<li class="empty">作付はまだありません（日程で入れます）</li>';
  }
  if (kind !== "bed") {
    $("edgeRows").innerHTML = edgeLengths(points)
      .map((length, i) => `<tr><td>${i + 1} → ${((i + 1) % points.length) + 1}（${edgeSide(points, i)}）</td><td>${formatLength(length)}</td></tr>`)
      .join("");
    $("deleteVertexBtn").disabled = state.selectedVertex === null || points.length <= 3;
  }
}

function render() {
  renderMap();
  renderPanel();
}

// ---- 保存 ----

const pendingSaves = new Set();
let saveTimer = null;

function queueSave(key) {
  pendingSaves.add(key);
  $("saveStatus").textContent = "保存中…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, SAVE_DELAY_MS);
}

async function flushSaves() {
  const keys = [...pendingSaves];
  pendingSaves.clear();
  try {
    const rows = { zones: [], blocks: [], beds: [] };
    for (const key of keys) {
      if (key === "field") {
        await state.store.saveField(state.field);
      } else if (key === "backdrop") {
        const { size, ...row } = state.backdrop;
        await state.store.saveBackdrop(row);
      } else {
        // 消したあとに残っていた保存の予約は、相手が見つからないので捨てる
        const found = findShape(key.slice(key.indexOf(":") + 1));
        if (found) {
          rows[TABLES[found.kind]].push(found.item);
        }
      }
    }
    for (const table of ["zones", "blocks", "beds"]) {
      await state.store.upsert(table, rows[table]);
    }
    if (!pendingSaves.size) {
      $("saveStatus").textContent = "保存しました";
    }
  } catch (error) {
    keys.forEach((key) => pendingSaves.add(key));
    $("saveStatus").textContent = `保存に失敗しました: ${error.message}`;
  }
}

// すぐに保存する操作（追加、削除、分割など）を包む
async function persist(action) {
  $("saveStatus").textContent = "保存中…";
  try {
    await action();
    $("saveStatus").textContent = "保存しました";
  } catch (error) {
    $("saveStatus").textContent = `保存に失敗しました: ${error.message}`;
  }
}

// ---- 操作 ----

function setMode(mode) {
  if (mode === "outline" && state.field.outline.length >= 3) {
    confirmAction({ message: "外形を描き直します。いまの外形は置き換わります。", name: "圃場の外形", action: "描き直す" }).then((ok) => {
      if (ok) {
        enterMode(mode);
      }
    });
    return;
  }
  enterMode(mode);
}

function enterMode(mode) {
  state.mode = mode;
  state.draft = [];
  if (mode !== "select") {
    state.selected = null;
    state.selectedVertex = null;
  }
  document.querySelectorAll(".mode-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  });
  map.classList.toggle("is-drawing", mode !== "select");
  $("hint").textContent = HINTS[mode === "scale" && state.backdrop?.fitted ? "scaleFitted" : mode];
  $("draftTools").hidden = mode !== "outline" && mode !== "zone";
  $("sizeTools").hidden = mode !== "size";
  $("splitTools").hidden = mode !== "split";
  render();
}

function select(id) {
  state.selected = id;
  state.selectedVertex = null;
  render();
}

function finishDraft() {
  if (state.draft.length < 3) {
    return;
  }
  const points = state.draft;
  if (state.mode === "outline") {
    state.field.outline = points;
    queueSave("field");
    setMode("select");
    record({ kind: "outline.draw", plan: false, text: "圃場の外形を描いた", after: sizeText("outline") });
    select("outline");
  } else {
    addZone(points);
  }
}

function addZone(points) {
  const zone = {
    id: crypto.randomUUID(),
    plan_id: state.plan.id,
    kind: $("zoneKind").value,
    name: "",
    shape: points,
    note: "",
    created_at: new Date().toISOString(),
  };
  state.zones.push(zone);
  queueSave(`zone:${zone.id}`);
  record({ kind: "zone.add", target: ["zone", zone.id], text: `区域「${zoneLabel(zone)}」を追加`, after: sizeText(zone.id) });
  setMode("select");
  select(zone.id);
}

function sizeInputs() {
  const along = Number($("sizeAlong").value);
  const depth = Number($("sizeDepth").value);
  return along > 0 && depth > 0 ? { along, depth } : null;
}

function sizedRect(center) {
  const size = sizeInputs();
  return size ? rectCentered(center, size.along, size.depth, nearestEdgeAngle(center, state.field.outline)) : null;
}

// 外形と、すべてのプランの区域・区画・畝に、同じ変換をかける（縮尺と向きの合わせ直しで使う）
async function transformShapes(change) {
  state.field.outline = change(state.field.outline);
  queueSave("field");
  for (const [kind, list] of [["zone", state.zones], ["block", state.blocks], ["bed", state.beds]]) {
    for (const item of list) {
      item.shape = change(item.shape);
      queueSave(`${kind}:${item.id}`);
    }
  }
  for (const plan of state.plans.filter((other) => other.id !== state.plan.id)) {
    for (const table of ["zones", "blocks", "beds"]) {
      const rows = await state.store.list(table, plan.id);
      await state.store.upsert(table, rows.map((row) => ({ ...row, shape: change(row.shape) })));
    }
  }
}

// 図形と下絵を同じ倍率で伸縮する。原点（基準点）は動かさない
function applyScale(factor) {
  if (state.backdrop) {
    state.backdrop.m_per_px *= factor;
    queueSave("backdrop");
  }
  const { x, y, w, h } = state.view;
  setView({ x: x * factor, y: y * factor, w: w * factor, h: h * factor });
  persist(() => transformShapes((points) => scalePoints(points, factor))).then(resetHistory);
  record({ kind: "field.scale", plan: false, text: "縮尺を合わせ直した（すべての図形の大きさが変わる）" });
  render();
}

// 数を尋ねる。allowZero なら 0 も受け付ける（端にぴったり付けるとき）
function askNumber(message, initial, allowZero = false) {
  const answer = prompt(message, initial ?? "");
  if (answer === null) {
    return null;
  }
  const value = Number(answer.replace(/[,，\s]/g, ""));
  if (!Number.isFinite(value) || value < 0 || (value === 0 && !allowZero)) {
    notify(allowZero ? "0 以上の数を入れてください。" : "0 より大きい数を入れてください。");
    return null;
  }
  return value;
}

function finishScale() {
  const measured = distance(state.draft[0], state.draft[1]);
  const actual = measured > 0 ? askNumber("この 2 点の実際の距離（m）") : null;
  if (actual && state.backdrop?.fitted) {
    // 図形に合わせて置いた下絵: 下絵の縮尺だけを変える。クリックした 2 点の中ほどは動かさない
    const middle = [(state.draft[0][0] + state.draft[1][0]) / 2, (state.draft[0][1] + state.draft[1][1]) / 2];
    setBackdrop(scaleBackdropAt(state.backdrop, actual / measured, middle));
    record({ kind: "backdrop.scale", plan: false, text: "下絵の縮尺を、下絵の尺度で合わせた（図形は変わらない）", after: `1 画素 = ${(state.backdrop.m_per_px * 100).toFixed(3)} cm` });
  } else if (actual) {
    applyScale(actual / measured);
  }
  setMode("select");
}

// 下絵の縮尺・向き・位置を変える。図形は変えない。前に測った下絵と図形の大きさの比は、使えなくなる
function setBackdrop(backdrop) {
  state.backdrop = backdrop;
  state.alignment = null;
  queueSave("backdrop");
  render();
}

// 圃場に図形が 1 つでもあるか（外形か、どれかのプランの区域・区画・畝）
async function fieldHasShapes() {
  if (state.field.outline.length >= 3 || state.zones.length || state.blocks.length || state.beds.length) {
    return true;
  }
  for (const plan of state.plans.filter((other) => other.id !== state.plan.id)) {
    if ((await state.store.list("zones", plan.id)).length) {
      return true;
    }
  }
  return false;
}

// 下絵を図形に合わせる。クリックは「下絵の上の目印、図形の上の点」の順で 2 組まで。
// 1 組目で平行移動し、2 組目で向きも合わせる。大きさは変えない
function alignStep() {
  const clicks = state.draft;
  if (clicks.length === 1) {
    $("hint").textContent = "その目印が来るべき、図形の上の点をクリック。";
  } else if (clicks.length === 2) {
    setBackdrop(alignBackdrop(state.backdrop, [[clicks[0], clicks[1]]]).backdrop);
    record({ kind: "backdrop.move", plan: false, text: "下絵の位置を、図形に合わせた（図形は変わらない）" });
    // 1 つ目の目印は、いまは図形の上の点にある。次のクリックは、2 組目の下絵の上の目印
    state.draft = [clicks[1], clicks[1]];
    state.alignAt = clicks[1];
    $("hint").textContent = "向きも合わせるときは、下絵の上の 2 つ目の目印をクリック（1 つ目から離れた点ほど正確です）。位置だけでよければ Esc。";
    renderMap();
  } else if (clicks.length === 3) {
    $("hint").textContent = "その 2 つ目の目印が来るべき、図形の上の点をクリック。";
  } else if (clicks.length === 4) {
    const [, , from, to] = clicks;
    const at = state.alignAt;
    const { backdrop, ratio } = alignBackdrop(state.backdrop, [[at, at], [from, to]]);
    setBackdrop(backdrop);
    state.alignment = { pixel: worldToImage(backdrop, at), at, ratio };
    record({ kind: "backdrop.turn", plan: false, text: "下絵の向きを、図形に合わせた（図形は変わらない）", after: `${round2(backdrop.rotation_deg)} 度` });
    setMode("select");
    const percent = (ratio - 1) * 100;
    notify(
      Math.abs(percent) < 0.5
        ? `図形と下絵の大きさは、ほぼ合っています（差 ${Math.abs(percent).toFixed(1)}%）。`
        : `図形は、この下絵の尺度より ${Math.abs(percent).toFixed(1)}% ${percent > 0 ? "大きく" : "小さく"}なっています` +
            `（図形の上で ${distance(at, to).toFixed(2)} m、下絵の上で ${distance(at, from).toFixed(2)} m）。\n` +
            "図形のほうが誤っているときは、「図形を下絵の縮尺に合わせる」で、この圃場の図形の大きさを直せます。下絵のほうが不正確なら、このままにしてください。"
    );
  }
}

const round2 = (value) => Math.round(value * 100) / 100;

// 図形を、下絵の縮尺に合わせる。この圃場のすべてのプランの図形を、原点のまわりに伸び縮みさせ、
// 下絵は、合わせた目印が図形と一緒に動くように平行移動する
async function fitShapesToBackdrop() {
  const alignment = state.alignment;
  if (!alignment) {
    return;
  }
  const factor = 1 / alignment.ratio;
  const ok = await confirmAction({
    message: "この圃場のすべてのプランの外形・区域・区画・畝の大きさを、下絵の縮尺に合わせて変えます。「元に戻す」では戻せません。",
    name: `図形を ${factor.toFixed(4)} 倍`,
    action: "図形の大きさを変える",
  });
  if (!ok || state.alignment !== alignment) {
    return;
  }
  const at = [alignment.at[0] * factor, alignment.at[1] * factor];
  state.backdrop = anchorBackdrop(state.backdrop, alignment.pixel, at);
  state.alignment = null;
  queueSave("backdrop");
  const { x, y, w, h } = state.view;
  setView({ x: x * factor, y: y * factor, w: w * factor, h: h * factor });
  persist(() => transformShapes((points) => scalePoints(points, factor))).then(resetHistory);
  record({ kind: "field.scale", plan: false, text: "図形を下絵の縮尺に合わせた（すべての図形の大きさが変わる）", after: `${factor.toFixed(4)} 倍` });
  render();
}


async function scaleByArea() {
  if (state.field.outline.length < 3) {
    notify("先に圃場の外形を描いてください。");
    return;
  }
  const actual = askNumber("圃場の実際の面積（㎡）");
  if (!actual) {
    return;
  }
  const factor = Math.sqrt(actual / polygonArea(state.field.outline));
  if (!state.backdrop?.fitted) {
    applyScale(factor);
    return;
  }
  // 図形に合わせて置いた下絵: 図形の大きさだけを直す。下絵は動かさない
  const ok = await confirmAction({
    message: "外形の面積に合わせて、この圃場のすべてのプランの図形の大きさを変えます。下絵は変わらないので、下絵と図形がずれます。「元に戻す」では戻せません。",
    name: `図形を ${factor.toFixed(4)} 倍`,
    action: "図形の大きさを変える",
  });
  if (!ok) {
    return;
  }
  state.alignment = null;
  persist(() => transformShapes((points) => scalePoints(points, factor))).then(resetHistory);
  record({ kind: "field.scale", plan: false, text: "外形の面積で、図形の大きさを直した（下絵は変わらない）", after: `${factor.toFixed(4)} 倍` });
  render();
}

function setRotation(degrees) {
  const delta = degrees - state.backdrop.rotation_deg;
  if (state.backdrop.fitted) {
    // 図形に合わせて置いた下絵: 下絵だけを、画面の真ん中のまわりに回す
    const { x, y, w, h } = state.view;
    setBackdrop(rotateBackdropAt(state.backdrop, delta, [x + w / 2, -(y + h / 2)]));
    record({ kind: "backdrop.turn", plan: false, text: "下絵の向きを変えた（図形は変わらない）", after: `${degrees} 度` });
    return;
  }
  state.backdrop.rotation_deg = degrees;
  queueSave("backdrop");
  if (state.field.view_dirs) {
    state.field.view_dirs = state.field.view_dirs.map((direction) => direction - delta);
    queueSave("field");
  }
  persist(() => transformShapes((points) => rotatePoints(points, delta))).then(resetHistory);
  record({ kind: "field.rotation", plan: false, text: "下絵の向きを合わせ直した", after: `${degrees} 度` });
  render();
}

// すき間を指定の距離にする。図形を、すき間の線の向きに動かす
function setGap(gap) {
  if (isBed(state.selected)) {
    return;
  }
  const target = askNumber("この距離を何 m にしますか（0 で端にぴったり付きます）", gap.distance.toFixed(2), true);
  if (target === null) {
    return;
  }
  const shift = (gap.distance - target) / gap.distance;
  translateShape(state.selected, (gap.to[0] - gap.from[0]) * shift, (gap.to[1] - gap.from[1]) * shift);
  recordMove(state.selected);
  render();
}

// 辺を、辺に直角な向きへ動かす（両端の頂点を同じだけずらす）。四角形なら、向かいの辺との幅が変わる
function moveEdge(index, delta) {
  const points = shapePoints(state.selected).map((point) => [...point]);
  const a = points[index];
  const b = points[(index + 1) % points.length];
  const length = distance(a, b) || 1;
  const normal = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
  const amount = delta[0] * normal[0] + delta[1] * normal[1];
  for (const point of [a, b]) {
    point[0] += normal[0] * amount;
    point[1] += normal[1] * amount;
  }
  setShapePoints(state.selected, points);
}

// 辺の長さを数値で決める。辺の始まりの頂点は動かさず、終わりの側（次の辺）を辺の向きにずらす
function setEdgeLength(index) {
  const was = sizeText(state.selected);
  const points = shapePoints(state.selected).map((point) => [...point]);
  const a = points[index];
  const b = points[(index + 1) % points.length];
  const c = points[(index + 2) % points.length];
  const length = distance(a, b);
  const wanted = askNumber("この辺の長さ（m）", length.toFixed(2));
  if (wanted === null || !length) {
    return;
  }
  const shift = [((b[0] - a[0]) / length) * (wanted - length), ((b[1] - a[1]) / length) * (wanted - length)];
  for (const point of points.length > 3 ? [b, c] : [b]) {
    point[0] += shift[0];
    point[1] += shift[1];
  }
  setShapePoints(state.selected, points);
  recordShape(state.selected, was);
  render();
}

// 矢印キーで動かす。向きは、囲んでいる図形の近くの辺に平行か直角のうち、押した矢印にいちばん近いもの
function nudgeSelected(arrow, step) {
  const { kind, item } = findShape(state.selected);
  const frame =
    kind === "bed" ? blockOf(item).shape : kind === "block" ? state.zones.find((zone) => zone.id === item.zone_id).shape : state.field.outline;
  const angle = nearestEdgeAngle(centroid(item.shape), frame);
  const u = [Math.cos(angle), Math.sin(angle)];
  const axes = [u, [-u[0], -u[1]], [-u[1], u[0]], [u[1], -u[0]]];
  const best = axes.reduce((a, b) => (b[0] * arrow[0] + b[1] * arrow[1] > a[0] * arrow[0] + a[1] * arrow[1] ? b : a));
  translateShape(state.selected, best[0] * step, best[1] * step);
  recordMove(state.selected);
  render();
}

function deleteSelectedVertex() {
  const points = shapePoints(state.selected);
  if (!points || state.selectedVertex === null || points.length <= 3) {
    return;
  }
  setShapePoints(state.selected, points.filter((_, i) => i !== state.selectedVertex));
  state.selectedVertex = null;
  render();
}

// 画面の側のデータから、畝や区画と、その下の作付・作業を消す（DB の側は外部キーが消す）
function forgetBeds(ids) {
  const beds = new Set(ids);
  const plantings = new Set(state.plantings.filter((planting) => beds.has(planting.bed_id)).map((planting) => planting.id));
  state.beds = state.beds.filter((bed) => !beds.has(bed.id));
  state.plantings = state.plantings.filter((planting) => !plantings.has(planting.id));
  state.works = state.works.filter((work) => !plantings.has(work.planting_id));
}

function forgetBlocks(ids) {
  const blocks = new Set(ids);
  forgetBeds(state.beds.filter((bed) => blocks.has(bed.block_id)).map((bed) => bed.id));
  state.works = state.works.filter((work) => !blocks.has(work.block_id));
  state.blocks = state.blocks.filter((block) => !blocks.has(block.id));
}

async function deleteSelectedShape() {
  if (!state.selected) {
    return;
  }
  const id = state.selected;
  if (id === "outline") {
    if ((await confirmDelete("圃場の外形を削除します。", "圃場の外形")) && state.selected === id) {
      state.field.outline = [];
      queueSave("field");
      record({ kind: "outline.delete", plan: false, text: "圃場の外形を削除" });
      select(null);
    }
    return;
  }
  const { kind, item } = findShape(id);
  const blocks = kind === "zone" ? state.blocks.filter((block) => block.zone_id === id) : kind === "block" ? [item] : [];
  const beds = kind === "bed" ? [item] : state.beds.filter((bed) => blocks.some((block) => block.id === bed.block_id));
  const message = {
    zone: () => `区域「${zoneLabel(item)}」を削除します。${blocks.length ? `中の区画 ${blocks.length} つ、畝 ${beds.length} 本と、その日程も消えます。` : ""}`,
    block: () => `区画「${item.name}」を削除します。${beds.length ? `中の畝 ${beds.length} 本と、` : ""}この区画の日程も消えます。`,
    bed: () => "この畝を、最初からなかったことにします。この畝の作付と日程も消えます。\n収穫のあとで畝をなくすだけなら、「表示日で畝をなくす」を使ってください。",
  }[kind]();
  // 確かめているあいだに、選んだ図形が変わったり消えたりしていたら、何も消さない
  if (!(await confirmDelete(message, shapeName(id))) || state.selected !== id || !findShape(id)) {
    return;
  }
  record({
    kind: `${kind}.delete`,
    text: `${shapeName(id)}を削除${kind !== "bed" && beds.length ? `（中の畝 ${beds.length} 本と日程も）` : ""}`,
  });
  if (kind === "zone") {
    forgetBlocks(blocks.map((block) => block.id));
    state.zones = state.zones.filter((zone) => zone.id !== id);
  } else if (kind === "block") {
    forgetBlocks([id]);
  } else {
    forgetBeds([id]);
    renumberBlock(item.block_id);
  }
  select(null);
  persist(() => state.store.remove(TABLES[kind], [id]));
}

// ---- 耕起対象区画 ----

// 有効圃場の中に、表示日から区画を作る。作れないときは理由を出して null を返す
function createBlock(zone, shape) {
  if (visibleBeds().some((bed) => polygonsOverlap(bed.shape, shape))) {
    notify("表示日に畝がある場所は、新しい区画にできません。先に、その畝をなくしてください。");
    return null;
  }
  const overlapping = state.blocks.filter((block) => block.zone_id === zone.id && polygonsOverlap(block.shape, shape));
  // 畝を置いたことのない区画は、描き直しとみなして置き換える（日程は新しい区画へ移す）。
  // 畝のあった区画と、日程が表示日より前に終わっている区画は、表示日で終わりにして、前の日の図を残す
  const finished = (block) => {
    const range = worksRange(state.works.filter((work) => work.block_id === block.id));
    return Boolean(range) && range.end < state.viewDate;
  };
  const replaced = [];
  const ended = [];
  for (const block of overlapping.filter(blockActive)) {
    if (!state.beds.some((bed) => bed.block_id === block.id) && !finished(block)) {
      replaced.push(block);
    } else if (!visibleBeds().some((bed) => bed.block_id === block.id)) {
      block.end_date = state.viewDate;
      ended.push(block);
    }
  }
  const id = crypto.randomUUID();
  const source = replaced.find((block) => state.works.some((work) => work.block_id === block.id));
  const inherited = source ? state.works.filter((work) => work.block_id === source.id) : [];
  inherited.forEach((work) => {
    work.block_id = id;
  });
  forgetBlocks(replaced.map((block) => block.id));
  const block = {
    id,
    plan_id: state.plan.id,
    zone_id: zone.id,
    name: nextBlockName(),
    shape,
    // 前に畝のあった区画が残る場所なら、表示日から。そうでなければ最初から
    start_date: overlapping.length > replaced.length ? state.viewDate : null,
    end_date: null,
    created_at: new Date().toISOString(),
  };
  record({
    kind: "block.add",
    target: ["block", block.id],
    text: `${block.name}を作成（${zoneLabel(zone)}の中${block.start_date ? `、${formatDate(block.start_date)} から` : ""}）`,
    after: `${polygonArea(shape).toFixed(1)} ㎡`,
  });
  state.blocks.push(block);
  persist(async () => {
    await state.store.upsert("blocks", [...ended, block]);
    // 日程を新しい区画へ付け替えてから、置き換えた区画を消す（先に消すと日程も消える）
    await state.store.upsert("works", inherited);
    await state.store.remove("blocks", replaced.map((item) => item.id));
  });
  return block;
}

async function blockFromZone(point) {
  const zone = tillableZoneAt(point);
  if (!zone) {
    notify("有効圃場の中をクリックしてください。");
    return;
  }
  if (
    visibleBlocks().some((block) => block.zone_id === zone.id) &&
    !(await confirmAction({ message: "この有効圃場には、すでに区画があります。表示日から、全体を 1 つの区画に設定し直しますか。", name: zoneLabel(zone), action: "設定し直す" }))
  ) {
    return;
  }
  const block = createBlock(zone, zone.shape.map((p) => [...p]));
  if (block) {
    setMode("select");
    select(block.id);
  }
}

// 分ける相手（表示日にある区画か、まだ区画のない有効圃場）と、分ける線の向き
function splitTarget(point) {
  const block = visibleBlocks().findLast((item) => pointInPolygon(point, item.shape)) || null;
  const zone = block ? null : tillableZoneAt(point);
  if (!block && (!zone || state.blocks.some((item) => item.zone_id === zone.id))) {
    return null;
  }
  const shape = block ? block.shape : zone.shape;
  return { block, zone, shape, angle: edgeAngles(shape)[$("splitSide").value] };
}

function splitAt(point) {
  const target = splitTarget(point);
  if (!target) {
    notify("区画の中をクリックしてください。区画のない有効圃場なら、そのままクリックして分けられます。");
    return;
  }
  const { shape, angle } = target;
  const range = crossRange(shape, point, angle);
  const fromMin = range.at - range.min <= range.max - range.at;
  const span = range.max - range.min;
  const wanted = askNumber(`近いほうの端からの距離（m）。全体は ${span.toFixed(2)} m です。`, (fromMin ? range.at - range.min : range.max - range.at).toFixed(2));
  if (wanted === null) {
    return;
  }
  if (wanted >= span) {
    notify(`${span.toFixed(2)} m より小さい数を入れてください。`);
    return;
  }
  const shift = (fromMin ? range.min + wanted : range.max - wanted) - range.at;
  const on = [point[0] + range.normal[0] * shift, point[1] + range.normal[1] * shift];
  const parts = splitPolygon(shape, on, angle);
  if (!parts[0] || !parts[1]) {
    notify("この位置では分けられません。");
    return;
  }
  const beds = target.block ? state.beds.filter((bed) => bed.block_id === target.block.id) : [];
  const line = crossRange(shape, on, angle).at;
  const straddles = (bed) => {
    const across = crossRange(bed.shape, on, angle);
    return across.min < line - 0.01 && across.max > line + 0.01;
  };
  if (beds.some(straddles)) {
    notify("畝をまたぐ位置では分けられません。畝と畝のあいだを選んでください。");
    return;
  }

  const now = new Date().toISOString();
  const first = target.block || {
    id: crypto.randomUUID(),
    plan_id: state.plan.id,
    zone_id: target.zone.id,
    name: nextBlockName(),
    start_date: null,
    end_date: null,
    created_at: now,
  };
  first.shape = parts[0];
  if (!target.block) {
    state.blocks.push(first);
  }
  const second = { ...first, id: crypto.randomUUID(), name: nextBlockName(), shape: parts[1], created_at: now };
  state.blocks.push(second);
  // 畝は、入っている側の区画に付け替える。区画の日程は、分けた両方に同じものを持たせる
  const moved = beds.filter((bed) => pointInPolygon(centroid(bed.shape), parts[1]));
  moved.forEach((bed) => {
    bed.block_id = second.id;
  });
  const copies = state.works.filter((work) => work.block_id === first.id).map((work) => ({ ...work, id: crypto.randomUUID(), block_id: second.id }));
  state.works.push(...copies);
  record({
    kind: "block.split",
    target: ["block", second.id],
    text: `${first.name}を線で分けて、${second.name}を作成`,
    after: `${polygonArea(first.shape).toFixed(1)} ㎡ と ${polygonArea(second.shape).toFixed(1)} ㎡`,
  });
  persist(async () => {
    await state.store.upsert("blocks", [first, second]);
    await state.store.upsert("beds", moved);
    await state.store.upsert("works", copies);
  });
  state.draft = [];
  render();
}

function blockFromRect(zone, points) {
  if (!zone || !polygonInside(points, zone.shape)) {
    notify("区画は、1 つの有効圃場の中に収まるように描いてください。");
    renderMap();
    return;
  }
  const block = createBlock(zone, points);
  if (block) {
    setMode("select");
    select(block.id);
  } else {
    renderMap();
  }
}

// ---- 畝 ----

// 区画に、いまある畝の続きから畝を足す。足した畝を返す
function addBedsToBlock(block, options) {
  const mine = state.beds.filter((bed) => bed.block_id === block.id);
  const existing = mine.filter(bedExists);
  const result = layoutBeds(block.shape, { ...options, existing: existing.map((bed) => bed.shape) });
  if (!result.beds.length) {
    notify("この寸法の畝は入りません。区画の残りの幅か、長さが足りません。");
    return [];
  }
  const created = createBeds(block.id, result.beds);
  const notes = [];
  if (options.count !== null && result.strips < options.count) {
    notes.push(`${options.count} 本のうち、入ったのは ${result.strips} 本です。`);
  }
  if (result.outside) {
    notes.push(`${result.outside} 本が区画からはみ出しています。位置を直すか、削除してください。`);
  }
  if (notes.length) {
    notify(notes.join("\n"));
  }
  return created;
}

// 形の決まった畝を区画に足す。番号は、いまある畝の続き。足した畝を返す
function createBeds(blockId, shapes) {
  const mine = state.beds.filter((bed) => bed.block_id === blockId);
  // 前に畝があった場所に置くときは、表示日からの畝にする
  const former = mine.filter((bed) => !bedExists(bed));
  let seq = Math.max(0, ...mine.map((bed) => bed.seq));
  const now = new Date().toISOString();
  const beds = shapes.map((shape) => {
    seq += 1;
    return {
      id: crypto.randomUUID(),
      plan_id: state.plan.id,
      block_id: blockId,
      seq,
      shape,
      start_date: former.some((bed) => polygonsOverlap(bed.shape, shape)) ? state.viewDate : null,
      removed_on: null,
      created_at: now,
    };
  });
  state.beds.push(...beds);
  const made = state.blocks.find((block) => block.id === blockId);
  record({
    kind: "bed.add",
    target: ["block", blockId],
    text: `${made.name}に畝を ${beds.length} 本追加（幅 ${Math.round(rectSize(shapes[0]).width * 100)} cm、長さ ${rectSize(shapes[0]).length.toFixed(1)} m）`,
  });
  persist(() => state.store.upsert("beds", beds));
  return beds;
}

// 畝の番号を、渡された順（左から順）に振り直す。
// なくす日の決まっている畝は、一定の期間あった畝なので番号を変えない。その番号は欠番として、ほかの畝にも使わない
function renumberBeds(ids) {
  const beds = ids.map((id) => state.beds.find((item) => item.id === id));
  if (!beds.length) {
    return;
  }
  const retired = new Set(state.beds.filter((bed) => bed.block_id === beds[0].block_id && bed.removed_on).map((bed) => bed.seq));
  let seq = 0;
  for (const bed of beds.filter((item) => !item.removed_on)) {
    do {
      seq += 1;
    } while (retired.has(seq));
    if (bed.seq !== seq) {
      bed.seq = seq;
      queueSave(`bed:${bed.id}`);
    }
  }
}

// 区画の畝の番号を、視点から見て左から順（同じ列の中は手前から順）に振り直す
function renumberBlock(blockId) {
  const beds = state.beds.filter((bed) => bed.block_id === blockId);
  if (!beds.length) {
    return;
  }
  const { d, v } = viewAxes(bedAngle(beds[0].shape), state.field.view_dirs);
  const low = (bed, axis) => Math.min(...bed.shape.map((point) => point[0] * axis[0] + point[1] * axis[1]));
  const place = new Map(beds.map((bed) => [bed.id, [low(bed, v), low(bed, d)]]));
  beds.sort((a, b) => {
    const [across, depth] = place.get(a.id).map((value, i) => value - place.get(b.id)[i]);
    return Math.abs(across) > 0.01 ? across : depth;
  });
  renumberBeds(beds.map((bed) => bed.id));
}

// 日程の画面から畝を足す。向き、長さ、前後の隙間は、いまある最後の畝に合わせる。
// 畝がまだない区画では、side（long か short）の辺に沿って、入るだけの長さで並べる
function appendBeds(blockId, widthCm, aisleCm, count, side = "long") {
  const block = state.blocks.find((item) => item.id === blockId);
  const last = state.beds.filter((bed) => bed.block_id === blockId && bedExists(bed)).sort((a, b) => a.seq - b.seq).at(-1);
  const sizes = { width: widthCm / 100, aisle: aisleCm / 100, count };
  // 視点から見て右へ足していく向きにする（並べる向きは、長い辺の向きの左手側）
  const { d } = viewAxes(last ? bedAngle(last.shape) : edgeAngles(block.shape)[side], state.field.view_dirs);
  const angle = Math.atan2(-d[1], -d[0]);
  if (!last) {
    return addBedsToBlock(block, { ...sizes, angle, endGap: 0.5, length: null });
  }
  const along = (point) => point[0] * Math.cos(angle) + point[1] * Math.sin(angle);
  const start = Math.min(...last.shape.map(along));
  return addBedsToBlock(block, {
    ...sizes,
    angle,
    endGap: Math.max(start - Math.min(...block.shape.map(along)), 0),
    length: Math.max(...last.shape.map(along)) - start,
  });
}

// 表示日に畝をなくせない理由。なくせるなら null
function removalProblem(bed) {
  let last = null;
  for (const planting of bedPlantings(bed)) {
    const end = harvestEnd(plantingWorks(planting));
    if (!end) {
      return "収穫完了予定日が決まっていない作付があります。日程で「収穫」の終了日を入れてください。";
    }
    last = !last || end > last ? end : last;
  }
  return last && state.viewDate <= last
    ? `収穫完了予定日（${formatDate(last)}）より後の日を、表示日に選んでください。`
    : null;
}

function removeBeds(beds) {
  const removable = beds.filter((bed) => !removalProblem(bed));
  removable.forEach((bed) => {
    bed.removed_on = state.viewDate;
  });
  if (removable.length) {
    record({
      kind: "bed.remove",
      target: ["block", removable[0].block_id],
      text: `${blockOf(removable[0]).name}の畝 ${removable.map((bed) => bed.seq).join("、")} を、${formatDate(state.viewDate)} でなくす設定にした`,
    });
  }
  persist(() => state.store.upsert("beds", removable));
  return removable.length;
}

async function removeBed(id) {
  const bed = state.beds.find((item) => item.id === id);
  const problem = removalProblem(bed);
  if (problem) {
    notify(problem);
    return;
  }
  const ok = await confirmAction({
    message: `${formatDate(state.viewDate)} に、この畝をなくします。それより前の日を表示すると、畝は残っています。`,
    name: shapeName(id),
    action: "畝をなくす",
  });
  if (ok && state.beds.includes(bed)) {
    removeBeds([bed]);
    select(null);
  }
}

async function removeBlockBeds(blockId) {
  const beds = visibleBeds().filter((bed) => bed.block_id === blockId);
  if (
    !beds.length ||
    !(await confirmAction({
      message: `${formatDate(state.viewDate)} に、この区画の畝をなくします。収穫が終わっていない畝は残します。`,
      name: `${state.blocks.find((block) => block.id === blockId)?.name || "区画"}の畝 ${beds.length} 本`,
      action: "畝をなくす",
    }))
  ) {
    return;
  }
  const removed = removeBeds(beds);
  render();
  if (removed < beds.length) {
    notify(`${beds.length - removed} 本は、収穫完了予定日が未定か、表示日より後なので残しました。`);
  }
}

// ---- 圃場とプラン ----
// 圃場はいくつも持てる。外形、下絵、プランは圃場ごと。品目、肥料、作業の種類、開発日誌のメモは共通。
// 圃場の中では、外形と下絵はすべてのプランで共通で、区域・区画・畝と日程をプランごとに持つ

function renderFields() {
  $("fieldSelect").innerHTML = state.fields
    .map((field) => `<option value="${field.id}">${escapeHtml(field.name || "（名前なし）")}</option>`)
    .join("");
  $("fieldSelect").value = state.field.id;
}

// 圃場のプランと下絵を読み、圃場を入れ替える。開くプラン（前に開いていたプランか、先頭）を返す。
// プランの中身は、続けて loadPlanData で読む
async function loadFieldData(field) {
  let plans = await state.store.loadPlans(field.id);
  if (!plans.length) {
    plans = [await state.store.createPlan({ field_id: field.id, name: "プラン1" })];
  }
  const backdrop = await state.store.loadBackdrop(field.id);
  let backdropUrl = "";
  if (backdrop) {
    backdropUrl = await state.store.imageUrl(backdrop.storage_path);
    backdrop.size = await imageSize(backdropUrl).catch(() => null);
  }
  const logs = await state.store.loadLogs(field.id);
  let currentId = null;
  try {
    currentId = localStorage.getItem(CURRENT_PLAN_KEY);
  } catch {
    // 読めなければ先頭のプランを開く
  }
  Object.assign(state, { field, plans, backdrop, backdropUrl, logs, alignment: null });
  return plans.find((plan) => plan.id === currentId) || plans[0];
}

async function openField(field) {
  clearTimeout(saveTimer);
  await flushSaves();
  const plan = await loadFieldData(field);
  try {
    localStorage.setItem(CURRENT_FIELD_KEY, field.id);
  } catch {
    // 保存できなくても、次に開くときに先頭の圃場になるだけ
  }
  $("fieldName").value = field.name;
  setMode("select");
  await openPlan(plan);
  fitView();
  render();
  renderWeatherSettings();
  syncWeather();
}

function newField() {
  const name = askPlanName("新しい圃場の名前", `圃場 ${state.fields.length + 1}`);
  if (!name) {
    return;
  }
  planTask(async () => {
    const field = await state.store.createField({ name });
    state.fields.push(field);
    await openField(field);
    record({ kind: "field.add", plan: false, target: ["field", field.id], text: `圃場「${field.name}」を作成` });
  });
}

// 圃場を消す。確認の窓に名前を出した圃場だけを消し、残った圃場の先頭を開く
async function deleteField() {
  const field = state.field;
  if (state.planBusy || state.fields.length <= 1 || $("fieldSelect").value !== field.id) {
    return;
  }
  const ok = await confirmDelete(
    `この圃場を削除します。外形、下絵、プラン ${state.plans.length} つ（区域、区画、畝、日程）がすべて消えます。開発日誌の記録とメモは残ります。`,
    `圃場「${field.name}」`
  );
  if (!ok || state.field.id !== field.id) {
    return;
  }
  planTask(async () => {
    // 消す圃場の図形の保存は、もう要らない。記録は、圃場があるうちに保存しておく
    clearTimeout(saveTimer);
    pendingSaves.clear();
    await saveJournalNow();
    const imagesLeft = await state.store.deleteField(field.id);
    state.fields = state.fields.filter((item) => item.id !== field.id);
    await openField(state.fields[0]);
    record({ kind: "field.delete", plan: false, target: ["field", field.id], text: `圃場「${field.name}」を削除` });
    if (imagesLeft) {
      notify(`圃場は消しましたが、下絵の画像 ${imagesLeft} 枚を、画像の置き場から消せませんでした。`);
    }
  });
}

function renderPlans() {
  const activeId = state.field.active_plan_id;
  $("schedulePlanName").textContent = state.plan.name;
  $("planSelect").innerHTML = state.plans
    .map((plan) => `<option value="${plan.id}">${escapeHtml(plan.name)}${plan.id === activeId ? "（実際に使う）" : ""}</option>`)
    .join("");
  $("planSelect").value = state.plan.id;
  const active = state.plans.find((plan) => plan.id === activeId);
  $("activePlanInfo").textContent = active
    ? `実際に使うプラン: ${active.name}。作業の記録は、このプランの畝につなぎます。`
    : "実際に使うプランが決まっていません。決めると、作業の記録を入れられます。";
  renderFields();
  renderPlanButtons();
  renderLogs();
}

const PLAN_CONTROLS = ["fieldSelect", "newFieldBtn", "deleteFieldBtn", "planSelect", "newPlanBtn", "copyPlanBtn", "renamePlanBtn", "deletePlanBtn"];

function renderPlanButtons() {
  PLAN_CONTROLS.forEach((id) => ($(id).disabled = state.planBusy));
  $("deleteFieldBtn").disabled = state.planBusy || state.fields.length <= 1;
  $("deletePlanBtn").disabled = state.planBusy || state.plans.length <= 1;
  $("activePlanBtn").disabled = state.planBusy || state.field.active_plan_id === state.plan.id;
  document.body.classList.toggle("plan-busy", state.planBusy);
}

// 開いているプランを、実際に使うプランにする。作業の記録は、このプランの畝・作付・作業につなぐ
function useThisPlan() {
  const plan = state.plan;
  if (state.planBusy || state.field.active_plan_id === plan.id) {
    return;
  }
  planTask(async () => {
    await state.store.setActivePlan(state.field.id, plan.id);
    state.field.active_plan_id = plan.id;
    record({ kind: "plan.active", target: ["plan", plan.id], text: `プラン「${plan.name}」を、実際に使うプランに設定` });
  });
}

// 実際に使うプランの区画・畝・作付・作業。開いているプランならそれを、違えば読み込む。決まっていなければ null
async function activePlanData() {
  const id = state.field.active_plan_id;
  if (!id) {
    return null;
  }
  if (id === state.plan.id) {
    return { blocks: state.blocks, beds: state.beds, plantings: state.plantings, works: state.works, crops: state.crops };
  }
  const loaded = { crops: state.crops };
  for (const table of ["blocks", "beds", "plantings", "works"]) {
    loaded[table] = await state.store.list(table, id);
  }
  return loaded;
}

// 圃場とプランの作成・コピー・名前の変更・削除・切り替えを、1 つずつ行う。
// 終わるまでは、プランの操作と、図と日程の操作を受け付けない。プランの選び方の欄だけが先に
// 新しいプランを指し、中身はまだ前のプランのまま、というときに操作されないようにする
async function planTask(action) {
  if (state.planBusy) {
    return;
  }
  state.planBusy = true;
  renderPlanButtons();
  try {
    await persist(action);
  } finally {
    state.planBusy = false;
    renderPlans();
  }
}

async function loadPlanData(plan) {
  const loaded = {};
  for (const table of ["zones", "blocks", "beds", "plantings", "works"]) {
    loaded[table] = await state.store.list(table, plan.id);
  }
  // 読み終えてから、プランと中身を一度に入れ替える。読み込みの途中で「元に戻す」の写しを取られると、
  // 新しいプランに前のプランの中身（空のことがある）が付いた写しができ、それに戻すと中身が消える
  Object.assign(state, { plan }, loaded);
  // 畝の番号を、決まりどおり（左から順、なくした畝の番号は欠番）に揃える。
  // 番号を詰め直す仕組みを入れる前に削除した畝の跡も、ここで詰まる
  state.blocks.forEach((block) => renumberBlock(block.id));
}

async function openPlan(plan) {
  clearTimeout(saveTimer);
  await flushSaves();
  await loadPlanData(plan);
  state.selected = null;
  state.selectedVertex = null;
  state.draft = [];
  try {
    localStorage.setItem(CURRENT_PLAN_KEY, plan.id);
  } catch {
    // 保存できなくても、次に開くときに先頭のプランになるだけ
  }
  renderPlans();
  render();
  renderSchedule();
  renderPlantingDetail();
  resetHistory(); // 前のプランの履歴は使えない。開き終えた状態から数え直す
}

function askPlanName(message, initial) {
  return (prompt(message, initial) || "").trim() || null;
}

function newPlan() {
  const name = askPlanName("新しいプランの名前", `プラン${state.plans.length + 1}`);
  if (!name) {
    return;
  }
  planTask(async () => {
    const plan = await state.store.createPlan({ field_id: state.field.id, name });
    state.plans.push(plan);
    record({ kind: "plan.add", plan, target: ["plan", plan.id], text: `プラン「${plan.name}」を作成` });
    await openPlan(plan);
  });
}

function renamePlan() {
  const name = askPlanName("プランの名前", state.plan.name);
  if (!name || name === state.plan.name) {
    return;
  }
  planTask(async () => {
    await state.store.renamePlan(state.plan.id, name);
    const was = state.plan.name;
    state.plan.name = name;
    record({ kind: "plan.name", target: ["plan", state.plan.id], text: "プランの名前を変更", before: was, after: name });
    renderPlans();
  });
}

function copyPlan() {
  const name = askPlanName("コピーしたプランの名前", `${state.plan.name}のコピー`);
  if (!name) {
    return;
  }
  planTask(async () => {
    clearTimeout(saveTimer);
    await flushSaves();
    const plan = await state.store.createPlan({ field_id: state.field.id, name });
    // 行ごとに新しい ID を振り、親を指す列は新しい ID に付け替える
    const ids = new Map();
    const fresh = (id) => {
      if (!ids.has(id)) {
        ids.set(id, crypto.randomUUID());
      }
      return ids.get(id);
    };
    const parents = { zones: [], blocks: ["zone_id"], beds: ["block_id"], plantings: ["bed_id"], works: ["block_id", "planting_id"] };
    for (const [table, keys] of Object.entries(parents)) {
      const rows = state[table].map((row) => {
        const copy = { ...row, id: fresh(row.id), plan_id: plan.id };
        keys.forEach((key) => {
          copy[key] = row[key] ? fresh(row[key]) : null;
        });
        return copy;
      });
      await state.store.upsert(table, rows);
    }
    record({ kind: "plan.copy", plan, target: ["plan", plan.id], text: `プラン「${state.plan.name}」をコピーして、プラン「${plan.name}」を作成` });
    state.plans.push(plan);
    await openPlan(plan);
  });
}

async function deletePlan() {
  // 確認の窓に出すプランと、消すプランを同じものにする
  const plan = state.plan;
  if (state.planBusy || state.plans.length <= 1 || $("planSelect").value !== plan.id) {
    return;
  }
  if (plan.id === state.field.active_plan_id) {
    notify("このプランは、実際に使うプランなので削除できません。先に、ほかのプランを実際に使うプランにしてください。");
    return;
  }
  const ok = await confirmDelete("このプランを削除します。区域、区画、畝、日程がすべて消えます。", `プラン「${plan.name}」`);
  if (!ok || state.plan.id !== plan.id) {
    return;
  }
  planTask(async () => {
    clearTimeout(saveTimer);
    [...pendingSaves].filter((key) => key.includes(":")).forEach((key) => pendingSaves.delete(key));
    record({ kind: "plan.delete", plan: false, target: ["plan", plan.id], text: `プラン「${plan.name}」を削除` });
    await state.store.deletePlan(plan.id);
    state.plans = state.plans.filter((item) => item.id !== plan.id);
    await openPlan(state.plans[0]);
  });
}

function imageSize(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
    image.onerror = () => reject(new Error("画像を読み込めませんでした"));
    image.src = url;
  });
}

// 下絵を読み込む。図形がすでにある圃場では、図形に合わせて置く下絵（fitted）になり、
// 縮尺・向き・位置を変えても図形は変わらない。前の下絵と同じ範囲を、解像度だけ変えて写した画像なら、
// 縮尺・基準点・向きを、画素の数の比から引き継げる
async function loadBackdropFile(file) {
  const previous = state.backdrop;
  let size;
  const local = URL.createObjectURL(file);
  try {
    size = await imageSize(local);
  } catch (error) {
    $("saveStatus").textContent = `画像を読めませんでした: ${error.message}`;
    return;
  } finally {
    URL.revokeObjectURL(local);
  }
  let placement = null;
  let carried = false; // 前の下絵の縮尺・位置・向きを引き継いだか
  const inherited = previous?.size ? inheritBackdrop(previous, previous.size, size) : null;
  if (inherited) {
    const same = await confirmAction({
      message:
        "前の下絵と、縦と横の比が同じ画像です。同じ範囲を、解像度だけ変えて写した画像なら、前の下絵の縮尺・位置・向きを引き継ぎます。別の範囲の画像なら、仮の縮尺で置きます。",
      name: `${previous.size.join(" × ")} 画素 → ${size.join(" × ")} 画素`,
      action: "同じ範囲として引き継ぐ",
      cancel: "別の画像として置く",
    });
    if (same) {
      placement = { ...inherited, fitted: Boolean(previous.fitted) };
      carried = true;
    }
  }
  if (!placement) {
    placement = {
      m_per_px: config.defaultMetersPerPixel,
      origin_px: [size[0] / 2, size[1] / 2],
      rotation_deg: 0,
      fitted: await fieldHasShapes(),
    };
  }
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  $("saveStatus").textContent = `画像を保存中…（${mb(file.size)} MB）`;
  try {
    const path = await state.store.uploadImage(state.field.id, file, (loaded, total) => {
      $("saveStatus").textContent = `画像を保存中… ${Math.floor((loaded / (total || 1)) * 100)}%（${mb(loaded)} / ${mb(total)} MB）`;
    });
    const url = await state.store.imageUrl(path);
    state.backdrop = { id: crypto.randomUUID(), field_id: state.field.id, storage_path: path, ...placement, size };
    state.backdropUrl = url;
    state.alignment = null;
    queueSave("backdrop");
    record({
      kind: "backdrop.load",
      plan: false,
      text: carried
        ? "下絵を読み込んだ（前の下絵の縮尺・位置・向きを引き継いだ）"
        : placement.fitted
          ? "下絵を読み込んだ（図形に合わせて置く下絵。縮尺・向き・位置を変えても図形は変わらない）"
          : "下絵を読み込んだ",
      after: `${size.join(" × ")} 画素`,
    });
    if (!placement.fitted) {
      fitView();
    }
    render();
  } catch (error) {
    $("saveStatus").textContent = `画像の保存に失敗しました: ${error.message}`;
  }
}

// ---- 図の上でのマウスと指の操作 ----

const pointers = new Map();
let gesture = null; // { kind: "pan" | "vertex" | "rect" | "move" | "pinch", ... }

map.addEventListener("pointerdown", (event) => {
  map.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, [event.clientX, event.clientY]);
  if (pointers.size > 1) {
    gesture = { kind: "pinch" };
    return;
  }
  const target = event.target;
  if (state.mode === "select" && target.dataset.vertex !== undefined) {
    state.selectedVertex = Number(target.dataset.vertex);
    gesture = { kind: "vertex", index: state.selectedVertex, moved: false, was: sizeText(state.selected) };
    render();
  } else if (state.mode === "select" && target.dataset.mid !== undefined && state.selected !== "outline") {
    // 区域と区画: 辺を平行に動かして、大きさを変える
    gesture = { kind: "edge", index: Number(target.dataset.mid), last: clientToWorld(event), was: sizeText(state.selected) };
  } else if (state.mode === "select" && target.dataset.mid !== undefined) {
    // 圃場の外形: 辺の途中に頂点を足す
    const index = Number(target.dataset.mid) + 1;
    const points = [...shapePoints(state.selected)];
    points.splice(index, 0, clientToWorld(event));
    setShapePoints(state.selected, points);
    state.selectedVertex = index;
    gesture = { kind: "vertex", index, moved: true, was: sizeText(state.selected) };
    render();
  } else if (state.mode === "rect" || state.mode === "blockrect") {
    // 区域は圃場の外形の辺に、区画は有効圃場の辺に平行に描く
    const start = clientToWorld(event);
    const zone = state.mode === "blockrect" ? tillableZoneAt(start) : null;
    const frame = zone ? zone.shape : state.field.outline;
    gesture = { kind: "rect", start, zone, angle: nearestEdgeAngle(start, frame), origin: [event.clientX, event.clientY] };
  } else if (state.mode === "select" && state.selected !== "outline" && !isBed(state.selected) && target.dataset.shape && target.dataset.shape === state.selected) {
    // 選択中の図形は、ドラッグでそのまま動かせる
    gesture = { kind: "move", moved: false, start: [event.clientX, event.clientY], last: clientToWorld(event) };
  } else {
    gesture = {
      kind: "pan",
      moved: false,
      start: [event.clientX, event.clientY],
      shape: target.dataset.shape,
      gap: target.dataset.gap,
      edge: target.dataset.edge,
    };
  }
});

// マウスを動かしているあいだの下書き（置く四角形や、分ける線）
function previewAt(point) {
  if (state.mode === "size") {
    state.draft = sizedRect(point) || [];
  } else if (state.mode === "split") {
    const target = splitTarget(point);
    state.draft = (target && cutSegment(target.shape, point, target.angle)) || [];
  } else {
    return;
  }
  renderMap();
}

map.addEventListener("pointermove", (event) => {
  const previous = pointers.get(event.pointerId);
  if (!previous || !gesture) {
    if (pointers.size === 0) {
      previewAt(clientToWorld(event));
    }
    return;
  }
  const current = [event.clientX, event.clientY];
  pointers.set(event.pointerId, current);

  if (gesture.kind === "pinch" && pointers.size === 2) {
    const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
    const before = distance(previous, other);
    const after = distance(current, other);
    if (before > 0 && after > 0) {
      const middle = { clientX: (current[0] + other[0]) / 2, clientY: (current[1] + other[1]) / 2 };
      zoomAt(clientToWorld(middle), before / after);
      renderMap();
    }
  } else if (gesture.kind === "vertex") {
    const points = [...shapePoints(state.selected)];
    points[gesture.index] = clientToWorld(event);
    setShapePoints(state.selected, points);
    gesture.moved = true;
    render();
  } else if (gesture.kind === "edge") {
    const world = clientToWorld(event);
    moveEdge(gesture.index, [world[0] - gesture.last[0], world[1] - gesture.last[1]]);
    gesture.last = world;
    render();
  } else if (gesture.kind === "rect") {
    state.draft = rectFromDiagonal(gesture.start, clientToWorld(event), gesture.angle);
    renderMap();
  } else if (gesture.kind === "move") {
    if (!gesture.moved && distance(gesture.start, current) < CLICK_TOLERANCE_PX) {
      return;
    }
    gesture.moved = true;
    const world = clientToWorld(event);
    translateShape(state.selected, world[0] - gesture.last[0], world[1] - gesture.last[1]);
    gesture.last = world;
    renderMap();
  } else if (gesture.kind === "pan") {
    if (!gesture.moved && distance(gesture.start, current) < CLICK_TOLERANCE_PX) {
      return;
    }
    gesture.moved = true;
    const z = zoom();
    setView({
      ...state.view,
      x: state.view.x - (current[0] - previous[0]) / z,
      y: state.view.y - (current[1] - previous[1]) / z,
    });
  }
});

function endPointer(event) {
  pointers.delete(event.pointerId);
  const finished = gesture;
  if (pointers.size === 0) {
    gesture = null;
  }
  if (finished && finished.kind === "rect") {
    const points = state.draft;
    state.draft = [];
    if (event.type !== "pointerup" || points.length !== 4 || distance(finished.origin, [event.clientX, event.clientY]) < MIN_RECT_PX) {
      renderMap();
    } else if (state.mode === "blockrect") {
      blockFromRect(finished.zone, points);
    } else {
      addZone(points);
    }
    return;
  }
  if (finished && finished.kind === "vertex" && finished.moved) {
    recordShape(state.selected, finished.was);
  }
  if (finished && (finished.kind === "move" || finished.kind === "edge")) {
    if (finished.kind === "edge") {
      recordShape(state.selected, finished.was);
    } else if (finished.moved) {
      recordMove(state.selected);
    }
    state.selectedVertex = null;
    render();
    return;
  }
  if (!finished || finished.kind !== "pan" || finished.moved || event.type === "pointercancel") {
    return;
  }
  // 動かさずに離した = クリック
  const world = clientToWorld(event);
  if (state.mode === "size") {
    const points = sizedRect(world);
    if (points) {
      addZone(points);
    } else {
      notify("寸法には 0 より大きい数を入れてください。");
    }
    return;
  }
  if (state.mode === "block") {
    blockFromZone(world);
    return;
  }
  if (state.mode === "split") {
    splitAt(world);
    return;
  }
  if (state.mode === "select" && finished.gap !== undefined) {
    setGap(state.gaps[Number(finished.gap)]);
    return;
  }
  if (state.mode === "select" && finished.edge !== undefined) {
    setEdgeLength(Number(finished.edge));
    return;
  }
  if (state.mode === "select") {
    state.selected = finished.shape || null;
    state.selectedVertex = null;
  } else if (state.mode === "align") {
    state.draft.push(world);
    alignStep();
    renderMap();
    return;
  } else if (state.mode === "scale") {
    state.draft.push(world);
    if (state.draft.length === 2) {
      renderMap();
      finishScale();
      return;
    }
  } else if (state.mode === "outline" || state.mode === "zone") {
    const first = state.draft[0];
    if (state.draft.length >= 3 && distance(first, world) * zoom() < CLOSE_TOLERANCE_PX) {
      finishDraft();
      return;
    }
    state.draft.push(world);
  }
  render();
}

map.addEventListener("pointerup", endPointer);
map.addEventListener("pointercancel", endPointer);

map.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    zoomAt(clientToWorld(event), event.deltaY > 0 ? 1.2 : 1 / 1.2);
    renderMap();
  },
  { passive: false }
);

window.addEventListener("resize", renderMap);

const ARROWS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

document.addEventListener("keydown", (event) => {
  if (!state.field || $("appView").hidden || ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) {
    return;
  }
  if (event.key === "Escape") {
    setMode("select");
  } else if (event.key === "Enter" && (state.mode === "outline" || state.mode === "zone")) {
    finishDraft();
  } else if (event.key === "Backspace" && state.draft.length && (state.mode === "outline" || state.mode === "zone")) {
    state.draft.pop();
    render();
  } else if (event.key === "Delete" && state.mode === "select") {
    deleteSelectedVertex();
  } else if (ARROWS[event.key] && state.mode === "select" && state.selected && state.selected !== "outline" && !isBed(state.selected)) {
    event.preventDefault();
    nudgeSelected(ARROWS[event.key], event.shiftKey ? NUDGE_M * 10 : NUDGE_M);
  }
});

// ---- 画面の部品 ----

document.querySelectorAll(".mode-btn").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});
$("draftDone").addEventListener("click", finishDraft);
$("draftCancel").addEventListener("click", () => setMode("select"));
$("fitBtn").addEventListener("click", () => {
  fitView();
  renderMap();
});
$("scaleByAreaBtn").addEventListener("click", scaleByArea);
$("fitShapesBtn").addEventListener("click", fitShapesToBackdrop);
$("fieldSelect").addEventListener("change", (event) => {
  planTask(() => openField(state.fields.find((field) => field.id === event.target.value)));
});
$("newFieldBtn").addEventListener("click", newField);
$("deleteFieldBtn").addEventListener("click", deleteField);
$("planSelect").addEventListener("change", (event) => {
  planTask(() => openPlan(state.plans.find((plan) => plan.id === event.target.value)));
});
$("newPlanBtn").addEventListener("click", newPlan);
$("renamePlanBtn").addEventListener("click", renamePlan);
$("copyPlanBtn").addEventListener("click", copyPlan);
$("activePlanBtn").addEventListener("click", useThisPlan);
$("deletePlanBtn").addEventListener("click", deletePlan);
$("deleteVertexBtn").addEventListener("click", deleteSelectedVertex);
$("deleteShapeBtn").addEventListener("click", deleteSelectedShape);
$("openScheduleBtn").addEventListener("click", () => {
  openInSchedule(findShape(state.selected).kind, state.selected);
  showView("schedule");
});

$("viewDate").addEventListener("change", (event) => {
  state.viewDate = event.target.value || localToday();
  event.target.value = state.viewDate;
  try {
    localStorage.setItem(VIEW_DATE_KEY, state.viewDate);
  } catch {
    // 覚えられなくても、次に開くときに今日になるだけ
  }
  // 表示日に存在しない畝を選んだままにしない
  const found = state.selected && state.selected !== "outline" ? findShape(state.selected) : null;
  if (found && found.kind === "bed" && !bedExists(found.item)) {
    state.selected = null;
  }
  render();
});
$("fieldName").addEventListener("input", (event) => {
  state.field.name = event.target.value;
  renderFields();
  queueSave("field");
});
for (const [input, kind] of [["zoneName", "zone"], ["blockName", "block"]]) {
  $(input).addEventListener("input", (event) => {
    const { item } = findShape(state.selected);
    const was = item.name;
    item.name = event.target.value;
    record({ kind: `${kind}.name`, target: [kind, item.id], text: `${kind === "zone" ? "区域" : "区画"}の名前を変更`, before: was || "（名前なし）", after: item.name || "（名前なし）" });
    queueSave(`${kind}:${state.selected}`);
    render();
  });
}
for (const [input, key] of [["blockStart", "start_date"], ["blockEnd", "end_date"]]) {
  $(input).addEventListener("change", (event) => {
    const block = findShape(state.selected).item;
    const was = blockPeriod(block);
    block[key] = event.target.value || null;
    record({ kind: "block.period", target: ["block", block.id], text: `${block.name}がある期間を変更`, before: was, after: blockPeriod(block) });
    queueSave(`block:${state.selected}`);
    render();
  });
}
$("zoneKindEdit").addEventListener("change", (event) => {
  const zone = findShape(state.selected).item;
  const was = ZONE_KINDS[zone.kind].label;
  zone.kind = event.target.value;
  record({ kind: "zone.kind", target: ["zone", zone.id], text: `区域「${zoneLabel(zone)}」の種類を変更`, before: was, after: ZONE_KINDS[zone.kind].label });
  queueSave(`zone:${state.selected}`);
  render();
});
[0, 1].forEach((k) => {
  $(`viewEdge${k + 1}`).addEventListener("change", (event) => {
    if (event.target.value !== "") {
      setViewEdge(k, Number(event.target.value));
    }
  });
});
$("mapPdfBtn").addEventListener("click", printMap);
$("warnings").addEventListener("click", (event) => {
  const item = event.target.closest("[data-shape]");
  if (item) {
    select(item.dataset.shape);
  }
});
// 木の行を押すと選んで内容を開き、選んでいる行をもう一度押すと閉じる。▸ は畝の行の出し入れ
$("shapeTree").addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-toggle]");
  if (toggle) {
    const id = toggle.dataset.toggle;
    if (toggle.getAttribute("aria-expanded") === "true") {
      openBlocks.delete(id);
      // 選んでいる畝の行ごとたたむときは、選択も外す
      if (state.beds.some((bed) => bed.id === state.selected && bed.block_id === id)) {
        state.selected = null;
      }
    } else {
      openBlocks.add(id);
    }
    render();
    return;
  }
  const item = event.target.closest("[data-shape]");
  if (item) {
    select(state.selected === item.dataset.shape ? null : item.dataset.shape);
  }
});
$("backdropFile").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) {
    loadBackdropFile(file);
  }
});
$("backdropVisible").addEventListener("change", (event) => {
  state.backdropVisible = event.target.checked;
  renderMap();
});
$("rotation").addEventListener("change", (event) => {
  const degrees = Number(event.target.value);
  if (state.backdrop && Number.isFinite(degrees)) {
    setRotation(degrees);
  }
});

// ---- 圃場図と日程の切り替え ----

// 作付の詳細（planting）は、日程のタブの中の画面として扱う
function showView(view) {
  const tab = view === "planting" ? "schedule" : view;
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === tab);
  });
  $("appView").hidden = view !== "map";
  $("scheduleView").hidden = view !== "schedule";
  $("plantingView").hidden = view !== "planting";
  $("cropsView").hidden = view !== "crops";
  $("journalView").hidden = view !== "journal";
  if (view === "map") {
    render();
    renderWeatherSettings();
  } else if (view === "schedule") {
    renderSchedule();
    renderLogs();
  } else if (view === "planting") {
    renderPlantingDetail();
    window.scrollTo(0, 0);
  } else if (view === "crops") {
    renderCrops();
  } else {
    renderJournal();
  }
}

document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

// 記録の行をクリックしたときに、その相手を開く。もうないものは開けない
function openPlace(entry) {
  const fieldId = entry.target_kind === "field" ? entry.target_id : entry.field_id;
  const field = state.fields.find((item) => item.id === fieldId);
  if (!field) {
    $("saveStatus").textContent = "この圃場は、もうありません。";
    return;
  }
  showView("map");
  planTask(async () => {
    if (field.id !== state.field.id) {
      await openField(field);
    }
    if (entry.target_kind === "plan") {
      const plan = state.plans.find((item) => item.id === entry.target_id);
      if (!plan) {
        notify("このプランは、もうありません。");
      } else if (plan.id !== state.plan.id) {
        await openPlan(plan);
      }
    }
  });
}

function openTarget(entry) {
  const status = (text) => {
    $("saveStatus").textContent = text;
  };
  // 圃場やプランの作成・削除などの行: その圃場とプランを開く（ほかの圃場のものでも）
  if (entry.target_kind === "plan" || entry.target_kind === "field") {
    openPlace(entry);
    return;
  }
  if (entry.field_id !== state.field.id) {
    const field = state.fields.find((item) => item.id === entry.field_id);
    status(`圃場「${field?.name || "（もうない圃場）"}」での変更です。圃場を切り替えると開けます。`);
    return;
  }
  if (entry.plan_id && entry.plan_id !== state.plan.id) {
    status(`プラン「${entry.plan_name}」での変更です。プランを切り替えると開けます。`);
    return;
  }
  const kind = entry.target_kind;
  const id = entry.target_id;
  if (kind === "crop" || kind === "fertilizer") {
    showView("crops");
  } else if (kind === "planting" && state.plantings.some((item) => item.id === id)) {
    openInSchedule("planting", id);
    showView("schedule");
  } else if (kind === "work" && state.works.some((item) => item.id === id)) {
    const work = state.works.find((item) => item.id === id);
    openInSchedule(work.block_id ? "block" : "planting", work.block_id || work.planting_id);
    showView("schedule");
  } else if (["zone", "block", "bed"].includes(kind) && findShape(id)) {
    showView("map");
    select(id);
  } else if (kind) {
    status("この記録の相手は、もうありません。");
  }
}

// ---- 起動 ----

function showFatal(message) {
  $("fatalError").textContent = message;
  $("fatalError").hidden = false;
}

function describeLoadError(error) {
  if (error.code === "PGRST106") {
    return "field スキーマが API の公開対象に入っていません。\nSupabase の Integrations > Data API > Settings > Exposed schemas に field を加えてください。";
  }
  return `データを読み込めませんでした: ${error.message}`;
}

async function startApp() {
  $("loginView").hidden = true;
  try {
    state.fields = await state.store.loadFields();
    if (!state.fields.length) {
      state.fields = [await state.store.createField({ name: config.defaultFieldName })];
    }
    let fieldId = null;
    try {
      fieldId = localStorage.getItem(CURRENT_FIELD_KEY);
    } catch {
      // 読めなければ先頭の圃場を開く
    }
    state.allWorkTypes = await state.store.loadWorkTypes();
    state.workTypes = state.allWorkTypes.filter(isPlannable);
    state.crops = await state.store.listAll("crops");
    state.fertilizers = await state.store.listAll("fertilizers");
    await loadPlanData(await loadFieldData(state.fields.find((field) => field.id === fieldId) || state.fields[0]));
  } catch (error) {
    showFatal(
      error.code === "42501" || /row-level security/.test(error.message || "")
        ? "この利用者には読み書きの権限がありません。field.owners に利用者の ID を登録してください。"
        : describeLoadError(error)
    );
    return;
  }
  $("fieldName").value = state.field.name;
  $("viewDate").value = state.viewDate;
  $("appView").hidden = false;
  $("viewTabs").hidden = false;
  renderPlans();
  fitView();
  setMode("select");
  initSchedule({
    state,
    queueSave,
    cropColor,
    plantingOn,
    appendBeds,
    createBeds,
    renumberBeds,
    removeBed,
    removeBlockBeds,
    deleteBed: (id) => {
      state.selected = id;
      deleteSelectedShape();
    },
    setStatus: (text) => ($("saveStatus").textContent = text),
    renderWarnings,
    openDetail: (kind, id) => {
      openPlantingDetail(kind, id);
      showView("planting");
    },
  });
  // 記録や取りやめが変わったら、日程と作付の詳細を描き直す
  const refreshRecords = () => {
    renderSchedule();
    renderPlantingDetail();
  };
  initLogs({ state, activePlanData, setStatus: (text) => ($("saveStatus").textContent = text), onLogsChanged: refreshRecords });
  initPlantingView({
    state,
    showView,
    openInSchedule,
    setStatus: (text) => ($("saveStatus").textContent = text),
    refresh: refreshRecords,
  });
  initWeather({ state, setStatus: (text) => ($("saveStatus").textContent = text), onWeatherChanged: renderPlantingDetail });
  renderWeatherSettings();
  syncWeather();
  // スマホは作業の確認が主なので、日程から開く。
  // ほかの読み込みを待つ前に切り替える（待ってからだと、圃場図が一瞬見えてしまう）
  if (window.matchMedia("(max-width: 800px)").matches) {
    showView("schedule");
  }
  initCrops({ state, setStatus: (text) => ($("saveStatus").textContent = text) });
  try {
    await initJournal({ state, openTarget, setStatus: (text) => ($("saveStatus").textContent = text) });
  } catch (error) {
    $("saveStatus").textContent = `変更の記録を読み込めませんでした: ${error.message}`;
  }
  initHistory({
    state,
    // プランを読み込んでいるあいだは、元に戻さない
    busy: () => state.planBusy,
    setStatus: (text) => ($("saveStatus").textContent = text),
    // まだ送っていない図形の保存を、先に済ませる
    flush: async () => {
      clearTimeout(saveTimer);
      await flushSaves();
    },
    // データを入れ替えたあと、どの画面も描き直す。なくなった図形を選んだままにしない
    refresh: () => {
      if (state.selected && state.selected !== "outline" && !findShape(state.selected)) {
        state.selected = null;
      }
      state.selectedVertex = null;
      state.draft = [];
      render();
      renderSchedule();
      renderCrops();
      renderJournal();
      renderLogs();
      renderPlantingDetail();
    },
  });
}

async function main() {
  if (new URLSearchParams(location.search).has("local")) {
    state.store = createLocalStore();
    $("saveStatus").textContent = "このブラウザーの中だけに保存します";
    await startApp();
    return;
  }

  state.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { db: { schema: "field" } });
  state.store = createSupabaseStore(state.client, { url: config.supabaseUrl, anonKey: config.supabaseAnonKey });

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("loginError").textContent = "";
    const { error } = await state.client.auth.signInWithPassword({
      email: $("loginEmail").value,
      password: $("loginPassword").value,
    });
    if (error) {
      $("loginError").textContent = "ログインできませんでした。メールアドレスとパスワードを確かめてください。";
      return;
    }
    $("logoutBtn").hidden = false;
    await startApp();
  });
  $("logoutBtn").addEventListener("click", async () => {
    await state.client.auth.signOut();
    location.reload();
  });

  const { data } = await state.client.auth.getSession();
  if (data.session) {
    $("logoutBtn").hidden = false;
    await startApp();
  } else {
    $("loginView").hidden = false;
  }
}

main();

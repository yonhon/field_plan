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
  nearestEdgeAngleOf,
  outlineArea,
  outlineParts,
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
import { clearDiaryDrafts, hasDiaryDrafts, initDiary, refreshDiaryWorks, renderDiary } from "./diary-view.js";
import { setPlace, setPlaceActions, setUserMenu } from "./user-menu.js";
import { initFieldPlans, openFieldPlans, refreshFieldPlans } from "./field-plans.js";
import { initToasts } from "./toast.js";
import { confirmAction, confirmDelete, notify, notifySaveFailed } from "./dialog.js";
import { initHistory, resetHistory } from "./history.js";
import { holdRecords, initJournal, record, releaseRecords, renderJournal, saveJournalNow } from "./journal.js";
import { handleLogDialogPop, initLogs, renderLogs } from "./log-view.js";
import { initProcessEditor } from "./process-editor.js";
import { initPlantingView, openPlantingDetail, plantingTarget, renderBlockRecord, renderPlantingDetail } from "./planting-view.js";
import { loadPref, savePref } from "./prefs.js";
import { initNews } from "./news-view.js";
import { beginWeatherDraft, cancelWeatherDraft, commitWeatherDraft, initWeather, renderWeatherSettings, syncWeather } from "./weather-view.js";
import { PAGE_PX, printPage, pxToMm } from "./print.js";
import { existsOn, harvestEnd, isPlannable, localToday, worksRange } from "./schedule.js";
import { currentBlockId, ganttHasFocus, initSchedule, openInSchedule, openProcessPlan, placeGantt, placePicker, problemTotal, renderPicker, renderSchedule, renderTypes, scheduleHash, selectedRowPreset } from "./schedule-view.js";
import { createLocalStore, createSupabaseStore, currentOperation, duringOperation, fetchWithOperation, forgetImageUrls, inOrder, startOperation, APP_VERSION } from "./store.js";
import { draw } from "./draw.js";

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
  outline: "圃場の角を順にクリック。最初の点をクリックするか「確定」で閉じます。外形がもうあるときは、同じ圃場の離れた部分として描き足します。",
  zone: "区域の角を順にクリック。最初の点をクリックするか「確定」で閉じます。",
  rect: "対角の 2 点をドラッグ。四角形は、いちばん近い外形の辺に平行になります。",
  size: "寸法を入れて、置く場所をクリック。置いたあとはドラッグで動かせます。",
  scale: "距離を測る 2 点を順にクリック。2 点目で、実際の距離を尋ねます（入れると、縮尺をそれに合わせます）。",
  scaleFitted: "下絵の尺度の線の両端など、距離を測る 2 点を順にクリック。2 点目で、実際の距離を尋ねます（入れると、下絵の縮尺だけが変わり、図形は変わりません）。",
  areaMeasure: "面積を測る範囲の角を順にクリックし、最初の点をクリックして閉じます。閉じたところで、実際の面積を尋ねます（入れると、縮尺をそれに合わせます）。",
  align: "下絵の上の目印（角や杭など）を 1 つクリック。",
  block: "有効圃場をクリックすると、その全体が 1 つの耕起対象区画になります。",
  split: "区画（または有効圃場）の中をクリックすると、その位置で 2 つに分けます。端からの距離は、クリックのあとで数値で直せます。",
  blockrect: "有効圃場の中で、対角の 2 点をドラッグ。表示日に畝がない場所を、新しい区画にします。",
};
const TABLES = { zone: "zones", block: "blocks", bed: "beds" };
const PLAN_TABLES = ["zones", "blocks", "beds", "plantings", "works"]; // プランの中身の表
const CURRENT_PLAN_KEY = "field_plan_current_plan";
const CURRENT_FIELD_KEY = "field_plan_current_field";
const VIEW_DATE_KEY = "field_plan_view_date";

// 前にその圃場を開いたときの表示日。覚えていなければ今日
function savedViewDate(fieldId) {
  const saved = loadPref(fieldId, "viewDate", VIEW_DATE_KEY);
  return /^\d{4}-\d{2}-\d{2}$/.test(saved || "") ? saved : localToday();
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
  mapEditing: false, // 図の編集中（「図を編集」を押してから「完了」まで）。ふだんの図は、選ぶ・見るだけ
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
  viewDate: localToday(), // 圃場図に出す日。区画と畝は、この日にあるものだけを描く（圃場を開くときに、その圃場で覚えた日にする）
  mode: "select",
  selected: null, // 圃場の外形の部分（"outline:0" など）か、区域・区画・畝の ID
  selectedVertex: null,
  draft: [],
  gaps: [], // 選択中の図形から、囲んでいる図形の辺と、隣の図形までのすき間
  view: { x: -40, y: -40, w: 80, h: 80 },
};

// 圃場の設定の窓の状態（窓の処理は「---- 圃場の設定の窓 ----」）
const settings = {
  open: false,
  start: null, // 開いたとき（保存したとき）の写し
  undo: [],
  redo: [],
  transforms: [], // 書きかけの図形の変換（保存するときに、ほかのプランにも当てる）
  records: [], // 書きかけの変更の記録（保存するときに記録する）
  home: null, // 図を戻す場所
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
  let points = outlinePoints();
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

// 点の並びがちょうど入る四角形に、3% の余白を足した範囲（SVG の向き。y は下向き）
function printView(points) {
  const box = boundingBox(points);
  const margin = Math.max(box.maxX - box.minX, box.maxY - box.minY) * 0.03;
  return { x: box.minX - margin, y: -box.maxY - margin, w: box.maxX - box.minX + margin * 2, h: box.maxY - box.minY + margin * 2 };
}

// 圃場図を、下絵なし、選択の印なしで描いて、印刷に回す。向きは画面と同じ（上が北）。
// 1 枚目は全体（外形のすべての部分。外形がなければ区域）を 1 枚に収める。
// 外形が離れた部分に分かれているときは、続けて、部分ごとに 1 枚ずつ、その部分を紙いっぱいに描く
function printMap() {
  const points = state.field.outline.length ? state.field.outline.flat() : state.zones.flatMap((zone) => zone.shape);
  if (points.length < 3) {
    notify("圃場の外形か区域を描くと、PDF にできます。");
    return;
  }
  const whole = printView(points);
  const landscape = whole.w >= whole.h;
  const [pageWidth, pageHeight] = PAGE_PX[landscape ? "landscape" : "portrait"];
  const fit = (view) => Math.min(pageWidth / view.w, pageHeight / view.h);
  // 部分ごとの紙。{ view, z, name（見出し） }
  const sheets =
    state.field.outline.length > 1
      ? state.field.outline.map((area, index) => {
          const view = printView(area);
          return { view, z: fit(view), name: `外形 ${index + 1}` };
        })
      : [];

  const kept = { selected: state.selected, vertex: state.selectedVertex, backdrop: state.backdropVisible, draft: state.draft };
  Object.assign(state, { selected: null, selectedVertex: null, backdropVisible: false, draft: [] });
  const drawn = new Map(); // 倍率ごとに描いた図形（同じ倍率の紙は、描いたものを使い回す）
  const shapesAt = (z) => {
    if (!drawn.has(z)) {
      renderMap(z);
      drawn.set(z, map.innerHTML);
    }
    return drawn.get(z);
  };
  const title = `圃場図　${state.field.name}　プラン: ${state.plan.name}　表示日: ${formatDate(state.viewDate)}`;
  const page = ({ view, z, name }) => {
    // 縮尺の線と、北の印を、紙の隅に書く
    const meters = [100, 50, 20, 10, 5, 2, 1].find((value) => value <= view.w * 0.2) || 1;
    const pad = 10 / z;
    const bottom = view.y + view.h - pad;
    const left = view.x + pad;
    const text = (x, y, value, anchor) =>
      `<text class="map-label" x="${x}" y="${y}" font-size="${11 / z}" stroke-width="${3 / z}" style="text-anchor:${anchor}">${escapeHtml(value)}</text>`;
    const extras =
      `<line class="print-scale" x1="${left}" y1="${bottom}" x2="${left + meters}" y2="${bottom}" />` +
      text(left + meters + 6 / z, bottom, `${meters} m`, "start") +
      text(view.x + view.w - pad, view.y + pad * 1.4, "↑ 北", "end");
    return {
      title: name ? `${title}　${name}` : title,
      body:
        `<svg class="print-map" xmlns="http://www.w3.org/2000/svg" viewBox="${view.x} ${view.y} ${view.w} ${view.h}" ` +
        `style="height:${pxToMm(Math.min(pageHeight, (pageWidth / view.w) * view.h)).toFixed(1)}mm">${shapesAt(z)}${extras}</svg>`,
    };
  };
  const wholeZ = fit(whole);
  const pages = [page({ view: whole, z: wholeZ, name: sheets.length ? "全体" : "" }), ...sheets.map((sheet) => page(sheet))];
  Object.assign(state, { selected: kept.selected, selectedVertex: kept.vertex, backdropVisible: kept.backdrop, draft: kept.draft });
  renderMap();
  printPage({ name: "圃場図", pages, landscape });
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

// 圃場の外形は、離れた部分をいくつも持てる（state.field.outline は多角形の並び）。
// 部分は「outline:0」「outline:1」… の名前で選ぶ。番号は描いた順
const OUTLINE_KEY = "outline:";
const outlineKey = (index) => `${OUTLINE_KEY}${index}`;
const isOutline = (key) => typeof key === "string" && key.startsWith(OUTLINE_KEY);
const outlineIndex = (key) => Number(key.slice(OUTLINE_KEY.length));
const outlinePoints = () => state.field.outline.flat(); // すべての部分の頂点
// 部分の呼び名。1 つだけなら番号を付けない
const outlineLabel = (index) => (state.field.outline.length > 1 ? `圃場の外形 ${index + 1}` : "圃場の外形");

function shapePoints(key) {
  if (isOutline(key)) {
    return state.field.outline[outlineIndex(key)] || null;
  }
  return findShape(key)?.item.shape || null;
}

function setShapePoints(key, points) {
  if (isOutline(key)) {
    state.field.outline[outlineIndex(key)] = points;
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
// 視点は向きだけを持つ。圃場の外形のどの部分の辺でも選べ、その向きで、すべての区画の畝を並べる。
// 視点 k（0 か 1）が立っている、外形の辺 { part, edge }。どの辺にも合っていなければ null。
// prefer の部分（選んでいる部分）の辺を先に探す
function viewEdge(k, prefer = -1) {
  const parts = state.field.outline;
  const order = [...parts.keys()].sort((a, b) => (b === prefer) - (a === prefer));
  for (const part of order) {
    const edge = parts[part].findIndex((_, i) => turnGap(edgeOutward(parts[part], i) + 180, viewDirs()[k]) < 1);
    if (edge >= 0) {
      return { part, edge };
    }
  }
  return null;
}

// 外形の辺の呼び名。部分が 1 つなら「辺 1 → 2」、いくつもあれば「外形 2 の辺 1 → 2」
function edgeName(part, index) {
  const points = state.field.outline[part];
  const edge = `辺 ${index + 1} → ${((index + 1) % points.length) + 1}`;
  return state.field.outline.length > 1 ? `外形 ${part + 1} の${edge}` : edge;
}

function setViewEdge(k, part, index) {
  const points = state.field.outline[part];
  const dirs = [...viewDirs()];
  dirs[k] = Math.round((((edgeOutward(points, index) + 180) % 360) + 360) % 360 * 100) / 100;
  state.field.view_dirs = dirs;
  queueSave("field");
  state.blocks.forEach((block) => renumberBlock(block.id));
  record({
    kind: "field.view",
    plan: false,
    text: `視点 ${k + 1} を、圃場の${edgeName(part, index)}（${edgeSide(points, index)}）に変更。畝の番号は、視点から見て左から順`,
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

// 選んだ図形が属する区域。圃場の外形を選んでいるときや、選んでいないときは null
function frontZoneId() {
  const found = state.selected && !isOutline(state.selected) ? findShape(state.selected) : null;
  if (!found) {
    return null;
  }
  const block = found.kind === "bed" ? blockOf(found.item) : found.item;
  return found.kind === "zone" ? found.item.id : block.zone_id;
}

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
// 外形が離れた部分をいくつも持つときは、区域はどれか 1 つの部分に入っているはず
function findOutside() {
  const parts = state.field.outline;
  const zoneOf = (block) => state.zones.find((zone) => zone.id === block.zone_id);
  return {
    zones: parts.length ? state.zones.filter((zone) => !parts.some((part) => polygonInside(zone.shape, part))) : [],
    blocks: visibleBlocks().filter((block) => !polygonInside(block.shape, zoneOf(block).shape)),
    beds: visibleBeds().filter((bed) => !polygonInside(bed.shape, blockOf(bed).shape)),
  };
}

// 区域が入っている、外形の部分の番号。収まっている部分がなければ、重心のある部分。どちらもなければ -1
function zonePart(zone) {
  const parts = state.field.outline;
  const inside = parts.findIndex((part) => polygonInside(zone.shape, part));
  return inside >= 0 ? inside : parts.findIndex((part) => pointInPolygon(centroid(zone.shape), part));
}

// 変更の記録に書く、図形の呼び名と大きさ
function shapeName(key) {
  if (isOutline(key)) {
    return outlineLabel(outlineIndex(key));
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
  const kind = isOutline(key) ? "outline" : findShape(key).kind;
  adjustRecord({
    kind: `${kind}.shape`,
    target: isOutline(key) ? [] : [kind, key],
    plan: isOutline(key) ? false : undefined,
    text: `${shapeName(key)}の大きさを変更`,
    before: was,
    after: sizeText(key),
  });
}

// 選択中の図形から、それを囲んでいる図形の各辺と、隣の図形までのすき間を求める。
// 区域は圃場の外形とほかの区域、区画は有効圃場とほかの区画、畝は区画とほかの畝が相手
function selectedGaps() {
  const found = state.selected && !isOutline(state.selected) ? findShape(state.selected) : null;
  if (!found) {
    return [];
  }
  const { kind, item } = found;
  let frames = state.field.outline; // 区域は、外形のどの部分の辺までも測る
  let neighbours = state.zones;
  if (kind === "block") {
    frames = [state.zones.find((zone) => zone.id === item.zone_id)?.shape || []];
    neighbours = visibleBlocks().filter((block) => block.zone_id === item.zone_id);
  } else if (kind === "bed") {
    frames = [blockOf(item).shape];
    neighbours = visibleBeds().filter((bed) => bed.block_id === item.block_id);
  }
  const toFrame = frames
    .filter((frame) => frame.length >= 3)
    .flatMap((frame) => frame.map((point, i) => gapToSegment(item.shape, point, frame[(i + 1) % frame.length])));
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

  state.field.outline.forEach((points, index) => {
    parts.push(
      `<polygon class="shape${selectedClass(outlineKey(index))}" data-shape="${outlineKey(index)}" ` +
        `points="${svgPoints(points)}" fill="${OUTLINE_COLOR}" fill-opacity="0.08" stroke="${OUTLINE_COLOR}" />`
    );
  });
  // PDF では、圃場の外形と有効圃場の各辺の長さを、辺の外側に、辺に沿って書く
  if (printing) {
    for (const points of [...state.field.outline, ...state.zones.filter((zone) => zone.kind === "tillable").map((zone) => zone.shape)]) {
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
  // 区域ごとに、区域、区画、畝の順で描く。選んだ図形の区域は、最後に描いていちばん上に見せる
  const drawGroup = (zones, groupBlocks, groupBeds) => {
    for (const zone of zones) {
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
    for (const block of groupBlocks) {
      parts.push(
        `<polygon class="shape block${selectedClass(block.id)}" data-shape="${block.id}" ` +
          `points="${svgPoints(block.shape)}" fill="${BLOCK_COLOR}" fill-opacity="${block === ghost ? 0.04 : 0.14}" stroke="${BLOCK_COLOR}" />`
      );
      if (!beds.some((bed) => bed.block_id === block.id)) {
        parts.push(label(centroid(block.shape), block.name));
      }
    }
    // 畝の文字は、畝の図形をすべて描いたあとに描く。文字は畝からはみ出すことがあり、
    // 先に描くと、隣の畝の図形に隠れる（見えにくく、押すと隣の畝が選ばれる）
    const bedLabels = [];
    for (const bed of groupBeds) {
      const planting = plantingOn(bed);
      const name = planting?.crop_name || "";
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
        // 品目名を押すと、作付の詳細を開く（印刷では開かない）。品目名だけを tspan に分けると、WebKit（iPad、iPhone）では
        // 品目名の高さが番号とずれ、押しても効かないので、文字は 1 つのまま、押した位置から品目名かを求める（mapLabelAt）。
        // data-name は、品目名が何文字目から始まるか
        const link = name && !printing ? ` data-detail="${planting.id}" data-name="${String(bed.seq).length + 1}"` : "";
        bedLabels.push(
          label(center, text, Math.min(fontSize, Math.max(size.width * 0.85, 9 / z)), `transform="rotate(${degrees} ${center[0]} ${-center[1]})" data-bed="${bed.id}"${link}`)
        );
      }
    }
    parts.push(...bedLabels);
  };
  const front = printing ? null : frontZoneId();
  const allBlocks = ghost ? [...blocks, ghost] : blocks;
  const inFront = (block) => block.zone_id === front;
  const bedInFront = (bed) => inFront(blockOf(bed));
  drawGroup(state.zones.filter((zone) => zone.id !== front), allBlocks.filter((block) => !inFront(block)), beds.filter((bed) => !bedInFront(bed)));
  drawGroup(state.zones.filter((zone) => zone.id === front), allBlocks.filter(inFront), beds.filter(bedInFront));

  const selectedPoints = state.selected ? shapePoints(state.selected) : null;
  const selectedKind = isOutline(state.selected) ? "outline" : state.selected ? findShape(state.selected)?.kind : null;
  // 畝は四角形のまま扱うので、頂点は動かさない。角と辺の丸は、いま動かせる図形にだけ出す
  const editable = !printing && shapeEditable(state.selected);
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
      if (editable) parts.push(`<circle class="handle mid edit-only" data-mid="${i}" cx="${mid[0]}" cy="${-mid[1]}" r="${4.5 / z}" />`);
    });
    selectedPoints.forEach((point, i) => {
      if (!editable) {
        return;
      }
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
  // 視点の矢印。立つ場所から、見る向きへ。辺を選んだ視点は、その辺（ほかの部分の辺でもよい）に立つ
  if (selectedKind === "outline") {
    viewDirs().forEach((degrees, k) => {
      const dir = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
      const found = viewEdge(k, outlineIndex(state.selected));
      const center = centroid(selectedPoints);
      const reach = Math.max(...selectedPoints.map((point) => (center[0] - point[0]) * dir[0] + (center[1] - point[1]) * dir[1]));
      const edgePoints = found ? state.field.outline[found.part] : null;
      const foot = found
        ? [
            (edgePoints[found.edge][0] + edgePoints[(found.edge + 1) % edgePoints.length][0]) / 2,
            (edgePoints[found.edge][1] + edgePoints[(found.edge + 1) % edgePoints.length][1]) / 2,
          ]
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
    const open = state.mode === "scale" || state.mode === "split" || state.mode === "align" || state.mode === "areaMeasure";
    const closing = !open && state.draft.length >= 3 ? ` ${svgPoints([state.draft[0]])}` : "";
    parts.push(`<polyline class="draft" points="${svgPoints(state.draft)}${closing}" />`);
    // 2 点の距離と位置合わせ: 最後に押した点から、マウスの位置まで線を伸ばす（2 点の距離では、その長さも出す）
    if ((state.mode === "scale" || state.mode === "align") && state.hover && state.draft.length % 2 === 1) {
      const from = state.draft.at(-1);
      const to = state.hover;
      parts.push(`<line class="draft" x1="${from[0]}" y1="${-from[1]}" x2="${to[0]}" y2="${-to[1]}" />`);
      if (state.mode === "scale") {
        parts.push(
          `<text class="map-label draft-label" x="${(from[0] + to[0]) / 2}" y="${-(from[1] + to[1]) / 2}" font-size="${fontSize * 1.1}" ` +
            `stroke-width="${fontSize / 3}">${distance(from, to).toFixed(2)} m</text>`
        );
      }
    }
    // 面積を測る: 押した点とマウスの位置で閉じた多角形と、今の縮尺での面積（3 点からは面積も出す）
    if (state.mode === "areaMeasure" && state.hover) {
      const polygon = [...state.draft, state.hover];
      parts.push(`<polygon class="draft draft-area" points="${svgPoints(polygon)}" />`);
      if (polygon.length >= 3) {
        const [cx, cy] = centroid(polygon);
        parts.push(
          `<text class="map-label draft-label" x="${cx}" y="${-cy}" font-size="${fontSize * 1.1}" stroke-width="${fontSize / 3}">${polygonArea(polygon).toFixed(2)} ㎡</text>`
        );
      }
    }
    if (state.mode !== "split") {
      // 計測と位置合わせで押した点は、下絵の上でも見えるよう、白い縁を付けて大きめに描く
      const big = state.mode === "scale" || state.mode === "align" || state.mode === "areaMeasure";
      state.draft.forEach((point) => {
        parts.push(`<circle class="draft-point${big ? " is-mark" : ""}" cx="${point[0]}" cy="${-point[1]}" r="${(big ? 6 : 4) / z}" />`);
      });
    }
  }

  draw(map, parts.join("") + lengthLabels.join(""));
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

// 図の上の「警告」の欄と、「圃場図」のタブの件数。図形のはみ出しと、日程の確認が必要な点（schedule-view.js が描く）を合わせる。
// 日程の画面で畝を動かしたときや、日程を描き直したときも呼ばれる
function renderWarnings(outside = findOutside()) {
  const warnings = mapWarnings(outside);
  $("warnings").hidden = warnings.length === 0;
  draw($("warnings"), warnings.map(([id, text]) => `<li data-shape="${id}">${escapeHtml(text)}</li>`).join(""));
  const total = warnings.length + problemTotal();
  $("alertPanel").hidden = total === 0;
  $("alertCount").textContent = `${total} 件`;
  $("mapBadge").hidden = total === 0;
  $("mapBadge").textContent = `⚠${total}`;
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
  // 区域とその中身。base は区域の行の深さ
  const addZone = (zone, base) => {
    add(zone.id, base, ZONE_KINDS[zone.kind].color, zoneLabel(zone), `${polygonArea(zone.shape).toFixed(1)} ㎡`);
    for (const block of state.blocks.filter((item) => item.zone_id === zone.id)) {
      const active = blockActive(block);
      const own = beds.filter((bed) => bed.block_id === block.id).sort((p, q) => p.seq - q.seq);
      const open = own.length > 0 && (openBlocks.has(block.id) || own.some((bed) => bed.id === state.selected));
      add(block.id, base + 1, BLOCK_COLOR, block.name, active ? `${polygonArea(block.shape).toFixed(1)} ㎡${own.length ? ` / 畝 ${own.length} 本` : ""}` : `表示日にはない（${blockPeriod(block)}）`, {
        away: !active,
        toggle: own.length
          ? `<button type="button" class="tree-toggle" data-toggle="${block.id}" aria-expanded="${open}" title="畝を${open ? "たたむ" : "開く"}">${open ? "▾" : "▸"}</button>`
          : undefined,
      });
      for (const bed of open ? own : []) {
        const size = rectSize(bed.shape);
        const crop = plantingOn(bed)?.crop_name;
        add(bed.id, base + 2, BED_COLOR, `畝${bed.seq}`, `${Math.round(size.width * 100)} cm × ${size.length.toFixed(1)} m`, {
          extra: crop ? `<span class="tree-crop">${escapeHtml(crop)}</span>` : "",
        });
      }
    }
  };
  // 外形があれば、外形の部分 ⊃ 区域 ⊃ 区画 ⊃ 畝 の木にする。区域は、入っている部分の下に置く。
  // どの部分にも入っていない区域は、最後に、外形と同じ深さで並べる（はみ出しの印が付く）
  const parts = state.field.outline;
  const partOf = new Map(state.zones.map((zone) => [zone.id, zonePart(zone)]));
  parts.forEach((points, index) => {
    add(outlineKey(index), 0, OUTLINE_COLOR, outlineLabel(index), `${polygonArea(points).toFixed(1)} ㎡`);
    state.zones.filter((zone) => partOf.get(zone.id) === index).forEach((zone) => addZone(zone, 1));
  });
  state.zones.filter((zone) => partOf.get(zone.id) < 0).forEach((zone) => addZone(zone, 0));
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
      draw(li, row.html);
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
  const fieldArea = outlineArea(state.field.outline); // 離れた部分の合計
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
  $("fitShapesBtn").title = state.alignment ? "" : "先に「図形に位置を合わせる」で、2 組の点を合わせてください";
  renderSettingsFoot();
}

function renderSelection() {
  const points = state.selected ? shapePoints(state.selected) : null;
  $("selectionPanel").hidden = !points;
  if (!points) {
    return;
  }
  const found = isOutline(state.selected) ? { kind: "outline" } : findShape(state.selected);
  const { kind, item } = found;
  $("zoneFields").hidden = kind !== "zone";
  $("outlineFields").hidden = kind !== "outline";
  $("blockFields").hidden = kind !== "block";
  $("bedFields").hidden = kind !== "bed";
  $("edgeTable").hidden = kind === "bed";
  $("deleteVertexBtn").hidden = kind === "bed";
  $("deleteShapeBtn").hidden = kind === "bed";
  // 区画は日程の画面で開く。畝は、図に出ている作付（表示日の作付）の詳細を開く。作付のない畝には出さない
  $("openScheduleBtn").hidden = !(kind === "block" || (kind === "bed" && plantingOn(item)));
  $("openScheduleBtn").textContent = kind === "bed" ? "作付の詳細を開く" : "日程で開く";
  $("deleteShapeBtn").textContent = { outline: "外形を削除", zone: "区域を削除", block: "区画を削除", bed: "畝を完全に削除" }[kind];
  $("shapeInfo").textContent = "";

  if (kind === "outline") {
    const selectedPart = outlineIndex(state.selected);
    $("selectionTitle").textContent = `選択中: ${outlineLabel(selectedPart)}`;
    // 視点の辺は、外形のどの部分の辺からでも選べる（2 つの視点が、すべての区画の畝の並びを決める）
    [0, 1].forEach((k) => {
      const found = viewEdge(k, selectedPart);
      const options = state.field.outline.flatMap((partPoints, part) =>
        partPoints.map(
          (_, i) =>
            `<option value="${part}:${i}">${edgeName(part, i)}（${edgeSide(partPoints, i)}、${formatLength(edgeLengths(partPoints)[i])}）</option>`
        )
      );
      if (!found) {
        options.unshift(`<option value="">${compassOf(viewDirs()[k] + 180)}側から（辺を選んでいません）</option>`);
      }
      draw($(`viewEdge${k + 1}`), options.join(""));
      $(`viewEdge${k + 1}`).value = found ? `${found.part}:${found.edge}` : "";
    });
    const square = turnGap(viewDirs()[0], viewDirs()[1]);
    $("viewNote").textContent =
      "その辺の外に立って、圃場を見ます。図に矢印が出ます。畝の長い辺が視点 1 の見る向きに近ければ視点 1 から、直角に近ければ視点 2 から見ます。日程の「区画と畝」の図の左右、畝の手前と奥、畝の番号（左から順）が、この視点で決まります。" +
      (state.field.outline.length > 1 ? " 外形が離れた部分に分かれているときは、どの部分の辺でも選べ、2 つの視点がすべての部分の畝の並びを決めます。" : "") +
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
    draw(
      $("bedPlantings"),
      plantings.length
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
        : '<li class="empty">作付はまだありません（日程で入れます）</li>'
    );
  }
  if (kind !== "bed") {
    draw(
      $("edgeRows"),
      edgeLengths(points)
        .map((length, i) => `<tr><td>${i + 1} → ${((i + 1) % points.length) + 1}（${edgeSide(points, i)}）</td><td>${formatLength(length)}</td></tr>`)
        .join("")
    );
    $("deleteVertexBtn").disabled = state.selectedVertex === null || points.length <= 3;
  }
}

function render() {
  renderMap();
  renderPanel();
  renderEditFoot();
}

// ---- 保存 ----

const pendingSaves = new Map(); // 保存の予約と、それを予約した操作の ID
let saveTimer = null;

function scheduleSaves() {
  $("saveStatus").textContent = "保存中…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, SAVE_DELAY_MS);
}

function queueSave(key) {
  if (settings.open && (key === "field" || key === "backdrop" || /^(zone|block|bed):/.test(key))) {
    return; // 圃場の設定の窓の書きかけ。窓の「保存する」でまとめて保存する
  }
  pendingSaves.set(key, currentOperation());
  scheduleSaves();
  renderEditFoot();
}

// 保存の状態の文字を出す。送り残しがあるあいだは「保存しました」と出さず、送り残しをもう一度送る。
// 続きの書き込みがあるあいだも出さない（その書き込みが終わったときに出る）
function setStatus(text) {
  if (text === "保存しました" && state.mapEditing) {
    text = EDIT_UNSAVED; // 図の編集の書きかけは、まだ DB に送っていない
  }
  if (text === "保存しました" && pendingSaves.size) {
    scheduleSaves();
  } else if (text !== "保存しました" || !state.store.writing()) {
    $("saveStatus").textContent = text;
  }
}

// まだ送っていない保存を、すぐに送る。親の行を先に保存したいときに使う
async function sendPendingSaves() {
  if (pendingSaves.size) {
    clearTimeout(saveTimer);
    await flushSaves();
  }
}

// 押す、キーを打つ、の始まりが、1 回の操作の区切り
for (const type of ["pointerdown", "keydown"]) {
  document.addEventListener(type, startOperation, true);
}

// 新しい版へ読み込み直す前に、送り残しの保存と、送っている書き込みと、変更の記録を送り終える。
// 区画を動かすと、区画の行を送ってから畝の行を送るので、途中で読み込み直すと、区画だけが動いて畝が残る。
// 送れずに残ったものがあれば false（読み込み直すと消えるので、読み込み直さない。失敗は flushSaves などが窓で知らせる）
async function finishSaves() {
  await sendPendingSaves();
  while (state.store?.writing()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await saveJournalNow();
  return !pendingSaves.size && !state.store?.writing();
}

// 「読み込み直す」のボタン（index.html）が、読み込み直す前に知らせてくる。待つものを detail.waits に入れる
document.addEventListener("app-before-reload", (event) => {
  event.detail.waits.push(finishSaves());
});

// 保存が終わらないうちに閉じると、変更が消える。閉じる前に送り、確かめる
window.addEventListener("beforeunload", (event) => {
  if (mapDraft.ops.length) {
    event.preventDefault(); // 図の編集を保存していない
  } else if (pendingSaves.size || state.store?.writing()) {
    sendPendingSaves();
    event.preventDefault();
  }
});

async function flushSaves() {
  const saves = [...pendingSaves];
  pendingSaves.clear();
  try {
    const rows = { zones: [], blocks: [], beds: [] };
    for (const [key, id] of saves) {
      if (key === "field") {
        await duringOperation(id, () => state.store.saveField(state.field));
      } else if (key === "backdrop") {
        const { size, ...row } = state.backdrop;
        await duringOperation(id, () => state.store.saveBackdrop(row));
      } else {
        // 消したあとに残っていた保存の予約は、相手が見つからないので捨てる
        const found = findShape(key.slice(key.indexOf(":") + 1));
        if (found) {
          rows[TABLES[found.kind]].push({ id, item: found.item });
        }
      }
    }
    // 予約した操作ごとに分けて送る
    for (const table of ["zones", "blocks", "beds"]) {
      for (const id of new Set(rows[table].map((row) => row.id))) {
        const items = rows[table].filter((row) => row.id === id).map((row) => row.item);
        await duringOperation(id, () => state.store.upsert(table, items));
      }
    }
    if (!pendingSaves.size) {
      $("saveStatus").textContent = state.mapEditing ? EDIT_UNSAVED : "保存しました";
    }
  } catch (error) {
    saves.filter(([key]) => !pendingSaves.has(key)).forEach(([key, id]) => pendingSaves.set(key, id));
    $("saveStatus").textContent = `保存に失敗しました: ${error.message}`;
    notify(`変更を保存できませんでした。次に保存するときに、もう一度送ります。\n${error.message}`);
  }
}

// ---- DB から読み直す ----
// ほかの端末（PC とスマホ）で変えた内容を拾うときと、「元に戻す」が途中で失敗して画面と DB がずれたときに使う。
// 範囲は、起動のときに読むもののうち、いまの圃場とプランのぶん。「元に戻す」が書き換えるもの（history.js）をすべて含む

const RELOAD_AFTER_HIDDEN_MS = 60 * 1000; // 画面が隠れてからこの時間がたって戻ってきたら、読み直す
const RELOAD_RETRY_MS = [2000, 5000, 10000, 30000]; // 読み直せなかったときに、次に試すまでの間

// いま画面が持っている内容を、読み直した内容（fetchCurrent）と同じ形にする
const currentData = () => ({
  fields: state.fields,
  plans: state.plans,
  allWorkTypes: state.allWorkTypes,
  crops: state.crops,
  fertilizers: state.fertilizers,
  logs: state.logs,
  tables: Object.fromEntries(PLAN_TABLES.map((table) => [table, state[table]])),
});

// DB から読む。state はまだ変えない
async function fetchCurrent() {
  const [fields, allWorkTypes, crops, fertilizers, plans, tables, logs] = await Promise.all([
    state.store.loadFields(),
    state.store.loadWorkTypes(),
    state.store.listAll("crops"),
    state.store.listAll("fertilizers"),
    state.store.loadPlans(state.field.id),
    loadTables(PLAN_TABLES, state.plan.id),
    state.store.loadLogs(state.field.id),
  ]);
  const field = fields.find((item) => item.id === state.field.id);
  if (field) {
    field.outline = outlineParts(field.outline);
  }
  return { fields, plans, allWorkTypes, crops, fertilizers, logs, tables };
}

// 読み直した内容を入れる。開いていた圃場かプランが DB にないとき（ほかの端末で消した）は、起動からやり直す
function applyCurrent(data) {
  const field = data.fields.find((item) => item.id === state.field.id);
  const plan = data.plans.find((item) => item.id === state.plan.id);
  if (!field || !plan) {
    location.reload();
    return false;
  }
  const { tables, ...rest } = data;
  Object.assign(state, rest, { field, workTypes: data.allWorkTypes.filter(isPlannable) });
  setPlanData(plan, tables);
  return true;
}

// 比べるために、行を ID の順に、列を名前の順にそろえる（画面で足した行は、DB から読んだ行と並びが違う）
function canonical(value) {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    const key = (item) => (item && typeof item === "object" && !Array.isArray(item) ? item.id ?? item.code : undefined);
    return items.every((item) => key(item) !== undefined) ? items.sort((a, b) => (String(key(a)) < String(key(b)) ? -1 : 1)) : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name])]));
  }
  return value;
}

// 比べる形にする。外形は、開いたことのある圃場だけが多角形の並びに直っているので、どの圃場もそろえる
const comparable = (data) => canonical({ ...data, fields: data.fields.map((field) => ({ ...field, outline: outlineParts(field.outline) })) });

// 画面の内容（local）が、DB から読んだ内容（remote）と同じか。
// 画面で作った行には、DB が入れる列（作った日時など）がまだないことがあるので、画面にある列だけを比べる
function sameContent(local, remote) {
  if (Array.isArray(local)) {
    return Array.isArray(remote) && local.length === remote.length && local.every((item, index) => sameContent(item, remote[index]));
  }
  if (local && typeof local === "object") {
    return Boolean(remote) && typeof remote === "object" && Object.keys(local).every((name) => sameContent(local[name], remote[name]));
  }
  return local === remote || (local == null && remote == null);
}

// データを入れ替えたあと、どの画面も描き直す。なくなった図形を選んだままにしない
function refreshViews() {
  if (state.selected && !shapePoints(state.selected)) {
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
}

// 「元に戻す」が途中で失敗したあとに呼ぶ。画面は戻したあとの内容、DB は途中までなので、DB から読み直して画面を DB にそろえる。
// 失敗するのは、たいてい回線が切れたときで、読み直しもすぐにはできない。読めるまで図と日程の操作を止め、間を空けて繰り返す
async function reloadFromDb() {
  state.planBusy = true;
  renderPlanButtons();
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (!applyCurrent(await fetchCurrent())) {
          return;
        }
        break;
      } catch {
        const wait = RELOAD_RETRY_MS[Math.min(attempt, RELOAD_RETRY_MS.length - 1)];
        // 回線が戻ったら、待たずに試す
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            window.removeEventListener("online", done);
            resolve();
          };
          const timer = setTimeout(done, wait);
          window.addEventListener("online", done);
        });
      }
    }
  } finally {
    state.planBusy = false;
    renderPlans();
  }
  refreshViews();
}

// 書きかけや送り残しがあるか。あるあいだは、読み直さない（入れ替えると、書きかけが消えたり、窓が古い行を指したままになったりする）
function midEdit() {
  const element = document.activeElement;
  const typing = element && (element.tagName === "TEXTAREA" || element.tagName === "INPUT" || element.tagName === "SELECT" || element.isContentEditable);
  return Boolean(
    state.planBusy ||
      settings.open ||
      state.mapEditing ||
      mapDraft.ops.length ||
      pendingSaves.size ||
      state.store.writing() ||
      document.querySelector("dialog[open]") ||
      typing
  );
}

// 「計画は PC、確認と実績はスマホ」と 2 台で使うと、開いたままの画面は古い内容を出し続け、そこで直すと、もう一方の変更を上書きする。
// 画面が隠れてしばらくたってから戻ってきたら、DB から読み直す。DB が画面と同じなら、何もしない（「元に戻す」の履歴も残る）。
// 違っていたら入れ替えて、履歴を空にする（古い写しに戻すと、ほかの端末の変更を消してしまう）
let hiddenAt = null;
let reloadDue = false; // 読み直すことになっているが、書きかけなどがあって、まだ読み直していない
let reloading = false;

async function reloadIfChanged() {
  if (!reloadDue || reloading || !state.field || !state.plan || midEdit()) {
    return;
  }
  reloading = true;
  try {
    const before = JSON.stringify(comparable(currentData()));
    const data = await fetchCurrent();
    // 読んでいるあいだに操作が始まっていたら、読んだものは使わない（次に戻ってきたときに読み直す）
    if (midEdit() || JSON.stringify(comparable(currentData())) !== before) {
      return;
    }
    reloadDue = false;
    if (sameContent(JSON.parse(before), comparable(data))) {
      return;
    }
    if (applyCurrent(data)) {
      renderPlans();
      refreshViews();
      resetHistory();
      setStatus("ほかの画面での変更を読み込みました");
    }
  } catch {
    // 圏外など。次に戻ってきたときに読み直す
  } finally {
    reloading = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  if (hiddenAt !== null && Date.now() - hiddenAt >= RELOAD_AFTER_HIDDEN_MS) {
    reloadDue = true;
  }
  hiddenAt = null;
  reloadIfChanged();
});

// すぐに保存する操作（追加、削除、分割など）を包む
async function persist(action) {
  $("saveStatus").textContent = "保存中…";
  try {
    await action();
    setStatus("保存しました");
  } catch (error) {
    setStatus(`保存に失敗しました: ${error.message}`);
    notifySaveFailed(error);
  }
}

// ---- 操作 ----

// 「外形を描く」は、外形に部分を描き足す。いまの外形は置き換えない（描き直すときは、部分を選んで削除してから描く）
function setMode(mode) {
  enterMode(mode);
}

function enterMode(mode) {
  state.mode = mode;
  state.draft = [];
  state.hover = null;
  if (mode !== "select") {
    state.selected = null;
    state.selectedVertex = null;
  }
  document.querySelectorAll(".mode-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  });
  // 区域・耕起対象区画のメニューのボタンは、その中の道具を選んでいるあいだ、選んだ色にする
  const group = { zone: "zone", rect: "zone", size: "zone", block: "block", split: "block", blockrect: "block" }[mode];
  document.querySelectorAll("[data-map-menu]").forEach((button) => button.classList.toggle("is-active", button.dataset.mapMenu === group));
  closeMapMenus();
  map.classList.toggle("is-drawing", mode !== "select");
  // 圃場の設定の窓の中では、図形を描くときの案内（選択）は出さない
  $("hint").textContent = settings.open && mode === "select" ? "" : HINTS[mode === "scale" && state.backdrop?.fitted ? "scaleFitted" : mode];
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
    markStep();
    state.field.outline = [...state.field.outline, points];
    queueSave("field");
    setMode("select");
    const key = outlineKey(state.field.outline.length - 1);
    adjustRecord({
      kind: "outline.draw",
      plan: false,
      text: state.field.outline.length > 1 ? `${shapeName(key)}を描き足した（離れた部分）` : "圃場の外形を描いた",
      after: sizeText(key),
    });
    select(key);
  } else {
    addZone(points);
  }
}

function addZone(points) {
  const zone = {
    id: crypto.randomUUID(),
    plan_id: state.plan.id,
    kind: document.querySelector('input[name="zoneKind"]:checked')?.value || "tillable",
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
  return size ? rectCentered(center, size.along, size.depth, nearestEdgeAngleOf(center, state.field.outline)) : null;
}

// 外形と、すべてのプランの区域・区画・畝に、同じ変換をかける（縮尺と向きの合わせ直しで使う）
async function transformShapes(change) {
  state.field.outline = state.field.outline.map(change);
  queueSave("field");
  for (const [kind, list] of [["zone", state.zones], ["block", state.blocks], ["bed", state.beds]]) {
    for (const item of list) {
      item.shape = change(item.shape);
      queueSave(`${kind}:${item.id}`);
    }
  }
  if (settings.open) {
    // 圃場の設定の窓の書きかけ: ほかのプランには、保存するときに当てる
    settings.transforms.push(change);
    return;
  }
  for (const plan of state.plans.filter((other) => other.id !== state.plan.id)) {
    for (const table of ["zones", "blocks", "beds"]) {
      const rows = await state.store.list(table, plan.id);
      await state.store.upsert(table, rows.map((row) => ({ ...row, shape: change(row.shape) })));
    }
  }
}

// 図形を伸び縮み・回転させる。ふだんはすぐ保存して、元に戻すの履歴を空にする（すべてのプランにまたがるので）。
// 圃場の設定の窓では書きかけにする（保存は窓の「保存する」）
function applyTransform(change) {
  if (settings.open) {
    transformShapes(change);
    return;
  }
  persist(() => transformShapes(change)).then(resetHistory);
}

// 図形と下絵を同じ倍率で伸縮する。原点（基準点）は動かさない
function applyScale(factor) {
  if (state.backdrop) {
    state.backdrop.m_per_px *= factor;
    queueSave("backdrop");
  }
  const { x, y, w, h } = state.view;
  setView({ x: x * factor, y: y * factor, w: w * factor, h: h * factor });
  applyTransform((points) => scalePoints(points, factor));
  adjustRecord({ kind: "field.scale", plan: false, text: "縮尺を合わせ直した（すべての図形の大きさが変わる）" });
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
  const actual = measured > 0 ? askNumber(`今の縮尺では ${measured.toFixed(2)} m です。実際の距離（m）は？`) : null;
  if (actual) {
    markStep();
  }
  if (actual && state.backdrop?.fitted) {
    // 図形に合わせて置いた下絵: 下絵の縮尺だけを変える。クリックした 2 点の中ほどは動かさない
    const middle = [(state.draft[0][0] + state.draft[1][0]) / 2, (state.draft[0][1] + state.draft[1][1]) / 2];
    setBackdrop(scaleBackdropAt(state.backdrop, actual / measured, middle));
    adjustRecord({ kind: "backdrop.scale", plan: false, text: "下絵の縮尺を、下絵の尺度で合わせた（図形は変わらない）", after: `1 画素 = ${(state.backdrop.m_per_px * 100).toFixed(3)} cm` });
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
  if (state.field.outline.length || state.zones.length || state.blocks.length || state.beds.length) {
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
    markStep();
    setBackdrop(alignBackdrop(state.backdrop, [[clicks[0], clicks[1]]]).backdrop);
    adjustRecord({ kind: "backdrop.move", plan: false, text: "下絵の位置を、図形に合わせた（図形は変わらない）" });
    // 1 つ目の目印は、いまは図形の上の点にある。次のクリックは、2 組目の下絵の上の目印
    state.draft = [clicks[1], clicks[1]];
    state.alignAt = clicks[1];
    $("hint").textContent =
      "位置を合わせました。向きも合わせるときは、下絵の上の 2 つ目の目印をクリック（1 つ目から離れた点ほど正確です）。" +
      "2 組目まで合わせると、図形と下絵の大きさの差も測れ、「図形を下絵の縮尺に合わせる」が使えるようになります。位置だけでよければ Esc。";
    renderMap();
  } else if (clicks.length === 3) {
    $("hint").textContent = "その 2 つ目の目印が来るべき、図形の上の点をクリック。";
  } else if (clicks.length === 4) {
    const [, , from, to] = clicks;
    const at = state.alignAt;
    const { backdrop, ratio } = alignBackdrop(state.backdrop, [[at, at], [from, to]]);
    markStep();
    setBackdrop(backdrop);
    state.alignment = { pixel: worldToImage(backdrop, at), at, ratio };
    adjustRecord({ kind: "backdrop.turn", plan: false, text: "下絵の向きを、図形に合わせた（図形は変わらない）", after: `${round2(backdrop.rotation_deg)} 度` });
    setMode("select");
    const percent = (ratio - 1) * 100;
    // 窓の中では、測った差と、次にできることを案内に残す
    if (settings.open) {
      $("hint").textContent =
        Math.abs(percent) < 0.5
          ? `位置と向きを合わせました。図形と下絵の大きさは、ほぼ合っています（差 ${Math.abs(percent).toFixed(1)}%）。`
          : `位置と向きを合わせました。図形は、下絵の尺度より ${Math.abs(percent).toFixed(1)}% ${percent > 0 ? "大きく" : "小さく"}なっています。` +
            "図形のほうを直すときは「図形を下絵の縮尺に合わせる」を押します。";
    }
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
  const ok = settings.open || await confirmAction({
    message: "この圃場のすべてのプランの外形・区域・区画・畝の大きさを、下絵の縮尺に合わせて変えます。「元に戻す」では戻せません。",
    name: `図形を ${factor.toFixed(4)} 倍`,
    action: "図形の大きさを変える",
  });
  if (!ok || state.alignment !== alignment) {
    return;
  }
  markStep();
  const at = [alignment.at[0] * factor, alignment.at[1] * factor];
  state.backdrop = anchorBackdrop(state.backdrop, alignment.pixel, at);
  state.alignment = null;
  queueSave("backdrop");
  const { x, y, w, h } = state.view;
  setView({ x: x * factor, y: y * factor, w: w * factor, h: h * factor });
  applyTransform((points) => scalePoints(points, factor));
  adjustRecord({ kind: "field.scale", plan: false, text: "図形を下絵の縮尺に合わせた（すべての図形の大きさが変わる）", after: `${factor.toFixed(4)} 倍` });
  $("hint").textContent = `図形の大きさを ${factor.toFixed(4)} 倍にして、下絵の縮尺に合わせました。`;
  render();
}


// 面積を測る: 囲んだ範囲の、今の縮尺での面積を出し、実際の面積を入れると、その比で縮尺を合わせる。
// 直し方は 2 点の距離と同じ（図形を描く下絵なら図形と下絵を一緒に、図形に合わせて置いた下絵なら下絵だけを伸び縮みさせる）
function finishAreaMeasure() {
  const points = state.draft;
  const measured = polygonArea(points);
  const actual = measured > 0 ? askNumber(`今の縮尺では ${measured.toFixed(2)} ㎡ です。実際の面積（㎡）は？`) : null;
  if (actual) {
    markStep();
    const factor = Math.sqrt(actual / measured);
    if (state.backdrop?.fitted) {
      // 図形に合わせて置いた下絵: 下絵の縮尺だけを変える。囲んだ範囲の真ん中は動かさない
      setBackdrop(scaleBackdropAt(state.backdrop, factor, centroid(points)));
      adjustRecord({ kind: "backdrop.scale", plan: false, text: "下絵の縮尺を、測った面積で合わせた（図形は変わらない）", after: `1 画素 = ${(state.backdrop.m_per_px * 100).toFixed(3)} cm` });
    } else {
      applyScale(factor);
    }
  }
  setMode("select");
}

function setRotation(degrees) {
  const delta = degrees - state.backdrop.rotation_deg;
  if (!delta) {
    return;
  }
  markStep();
  if (state.backdrop.fitted) {
    // 図形に合わせて置いた下絵: 下絵だけを、画面の真ん中のまわりに回す
    const { x, y, w, h } = state.view;
    setBackdrop(rotateBackdropAt(state.backdrop, delta, [x + w / 2, -(y + h / 2)]));
    adjustRecord({ kind: "backdrop.turn", plan: false, text: "下絵の向きを変えた（図形は変わらない）", after: `${degrees} 度` });
    return;
  }
  state.backdrop.rotation_deg = degrees;
  queueSave("backdrop");
  if (state.field.view_dirs) {
    state.field.view_dirs = state.field.view_dirs.map((direction) => direction - delta);
    queueSave("field");
  }
  applyTransform((points) => rotatePoints(points, delta));
  adjustRecord({ kind: "field.rotation", plan: false, text: "下絵の向きを合わせ直した", after: `${degrees} 度` });
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
    kind === "bed" ? [blockOf(item).shape] : kind === "block" ? [state.zones.find((zone) => zone.id === item.zone_id).shape] : state.field.outline;
  const angle = nearestEdgeAngleOf(centroid(item.shape), frame);
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
  markStep(); // 圃場の設定の窓の中（外形）なら、元に戻すの区切り
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
  if (isOutline(id)) {
    // 外形の部分を 1 つ消す。ほかの部分は残る（番号は詰まる）
    const name = shapeName(id);
    const rest = state.field.outline.length - 1;
    const message = rest ? `${name}を削除します。ほかの ${rest} つの部分は残ります。` : "圃場の外形を削除します。";
    if ((await confirmDelete(message, name)) && state.selected === id && shapePoints(id)) {
      markStep();
      state.field.outline = state.field.outline.filter((_, i) => i !== outlineIndex(id));
      queueSave("field");
      adjustRecord({ kind: "outline.delete", plan: false, text: `${name}を削除` });
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
  const logs = logsWithout(blocks.map((block) => block.id), beds.map((bed) => bed.id));
  const logNote = logs.count
    ? `\n作業の記録 ${logs.count} 件から、${kind === "bed" ? "この畝" : "消える区画と畝"}を対象から外します。` +
      (logs.emptied.length ? `そのうち、ほかに対象のない記録 ${logs.emptied.length} 件は、記録ごと消えます。` : "")
    : "";
  // 確かめているあいだに、選んだ図形が変わったり消えたりしていたら、何も消さない
  if (!(await confirmDelete(message + logNote, shapeName(id))) || state.selected !== id || !findShape(id)) {
    return;
  }
  record({
    kind: `${kind}.delete`,
    text: `${shapeName(id)}を削除${kind !== "bed" && beds.length ? `（中の畝 ${beds.length} 本と日程も）` : ""}` +
      (logs.count ? `（作業の記録 ${logs.count} 件から対象を外した）` : ""),
  });
  // 確かめているあいだに記録が変わっていることがあるので、数え直してから外す
  const dropped = logsWithout(blocks.map((block) => block.id), beds.map((bed) => bed.id));
  const emptied = new Set(dropped.emptied.map((log) => log.id));
  const changed = new Map(dropped.changed.map((log) => [log.id, log]));
  state.logs = (state.logs || []).filter((log) => !emptied.has(log.id)).map((log) => changed.get(log.id) || log);
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
  // 記録を先に直してから、図形を消す。同じ操作の書き込みとして、続けて送る（元に戻すと、図形を戻してから記録を戻す）
  const { store } = state;
  persist(() =>
    Promise.all([
      ...dropped.emptied.map((log) => store.deleteLog(log.id)),
      ...dropped.changed.map((log) => store.saveLog(log)),
      store.remove(TABLES[kind], [id]),
    ])
  );
}

// 区画・畝を消すときに、それを対象にした作業の記録から、その対象を外した記録。
// DB の外部キーに任せると、畝と作付の ID だけが空になった対象が残り、区画の記録に見えてしまう。
// changed は対象を外した記録、emptied はほかに対象がなくなる記録（記録ごと消す）、count はその合計
function logsWithout(blockIds, bedIds) {
  const blocks = new Set(blockIds);
  const beds = new Set(bedIds);
  const plantings = new Set(state.plantings.filter((planting) => beds.has(planting.bed_id)).map((planting) => planting.id));
  const gone = (target) => blocks.has(target.block_id) || beds.has(target.bed_id) || plantings.has(target.planting_id);
  const changed = [];
  const emptied = [];
  for (const log of state.logs || []) {
    if (!log.targets?.some(gone)) {
      continue;
    }
    const targets = log.targets.filter((target) => !gone(target));
    if (targets.length) {
      changed.push({ ...log, targets });
    } else {
      emptied.push(log);
    }
  }
  return { changed, emptied, count: changed.length + emptied.length };
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
    await sendPendingSaves(); // 親の区域が、まだ送られていないことがある
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
    await sendPendingSaves(); // 親の区域が、まだ送られていないことがある
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
  const end = Math.max(...last.shape.map(along));
  // 前と後ろの隙間は、最後の畝のとおりに別々に取る（畝が区画の片側に寄っていても入るように）
  return addBedsToBlock(block, {
    ...sizes,
    angle,
    endGap: Math.max(start - Math.min(...block.shape.map(along)), 0),
    tailGap: Math.max(Math.max(...block.shape.map(along)) - end, 0),
    length: end - start,
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

// ヘッダーの左上に、開いている圃場とプランを出す（実際に使うプランでなければ、目立たせる）
function renderPlace() {
  setPlace({
    field: state.field.name || "（名前なし）",
    plan: state.plan.name,
    trial: state.field.active_plan_id !== state.plan.id,
    fieldId: state.field.id,
    planId: state.plan.id,
  });
}

// 圃場の中身（下絵・プラン・作業の記録）と、開くプランの中身を読む。state はまだ変えない。
// 開くのは、前にその圃場で開いていたプラン。覚えていなければ先頭のプラン。
// DB の往復を待つ回数を減らすため、すべて並べて読む。開くプランを覚えていれば、プランの一覧を待たずに、その中身も読み始める
async function fetchFieldData(fieldId) {
  const loadBackdrop = async () => {
    const backdrop = await state.store.loadBackdrop(fieldId);
    return { backdrop, backdropUrl: backdrop ? await state.store.imageUrl(backdrop.storage_path) : "" };
  };
  const others = Promise.all([loadBackdrop(), state.store.loadLogs(fieldId)]);
  const savedId = loadPref(fieldId, "plan", CURRENT_PLAN_KEY);
  const early = savedId ? loadTables(PLAN_TABLES, savedId) : null;
  // 覚えていたプランが消えていて使わなかったときの失敗で、止めないようにする。使うときは、下で待つので失敗が伝わる
  early?.catch(() => {});
  const plans = await state.store.loadPlans(fieldId);
  const plan = plans.find((item) => item.id === savedId) || plans[0] || null;
  const loaded = plan && (plan.id === savedId ? early : loadTables(PLAN_TABLES, plan.id));
  const [[{ backdrop, backdropUrl }, logs], tables] = await Promise.all([others, loaded]);
  return { plans, plan, tables, backdrop, backdropUrl, logs };
}

// 圃場を読み、中身とプランを一度に入れ替える。開いたプランを返す。
// pending は、先に読み始めておいた fetchFieldData（startApp が、圃場の一覧と並べて読む）
async function loadFieldData(field, pending = fetchFieldData(field.id)) {
  let { plans, plan, tables, backdrop, backdropUrl, logs } = await pending;
  if (!plan) {
    plan = await state.store.createPlan({ field_id: field.id, name: "プラン1" });
    plans = [plan];
    tables = await loadTables(PLAN_TABLES, plan.id);
  }
  // 外形は多角形の並びで持つ。1 つしか持てなかったころの形も、ここで並びに直す
  field.outline = outlineParts(field.outline);
  // 表示日は、前にその圃場で見ていた日。覚えていなければ今日
  Object.assign(state, { field, plans, backdrop, backdropUrl, logs, viewDate: savedViewDate(field.id), alignment: null });
  setPlanData(plan, tables);
  if (backdrop) {
    measureBackdrop(backdrop, backdropUrl);
  }
  return plan;
}

// 下絵の画像の大きさ。外形を描く前の圃場で、図を下絵に合わせるのに使う。
// 画像は大きいので、読み終わるのを待たずに画面を出し、読めたら合わせ直す
function measureBackdrop(backdrop, url) {
  imageSize(url)
    .then((size) => {
      backdrop.size = size;
      if (state.backdrop === backdrop && !state.field.outline.length) {
        fitView();
        renderMap();
      }
    })
    .catch(() => {});
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
  $("viewDate").value = state.viewDate;
  setMode("select");
  showPlan(plan);
  fitView();
  render();
  renderWeatherSettings();
  syncWeather();
}

// 圃場を作って開く。作った圃場を返す（やめたときは null）
async function newField() {
  const name = askPlanName("新しい圃場の名前", `圃場 ${state.fields.length + 1}`);
  if (!name) {
    return null;
  }
  let field = null;
  await planTask(async () => {
    field = await state.store.createField({ name });
    state.fields.push(field);
    await openField(field);
    record({ kind: "field.add", plan: false, target: ["field", field.id], text: `圃場「${field.name}」を作成` });
  });
  return field;
}

// 圃場の名前を変える（開いていない圃場も）
async function renameField(field) {
  const name = askPlanName("圃場の名前", field.name || "");
  if (!name || name === field.name) {
    return;
  }
  const was = field.name;
  await planTask(async () => {
    field.name = name;
    await state.store.saveField(field);
    record({ kind: "field.name", plan: false, field, target: ["field", field.id], text: "圃場の名前を変更", before: was, after: name });
  });
}

// 圃場を消す。確認の窓に名前を出した圃場だけを消す。開いている圃場を消したら、残った圃場の先頭を開く
async function deleteField(field) {
  if (state.planBusy || state.fields.length <= 1 || !state.fields.includes(field)) {
    return;
  }
  const isOpen = field.id === state.field.id;
  const count = isOpen ? state.plans.length : (await state.store.loadPlans(field.id)).length;
  const ok = await confirmDelete(
    `この圃場を削除します。外形、下絵、プラン ${count} つ（区域、区画、畝、日程）がすべて消えます。変更の履歴とメモは残ります。`,
    `圃場「${field.name}」`
  );
  if (!ok || !state.fields.includes(field)) {
    return;
  }
  await planTask(async () => {
    if (isOpen) {
      // 消す圃場の図形の保存は、もう要らない
      clearTimeout(saveTimer);
      pendingSaves.clear();
    }
    // 記録は、圃場があるうちに保存しておく
    await saveJournalNow();
    const imagesLeft = await state.store.deleteField(field.id);
    state.fields = state.fields.filter((item) => item.id !== field.id);
    if (isOpen) {
      await openField(state.fields[0]);
    }
    record({ kind: "field.delete", plan: false, target: ["field", field.id], text: `圃場「${field.name}」を削除` });
    if (imagesLeft) {
      notify(`圃場は消しましたが、下絵の画像 ${imagesLeft} 枚を、画像の置き場から消せませんでした。`);
    }
  });
}

function renderPlans() {
  renderPlace();
  renderPlanButtons();
  renderLogs();
}

// 圃場とプランの操作の途中は、図と日程を薄くして押せなくする。「圃場とプラン」の窓のボタンも押せなくする
function renderPlanButtons() {
  document.body.classList.toggle("plan-busy", Boolean(state.planBusy));
  refreshFieldPlans();
}

// プランを、実際に使うプランにする。作業の記録は、このプランの畝・作付・作業につなぐ
async function activatePlan(field = state.field, plan = state.plan) {
  if (state.planBusy || field.active_plan_id === plan.id) {
    return;
  }
  const ok = await confirmAction({
    message: `「${plan.name}」を、実際に使うプランにします。これからの実績と管理作業の計画は、このプランの畝につなぎます。`,
    action: "実際に使うプランにする",
  });
  if (!ok) {
    return;
  }
  await planTask(async () => {
    await state.store.setActivePlan(field.id, plan.id);
    field.active_plan_id = plan.id;
    record({ kind: "plan.active", plan, field, target: ["plan", plan.id], text: `プラン「${plan.name}」を、実際に使うプランに設定` });
  });
  if (field.id === state.field.id) {
    renderSchedule();
    renderPlantingDetail();
  }
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
  return { ...(await loadTables(["blocks", "beds", "plantings", "works"], id)), crops: state.crops };
}

// プランの下の表を、並べて読む。{ 表の名前: 行 } を返す
async function loadTables(tables, planId) {
  const rows = await Promise.all(tables.map((table) => state.store.list(table, planId)));
  return Object.fromEntries(tables.map((table, index) => [table, rows[index]]));
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
  setPlanData(plan, await loadTables(PLAN_TABLES, plan.id));
}

function setPlanData(plan, tables) {
  // 読み終えてから、プランと中身を一度に入れ替える。読み込みの途中で「元に戻す」の写しを取られると、
  // 新しいプランに前のプランの中身（空のことがある）が付いた写しができ、それに戻すと中身が消える
  Object.assign(state, { plan }, tables);
  // 畝の番号を、決まりどおり（左から順、なくした畝の番号は欠番）に揃える。
  // 番号を詰め直す仕組みを入れる前に削除した畝の跡も、ここで詰まる
  state.blocks.forEach((block) => renumberBlock(block.id));
}

async function openPlan(plan) {
  clearTimeout(saveTimer);
  await flushSaves();
  await loadPlanData(plan);
  showPlan(plan);
}

// 読み終えたプランを開いて、描き直す
function showPlan(plan) {
  state.selected = null;
  state.selectedVertex = null;
  state.draft = [];
  savePref(state.field.id, "plan", plan.id);
  renderPlans();
  render();
  renderSchedule();
  renderPlantingDetail();
  resetHistory(); // 前のプランの履歴は使えない。開き終えた状態から数え直す
}

function askPlanName(message, initial) {
  return (prompt(message, initial) || "").trim() || null;
}

// プランを作る。開いている圃場なら、作ったプランを開く。plans は、その圃場のプランの一覧（足す）
async function newPlan(field = state.field, plans = state.plans) {
  const name = askPlanName("新しいプランの名前", `プラン${plans.length + 1}`);
  if (!name) {
    return null;
  }
  let plan = null;
  await planTask(async () => {
    plan = await state.store.createPlan({ field_id: field.id, name });
    plans.push(plan);
    record({ kind: "plan.add", plan, field, target: ["plan", plan.id], text: `プラン「${plan.name}」を作成` });
    if (field.id === state.field.id) {
      await openPlan(plan);
    }
  });
  return plan;
}

async function renamePlan(field = state.field, plan = state.plan) {
  const name = askPlanName("プランの名前", plan.name);
  if (!name || name === plan.name) {
    return;
  }
  await planTask(async () => {
    await state.store.renamePlan(plan.id, name);
    const was = plan.name;
    plan.name = name;
    record({ kind: "plan.name", plan, field, target: ["plan", plan.id], text: "プランの名前を変更", before: was, after: name });
  });
}

// プランをコピーして、新しいプランを作る（開かない）。開いていないプランは、中身を読んでから写す
async function copyPlan(field = state.field, plan = state.plan, plans = state.plans) {
  const name = askPlanName("コピーしたプランの名前", `${plan.name}のコピー`);
  if (!name) {
    return null;
  }
  let copy = null;
  await planTask(async () => {
    let source = state;
    if (plan.id === state.plan.id) {
      clearTimeout(saveTimer);
      await flushSaves();
    } else {
      source = await loadTables(PLAN_TABLES, plan.id);
    }
    copy = await state.store.createPlan({ field_id: field.id, name });
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
      const rows = source[table].map((row) => {
        const item = { ...row, id: fresh(row.id), plan_id: copy.id };
        keys.forEach((key) => {
          item[key] = row[key] ? fresh(row[key]) : null;
        });
        return item;
      });
      await state.store.upsert(table, rows);
    }
    record({ kind: "plan.copy", plan: copy, field, target: ["plan", copy.id], text: `プラン「${plan.name}」をコピーして、プラン「${copy.name}」を作成` });
    plans.push(copy);
  });
  return copy;
}

// プランを消す。実際に使うプランと、圃場の最後のプランは消せない。開いているプランを消したら、残ったプランの先頭を開く
async function deletePlan(field = state.field, plan = state.plan, plans = state.plans) {
  if (state.planBusy || plans.length <= 1 || !plans.includes(plan)) {
    return;
  }
  if (plan.id === field.active_plan_id) {
    notify("このプランは、実際に使うプランなので削除できません。先に、ほかのプランを実際に使うプランにしてください。");
    return;
  }
  const ok = await confirmDelete("このプランを削除します。区域、区画、畝、日程がすべて消えます。", `プラン「${plan.name}」`);
  if (!ok || !plans.includes(plan)) {
    return;
  }
  const isOpen = plan.id === state.plan.id;
  await planTask(async () => {
    if (isOpen) {
      clearTimeout(saveTimer);
      [...pendingSaves.keys()].filter((key) => key.includes(":")).forEach((key) => pendingSaves.delete(key));
    }
    record({ kind: "plan.delete", plan: false, field, target: ["plan", plan.id], text: `プラン「${plan.name}」を削除` });
    await state.store.deletePlan(plan.id);
    plans.splice(plans.indexOf(plan), 1);
    if (isOpen) {
      await openPlan(plans[0]);
    }
  });
}

// 「圃場とプラン」の窓の「開く」。ほかの圃場のプランなら、その圃場を開いてから、そのプランを開く
async function openPlanOf(field, plan) {
  await planTask(async () => {
    if (field.id !== state.field.id) {
      savePref(field.id, "plan", plan.id);
      await openField(field);
    } else if (plan.id !== state.plan.id) {
      await openPlan(plan);
    }
  });
}

// 「圃場とプラン」の窓に渡す、データを変える処理
const fieldPlanOps = {
  loadPlans: (fieldId) => state.store.loadPlans(fieldId),
  planStats: async (planId) => {
    const tables = await loadTables(["blocks", "beds"], planId);
    return { blocks: tables.blocks.length, beds: tables.beds.length };
  },
  openPlan: openPlanOf,
  newField,
  renameField,
  deleteField,
  newPlan,
  renamePlan,
  copyPlan,
  activatePlan,
  deletePlan,
};

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
    markStep();
    state.backdrop = { id: crypto.randomUUID(), field_id: state.field.id, storage_path: path, ...placement, size };
    state.backdropUrl = url;
    state.alignment = null;
    queueSave("backdrop");
    adjustRecord({
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

// 選択中の図形の上を押したか。区域を選んだまま、その区画や畝の上からも動かせるよう、重なり順ではなく位置で見る。
// 距離と長さの数字は、押すと値を入れる窓が開くので除く。外形と畝は、図の上では動かさない
function pressedSelected(event) {
  const { gap, edge } = event.target.dataset;
  const points = state.selected && !isOutline(state.selected) && !isBed(state.selected) ? shapePoints(state.selected) : null;
  return Boolean(points) && gap === undefined && edge === undefined && pointInPolygon(clientToWorld(event), points);
}

// 図の編集の道具（「図を編集」で出す帯）が出ているか。スマホやタブレットの幅では出さない（.edit-only）。
// 出ていないときは、図形を動かしたり描いたりせず、なぞったら図が動くだけにする（選ぶ・見るための図なので）
function drawingToolsShown() {
  if (settings.open || !state.mapEditing) {
    return false; // 圃場の設定の窓の中の図は、外形のほかは見るだけ（2 点の距離と、位置合わせのクリックだけ受ける）
  }
  return getComputedStyle($("mapBand")).display !== "none";
}

// いま、角や辺を動かせる図形か。「図を編集」のあいだだけ
const shapeEditable = (key) => Boolean(key) && drawingToolsShown();

// ---- 図の編集（書きかけ） ----
// 「図を編集」から「閉じる」までの変更は書きかけ。DB への書き込み（図形、作業、記録など）と変更の記録は送らずに溜め、
// 「保存する」で、溜めた順に送る。保存しないで閉じたら、編集を始める前の写しに戻す（DB は変わっていない）。
// 書き込みは、した時点の操作の ID を付けて送る（DB の操作の記録で、1 回の操作としてまとまる）
const EDIT_UNSAVED = "図の編集を保存していません";
const DRAFT_WRITES = ["upsert", "remove", "saveField", "saveLog", "deleteLog", "saveWorkType"];
const mapDraft = { base: null, ops: [], start: null };

// 編集で変わりうるデータの写し
function editSnapshot() {
  return structuredClone({
    outline: state.field.outline,
    viewDirs: state.field.view_dirs ?? null,
    zones: state.zones,
    blocks: state.blocks,
    beds: state.beds,
    plantings: state.plantings,
    works: state.works,
    logs: state.logs,
    crops: state.crops,
    fertilizers: state.fertilizers,
    workTypes: state.workTypes,
  });
}

function restoreEditSnapshot(snap) {
  const copy = structuredClone(snap);
  state.field.outline = copy.outline;
  state.field.view_dirs = copy.viewDirs;
  for (const key of ["zones", "blocks", "beds", "plantings", "works", "logs", "crops", "fertilizers", "workTypes"]) {
    state[key] = copy[key];
  }
  if (state.selected && !shapePoints(state.selected)) {
    state.selected = null;
  }
  state.selectedVertex = null;
  state.draft = [];
  render();
  renderSchedule();
  renderCrops();
  renderLogs();
  renderPlantingDetail();
}

function renderEditFoot() {
  if (!state.mapEditing) {
    return;
  }
  const dirty = mapDraft.ops.length > 0 || pendingSaves.size > 0;
  $("mapEditSave").disabled = !dirty;
  if (dirty) {
    $("mapEditStatus").textContent = "保存していない変更があります";
  } else if ($("mapEditStatus").textContent !== "保存しました") {
    $("mapEditStatus").textContent = "編集中";
  }
}

function showMapEditing(on) {
  state.mapEditing = on;
  map.closest(".map-frame").classList.toggle("is-editing", on);
  document.body.classList.toggle("map-editing", on);
  $("mapBand").hidden = !on;
  $("mapEditBtn").hidden = on;
  setMode("select");
}

// 「図を編集」。送り残しを送り終えてから、書き込みを溜める店に替える。道具は「選択・移動」から
async function startMapEditing() {
  if (state.mapEditing || settings.open || state.planBusy) {
    return;
  }
  await finishSaves();
  mapDraft.base = state.store;
  mapDraft.ops = [];
  mapDraft.start = editSnapshot();
  const held = DRAFT_WRITES.filter((name) => mapDraft.base[name]).map((name) => [
    name,
    async (...args) => {
      mapDraft.ops.push({ name, args: structuredClone(args), op: currentOperation() });
      renderEditFoot();
    },
  ]);
  state.store = { ...mapDraft.base, ...Object.fromEntries(held) };
  holdRecords();
  $("mapEditStatus").textContent = "編集中";
  showMapEditing(true);
}

// 「保存する」。溜めた書き込みを順に送り、変更の記録も残す。編集は続ける。送れなかった分は残して、次に送る
async function saveMapEditing() {
  await sendPendingSaves();
  $("mapEditStatus").textContent = "保存中…";
  $("mapEditSave").disabled = true;
  try {
    while (mapDraft.ops.length) {
      const { name, args, op } = mapDraft.ops[0];
      await duringOperation(op, () => mapDraft.base[name](...args));
      mapDraft.ops.shift();
    }
    releaseRecords(true);
    holdRecords();
    mapDraft.start = editSnapshot();
    $("mapEditStatus").textContent = "保存しました";
    $("saveStatus").textContent = "保存しました";
  } catch (error) {
    $("mapEditStatus").textContent = `保存できませんでした: ${error.message}`;
    notifySaveFailed(error);
  }
  renderEditFoot();
}

// 「閉じる」。保存していない変更があれば、捨ててよいかを確かめ、捨てると編集を始める前に戻す。閉じたら true
async function closeMapEditing() {
  if (!state.mapEditing) {
    return true;
  }
  await sendPendingSaves();
  const changed = mapDraft.ops.length > 0 && JSON.stringify(editSnapshot()) !== JSON.stringify(mapDraft.start);
  if (changed && !(await confirmAction({ message: "まだ保存していない図の変更があります。この変更は消えます。", action: "捨てて閉じる", cancel: "編集を続ける" }))) {
    return false;
  }
  // 変更がない（元に戻して始めと同じになった）ときも、溜めた書き込みは送らない
  mapDraft.ops = [];
  releaseRecords(false);
  state.store = mapDraft.base;
  showMapEditing(false);
  if (changed) {
    restoreEditSnapshot(mapDraft.start);
    resetHistory(); // 元に戻すの履歴には、捨てた変更が入っている
  }
  $("saveStatus").textContent = "";
  return true;
}

// 図の編集中に押されたら止める、DB を変える操作の入口。図の編集の書きかけと食い違わないように、押した時点で止めて知らせる。
// 見るだけの操作（画面の切り替え、表示期間、作付の詳細を開くなど）と、日記・ニュースの確認は止めない。
// ここにない入口から書き込んでも、書き込みは図の編集の書きかけに入る（黙って保存されることはない）
const EDIT_GUARDED = [
  "#logAddBtn",
  "#weekList [data-week]",
  "#lateList [data-week]",
  "#logList [data-log]",
  "#gantt .gantt-bar",
  "#gantt .gantt-actual-bar",
  "#copyPickedBtn",
  "#cutPickedBtn",
  "#pastePickedBtn",
  "#deletePickedBtn",
  "#strip",
  ".strip-tools",
  "#typeRows :is(input, select, textarea, button)",
  "#addCropBtn",
  "#addFertilizerBtn",
  "#cropTable :is(input, select, textarea, button)",
  "#fertilizerTable :is(input, select, textarea, button)",
  ...["#plantingBody", "#blockRecord", "#blockHead"].map(
    (box) => `${box} :is([data-log], [data-plan-edit], [data-uncancel], [data-plan], [data-act="record"], [data-act="reschedule"])`
  ),
].join(", ");
const EDIT_GUARD_FREE = "#strip [data-open], #strip [data-planting]"; // 畝の図の中でも、作付の詳細を開くのは止めない
const EDIT_GUARD_TEXT = "図の編集中です。圃場図の上の帯の「保存する」か「閉じる」で、編集を終えてから操作してください。";

const guarded = (target) => state.mapEditing && target instanceof Element && Boolean(target.closest(EDIT_GUARDED)) && !target.closest(EDIT_GUARD_FREE);

// 押し始め（ドラッグの始まり、入力欄に入る、選ぶ欄が開く）は黙って止め、クリックで知らせる
for (const type of ["pointerdown", "mousedown"]) {
  document.addEventListener(
    type,
    (event) => {
      if (guarded(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );
}
document.addEventListener(
  "click",
  (event) => {
    if (guarded(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      document.activeElement?.blur?.();
      notify(EDIT_GUARD_TEXT);
    }
  },
  true
);
// 工程表のキーの操作（削除、切り取り、貼り付け）も止める
document.addEventListener(
  "keydown",
  (event) => {
    const ctrl = event.ctrlKey || event.metaKey;
    if (state.mapEditing && ganttHasFocus() && (event.key === "Delete" || event.key === "Backspace" || (ctrl && ["x", "v"].includes(event.key.toLowerCase())))) {
      event.preventDefault();
      event.stopPropagation();
      notify(EDIT_GUARD_TEXT);
    }
  },
  true
);

// 図の編集中に、圃場とプランの窓や圃場の設定の窓を開くとき。先に編集を閉じる（保存していなければ確かめる）
const afterMapEditing = (open) => async () => {
  if (await closeMapEditing()) {
    open();
  }
};

function closeMapMenus() {
  document.querySelectorAll(".map-menu").forEach((menu) => (menu.hidden = true));
  document.querySelectorAll("[data-map-menu]").forEach((button) => button.setAttribute("aria-expanded", "false"));
}

// 押した位置にある畝の文字。{ bed: 畝の ID, detail: 品目名なら作付の ID }。文字がなければ null。
// ブラウザーの「押された要素」は使わず、文字の位置から求める（WebKit は、文字の一部だけを押せるようにしても効かない。
// 文字の線の上でなく、文字と文字のすき間を押しても、品目名として扱う）
function mapLabelAt(event) {
  const pad = 2; // 画面の px。文字の枠の外側も少し含める
  for (const text of map.querySelectorAll("text[data-bed]")) {
    const ctm = text.getScreenCTM();
    const count = text.getNumberOfChars();
    if (!ctm || !count) {
      continue;
    }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    const margin = pad / Math.hypot(ctm.a, ctm.b);
    const nameStart = Number(text.dataset.name || count);
    // 番号と品目名の、それぞれの文字の枠をまとめた四角形に入っているか
    const inside = (from, to) => {
      if (from >= to) {
        return false;
      }
      const boxes = Array.from({ length: to - from }, (_, i) => text.getExtentOfChar(from + i));
      const left = Math.min(...boxes.map((box) => box.x)) - margin;
      const right = Math.max(...boxes.map((box) => box.x + box.width)) + margin;
      const top = Math.min(...boxes.map((box) => box.y)) - margin;
      const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + margin;
      return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
    };
    if (text.dataset.detail && inside(nameStart, count)) {
      return { bed: text.dataset.bed, detail: text.dataset.detail };
    }
    if (inside(0, Math.min(nameStart, count))) {
      return { bed: text.dataset.bed, detail: null };
    }
  }
  return null;
}

map.addEventListener("pointerdown", (event) => {
  map.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, [event.clientX, event.clientY]);
  if (pointers.size > 1) {
    gesture = { kind: "pinch" };
    return;
  }
  const target = event.target;
  // 畝の文字を押したときは、その畝（品目名なら作付の詳細）。文字は押せない（pointer-events: none）ので、位置から求める
  const labelHit = mapLabelAt(event);
  const detail = labelHit?.detail;
  // 作図の道具が出ていないときは、図形を動かさず、図を動かす（pan）。離したときは、図形を選ぶか、品目名から作付の詳細を開くだけ
  const editing = drawingToolsShown();
  // 圃場の設定の窓では、図形を描く道具は出さないが、下絵の 2 点の距離と位置合わせのクリックは受ける
  const settingsClick = settings.open && (state.mode === "scale" || state.mode === "align" || state.mode === "areaMeasure");
  if (!editing && state.mode !== "select" && !settingsClick) {
    // PC の幅で道具を選んだまま、画面を狭めたとき。道具は見えないので、選択に戻す
    setMode("select");
  }
  const editable = state.mode === "select" && shapeEditable(state.selected);
  if (editable && target.dataset.vertex !== undefined) {
    state.selectedVertex = Number(target.dataset.vertex);
    // 圃場の設定の窓の中では、動かす前の写しを取っておき、動かしたら「元に戻す」の区切りにする
    gesture = { kind: "vertex", index: state.selectedVertex, moved: false, was: sizeText(state.selected), snap: settings.open ? settingsSnapshot() : null };
    render();
  } else if (editable && target.dataset.mid !== undefined && !isOutline(state.selected)) {
    // 区域と区画: 辺を平行に動かして、大きさを変える
    gesture = { kind: "edge", index: Number(target.dataset.mid), last: clientToWorld(event), was: sizeText(state.selected) };
  } else if (editable && target.dataset.mid !== undefined) {
    // 圃場の外形: 辺の途中に頂点を足す
    markStep();
    const index = Number(target.dataset.mid) + 1;
    const points = [...shapePoints(state.selected)];
    points.splice(index, 0, clientToWorld(event));
    setShapePoints(state.selected, points);
    state.selectedVertex = index;
    gesture = { kind: "vertex", index, moved: true, was: sizeText(state.selected) };
    render();
  } else if (editing && (state.mode === "rect" || state.mode === "blockrect")) {
    // 区域は圃場の外形の辺に、区画は有効圃場の辺に平行に描く
    const start = clientToWorld(event);
    const zone = state.mode === "blockrect" ? tillableZoneAt(start) : null;
    const frames = zone ? [zone.shape] : state.field.outline;
    gesture = { kind: "rect", start, zone, angle: nearestEdgeAngleOf(start, frames), origin: [event.clientX, event.clientY] };
  } else if (editing && state.mode === "select" && !detail && pressedSelected(event)) {
    // 選択中の図形は、ドラッグでそのまま動かせる。動かさずに離したら、押した図形を選ぶ
    gesture = { kind: "move", moved: false, start: [event.clientX, event.clientY], last: clientToWorld(event), shape: labelHit?.bed || target.dataset.shape };
  } else {
    gesture = {
      kind: "pan",
      moved: false,
      start: [event.clientX, event.clientY],
      shape: labelHit?.bed || target.dataset.shape,
      // すき間と辺の長さの数字を押すと、長さを入れる窓が開く。作図の道具が出ていないときは開かない
      gap: editing ? target.dataset.gap : undefined,
      edge: editing ? target.dataset.edge : undefined,
      detail,
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
  } else if ((state.mode === "scale" || state.mode === "align") && state.draft.length % 2 === 1) {
    // 2 点の距離と位置合わせ: 押した点から、マウスの位置まで線を伸ばす
    state.hover = point;
  } else if (state.mode === "areaMeasure" && state.draft.length) {
    // 面積を測る: 押した点とマウスの位置で、多角形を閉じる
    state.hover = point;
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
    if (finished.snap && settings.open) {
      settings.undo.push(finished.snap);
      settings.redo.length = 0;
    }
    recordShape(state.selected, finished.was);
    renderSettingsFoot();
  }
  if (finished && (finished.kind === "move" || finished.kind === "edge")) {
    if (finished.kind === "edge") {
      recordShape(state.selected, finished.was);
    } else if (finished.moved) {
      recordMove(state.selected);
    } else if (finished.shape && event.type === "pointerup") {
      state.selected = finished.shape;
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
  if (state.mode === "select" && finished.detail) {
    // 畝の品目名: その作付の詳細を開く
    openPlantingDetail("planting", finished.detail);
    showView("planting");
    return;
  }
  if (state.mode === "select" && settings.open) {
    return;
  } else if (state.mode === "select") {
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
      // 2 点を結んだ線を描いてから、実際の距離を尋ねる（尋ねる窓が出ているあいだは、画面が描き直されないため）
      state.hover = null;
      renderMap();
      setTimeout(finishScale, 60);
      return;
    }
  } else if (state.mode === "areaMeasure") {
    // 最初の点を押したら閉じて、実際の面積を尋ねる（閉じた多角形を描いてから尋ねる）
    if (state.draft.length >= 3 && distance(state.draft[0], world) * zoom() < CLOSE_TOLERANCE_PX) {
      state.hover = null;
      renderMap();
      setTimeout(finishAreaMeasure, 60);
      return;
    }
    state.draft.push(world);
    state.hover = null;
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
  // 最後に工程表の欄を押したときは、キーは工程表の操作（schedule-view.js）に渡す
  if (!state.field || $("appView").hidden || ganttHasFocus() || ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) {
    return;
  }
  if (event.key === "Escape") {
    closeMapMenus();
    setMode("select");
  } else if (event.key === "Enter" && (state.mode === "outline" || state.mode === "zone")) {
    finishDraft();
  } else if (event.key === "Backspace" && state.draft.length && (state.mode === "outline" || state.mode === "zone")) {
    state.draft.pop();
    render();
  } else if (event.key === "Delete" && state.mode === "select" && shapeEditable(state.selected)) {
    deleteSelectedVertex();
  } else if (ARROWS[event.key] && state.mode === "select" && drawingToolsShown() && state.selected && !isOutline(state.selected) && !isBed(state.selected)) {
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
$("mapEditBtn").addEventListener("click", startMapEditing);
$("mapEditSave").addEventListener("click", saveMapEditing);
$("mapEditDone").addEventListener("click", closeMapEditing);
// 区域・耕起対象区画のメニュー。押すと開き、もう一度押すか、ほかの所を押すと閉じる
document.querySelectorAll("[data-map-menu]").forEach((button) => {
  button.addEventListener("click", () => {
    const menu = document.querySelector(`.map-menu[data-menu-of="${button.dataset.mapMenu}"]`);
    const open = menu.hidden;
    closeMapMenus();
    menu.hidden = !open;
    menu.style.left = `${button.offsetLeft}px`;
    button.setAttribute("aria-expanded", String(open));
  });
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".map-menu, [data-map-menu]")) {
    closeMapMenus();
  }
});
$("fitBtn").addEventListener("click", () => {
  fitView();
  renderMap();
});
$("fitShapesBtn").addEventListener("click", fitShapesToBackdrop);
$("deleteVertexBtn").addEventListener("click", deleteSelectedVertex);
$("deleteShapeBtn").addEventListener("click", deleteSelectedShape);
$("openScheduleBtn").addEventListener("click", () => {
  const { kind, item } = findShape(state.selected);
  const planting = kind === "bed" ? plantingOn(item) : null;
  if (planting) {
    openPlantingDetail("planting", planting.id);
    showView("planting");
  } else if (kind === "block") {
    openInSchedule(kind, state.selected);
    showView("schedule");
  }
});

$("viewDate").addEventListener("change", (event) => {
  state.viewDate = event.target.value || localToday();
  event.target.value = state.viewDate;
  savePref(state.field.id, "viewDate", state.viewDate);
  // 表示日に存在しない畝を選んだままにしない
  const found = state.selected && !isOutline(state.selected) ? findShape(state.selected) : null;
  if (found && found.kind === "bed" && !bedExists(found.item)) {
    state.selected = null;
  }
  render();
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
      const [part, edge] = event.target.value.split(":").map(Number);
      setViewEdge(k, part, edge);
    }
  });
});
$("mapPdfBtn").addEventListener("click", printMap);
$("warnings").addEventListener("click", (event) => {
  const item = event.target.closest("[data-shape]");
  if (item) {
    select(item.dataset.shape);
    // 警告の欄は図の上にあるので、選んだ図形が見えるよう、図まで送る
    document.querySelector(".map-frame").scrollIntoView({ block: "nearest", behavior: "smooth" });
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
document.querySelectorAll(".backdrop-visible").forEach((box) =>
  box.addEventListener("change", (event) => {
    state.backdropVisible = event.target.checked;
    document.querySelectorAll(".backdrop-visible").forEach((other) => (other.checked = state.backdropVisible));
    renderMap();
  })
);
$("rotation").addEventListener("change", (event) => {
  const degrees = Number(event.target.value);
  if (state.backdrop && Number.isFinite(degrees)) {
    setRotation(degrees);
  }
});

// ---- 圃場の設定の窓 ----
// 下絵・縮尺・位置と向き・気象。開いているあいだは、圃場図の図（と案内）を窓の中へ移す。
// 調整は書きかけ: 下絵・外形・図形の保存と、変更の履歴の記録を止めて溜め、図形の伸び縮み・回転は開いているプランにだけ当てて覚える。
// 調整のたびに状態の写しを取り、窓の中の「元に戻す・やり直す」で行き来する。「保存する」でまとめて保存し（窓は閉じない）、
// ほかのプランの図形にも同じ変換を当てる。保存しないまま閉じたら、開く前の状態に戻す

// （settings は、ファイルの先頭のほうで宣言している）

// 下絵の調整の変更の記録。窓を開いているあいだは溜めておく
function adjustRecord(entry) {
  if (settings.open) {
    settings.records.push(entry);
  } else {
    record(entry);
  }
}

function settingsSnapshot() {
  return {
    backdrop: state.backdrop ? structuredClone(state.backdrop) : null,
    backdropUrl: state.backdropUrl,
    alignment: state.alignment ? structuredClone(state.alignment) : null,
    outline: structuredClone(state.field.outline),
    viewDirs: state.field.view_dirs ? [...state.field.view_dirs] : (state.field.view_dirs ?? null),
    shapes: Object.fromEntries(["zones", "blocks", "beds"].map((table) => [table, Object.fromEntries(state[table].map((item) => [item.id, structuredClone(item.shape)]))])),
    transforms: [...settings.transforms],
    records: [...settings.records],
    view: { ...state.view },
    weather: { base_lat: state.field.base_lat ?? null, base_lng: state.field.base_lng ?? null, weather: structuredClone(state.field.weather || {}) },
  };
}

function restoreSnapshot(snap) {
  state.backdrop = snap.backdrop ? structuredClone(snap.backdrop) : null;
  state.backdropUrl = snap.backdropUrl;
  state.alignment = snap.alignment ? structuredClone(snap.alignment) : null;
  state.field.outline = structuredClone(snap.outline);
  state.field.view_dirs = snap.viewDirs;
  for (const table of ["zones", "blocks", "beds"]) {
    for (const item of state[table]) {
      if (snap.shapes[table][item.id]) {
        item.shape = structuredClone(snap.shapes[table][item.id]);
      }
    }
  }
  // 戻した状態にない図形（描いたばかりの外形など）は選ばない。角の番号も変わることがあるので外す
  if (state.selected && !shapePoints(state.selected)) {
    state.selected = null;
  }
  state.selectedVertex = null;
  settings.transforms = [...snap.transforms];
  settings.records = [...snap.records];
  Object.assign(state.field, structuredClone(snap.weather));
  setView(snap.view);
  render();
  renderWeatherSettings();
}

// 保存するものが変わったかを見分ける写しの要約（表示の位置や画像の大きさは含めない）
const settingsKey = (snap) =>
  JSON.stringify({ backdrop: snap.backdrop && { ...snap.backdrop, size: null }, outline: snap.outline, viewDirs: snap.viewDirs, shapes: snap.shapes, transforms: snap.transforms.length, weather: snap.weather });
const settingsDirty = () => settings.open && settingsKey(settingsSnapshot()) !== settingsKey(settings.start);

// 調整を 1 回する前に呼ぶ。いまの状態を「元に戻す」の履歴に積む
function markStep() {
  if (!settings.open) {
    return;
  }
  settings.undo.push(settingsSnapshot());
  settings.redo.length = 0;
  $("settingsStatus").textContent = "";
}

function renderSettingsFoot() {
  if (!settings.open) {
    return;
  }
  const dirty = settingsDirty();
  $("settingsSave").disabled = !dirty;
  $("settingsUndo").disabled = !settings.undo.length;
  $("settingsRedo").disabled = !settings.redo.length;
  $("settingsWarn").hidden = !settings.transforms.length;
  if (dirty) {
    $("settingsStatus").textContent = settings.undo.length ? `保存していない調整があります（${settings.undo.length} 回）` : "保存していない変更があります";
  } else if ($("settingsStatus").textContent !== "保存しました") {
    $("settingsStatus").textContent = "変更はありません";
  }
}

async function openFieldSettings() {
  if (settings.open || state.planBusy) {
    return;
  }
  // それまでの図形の保存を先に済ませる（窓を開いているあいだの保存の予約は止めるので）
  await sendPendingSaves();
  setMode("select");
  Object.assign(settings, { open: true, undo: [], redo: [], transforms: [], records: [] });
  settings.start = settingsSnapshot();
  // 気象の欄を変える前に、元に戻すの区切りを入れる。変えたあとに、下の欄を描き直す
  beginWeatherDraft({ before: markStep, after: renderSettingsFoot });
  const frame = document.querySelector("#appView .map-frame");
  settings.home = { parent: frame.parentElement, next: frame.nextSibling };
  $("settingsMapSlot").append($("hint"), frame);
  $("fieldSettingsName").textContent = state.field.name || "";
  $("settingsStatus").textContent = "";
  $("fieldSettings").showModal();
  $("fieldSettingsTitle").focus({ preventScroll: true });
  renderWeatherSettings();
  render();
}

// 閉じる。保存していない変更があれば、捨ててよいかを確かめる
async function requestCloseSettings() {
  if (settingsDirty() && !(await confirmAction({ message: "まだ保存していない設定があります。この設定は消えます。", action: "捨てて閉じる", cancel: "入力を続ける" }))) {
    return;
  }
  setMode("select");
  if (settingsDirty()) {
    restoreSnapshot(settings.start);
  }
  cancelWeatherDraft();
  settings.open = false;
  const frame = $("settingsMapSlot").querySelector(".map-frame");
  settings.home.parent.insertBefore(frame, settings.home.next);
  $("hintFold").append($("hint"));
  $("fieldSettings").close();
  renderWeatherSettings();
  render();
}

// 書きかけをまとめて保存する。窓は閉じない。保存したところを新しい出発点にし、「元に戻す」の履歴は空にする
async function saveFieldSettings() {
  if (!settingsDirty()) {
    return;
  }
  if (settings.transforms.length) {
    const ok = await confirmAction({
      message: "図形の大きさ・向きを変える調整が入っています。この圃場のすべてのプランの外形・区域・区画・畝に当てて保存します。保存したあとは「元に戻す」で戻せません。",
      action: "保存する",
    });
    if (!ok) {
      return;
    }
  }
  setMode("select");
  const start = settings.start;
  const now = settingsSnapshot();
  $("settingsStatus").textContent = "保存中…";
  $("settingsSave").disabled = true;
  try {
    if (JSON.stringify(now.backdrop && { ...now.backdrop, size: null }) !== JSON.stringify(start.backdrop && { ...start.backdrop, size: null }) && state.backdrop) {
      const { size, ...row } = state.backdrop;
      await state.store.saveBackdrop(row);
    }
    if (JSON.stringify([now.outline, now.viewDirs]) !== JSON.stringify([start.outline, start.viewDirs])) {
      await state.store.saveField(state.field);
    }
    for (const table of ["zones", "blocks", "beds"]) {
      const changed = state[table].filter((item) => JSON.stringify(item.shape) !== JSON.stringify(start.shapes[table][item.id]));
      if (changed.length) {
        await state.store.upsert(table, changed);
      }
    }
    // ほかのプランの図形にも、同じ変換を順に当てる
    if (settings.transforms.length) {
      for (const plan of state.plans.filter((other) => other.id !== state.plan.id)) {
        for (const table of ["zones", "blocks", "beds"]) {
          const rows = await state.store.list(table, plan.id);
          await state.store.upsert(table, rows.map((row) => ({ ...row, shape: settings.transforms.reduce((shape, change) => change(shape), row.shape) })));
        }
      }
    }
    await commitWeatherDraft();
    settings.records.forEach((entry) => record(entry));
    Object.assign(settings, { undo: [], redo: [], transforms: [], records: [] });
    settings.start = settingsSnapshot();
    resetHistory();
    $("settingsStatus").textContent = "保存しました";
  } catch (error) {
    $("settingsStatus").textContent = `保存できませんでした: ${error.message}`;
    notifySaveFailed(error);
  }
  renderSettingsFoot();
}

function settingsUndo(from, to) {
  if (!from.length) {
    return;
  }
  setMode("select");
  to.push(settingsSnapshot());
  restoreSnapshot(from.pop());
  $("settingsStatus").textContent = "";
  renderSettingsFoot();
}

$("settingsUndo").addEventListener("click", () => settingsUndo(settings.undo, settings.redo));
$("settingsRedo").addEventListener("click", () => settingsUndo(settings.redo, settings.undo));
$("settingsSave").addEventListener("click", saveFieldSettings);
$("fieldSettingsClose").addEventListener("click", requestCloseSettings);
// Esc: 書きかけがあれば、捨ててよいかを確かめる
$("fieldSettings").addEventListener("cancel", (event) => {
  event.preventDefault();
  requestCloseSettings();
});
// 下絵・縮尺・位置と向き・気象のタブ
$("fieldSettings").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-fstab]");
  if (!tab) {
    return;
  }
  setMode("select");
  document.querySelectorAll("[data-fstab]").forEach((item) => {
    item.classList.toggle("is-on", item === tab);
    item.setAttribute("aria-selected", String(item === tab));
  });
  document.querySelectorAll("[data-fspanel]").forEach((panel) => (panel.hidden = panel.dataset.fspanel !== tab.dataset.fstab));
});

// ---- 圃場図と日程の切り替え ----

// 作付の詳細（planting）は、日程のタブの中の画面として扱う
// 画面の URL。#map、#schedule、#crops、#diary、#journal、作付の詳細は #detail/planting/作付の ID。
// 日程の画面は、開いている区画を付けて #schedule/block/区画の ID にする。
// 前にあった区画の詳細（#detail/block/区画の ID）は、日程の画面でその区画を開く
// 画面を移るたびに URL を書き換えて、ブラウザーの履歴に積む（戻る・進むで画面を行き来でき、再読み込みしても同じ画面を開く）
const VIEW_NAMES = ["map", "schedule", "crops", "diary", "journal"];

function routeFromHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  const detail = /^detail\/(planting|block)\/([\w-]+)$/.exec(hash);
  if (detail) {
    return detail[1] === "block" ? { view: "schedule", block: detail[2] } : { view: "planting", kind: detail[1], id: detail[2] };
  }
  const block = /^schedule\/block\/([\w-]+)$/.exec(hash);
  if (block) {
    return { view: "schedule", block: block[1] };
  }
  return VIEW_NAMES.includes(hash) ? { view: hash } : null;
}

function hashOf(view) {
  if (view === "planting") {
    const target = plantingTarget();
    return `#detail/${target.kind}/${target.id}`;
  }
  return view === "schedule" ? scheduleHash() : `#${view}`;
}

function openRoute(route, mode) {
  if (route.view === "planting") {
    openPlantingDetail(route.kind, route.id);
  } else if (route.block) {
    openInSchedule("block", route.block);
  }
  showView(route.view, { history: mode });
}

// history: push（履歴に積む）、replace（いまの履歴を書き換える）、none（戻る・進むで来たので、触らない）
function showView(view, { history: mode = "push" } = {}) {
  const hash = hashOf(view);
  if (mode !== "none" && location.hash !== hash) {
    window.history[mode === "replace" ? "replaceState" : "pushState"]({ fieldPlanView: view }, "", hash);
  }
  const tab = view === "planting" ? "schedule" : view;
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === tab);
  });
  $("appView").hidden = view !== "map";
  $("scheduleView").hidden = view !== "schedule";
  $("plantingView").hidden = view !== "planting";
  $("cropsView").hidden = view !== "crops";
  $("diaryView").hidden = view !== "diary";
  $("journalView").hidden = view !== "journal";
  // 右下の「＋ 入力する」は圃場図だけ（日程の画面と作付の詳細では、頭の「＋ 作業を入力」を使う）
  $("logAddBtn").hidden = view !== "map";
  // 工程表の欄は 1 つで、圃場図と日程の画面のうち、開いた方へ移す（描くのは renderSchedule）
  if (view === "map" || view === "schedule") {
    placeGantt(view);
  }
  // 区画・畝の欄は、日程の画面と作付の詳細の上に出す
  if (view === "schedule" || view === "planting") {
    placePicker(view);
  }
  if (view === "map") {
    render();
    renderSchedule(); // 今週やること、警告、工程表（すべての区画）
    renderLogs();
    renderWeatherSettings();
  } else if (view === "schedule") {
    renderSchedule();
  } else if (view === "planting") {
    renderPlantingDetail();
    window.scrollTo(0, 0);
  } else if (view === "crops") {
    renderCrops();
    renderTypes();
  } else if (view === "diary") {
    renderDiary();
  } else {
    renderJournal();
  }
}

document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

// ブラウザーの戻る・進み。URL の画面を出す（アプリを開く前の画面では何もしない）
// 実績・計画の入力の窓が開いているときは、窓だけを閉じる
window.addEventListener("popstate", () => {
  if (handleLogDialogPop() || $("viewTabs").hidden) {
    return;
  }
  openRoute(routeFromHash() || { view: "map" }, "none");
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
    // 作付と作業: 日程の画面でその区画を開き、窓の工程の計画をその作付（区画）で開く
    openInSchedule("planting", id);
    showView("schedule");
    openProcessPlan("planting", id);
  } else if (kind === "work" && state.works.some((item) => item.id === id)) {
    const work = state.works.find((item) => item.id === id);
    openInSchedule(work.block_id ? "block" : "planting", work.block_id || work.planting_id);
    showView("schedule");
    openProcessPlan(work.block_id ? "block" : "planting", work.block_id || work.planting_id);
  } else if (["zone", "block", "bed"].includes(kind) && findShape(id)) {
    showView("map");
    select(id);
  } else if (kind) {
    status("この変更の相手は、もうありません。");
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
    let fieldId = null;
    try {
      fieldId = localStorage.getItem(CURRENT_FIELD_KEY);
    } catch {
      // 読めなければ先頭の圃場を開く
    }
    // 前に開いていた圃場の中身は、圃場の一覧を待たずに読み始める。DB の往復を待つ回数が 1 回減る
    const early = fieldId ? fetchFieldData(fieldId) : null;
    // 圃場が消えていて使わなかったときの失敗で、止めないようにする。使うときは loadFieldData が待つので失敗が伝わる
    early?.catch(() => {});
    const [fields, allWorkTypes, crops, fertilizers, minVersion] = await Promise.all([
      state.store.loadFields(),
      state.store.loadWorkTypes(),
      state.store.listAll("crops"),
      state.store.listAll("fertilizers"),
      state.store.minAppVersion(),
    ]);
    // DB の形が、この版の画面では正しく書けない形に変わっている。書く前に止め、新しい版を読み込み直す（index.html が受ける）
    if (APP_VERSION < minVersion) {
      showFatal("この DB を使うには、アプリの新しい版が要ります。読み込み直してください。");
      document.dispatchEvent(new Event("app-outdated"));
      return;
    }
    Object.assign(state, { fields, allWorkTypes, workTypes: allWorkTypes.filter(isPlannable), crops, fertilizers });
    if (!state.fields.length) {
      state.fields = [await state.store.createField({ name: config.defaultFieldName })];
    }
    const field = state.fields.find((item) => item.id === fieldId);
    await (field ? loadFieldData(field, early) : loadFieldData(state.fields[0]));
  } catch (error) {
    showFatal(
      error.code === "42501" || /row-level security/.test(error.message || "")
        ? "この利用者には読み書きの権限がありません。field.owners に利用者の ID を登録してください。"
        : describeLoadError(error)
    );
    return;
  }
  $("viewDate").value = state.viewDate;
  $("appView").hidden = false;
  $("viewTabs").hidden = false;
  initFieldPlans({ state, notify, ops: fieldPlanOps });
  setPlaceActions({ choose: afterMapEditing(openFieldPlans), settings: afterMapEditing(openFieldSettings) });
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
      return deleteSelectedShape();
    },
    setStatus,
    renderWarnings,
    showView,
    renderBlockRecord,
    plantingTarget,
    openDetail: (kind, id) => {
      openPlantingDetail(kind, id);
      showView("planting");
    },
  });
  // 記録や取りやめが変わったら、日程と作付の詳細を描き直す
  const refreshRecords = () => {
    renderSchedule();
    renderPlantingDetail();
    refreshDiaryWorks();
  };
  initLogs({ state, activePlanData, setStatus, onLogsChanged: refreshRecords, selectedTarget: selectedRowPreset });
  initProcessEditor({ state, setStatus, refresh: refreshRecords, currentBlockId });
  initPlantingView({
    state,
    showView,
    renderPicker: () => renderPicker("planting"),
    openInSchedule,
    setStatus,
    refresh: refreshRecords,
  });
  initWeather({ state, setStatus, onWeatherChanged: renderPlantingDetail });
  renderWeatherSettings();
  syncWeather();
  initNews({ state, setStatus });
  // URL に画面があれば、その画面を開く（再読み込み、ブックマーク）。なければ、スマホも PC も圃場図（今週やることが図の上にある）。
  // ほかの読み込みを待つ前に切り替える（待ってからだと、圃場図が一瞬見えてしまう）。履歴の画面は、読み込んでから開く
  const route = routeFromHash();
  if (route && route.view !== "journal") {
    openRoute(route, "replace");
  } else if (!route) {
    showView("map", { history: "replace" });
  }
  initCrops({ state, setStatus });
  initDiary({ state, setStatus });
  try {
    await initJournal({ state, openTarget, setStatus });
  } catch (error) {
    $("saveStatus").textContent = `変更の履歴を読み込めませんでした: ${error.message}`;
  }
  if (route?.view === "journal") {
    openRoute(route, "replace");
  }
  initHistory({
    state,
    // プランを読み込んでいるあいだは、元に戻さない
    busy: () => state.planBusy || settings.open,
    setStatus,
    // まだ送っていない図形の保存を、先に済ませる
    flush: async () => {
      clearTimeout(saveTimer);
      await flushSaves();
    },
    refresh: refreshViews,
    // 戻すのに途中で失敗したとき、DB から読み直す
    reload: reloadFromDb,
  });
}

// ログアウト。日記の書きかけが端末に残っていれば、消してよいかを確かめる（日記にはほかの方の名前も入るので、端末に残さない）
async function logout() {
  if (
    hasDiaryDrafts() &&
    !(await confirmAction({ message: "保存していない書きかけがあります。消してログアウトしますか", action: "消してログアウト", cancel: "キャンセル" }))
  ) {
    return;
  }
  clearDiaryDrafts();
  await state.client.auth.signOut();
  forgetImageUrls();
  location.reload();
}

async function main() {
  initToasts();
  const params = new URLSearchParams(location.search);
  if (params.has("local")) {
    state.store = inOrder(createLocalStore({ strict: params.has("strict") }));
    setUserMenu({ local: true });
    await startApp();
    return;
  }

  state.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { db: { schema: "field" }, global: { fetch: fetchWithOperation } });
  state.store = inOrder(createSupabaseStore(state.client, { url: config.supabaseUrl, anonKey: config.supabaseAnonKey }));

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("loginError").textContent = "";
    const { data: signedIn, error } = await state.client.auth.signInWithPassword({
      email: $("loginEmail").value,
      password: $("loginPassword").value,
    });
    if (error) {
      $("loginError").textContent = "ログインできませんでした。メールアドレスとパスワードを確かめてください。";
      return;
    }
    setUserMenu({ email: signedIn.user?.email, logout });
    await startApp();
  });

  const { data } = await state.client.auth.getSession();
  if (data.session) {
    setUserMenu({ email: data.session.user?.email, logout });
    await startApp();
  } else {
    $("loginView").hidden = false;
  }
  // 画面が出たことを index.html に知らせる。アプリの更新の確認は、ここから始める
  document.dispatchEvent(new Event("app-ready"));
}

main();

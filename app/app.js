import {
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
  layoutBeds,
  nearestEdgeAngle,
  pointInPolygon,
  polygonArea,
  polygonInside,
  polygonsOverlap,
  rectCentered,
  rectFromDiagonal,
  rectSize,
  rotatePoints,
  scalePoints,
  splitPolygon,
  translatePoints,
} from "./geometry.js";
import { initCrops, renderCrops } from "./crops-view.js";
import { notify } from "./dialog.js";
import { initHistory, resetHistory } from "./history.js";
import { initJournal, record, renderJournal } from "./journal.js";
import { existsOn, harvestEnd, localToday, worksRange } from "./schedule.js";
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
  block: "有効圃場をクリックすると、その全体が 1 つの耕起対象区画になります。",
  split: "区画（または有効圃場）の中をクリックすると、その位置で 2 つに分けます。端からの距離は、クリックのあとで数値で直せます。",
  blockrect: "有効圃場の中で、対角の 2 点をドラッグ。表示日に畝がない場所を、新しい区画にします。",
};
const TABLES = { zone: "zones", block: "blocks", bed: "beds" };
const CURRENT_PLAN_KEY = "field_plan_current_plan";
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
  client: null,
  field: null,
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
  workTypes: [],
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

function renderMap() {
  const z = zoom();
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
    // 畝の番号と品目は、畝の向きに沿って書く。画面で小さい畝には書かない
    const size = rectSize(bed.shape);
    if (size.length * z > 50 && size.width * z > 9) {
      const [a, b] = distance(bed.shape[0], bed.shape[1]) >= distance(bed.shape[1], bed.shape[2]) ? [bed.shape[0], bed.shape[1]] : [bed.shape[1], bed.shape[2]];
      let degrees = (-Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      degrees = degrees > 90 ? degrees - 180 : degrees <= -90 ? degrees + 180 : degrees;
      const center = centroid(bed.shape);
      const text = `${bed.seq}${name ? ` ${name}` : ""}`;
      parts.push(label(center, text, Math.min(fontSize, size.width * 0.85), `transform="rotate(${degrees} ${center[0]} ${-center[1]})"`));
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
    const open = state.mode === "scale" || state.mode === "split";
    const closing = !open && state.draft.length >= 3 ? ` ${svgPoints([state.draft[0]])}` : "";
    parts.push(`<polyline class="draft" points="${svgPoints(state.draft)}${closing}" />`);
    if (state.mode !== "split") {
      state.draft.forEach((point) => {
        parts.push(`<circle class="draft-point" cx="${point[0]}" cy="${-point[1]}" r="${4 / z}" />`);
      });
    }
  }

  map.innerHTML = parts.join("");
  renderScaleBar(z);
}

function renderScaleBar(z) {
  // 画面で 60〜150 px に収まる、切りのよい長さを選ぶ
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  const meters = steps.find((step) => step * z >= 60) || steps[steps.length - 1];
  $("scaleBarLine").style.width = `${meters * z}px`;
  $("scaleBarLabel").textContent = `${meters} m`;
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
  const warnings = [
    ...outside.zones.map((zone) => [zone.id, `${zoneLabel(zone)}が、圃場の外形からはみ出しています。`]),
    ...outside.blocks.map((block) => [
      block.id,
      `${block.name}が、${zoneLabel(state.zones.find((zone) => zone.id === block.zone_id))}からはみ出しています。`,
    ]),
  ];
  // 畝は本数が多いので、区画ごとにまとめる
  for (const block of visibleBlocks()) {
    const strays = outside.beds.filter((bed) => bed.block_id === block.id).sort((a, b) => a.seq - b.seq);
    if (strays.length) {
      warnings.push([strays[0].id, `${block.name}の畝${strays.map((bed) => bed.seq).join("、")}が、区画からはみ出しています。`]);
    }
  }
  $("warnings").innerHTML = warnings.map(([id, text]) => `<li data-shape="${id}">${escapeHtml(text)}</li>`).join("");

  const selectedRow = (id) => (state.selected === id ? "is-selected" : "");
  $("zoneList").innerHTML = state.zones.length
    ? state.zones
        .map(
          (zone) =>
            `<li data-shape="${zone.id}" class="${selectedRow(zone.id)}">` +
            `<span><span class="swatch" style="background:${ZONE_KINDS[zone.kind].color}"></span>${escapeHtml(zoneLabel(zone))}</span>` +
            `<span>${polygonArea(zone.shape).toFixed(1)} ㎡</span></li>`
        )
        .join("")
    : '<li class="empty">まだありません</li>';
  $("blockList").innerHTML = state.blocks.length
    ? state.blocks
        .map((block) => {
          const active = blockActive(block);
          const count = beds.filter((bed) => bed.block_id === block.id).length;
          const detail = active
            ? `${polygonArea(block.shape).toFixed(1)} ㎡${count ? ` / 畝 ${count} 本` : ""}`
            : `表示日にはない（${blockPeriod(block)}）`;
          return (
            `<li data-shape="${block.id}" class="${selectedRow(block.id)}${active ? "" : " is-away"}">` +
            `<span><span class="swatch" style="background:${BLOCK_COLOR}"></span>${escapeHtml(block.name)}</span>` +
            `<span>${detail}</span></li>`
          );
        })
        .join("")
    : '<li class="empty">まだありません</li>';

  renderSelection();

  $("scaleText").textContent = state.backdrop
    ? `1 画素 = ${(state.backdrop.m_per_px * 100).toFixed(2)} cm`
    : "下絵がありません";
  $("rotation").value = state.backdrop ? state.backdrop.rotation_deg : 0;
  $("rotation").disabled = !state.backdrop;
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
  $("blockFields").hidden = kind !== "block";
  $("bedFields").hidden = kind !== "bed";
  $("edgeTable").hidden = kind === "bed";
  $("deleteVertexBtn").hidden = kind === "bed";
  $("openScheduleBtn").hidden = kind !== "block" && kind !== "bed";
  $("deleteShapeBtn").textContent = { outline: "外形を削除", zone: "区域を削除", block: "区画を削除", bed: "畝を完全に削除" }[kind];
  $("shapeInfo").textContent = "";

  if (kind === "outline") {
    $("selectionTitle").textContent = "選択中: 圃場の外形";
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
      .map((length, i) => `<tr><td>${i + 1} → ${((i + 1) % points.length) + 1}</td><td>${formatLength(length)}</td></tr>`)
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
  if (mode === "outline" && state.field.outline.length >= 3 && !confirm("外形を描き直します。いまの外形は置き換わります。")) {
    return;
  }
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
  $("hint").textContent = HINTS[mode];
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
  if (actual) {
    applyScale(actual / measured);
  }
  setMode("select");
}

function scaleByArea() {
  if (state.field.outline.length < 3) {
    notify("先に圃場の外形を描いてください。");
    return;
  }
  const actual = askNumber("圃場の実際の面積（㎡）");
  if (actual) {
    applyScale(Math.sqrt(actual / polygonArea(state.field.outline)));
  }
}

function setRotation(degrees) {
  const delta = degrees - state.backdrop.rotation_deg;
  state.backdrop.rotation_deg = degrees;
  queueSave("backdrop");
  persist(() => transformShapes((points) => rotatePoints(points, delta))).then(resetHistory);
  record({ kind: "field.rotation", plan: false, text: "下絵の向きを合わせ直した", after: `${degrees} 度` });
  render();
}

// すき間を指定の距離にする。図形を、すき間の線の向きに動かす
function setGap(gap) {
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

function deleteSelectedShape() {
  if (!state.selected) {
    return;
  }
  const id = state.selected;
  if (id === "outline") {
    if (confirm("圃場の外形を削除します。")) {
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
  if (!confirm(message)) {
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

function blockFromZone(point) {
  const zone = tillableZoneAt(point);
  if (!zone) {
    notify("有効圃場の中をクリックしてください。");
    return;
  }
  if (visibleBlocks().some((block) => block.zone_id === zone.id) && !confirm(`${zoneLabel(zone)}には、すでに区画があります。表示日から、全体を 1 つの区画に設定し直しますか。`)) {
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

function layoutSelectedBlock() {
  const block = state.blocks.find((item) => item.id === state.selected);
  const number = (id) => ($(id).value.trim() === "" ? null : Number($(id).value));
  const width = number("bedWidth");
  const aisle = number("bedAisle");
  const endGap = number("bedEndGap");
  const length = number("bedLength");
  const count = number("bedCount");
  if (!(width > 0) || !(aisle >= 0) || !(endGap >= 0) || (length !== null && !(length > 0)) || (count !== null && !(count >= 1))) {
    notify("畝幅と長さ、本数には 0 より大きい数を、隙間には 0 以上の数を入れてください。");
    return;
  }
  addBedsToBlock(block, {
    angle: edgeAngles(block.shape)[$("bedSide").value],
    width: width / 100,
    aisle: aisle / 100,
    endGap,
    length,
    count: count === null ? null : Math.floor(count),
  });
  render();
}

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

// 区画の畝の番号を、いまの番号の順のまま詰め直す（畝を完全に削除したあと）
function renumberBlock(blockId) {
  renumberBeds(state.beds.filter((bed) => bed.block_id === blockId).sort((a, b) => a.seq - b.seq).map((bed) => bed.id));
}

// 日程の画面から畝を足す。向き、長さ、前後の隙間は、いまある最後の畝に合わせる
function appendBeds(blockId, widthCm, aisleCm, count) {
  const block = state.blocks.find((item) => item.id === blockId);
  const last = state.beds.filter((bed) => bed.block_id === blockId && bedExists(bed)).sort((a, b) => a.seq - b.seq).at(-1);
  const sizes = { width: widthCm / 100, aisle: aisleCm / 100, count };
  if (!last) {
    return addBedsToBlock(block, { ...sizes, angle: edgeAngles(block.shape).long, endGap: 0.5, length: null });
  }
  const [p, q, r] = last.shape;
  const [from, to] = distance(p, q) >= distance(q, r) ? [p, q] : [q, r];
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
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

function removeSelectedBed() {
  removeBed(state.selected);
}

function removeBed(id) {
  const bed = state.beds.find((item) => item.id === id);
  const problem = removalProblem(bed);
  if (problem) {
    notify(problem);
    return;
  }
  if (confirm(`${formatDate(state.viewDate)} に、この畝をなくします。それより前の日を表示すると、畝は残っています。`)) {
    removeBeds([bed]);
    select(null);
  }
}

function removeBlockBeds() {
  const beds = visibleBeds().filter((bed) => bed.block_id === state.selected);
  if (!beds.length || !confirm(`${formatDate(state.viewDate)} に、この区画の畝 ${beds.length} 本をなくします。収穫が終わっていない畝は残します。`)) {
    return;
  }
  const removed = removeBeds(beds);
  render();
  if (removed < beds.length) {
    notify(`${beds.length - removed} 本は、収穫完了予定日が未定か、表示日より後なので残しました。`);
  }
}

// ---- プラン ----
// 圃場の外形と下絵は共通で、区域・区画・畝と日程をプランごとに持つ

function renderPlans() {
  $("schedulePlanName").textContent = state.plan.name;
  $("planSelect").innerHTML = state.plans
    .map((plan) => `<option value="${plan.id}">${escapeHtml(plan.name)}</option>`)
    .join("");
  $("planSelect").value = state.plan.id;
  $("deletePlanBtn").disabled = state.plans.length <= 1;
}

async function loadPlanData(plan) {
  state.plan = plan;
  for (const table of ["zones", "blocks", "beds", "plantings", "works"]) {
    state[table] = await state.store.list(table, plan.id);
  }
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
}

function askPlanName(message, initial) {
  return (prompt(message, initial) || "").trim() || null;
}

function newPlan() {
  const name = askPlanName("新しいプランの名前", `プラン${state.plans.length + 1}`);
  if (!name) {
    return;
  }
  persist(async () => {
    const plan = await state.store.createPlan({ field_id: state.field.id, name });
    state.plans.push(plan);
    record({ kind: "plan.add", plan, text: `プラン「${plan.name}」を作成` });
    await openPlan(plan);
  });
}

function renamePlan() {
  const name = askPlanName("プランの名前", state.plan.name);
  if (!name || name === state.plan.name) {
    return;
  }
  persist(async () => {
    await state.store.renamePlan(state.plan.id, name);
    const was = state.plan.name;
    state.plan.name = name;
    record({ kind: "plan.name", text: "プランの名前を変更", before: was, after: name });
    renderPlans();
  });
}

function copyPlan() {
  const name = askPlanName("コピーしたプランの名前", `${state.plan.name}のコピー`);
  if (!name) {
    return;
  }
  persist(async () => {
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
    record({ kind: "plan.copy", plan, text: `プラン「${state.plan.name}」をコピーして、プラン「${plan.name}」を作成` });
    state.plans.push(plan);
    await openPlan(plan);
  });
}

function deletePlan() {
  if (state.plans.length <= 1 || !confirm(`プラン「${state.plan.name}」を削除します。このプランの区域、区画、畝、日程がすべて消えます。`)) {
    return;
  }
  persist(async () => {
    clearTimeout(saveTimer);
    [...pendingSaves].filter((key) => key.includes(":")).forEach((key) => pendingSaves.delete(key));
    const id = state.plan.id;
    record({ kind: "plan.delete", plan: false, text: `プラン「${state.plan.name}」を削除` });
    await state.store.deletePlan(id);
    state.plans = state.plans.filter((plan) => plan.id !== id);
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

async function loadBackdropFile(file) {
  $("saveStatus").textContent = "画像を保存中…";
  try {
    const path = await state.store.uploadImage(state.field.id, file);
    const url = await state.store.imageUrl(path);
    const size = await imageSize(url);
    state.backdrop = {
      id: crypto.randomUUID(),
      field_id: state.field.id,
      storage_path: path,
      m_per_px: config.defaultMetersPerPixel,
      origin_px: [size[0] / 2, size[1] / 2],
      rotation_deg: 0,
      size,
    };
    state.backdropUrl = url;
    queueSave("backdrop");
    fitView();
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
  } else if (state.mode === "select" && state.selected !== "outline" && target.dataset.shape && target.dataset.shape === state.selected) {
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
  } else if (ARROWS[event.key] && state.mode === "select" && state.selected && state.selected !== "outline") {
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
$("planSelect").addEventListener("change", (event) => {
  persist(() => openPlan(state.plans.find((plan) => plan.id === event.target.value)));
});
$("newPlanBtn").addEventListener("click", newPlan);
$("renamePlanBtn").addEventListener("click", renamePlan);
$("copyPlanBtn").addEventListener("click", copyPlan);
$("deletePlanBtn").addEventListener("click", deletePlan);
$("deleteVertexBtn").addEventListener("click", deleteSelectedVertex);
$("deleteShapeBtn").addEventListener("click", deleteSelectedShape);
$("layoutBedsBtn").addEventListener("click", layoutSelectedBlock);
$("removeBlockBedsBtn").addEventListener("click", removeBlockBeds);
$("removeBedBtn").addEventListener("click", removeSelectedBed);
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
for (const list of ["zoneList", "blockList", "warnings"]) {
  $(list).addEventListener("click", (event) => {
    const item = event.target.closest("[data-shape]");
    if (item) {
      select(item.dataset.shape);
    }
  });
}
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

function showView(view) {
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  $("appView").hidden = view !== "map";
  $("scheduleView").hidden = view !== "schedule";
  $("cropsView").hidden = view !== "crops";
  $("journalView").hidden = view !== "journal";
  if (view === "map") {
    render();
  } else if (view === "schedule") {
    renderSchedule();
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
function openTarget(entry) {
  const status = (text) => {
    $("saveStatus").textContent = text;
  };
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
    let field = await state.store.loadField();
    if (!field) {
      field = await state.store.createField({ name: config.defaultFieldName });
    }
    state.field = field;
    state.plans = await state.store.loadPlans(field.id);
    if (!state.plans.length) {
      state.plans = [await state.store.createPlan({ field_id: field.id, name: "プラン1" })];
    }
    let currentId = null;
    try {
      currentId = localStorage.getItem(CURRENT_PLAN_KEY);
    } catch {
      // 読めなければ先頭のプランを開く
    }
    state.workTypes = await state.store.loadWorkTypes();
    state.crops = await state.store.listAll("crops");
    state.fertilizers = await state.store.listAll("fertilizers");
    await loadPlanData(state.plans.find((plan) => plan.id === currentId) || state.plans[0]);
    state.backdrop = await state.store.loadBackdrop(field.id);
    if (state.backdrop) {
      state.backdropUrl = await state.store.imageUrl(state.backdrop.storage_path);
      state.backdrop.size = await imageSize(state.backdropUrl).catch(() => null);
    }
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
    deleteBed: (id) => {
      state.selected = id;
      deleteSelectedShape();
    },
    setStatus: (text) => ($("saveStatus").textContent = text),
  });
  initCrops({ state, setStatus: (text) => ($("saveStatus").textContent = text) });
  try {
    await initJournal({ state, openTarget, setStatus: (text) => ($("saveStatus").textContent = text) });
  } catch (error) {
    $("saveStatus").textContent = `変更の記録を読み込めませんでした: ${error.message}`;
  }
  initHistory({
    state,
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
    },
  });
  // スマホは作業の確認が主なので、日程から開く
  if (window.matchMedia("(max-width: 800px)").matches) {
    showView("schedule");
  }
}

async function main() {
  if (new URLSearchParams(location.search).has("local")) {
    state.store = createLocalStore();
    $("saveStatus").textContent = "このブラウザーの中だけに保存します";
    await startApp();
    return;
  }

  state.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { db: { schema: "field" } });
  state.store = createSupabaseStore(state.client);

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

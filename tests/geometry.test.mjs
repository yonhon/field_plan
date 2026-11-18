// 図形の計算（app/geometry.js）のテスト。実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bedAngle,
  boundingBox,
  viewAxes,
  centroid,
  crossRange,
  cutSegment,
  edgeAngles,
  edgeLengths,
  gapBetweenPolygons,
  gapToSegment,
  imageToWorld,
  worldToImage,
  anchorBackdrop,
  scaleBackdropAt,
  rotateBackdropAt,
  alignBackdrop,
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
  rotatePoints,
  scalePoints,
  splitPolygon,
} from "../app/geometry.js";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const rect = [[0, 0], [30, 0], [30, 50], [0, 50]];

test("面積と辺の長さ", () => {
  near(polygonArea(rect), 1500);
  near(polygonArea([...rect].reverse()), 1500);
  assert.deepEqual(edgeLengths(rect), [30, 50, 30, 50]);
});

test("重心と内外の判定", () => {
  assert.deepEqual(centroid(rect), [15, 25]);
  assert.equal(pointInPolygon([1, 1], rect), true);
  assert.equal(pointInPolygon([32, 1], rect), false);
});

test("面積で縮尺を合わせると、面積が指定の値になる", () => {
  const factor = Math.sqrt(2000 / polygonArea(rect));
  near(polygonArea(scalePoints(rect, factor)), 2000);
});

test("回転は時計回りで、面積を変えない", () => {
  const [[x, y]] = rotatePoints([[0, 10]], 90);
  near(x, 10);
  near(y, 0);
  near(polygonArea(rotatePoints(rect, 25)), 1500);
});

test("下絵の画素から圃場の座標へ", () => {
  const backdrop = { origin_px: [100, 100], m_per_px: 0.5, rotation_deg: 0 };
  // 画像の右は東、画像の下は南
  assert.deepEqual(imageToWorld(backdrop, [120, 100]), [10, -0]);
  assert.deepEqual(imageToWorld(backdrop, [100, 120]), [0, -10]);
  // 画像の上が東を向いている（北から 90 度）とき、画像の上の点は東にある
  const [x, y] = imageToWorld({ ...backdrop, rotation_deg: 90 }, [100, 80]);
  near(x, 10);
  near(y, 0);
});

test("四角形は、いちばん近い辺に平行になる", () => {
  // 25 度傾いた圃場。下の辺の近くでは、その辺の向きになる
  const tilted = rotatePoints(rect, -25);
  const angle = nearestEdgeAngle(rotatePoints([[15, 1]], -25)[0], tilted);
  near(angle, (25 * Math.PI) / 180);

  const sized = rectCentered([5, 5], 3, 2, angle);
  const lengths = edgeLengths(sized);
  near(lengths[0], 3);
  near(lengths[1], 2);
  near(polygonArea(sized), 6);
  near(Math.atan2(sized[1][1] - sized[0][1], sized[1][0] - sized[0][0]), angle);

  const dragged = rectFromDiagonal([0, 0], [4, 3], 0);
  assert.deepEqual(dragged, [[0, 0], [4, 0], [4, 3], [0, 3]]);
  near(polygonArea(rectFromDiagonal([1, 1], [9, 4], angle)), edgeLengths(rectFromDiagonal([1, 1], [9, 4], angle)).slice(0, 2).reduce((x, y) => x * y));
});

test("区域と外形の辺、区域どうしのすき間", () => {
  const zone = [[2, 3], [12, 3], [12, 8], [2, 8]];
  // 平行な辺までは、辺の中ほどで測る
  const bottom = gapToSegment(zone, rect[0], rect[1]);
  near(bottom.distance, 3);
  assert.deepEqual(bottom.from, [7, 3]);
  assert.deepEqual(bottom.to, [7, 0]);
  near(gapToSegment(zone, rect[3], rect[0]).distance, 2);

  const neighbour = [[15, 3], [20, 3], [20, 8], [15, 8]];
  const between = gapBetweenPolygons(zone, neighbour);
  near(between.distance, 3);
  assert.deepEqual(between.from, [12, 5.5]);

  // 小さい区域が大きい区域の辺の途中に向き合っていても、最短の距離になる
  const small = [[13, 5], [14, 5], [14, 6], [13, 6]];
  near(gapBetweenPolygons(zone, small).distance, 1);
  near(gapBetweenPolygons(small, zone).distance, 1);

  // 傾いていても同じ
  const tilt = (points) => rotatePoints(points, -25);
  near(gapBetweenPolygons(tilt(zone), tilt(neighbour)).distance, 3);
});

test("有効圃場を線で分ける", () => {
  const zone = [[0, 0], [26, 0], [26, 20], [0, 20]];
  const { long, short } = edgeAngles(zone);
  near(long, 0);
  near(short, Math.PI / 2);

  // 短い辺に平行な線で、左の端から 10 m のところを分ける
  const range = crossRange(zone, [10, 5], short);
  near(Math.min(range.at - range.min, range.max - range.at), 10);
  const [first, second] = splitPolygon(zone, [10, 5], short);
  near(polygonArea(first) + polygonArea(second), 520);
  assert.deepEqual([polygonArea(first), polygonArea(second)].sort((a, b) => a - b), [200, 320]);
  assert.deepEqual(cutSegment(zone, [10, 5], short).map((p) => Math.round(p[0] * 1e6) / 1e6), [10, 10]);

  // 端より外では分けられない
  assert.equal(cutSegment(zone, [30, 5], short), null);
  // 分けた 2 つは辺を共有するだけで、重なってはいない
  assert.equal(polygonsOverlap(first, second), false);
  assert.equal(polygonsOverlap(first, zone), true);
  assert.equal(polygonInside(first, zone), true);
  assert.equal(polygonInside([[20, 5], [30, 5], [30, 8], [20, 8]], zone), false);

  // 傾いていても面積は変わらない
  const tilted = rotatePoints(zone, -25);
  const parts = splitPolygon(tilted, rotatePoints([[10, 5]], -25)[0], edgeAngles(tilted).short);
  near(polygonArea(parts[0]) + polygonArea(parts[1]), 520);
});

test("区画の中に畝を並べる", () => {
  const block = [[0, 0], [10, 0], [10, 20], [0, 20]];
  const angle = edgeAngles(block).long; // 長い辺（20 m）に沿う
  const options = { angle, width: 0.7, aisle: 0.6, endGap: 0.5 };

  // 入るだけ: 最初に 0.6 m あけ、1.3 m ごとに並ぶ。10 m の幅には 7 本
  const full = layoutBeds(block, options);
  assert.equal(full.strips, 7);
  assert.equal(full.beds.length, 7);
  assert.equal(full.outside, 0);
  const size = rectSize(full.beds[0]);
  near(size.length, 19);
  assert.ok(Math.abs(size.width - 0.7) < 1e-9);
  assert.ok(full.beds.every((bed, i) => i === 0 || !polygonsOverlap(bed, full.beds[i - 1])));

  // 本数を決めて並べ、あとから幅の違う畝を続きに足す
  const first = layoutBeds(block, { ...options, count: 3 });
  assert.equal(first.beds.length, 3);
  const more = layoutBeds(block, { ...options, width: 1.0, count: 2, existing: first.beds });
  assert.equal(more.beds.length, 2);
  assert.ok(!polygonsOverlap(more.beds[0], first.beds[2]));
  assert.ok(Math.abs(gapBetweenPolygons(more.beds[0], first.beds[2]).distance - 0.6) < 1e-9);

  // 畝の長さを決めると、前後に隙間をあけて縦にも並ぶ: (19 + 0.5) / (6 + 0.5) = 3 つ
  const short = layoutBeds(block, { ...options, length: 6, count: 2 });
  assert.equal(short.strips, 2);
  assert.equal(short.beds.length, 6);
  near(rectSize(short.beds[0]).length, 6);

  // 前と後ろの隙間が違う（畝が片側に寄っている）: 前 3.9 m・後ろ 0.5 m なら、長さ 15.6 m の畝が入る。
  // 前の隙間を後ろにも取ると、20 - 3.9 * 2 = 12.2 m しかなく入らない
  const shifted = layoutBeds(block, { ...options, endGap: 3.9, tailGap: 0.5, length: 15.6, count: 1 });
  assert.equal(shifted.beds.length, 1);
  assert.equal(shifted.outside, 0);
  near(rectSize(shifted.beds[0]).length, 15.6);
  assert.equal(layoutBeds(block, { ...options, endGap: 3.9, length: 15.6, count: 1 }).beds.length, 0);

  // 入らない寸法では 1 本も並ばない
  assert.equal(layoutBeds(block, { ...options, width: 12 }).beds.length, 0);
});

// 以下は、Mutation testing（stryker.config.json）で、テストが気づかなかった書き換えを確かめる。
// 軸に平行な長方形だけでは、x と y の取り違えや符号の誤りに気づけないので、傾いた図形と、L 字の図形も使う

const nearPoints = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((point, i) => point.forEach((value, k) => assert.ok(Math.abs(value - expected[i][k]) < 1e-6, `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)));
};

test("重心: L 字の図形では、頂点の平均ではなく面積の重心。つぶれた図形は頂点の平均", () => {
  // 4×1 の長方形（重心 (2, 0.5)）と 1×3 の長方形（重心 (0.5, 2.5)）を合わせた L 字。面積 7
  const ell = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
  nearPoints([centroid(ell)], [[9.5 / 7, 9.5 / 7]]);
  nearPoints([centroid([...ell].reverse())], [[9.5 / 7, 9.5 / 7]]);
  // 一直線に並んだ点
  nearPoints([centroid([[1, 1], [3, 1], [5, 1]])], [[3, 1]]);
  assert.deepEqual(centroid([]), [0, 0]);
});

test("内外の判定と外接する長方形: 斜めの辺", () => {
  const triangle = [[0, 0], [4, 0], [0, 4]];
  assert.equal(pointInPolygon([1, 1], triangle), true);
  assert.equal(pointInPolygon([1.9, 2], triangle), true);
  assert.equal(pointInPolygon([2.1, 2], triangle), false);
  assert.equal(pointInPolygon([-0.1, 2], triangle), false);
  assert.deepEqual(boundingBox([[1, 5], [-2, 3], [4, -1]]), { minX: -2, maxX: 4, minY: -1, maxY: 5 });
});

test("すき間: 線分の端が辺の途中に向き合うとき。ほぼ同じ近さの頂点は、中ほどで測る", () => {
  const square = [[0, 0], [2, 0], [2, 2], [0, 2]];
  // 上の辺の途中（1.5, 2）に、縦の線分の端（1.5, 3）が向き合う
  const facing = gapToSegment(square, [1.5, 3], [1.5, 5]);
  near(facing.distance, 1);
  nearPoints([facing.from, facing.to], [[1.5, 2], [1.5, 3]]);
  // 斜めの線分は、いちばん近い頂点で測る
  const corner = gapToSegment(square, [3, 3], [5, 5]);
  near(corner.distance, Math.SQRT2);
  nearPoints([corner.from, corner.to], [[2, 2], [3, 3]]);
  assert.ok(!corner.parallel);
  // 近さの差が 5 mm より小さい頂点どうしは、同じ近さとみなし、その中ほどで測る
  const almost = gapToSegment([[0, 0], [2, 0], [2, 2], [0, 2.003]], [-1, 3], [3, 3]);
  assert.equal(almost.parallel, true);
  nearPoints([almost.from, almost.to], [[1, 2.0015], [1, 3]]);
  // 差が 5 mm より大きければ、近いほうの頂点で測る
  const apart = gapToSegment([[0, 0], [2, 0], [2, 2], [0, 2.01]], [-1, 3], [3, 3]);
  assert.ok(!apart.parallel);
  nearPoints([apart.from, apart.to], [[0, 2.01], [0, 3]]);
  // 多角形どうしは、同じ距離なら、平行な辺どうしで測ったほうを選ぶ（先に見つかった角どうしではなく）
  const between = gapBetweenPolygons(square, [[3, 0], [5, 0], [5, 2], [3, 2]]);
  near(between.distance, 1);
  assert.equal(between.parallel, true);
  nearPoints([between.from, between.to], [[2, 1], [3, 1]]);
});

test("線で分ける: 傾いていても分けた面積は同じ。頂点を通る線と、辺に重なる線", () => {
  const zone = [[0, 0], [26, 0], [26, 20], [0, 20]];
  const tilted = rotatePoints(zone, -25);
  const parts = splitPolygon(tilted, rotatePoints([[10, 5]], -25)[0], edgeAngles(tilted).short);
  assert.deepEqual(parts.map((part) => Math.round(polygonArea(part))).sort((a, b) => a - b), [200, 320]);
  // 対角線で分けると、三角形が 2 つ（対角線の両端の頂点は、両方に入る）
  const square = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const halves = splitPolygon(square, [0, 0], Math.PI / 4);
  assert.deepEqual(halves.map((part) => part.length), [3, 3]);
  halves.forEach((part) => near(polygonArea(part), 8));
  // 辺に重なる線では分けられない。つぶれた側は null
  const edge = splitPolygon(square, [4, 0], Math.PI / 2);
  assert.equal(edge.filter(Boolean).length, 1);
  near(polygonArea(edge.find(Boolean)), 16);
});

test("面の重なり: 中に収まる、十字に交わる、少しだけ重なる", () => {
  const big = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const inner = [[4, 4], [6, 4], [6, 6], [4, 6]];
  assert.equal(polygonsOverlap(inner, big), true);
  assert.equal(polygonsOverlap(big, inner), true);
  // 頂点はどれも相手の中にないが、辺が交わる
  const across = [[0, 4], [10, 4], [10, 6], [0, 6]];
  const down = [[4, -2], [6, -2], [6, 12], [4, 12]];
  assert.equal(polygonsOverlap(across, down), true);
  // 5 cm だけ重なる（辺を共有するだけの図形を重なりと数えないための寄せ幅は 2 cm）
  assert.equal(polygonsOverlap(big, [[9.95, 0], [20, 0], [20, 10], [9.95, 10]]), true);
  // 離れている、角が触れているだけ
  assert.equal(polygonsOverlap(big, [[11, 0], [20, 0], [20, 10], [11, 10]]), false);
  assert.equal(polygonsOverlap(big, [[10, 10], [20, 10], [20, 20], [10, 20]]), false);
});

test("畝を並べる位置: 区画の端から、隙間をあけて順に置く。傾いていても同じ", () => {
  // 原点から離れた 10 m × 20 m の区画。長い辺（南北）に沿って、東の端から西へ並ぶ
  const block = [[5, 3], [15, 3], [15, 23], [5, 23]];
  const options = { angle: edgeAngles(block).long, width: 0.7, aisle: 0.6, endGap: 0.5, count: 2 };
  const expected = [
    [[14.4, 3.5], [14.4, 22.5], [13.7, 22.5], [13.7, 3.5]],
    [[13.1, 3.5], [13.1, 22.5], [12.4, 22.5], [12.4, 3.5]],
  ];
  const full = layoutBeds(block, options);
  full.beds.forEach((bed, i) => nearPoints(bed, expected[i]));
  // 長さ 6 m なら、前と、縦に並ぶ畝どうしに 0.5 m あけて 3 つ
  const short = layoutBeds(block, { ...options, length: 6, count: 1 });
  short.beds.forEach((bed, i) => nearPoints(bed, [[14.4, 3.5 + 6.5 * i], [14.4, 9.5 + 6.5 * i], [13.7, 9.5 + 6.5 * i], [13.7, 3.5 + 6.5 * i]]));
  // 25 度傾けた区画に並べ、戻すと同じ位置
  const tilted = rotatePoints(block, -25);
  const turned = layoutBeds(tilted, { ...options, angle: edgeAngles(tilted).long });
  assert.equal(turned.outside, 0);
  turned.beds.forEach((bed, i) => nearPoints(rotatePoints(bed, 25), expected[i]));
});

test("畝を並べる: 幅ちょうどまで入れる。入らない寸法は並べない。区画からはみ出した数", () => {
  // 東西に長い 20 m × 10 m。幅 1 m・隙間 1 m なら、y = 1, 3, 5, 7, 9 から 5 本（最後の畝は区画の端にちょうど届く）
  const block = [[0, 0], [20, 0], [20, 10], [0, 10]];
  const options = { angle: 0, width: 1, aisle: 1, endGap: 0.5 };
  assert.equal(layoutBeds(block, options).strips, 5);
  // 前後の隙間で長さがなくなる、畝が長すぎる、畝幅が 0
  assert.equal(layoutBeds(block, { ...options, endGap: 10 }).beds.length, 0);
  assert.equal(layoutBeds(block, { ...options, length: 25 }).beds.length, 0);
  assert.equal(layoutBeds(block, { ...options, width: 0 }).beds.length, 0);
  // 北の辺が斜め（西の端は 5 m、東の端は 10 m）。y = 5 より北の畝は、西の端がはみ出す
  const trapezoid = [[0, 0], [20, 0], [20, 10], [0, 5]];
  const placed = layoutBeds(trapezoid, options);
  assert.equal(placed.beds.length, 5);
  assert.equal(placed.outside, 3);
});

const nearPair = (actual, expected) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual} != ${expected}`));

test("viewAxes: 南から見る視点では、南北の畝の手前は南、左は西", () => {
  // 視点 1 は北を見る（南に立つ）、視点 2 は東を見る（西に立つ）
  for (const angle of [Math.PI / 2, -Math.PI / 2]) {
    const { d, v } = viewAxes(angle, [90, 0]);
    nearPair(d, [0, 1]);
    nearPair(v, [1, 0]);
  }
});

test("viewAxes: 視点 1 と直角の畝は、視点 2 から見る", () => {
  for (const angle of [0, Math.PI]) {
    const { d, v } = viewAxes(angle, [90, 0]);
    nearPair(d, [1, 0]); // 西に立って東を見る
    nearPair(v, [0, -1]); // 左が北、右が南
  }
  // 視点 2 を東側に変えると、手前と左右が入れ替わる
  nearPair(viewAxes(0, [90, 180]).d, [-1, 0]);
  nearPair(viewAxes(0, [90, 180]).v, [0, 1]);
});

test("viewAxes: 決めていないときは、南と西から見る", () => {
  nearPair(viewAxes(Math.PI / 2, null).d, [0, 1]);
  nearPair(viewAxes(0, undefined).d, [1, 0]);
});

test("bedAngle: 長い辺の向き", () => {
  const angle = bedAngle([[0, 0], [1, 0], [1, 10], [0, 10]]);
  assert.ok(Math.abs(Math.abs(Math.sin(angle)) - 1) < 1e-9);
});

test("worldToImage は imageToWorld の逆", () => {
  const backdrop = { origin_px: [300, 200], m_per_px: 0.05, rotation_deg: 23 };
  for (const pixel of [[0, 0], [300, 200], [812, 47]]) {
    nearPair(worldToImage(backdrop, imageToWorld(backdrop, pixel)), pixel);
  }
});

test("下絵だけを動かす: 平行移動、縮尺、回転", () => {
  const backdrop = { origin_px: [100, 100], m_per_px: 0.1, rotation_deg: 10 };
  // 画素 (150, 80) を、圃場の (3, 4) に置く
  nearPair(imageToWorld(anchorBackdrop(backdrop, [150, 80], [3, 4]), [150, 80]), [3, 4]);
  // 縮尺を 2 倍にしても、(5, 5) にある画素は動かない。ほかの画素は (5, 5) から 2 倍離れる
  const point = [5, 5];
  const pixel = worldToImage(backdrop, point);
  const scaled = scaleBackdropAt(backdrop, 2, point);
  near(scaled.m_per_px, 0.2);
  nearPair(imageToWorld(scaled, pixel), point);
  const far = imageToWorld(backdrop, [0, 0]);
  const farScaled = imageToWorld(scaled, [0, 0]);
  nearPair([farScaled[0] - point[0], farScaled[1] - point[1]], [2 * (far[0] - point[0]), 2 * (far[1] - point[1])]);
  // 回しても、(5, 5) にある画素は動かない
  const turned = rotateBackdropAt(backdrop, 30, point);
  near(turned.rotation_deg, 40);
  nearPair(imageToWorld(turned, pixel), point);
});

test("alignBackdrop: 目印を図形の点に合わせる。大きさは変えない", () => {
  const backdrop = { origin_px: [0, 0], m_per_px: 0.1, rotation_deg: 0 };
  // 1 組: 平行移動だけ
  const moved = alignBackdrop(backdrop, [[[1, 1], [4, 5]]]);
  assert.equal(moved.ratio, null);
  nearPair(imageToWorld(moved.backdrop, worldToImage(backdrop, [1, 1])), [4, 5]);
  near(moved.backdrop.rotation_deg, 0);
  // 2 組: 下絵の上の東向き 10 m を、図形の上の北向き 12 m に合わせる（反時計回りに 90 度 = 時計回りに -90 度）
  const pixel1 = worldToImage(backdrop, [0, 0]);
  const pixel2 = worldToImage(backdrop, [10, 0]);
  const aligned = alignBackdrop(backdrop, [[[0, 0], [2, 2]], [[10, 0], [2, 14]]]);
  near(aligned.backdrop.rotation_deg, -90);
  near(aligned.backdrop.m_per_px, 0.1);
  near(aligned.ratio, 1.2);
  nearPair(imageToWorld(aligned.backdrop, pixel1), [2, 2]);
  // 2 つ目の目印は、図形の点の向きに、下絵の大きさのまま（10 m）来る
  nearPair(imageToWorld(aligned.backdrop, pixel2), [2, 12]);
});

test("inheritBackdrop: 解像度だけを変えた画像に、縮尺と基準点を引き継ぐ", () => {
  const previous = { origin_px: [1130.5, 1582.5], m_per_px: 0.1, rotation_deg: 3 };
  const next = inheritBackdrop(previous, [2261, 3165], [1024, 1433]);
  near(next.rotation_deg, 3);
  assert.ok(Math.abs(next.m_per_px - 0.22083) < 1e-4);
  nearPair(next.origin_px, [512, 716.5]);
  // 同じ画素が、同じ圃場の座標に来る
  const corner = imageToWorld(previous, [2261, 0]);
  const after = imageToWorld({ ...previous, ...next }, [1024, 0]);
  assert.ok(Math.abs(corner[0] - after[0]) < 0.1 && Math.abs(corner[1] - after[1]) < 0.1);
  // 縦横の比が違えば、同じ範囲とはみなさない
  assert.equal(inheritBackdrop(previous, [2261, 3165], [768, 1024]), null);
});

test("圃場の外形は、離れた部分の並び。前の形（多角形 1 つ）も読める", () => {
  const far = [[100, 0], [110, 0], [110, 10], [100, 10]];
  assert.deepEqual(outlineParts([]), []);
  assert.deepEqual(outlineParts(null), []);
  assert.deepEqual(outlineParts(rect), [rect]);
  assert.deepEqual(outlineParts([rect, far]), [rect, far]);
  // 3 点に満たない部分は捨てる
  assert.deepEqual(outlineParts([rect, [[0, 0], [1, 1]]]), [rect]);
  near(outlineArea(rect), 1500);
  near(outlineArea([rect, far]), 1600);
  near(outlineArea([]), 0);
});

test("いちばん近い辺の向きは、離れた部分の辺からも探す", () => {
  const tilted = [[100, 0], [110, 10], [100, 20], [90, 10]];
  near(nearestEdgeAngleOf([1, 25], [rect, tilted]), -Math.PI / 2); // rect の西の辺（北から南へ）
  near(nearestEdgeAngleOf([106, 4], [rect, tilted]), Math.PI / 4);
  near(nearestEdgeAngleOf([1, 25], []), 0);
});

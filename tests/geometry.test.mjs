// 図形の計算（app/geometry.js）のテスト。実行: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bedAngle,
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

  // 入らない寸法では 1 本も並ばない
  assert.equal(layoutBeds(block, { ...options, width: 12 }).beds.length, 0);
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

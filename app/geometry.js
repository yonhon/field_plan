// 多角形の計算。点は [x, y]（メートル。x は東、y は北）。

export function distance(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function edgeLengths(points) {
  return points.map((point, i) => distance(point, points[(i + 1) % points.length]));
}

// 面積の重心。つぶれた多角形では頂点の平均を返す
export function centroid(points) {
  let cross = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const f = x1 * y2 - x2 * y1;
    cross += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(cross) < 1e-9) {
    const n = points.length || 1;
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * cross), cy / (3 * cross)];
}

export function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function scalePoints(points, factor) {
  return points.map(([x, y]) => [x * factor, y * factor]);
}

// 原点のまわりに時計回りに回す（北が上の図で見た向き）
export function rotatePoints(points, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return points.map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos]);
}

export function boundingBox(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// 下絵の画素を圃場の座標に直す。rotation_deg は、画像の上が北から時計回りに何度ずれているか
export function imageToWorld(backdrop, pixel) {
  const dx = (pixel[0] - backdrop.origin_px[0]) * backdrop.m_per_px;
  const dy = (pixel[1] - backdrop.origin_px[1]) * backdrop.m_per_px;
  const rad = (backdrop.rotation_deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [dx * cos - dy * sin, -(dx * sin + dy * cos)];
}

export function translatePoints(points, dx, dy) {
  return points.map(([x, y]) => [x + dx, y + dy]);
}

function closestPointOnSegment(point, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq ? Math.max(0, Math.min(1, ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby) / lengthSq)) : 0;
  return [a[0] + abx * t, a[1] + aby * t];
}

function distanceToSegment(point, a, b) {
  return distance(point, closestPointOnSegment(point, a, b));
}

// 多角形と線分のすき間。from は多角形の側、to は線分の側のいちばん近い点。
// 辺どうしが平行で、同じ近さの頂点がいくつもあるときは、その中ほどで測る
export function gapToSegment(polygon, a, b) {
  const TIE = 0.005;
  let best = { distance: Infinity, from: null, to: null };
  const near = [];
  for (const vertex of polygon) {
    const d = distanceToSegment(vertex, a, b);
    if (d < best.distance - TIE) {
      near.length = 0;
    }
    if (d < best.distance + TIE) {
      near.push(vertex);
      if (d < best.distance) {
        best = { distance: d, from: vertex, to: closestPointOnSegment(vertex, a, b) };
      }
    }
  }
  if (near.length > 1) {
    const from = [near.reduce((sum, p) => sum + p[0], 0) / near.length, near.reduce((sum, p) => sum + p[1], 0) / near.length];
    const to = closestPointOnSegment(from, a, b);
    best = { distance: distance(from, to), from, to, parallel: true };
  }
  // 線分の端のほうが近い場合（多角形の辺の途中に、線分の端が向き合っている）
  for (const end of [a, b]) {
    for (let i = 0; i < polygon.length; i += 1) {
      const from = closestPointOnSegment(end, polygon[i], polygon[(i + 1) % polygon.length]);
      const d = distance(end, from);
      if (d < best.distance - TIE) {
        best = { distance: d, from, to: end };
      }
    }
  }
  return best;
}

// 多角形どうしのすき間。from は polygon の側、to は other の側
export function gapBetweenPolygons(polygon, other) {
  let best = { distance: Infinity, from: null, to: null };
  for (let i = 0; i < other.length; i += 1) {
    const gap = gapToSegment(polygon, other[i], other[(i + 1) % other.length]);
    // 同じ距離なら、平行な辺どうしで測ったほうを選ぶ
    if (gap.distance < best.distance - 0.005 || (gap.distance < best.distance + 0.005 && gap.parallel && !best.parallel)) {
      best = gap;
    }
  }
  return best;
}

// 点にいちばん近い辺の向き（ラジアン）。四角形をその辺に平行に置くために使う。多角形がなければ 0
export function nearestEdgeAngle(point, polygon) {
  let nearest = Infinity;
  let angle = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const d = distanceToSegment(point, a, b);
    if (d < nearest) {
      nearest = d;
      angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  return angle;
}

// 対角の 2 点から、angle の向きに辺をそろえた四角形を作る
export function rectFromDiagonal(start, end, angle) {
  const u = [Math.cos(angle), Math.sin(angle)];
  const v = [-u[1], u[0]];
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const along = dx * u[0] + dy * u[1];
  const depth = dx * v[0] + dy * v[1];
  return [
    start,
    [start[0] + along * u[0], start[1] + along * u[1]],
    end,
    [start[0] + depth * v[0], start[1] + depth * v[1]],
  ];
}

// 中心と寸法から四角形を作る。along は angle の向きの長さ、depth はそれと直角の長さ
export function rectCentered(center, along, depth, angle) {
  const u = [(Math.cos(angle) * along) / 2, (Math.sin(angle) * along) / 2];
  const v = [(-Math.sin(angle) * depth) / 2, (Math.cos(angle) * depth) / 2];
  return [
    [center[0] - u[0] - v[0], center[1] - u[1] - v[1]],
    [center[0] + u[0] - v[0], center[1] + u[1] - v[1]],
    [center[0] + u[0] + v[0], center[1] + u[1] + v[1]],
    [center[0] - u[0] + v[0], center[1] - u[1] + v[1]],
  ];
}

// ---- 耕起対象区画と畝 ----

const EPS = 1e-9;

function frame(angle) {
  const u = [Math.cos(angle), Math.sin(angle)];
  return { u, v: [-u[1], u[0]] };
}

// 多角形のいちばん長い辺の向き（long）と、その隣の辺の向き（short）。長方形なら直角になる
export function edgeAngles(polygon) {
  const lengths = edgeLengths(polygon);
  const i = lengths.indexOf(Math.max(...lengths));
  const angleOf = (k) => {
    const a = polygon[k % polygon.length];
    const b = polygon[(k + 1) % polygon.length];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  return { long: angleOf(i), short: angleOf(i + 1) };
}

// angle の向きの直線から測った、多角形の手前の端と奥の端、点の位置（直線に直角な向きの座標）
export function crossRange(polygon, point, angle) {
  const { v } = frame(angle);
  const along = (p) => p[0] * v[0] + p[1] * v[1];
  const values = polygon.map(along);
  return { min: Math.min(...values), max: Math.max(...values), at: along(point), normal: v };
}

// 点 point を通る angle の向きの直線で、多角形を 2 つに分ける（凸の多角形を想定）。
// 片方がつぶれるときは、その側が null になる
export function splitPolygon(polygon, point, angle) {
  const { v } = frame(angle);
  const side = (p) => (p[0] - point[0]) * v[0] + (p[1] - point[1]) * v[1];
  const parts = [[], []];
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    const sa = side(a);
    const sb = side(b);
    if (sa >= -EPS) {
      parts[0].push(a);
    }
    if (sa <= EPS) {
      parts[1].push(a);
    }
    if ((sa > EPS && sb < -EPS) || (sa < -EPS && sb > EPS)) {
      const t = sa / (sa - sb);
      const cut = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      parts[0].push(cut);
      parts[1].push(cut);
    }
  });
  return parts.map((part) => (part.length >= 3 && polygonArea(part) > 1e-4 ? part : null));
}

// 分ける線が多角形を横切る区間の両端。横切らなければ null
export function cutSegment(polygon, point, angle) {
  const [first, second] = splitPolygon(polygon, point, angle);
  if (!first || !second) {
    return null;
  }
  const shared = first.filter((p) => second.some((q) => distance(p, q) < 1e-6));
  return shared.length >= 2 ? [shared[0], shared[shared.length - 1]] : null;
}

// 頂点を重心のほうへ少し寄せる。辺を共有しているだけの図形を「重なり」と数えないために使う
function shrink(polygon, by = 0.02) {
  const center = centroid(polygon);
  return polygon.map((p) => {
    const d = distance(p, center) || 1;
    const t = Math.min(by / d, 0.5);
    return [p[0] + (center[0] - p[0]) * t, p[1] + (center[1] - p[1]) * t];
  });
}

function segmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

// 2 つの多角形が面で重なっているか。辺や角が触れているだけなら false
export function polygonsOverlap(first, second) {
  const a = shrink(first);
  const b = shrink(second);
  if (a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a))) {
    return true;
  }
  return a.some((p, i) => b.some((q, j) => segmentsCross(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
}

// inner が outer の中に収まっているか（辺の上は中とみなす）
export function polygonInside(inner, outer) {
  return shrink(inner).every((p) => pointInPolygon(p, outer));
}

// 区画の中に、畝の四角形を並べる。
//   angle   畝の長い辺の向き
//   width   畝幅、aisle 左右の隙間、endGap 前後の隙間、length 畝の長さ（null なら入るだけ）
//   count   並べる本数（null なら入るだけ）
//   existing いまある畝。その続きから並べる
// 戻り値の strips は並べた本数（列の数）、outside は区画からはみ出した畝の数
export function layoutBeds(block, { angle, width, aisle, endGap, length = null, count = null, existing = [] }) {
  const { u, v } = frame(angle);
  const pu = (p) => p[0] * u[0] + p[1] * u[1];
  const pv = (p) => p[0] * v[0] + p[1] * v[1];
  const toWorld = (a, b) => [a * u[0] + b * v[0], a * u[1] + b * v[1]];
  const us = block.map(pu);
  const vs = block.map(pv);
  const u0 = Math.min(...us);
  const v1 = Math.max(...vs);
  const room = Math.max(...us) - u0 - endGap * 2;
  const bedLength = length ?? room;
  const perStrip = length ? Math.floor((room + endGap + 1e-6) / (length + endGap)) : 1;
  const beds = [];
  let strips = 0;
  if (bedLength <= 0 || perStrip < 1 || width <= 0) {
    return { beds, strips, outside: 0 };
  }
  let cursor = Math.min(...vs) + aisle;
  if (existing.length) {
    cursor = Math.max(...existing.flatMap((bed) => bed.map(pv))) + aisle;
  }
  while ((count === null || strips < count) && cursor + width <= v1 + 1e-6) {
    for (let j = 0; j < perStrip; j += 1) {
      const start = u0 + endGap + j * (bedLength + endGap);
      beds.push([
        toWorld(start, cursor),
        toWorld(start + bedLength, cursor),
        toWorld(start + bedLength, cursor + width),
        toWorld(start, cursor + width),
      ]);
    }
    strips += 1;
    cursor += width + aisle;
  }
  return { beds, strips, outside: beds.filter((bed) => !polygonInside(bed, block)).length };
}

// 四角形の畝の、長い辺と短い辺の長さ
export function rectSize(points) {
  const lengths = edgeLengths(points);
  return { length: Math.max(lengths[0], lengths[1]), width: Math.min(lengths[0], lengths[1]) };
}

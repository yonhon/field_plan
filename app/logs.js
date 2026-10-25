// 作業の記録の計算。画面（log-view.js）とテストから使う。
// 記録はプランではなく圃場に付け、実際に使うプランの区画・畝・作付・作業へは ID でつなぐ。
import { bedAngle, centroid, crossRange, polygonArea, rectSize } from "./geometry.js";
import { existsOn, worksRange } from "./schedule.js";

const bySeq = (a, b) => a.seq - b.seq;

// 畝＋通路の面積（㎡）。畝の長さ ×（畝幅＋両隣との隙間の半分ずつ）。
// 端の畝は、区画の端までの隙間を全部持つ。こうすると、区画の中の畝の面積を足すと区画の面積とほぼ同じになる。
// beds は同じ区画の、同じ日にある畝。返り値は 畝の ID → 面積
export function bedAreas(block, beds) {
  const areas = new Map();
  if (!beds.length) {
    return areas;
  }
  const angle = bedAngle(beds[0].shape);
  const items = beds
    .map((bed) => {
      const range = crossRange(bed.shape, centroid(bed.shape), angle);
      return { bed, min: range.min, max: range.max, length: rectSize(bed.shape).length };
    })
    .sort((a, b) => a.min - b.min);
  const edge = crossRange(block.shape, centroid(block.shape), angle);
  items.forEach((item, i) => {
    const before = i ? (item.min - items[i - 1].max) / 2 : item.min - edge.min;
    const after = i < items.length - 1 ? (items[i + 1].min - item.max) / 2 : edge.max - item.max;
    areas.set(item.bed.id, item.length * (item.max - item.min + Math.max(before, 0) + Math.max(after, 0)));
  });
  return areas;
}

// その日に畝にある作付。いまの作付か、次に来る作付。収穫を終えた作付（最後の作業の終了日が前）は選ばない
export function plantingOnDate(plantings, works, date) {
  return (
    [...plantings].sort(bySeq).find((planting) => {
      const range = worksRange(works.filter((work) => work.planting_id === planting.id));
      return !range || range.end >= date;
    }) || null
  );
}

const cropMulch = (planting, crops) => planting.mulch ?? crops.find((crop) => crop.id === planting.crop_id)?.mulch ?? false;

// 記録の対象にできるもの。その日にある畝の作付を、品目ごとにまとめる（同じ品目でも、マルチの有無で分ける）。
// 区画の作業のために、その日にある区画も返す
export function targetChoices({ blocks, beds, plantings, works, crops = [] }, date) {
  const liveBlocks = blocks.filter((block) => existsOn(block.start_date, block.end_date, date));
  const groups = new Map();
  for (const block of liveBlocks) {
    const live = beds.filter((bed) => bed.block_id === block.id && existsOn(bed.start_date, bed.removed_on, date)).sort(bySeq);
    const areas = bedAreas(block, live);
    for (const bed of live) {
      const planting = plantingOnDate(
        plantings.filter((item) => item.bed_id === bed.id),
        works,
        date
      );
      if (!planting) {
        continue;
      }
      const cropName = planting.crop_name || "（品目なし）";
      const mulch = cropMulch(planting, crops);
      const key = `${cropName}|${mulch ? 1 : 0}`;
      if (!groups.has(key)) {
        groups.set(key, { key, name: cropName, mulch, items: [] });
      }
      groups.get(key).items.push({
        planting_id: planting.id,
        bed_id: bed.id,
        block_id: block.id,
        label: `${block.name} 畝${bed.seq} ${planting.crop_name}`.trim(),
        crop_name: planting.crop_name,
        area_m2: areas.get(bed.id),
      });
    }
  }
  return {
    crops: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, "ja") || a.mulch - b.mulch),
    blocks: liveBlocks.map((block) => ({
      block_id: block.id,
      label: block.name,
      crop_name: "",
      area_m2: polygonArea(block.shape),
    })),
  };
}

// 計画の作業の実績。記録から、開始（いちばん早い日）と終了（finishes の付いた記録のいちばん遅い日）を求める。
// 返り値は 作業の ID → { start, end }。end が null なら、まだ終わっていない
export function workActuals(logs) {
  const actuals = new Map();
  for (const log of logs) {
    for (const target of log.targets || []) {
      if (!target.work_id) {
        continue;
      }
      const actual = actuals.get(target.work_id) || { start: log.date, end: null };
      if (log.date < actual.start) {
        actual.start = log.date;
      }
      if (log.finishes && (!actual.end || log.date > actual.end)) {
        actual.end = log.date;
      }
      actuals.set(target.work_id, actual);
    }
  }
  return actuals;
}

// 記録につなぐ計画の作業。その作付（または区画）の作業のうち、同じ種類で、取りやめておらず、
// まだ終わっていない最初の作業。actuals は workActuals の結果（直している記録そのものは除いて求める）
export function matchWork(works, owner, workType, actuals) {
  return (
    works
      .filter(
        (work) =>
          work.work_type === workType &&
          !work.cancelled_on &&
          (owner.planting_id ? work.planting_id === owner.planting_id : work.block_id === owner.block_id)
      )
      .sort(bySeq)
      .find((work) => !actuals.get(work.id)?.end) || null
  );
}

// 品目ごとに入れた液の量（L）を、その品目の畝に面積の比で分ける。面積が分からなければ等分
export function splitByArea(items, liters) {
  if (!items.length || !(liters > 0)) {
    return items.map(() => null);
  }
  const total = items.reduce((sum, item) => sum + (item.area_m2 || 0), 0);
  return items.map((item) => (total > 0 ? (liters * (item.area_m2 || 0)) / total : liters / items.length));
}

// 液の量（L）と希釈倍率から、使う製品の量（mL か g）。どちらかが分からなければ null
export function productAmount(liters, dilution) {
  return liters > 0 && dilution > 0 ? (liters * 1000) / dilution : null;
}

// 記録の対象を、品目ごとの本数で短く表す。例: リーフレタス 3 本、ニンジン 2 本
export function targetSummary(targets) {
  const counts = new Map();
  for (const target of targets) {
    const name = target.bed_id || target.planting_id || target.crop_name ? target.crop_name || "（品目なし）" : target.label;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ${count} 本` : name))
    .join("、");
}

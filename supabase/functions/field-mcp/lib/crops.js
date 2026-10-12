// 品目の設定値から、作付ごとの苗数と施肥量を計算する。
import { polygonArea, rectSize } from "./geometry.js";

const TEN_ARES_SQM = 1000;

// 1 つの作付の数字。品目が登録されていなければ、畝の寸法だけを返す。
//   seedlings     苗数 = 切り捨て（畝長 ÷ 株間）× 条数
//   nitrogenKg    窒素量 = 畝の面積 × 10 a あたりの窒素量 ÷ 1,000 ㎡
//   fertilizerKg  肥料の量 = 窒素量 ÷ 肥料の窒素成分
//   widthGapCm    実際の畝幅 − 品目の畝幅（1 cm 未満の差は 0）
export function plantingNumbers(bedShape, crop, fertilizer) {
  const { length, width } = rectSize(bedShape);
  const area = polygonArea(bedShape);
  const result = { length, width, area, seedlings: null, nitrogenKg: null, fertilizerKg: null, widthGapCm: 0 };
  if (!crop) {
    return result;
  }
  if (crop.plant_gap_cm > 0 && crop.row_count > 0) {
    // 1 条に入る株の数を切り捨てで求めてから、条数を掛ける。
    // 割り切れるのに計算の誤差で 152.9999… のようになった分は、切り捨てない
    result.seedlings = Math.floor(length / (crop.plant_gap_cm / 100) + 1e-6) * crop.row_count;
  }
  if (crop.n_kg_per_10a > 0) {
    result.nitrogenKg = (area * crop.n_kg_per_10a) / TEN_ARES_SQM;
    if (fertilizer && fertilizer.n_pct > 0) {
      result.fertilizerKg = result.nitrogenKg / (fertilizer.n_pct / 100);
    }
  }
  if (crop.bed_width_cm > 0) {
    const gap = Math.round(width * 100 - crop.bed_width_cm);
    result.widthGapCm = Math.abs(gap) >= 1 ? gap : 0;
  }
  return result;
}

// プラン全体の集計。品目ごとの作付の数、面積、苗数と、肥料ごとの量。
// 品目を登録していない作付は、名前ごとに面積だけを数える
export function summarize({ beds, plantings, crops, fertilizers }) {
  const byCrop = new Map();
  const byFertilizer = new Map();
  for (const planting of plantings) {
    const bed = beds.find((item) => item.id === planting.bed_id);
    if (!bed) {
      continue;
    }
    const crop = crops.find((item) => item.id === planting.crop_id) || null;
    const fertilizer = crop ? fertilizers.find((item) => item.id === crop.fertilizer_id) || null : null;
    const numbers = plantingNumbers(bed.shape, crop, fertilizer);
    const key = crop ? crop.id : `name:${planting.crop_name}`;
    if (!byCrop.has(key)) {
      byCrop.set(key, { name: crop ? cropLabel(crop) : planting.crop_name || "品目なし", registered: Boolean(crop), count: 0, area: 0, seedlings: 0, fertilizer: fertilizer?.name || "", fertilizerKg: 0 });
    }
    const row = byCrop.get(key);
    row.count += 1;
    row.area += numbers.area;
    row.seedlings += numbers.seedlings || 0;
    row.fertilizerKg += numbers.fertilizerKg || 0;
    if (fertilizer && numbers.fertilizerKg) {
      byFertilizer.set(fertilizer.name, (byFertilizer.get(fertilizer.name) || 0) + numbers.fertilizerKg);
    }
  }
  return {
    crops: [...byCrop.values()].sort((a, b) => a.name.localeCompare(b.name, "ja")),
    fertilizers: [...byFertilizer.entries()].map(([name, kg]) => ({ name, kg })).sort((a, b) => a.name.localeCompare(b.name, "ja")),
  };
}

// 品目の呼び名。品種があれば添える
export function cropLabel(crop) {
  return crop.variety ? `${crop.name}（${crop.variety}）` : crop.name;
}

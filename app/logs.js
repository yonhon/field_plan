// 作業の記録の計算。画面（log-view.js）とテストから使う。
// 記録はプランではなく圃場に付け、実際に使うプランの区画・畝・作付・作業へは ID でつなぐ。
import { bedAngle, centroid, crossRange, polygonArea, rectSize } from "./geometry.js";
import { addDays, diffDays, existsOn, worksRange } from "./schedule.js";

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

// 作付が始まった日。計画と実績の両方があれば実績を優先し、記録があれば最初の記録の日、なければ計画の最初の作業の日。
// どちらもなければ null
export function plantingStart(planting, works, logs = []) {
  const recorded = logs
    .filter((log) => (log.targets || []).some((target) => target.planting_id === planting.id))
    .map((log) => log.date)
    .sort()[0];
  return recorded || worksRange(works.filter((work) => work.planting_id === planting.id))?.start || null;
}

// その日に畝にある作付。その日までに始まった作付のうち、いちばん新しいもの。まだどれも始まっていなければ、次に来る作付。
// 計画に収穫が入っていない作付（計画を作りかけの作付）も、次の作付が始まるまでは、その畝の作付として扱う
export function plantingOnDate(plantings, works, date, logs = []) {
  const sorted = [...plantings].sort(bySeq);
  const started = sorted.filter((planting) => {
    const start = plantingStart(planting, works, logs);
    return !start || start <= date;
  });
  return started.at(-1) || sorted[0] || null;
}

const cropMulch = (planting, crops) => planting.mulch ?? crops.find((crop) => crop.id === planting.crop_id)?.mulch ?? false;

// 記録の対象にできるもの。その日にある畝の作付を、品目ごとにまとめる（同じ品目でも、マルチの有無で分ける）。
// 区画の作業のために、その日にある区画も返す
export function targetChoices({ blocks, beds, plantings, works, crops = [], logs = [] }, date) {
  const liveBlocks = blocks.filter((block) => existsOn(block.start_date, block.end_date, date));
  const groups = new Map();
  for (const block of liveBlocks) {
    const live = beds.filter((bed) => bed.block_id === block.id && existsOn(bed.start_date, bed.removed_on, date)).sort(bySeq);
    const areas = bedAreas(block, live);
    for (const bed of live) {
      const planting = plantingOnDate(
        plantings.filter((item) => item.bed_id === bed.id),
        works,
        date,
        logs
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

// 計画の作業の状態。cancelled（取りやめ）、done（完了）、late（予定日を過ぎて未完了）、started（始めたが未完了）、planned（これから）
export function workStatus(work, actuals, today) {
  if (work.cancelled_on) {
    return "cancelled";
  }
  const actual = actuals.get(work.id);
  if (actual?.end) {
    return "done";
  }
  if (work.plan_end && work.plan_end < today) {
    return "late";
  }
  return actual ? "started" : "planned";
}

// 予定日を過ぎても終わっていない作業。予定日の早い順
export function lateWorks(works, actuals, today) {
  return works
    .filter((work) => workStatus(work, actuals, today) === "late")
    .sort((a, b) => a.plan_end.localeCompare(b.plan_end) || a.seq - b.seq);
}

// 計画と実績の日のずれ。終了日どうしで比べる。終わっていなければ空
export function dayGap(work, actual) {
  if (!actual?.end || !work.plan_end) {
    return "";
  }
  const days = diffDays(work.plan_end, actual.end);
  return days === 0 ? "予定どおり" : days > 0 ? `${days} 日遅れ` : `${-days} 日早い`;
}

// 計画の日付を、実績のある作業は実績の日に置き換える（日程の無理を、実績の日で見るため）。
// 始めただけの作業は、開始日だけを置き換える
export function withActualDates(works, actuals) {
  return works.map((work) => {
    const actual = actuals.get(work.id);
    if (!actual || work.cancelled_on) {
      return work;
    }
    const end = actual.end || (work.plan_end && work.plan_end > actual.start ? work.plan_end : actual.start);
    return { ...work, plan_start: actual.start, plan_end: end };
  });
}

// 実績に合わせて後ろを並べ直す。works は 1 つの区画または作付の作業（順番どおり）。
// 終わった作業のうち最後のものについて、実績の終了日と計画の終了日の差の日数だけ、そのあとの終わっていない作業をずらす。
// 作業どうしの間隔は保つ（計画で手で空けた間隔や、品目の設定値のない作付の収穫までの間隔を崩さないため）。
// 返り値は { days, works }（days はずらす日数、works はずらした作業）。終わった作業がなければ null
export function shiftAfterActual(works, actuals) {
  const sorted = [...works].sort(bySeq);
  let anchor = -1;
  sorted.forEach((work, i) => {
    if (actuals.get(work.id)?.end && work.plan_end) {
      anchor = i;
    }
  });
  if (anchor < 0) {
    return null;
  }
  const last = sorted[anchor];
  const days = diffDays(last.plan_end, actuals.get(last.id).end);
  const rest = sorted.slice(anchor + 1).filter((work) => !work.cancelled_on && !actuals.get(work.id)?.end && work.plan_start && work.plan_end);
  return {
    days,
    works: days ? rest.map((work) => ({ ...work, plan_start: addDays(work.plan_start, days), plan_end: addDays(work.plan_end, days) })) : [],
  };
}

// 定植・播種の仕様のうち、計画と実績で違うもの。planned は作付の値（なければ品目の値）
const SPEC_KEYS = [
  ["plant_gap_cm", "株間", "cm"],
  ["row_gap_cm", "条間", "cm"],
  ["row_count", "条数", "条"],
  ["staggered", "千鳥", ""],
];
export function specDiff(spec, planned) {
  return SPEC_KEYS.filter(([key]) => spec[key] !== undefined && spec[key] !== null)
    .filter(([key]) => (key === "staggered" ? Boolean(spec[key]) !== Boolean(planned[key]) : Number(spec[key]) !== Number(planned[key])))
    .map(([key, label, unit]) => ({ key, label, unit, planned: planned[key] ?? null, actual: spec[key] }));
}

// 作業のない期間を詰めた時間の軸。spans は [開始, 終了] の日付の組。作業のある日の前後 margin 日を残し、
// minGap 日以上の空きは gapWidth 日ぶんの幅に詰める。x(日付) は軸の上の位置（日の単位）、total は軸の長さ。
// breaks は詰めた空き（位置、幅、日数）、ticks は詰めた空きのあとに作業が始まる位置と日付
export function compressedAxis(spans, { margin = 1, minGap = 3, gapWidth = 2 } = {}) {
  const valid = spans.filter(([start, end]) => start && end);
  if (!valid.length) {
    return null;
  }
  const first = addDays(valid.map(([start]) => start).sort()[0], -margin);
  const last = addDays(valid.map(([, end]) => end).sort().at(-1), margin);
  const length = diffDays(first, last) + 1;
  const active = new Array(length).fill(false);
  for (const [start, end] of valid) {
    for (let i = Math.max(diffDays(first, start) - margin, 0); i <= Math.min(diffDays(first, end) + margin, length - 1); i += 1) {
      active[i] = true;
    }
  }
  const positions = new Array(length);
  const breaks = [];
  const ticks = [];
  let x = 0;
  let i = 0;
  let fresh = true;
  while (i < length) {
    if (active[i]) {
      if (fresh) {
        ticks.push({ x, day: addDays(first, Math.min(i + margin, length - 1)) });
      }
      positions[i] = x;
      x += 1;
      i += 1;
      fresh = false;
      continue;
    }
    let k = i;
    while (k < length && !active[k]) {
      k += 1;
    }
    const days = k - i;
    if (days >= minGap) {
      breaks.push({ x, width: gapWidth, days, start: addDays(first, i) });
      for (let j = i; j < k; j += 1) {
        positions[j] = x + ((j - i) / days) * gapWidth;
      }
      x += gapWidth;
      fresh = true;
    } else {
      for (let j = i; j < k; j += 1) {
        positions[j] = x;
        x += 1;
      }
    }
    i = k;
  }
  const at = (iso) => positions[Math.min(Math.max(diffDays(first, iso), 0), length - 1)];
  return { first, last, total: x, x: at, breaks, ticks };
}

// ---- 記録の文 ----
// 画面と MCP サーバーで同じ書き方にする

// 作業の種類ごとの仕様の欄。[spec のキー, 見出し, 種類（省くと数）]
export const SPEC_FIELDS = {
  plant: [
    ["plant_gap_cm", "株間（cm）"],
    ["row_gap_cm", "条間（cm）"],
    ["row_count", "条数"],
    ["seeds", "1 か所の粒数"],
    ["depth_cm", "植える深さ（cm）"],
    ["staggered", "千鳥", "check"],
  ],
  nursery_sow: [
    ["tray", "トレイ（例: 128 穴）", "text"],
    ["trays", "枚数"],
    ["seeds", "1 穴の粒数"],
  ],
  ridge: [
    ["bed_width_cm", "実畦の幅（cm）"],
    ["aisle_width_cm", "通路の幅（cm）"],
    ["height_cm", "畝の高さ（cm）"],
  ],
  mulch: [
    ["mulch", "マルチの種類", "text"],
    ["width_cm", "幅（cm）"],
  ],
  harvest: [["harvest_kg", "収穫量（kg）"]],
};

// 記録の仕様を短い文にする。例: 株間（cm） 30・条数 3・千鳥
export function specText(type, spec = {}) {
  return (SPEC_FIELDS[type] || [])
    .filter(([key]) => spec[key] !== undefined && spec[key] !== null && spec[key] !== "" && spec[key] !== false)
    .map(([key, label, kind]) => (kind === "check" ? label : `${label.replace(/（.*）/, "")} ${spec[key]}${(label.match(/（(cm|kg)）/) || [])[1] || ""}`))
    .join("・");
}

// 記録の資材を短い文にする。例: テスト乳剤 2000 倍 散布
export function inputText(input) {
  if (input.kind === "pesticide") {
    return [input.name || "農薬", input.dilution ? `${input.dilution} 倍` : "", input.method].filter(Boolean).join(" ");
  }
  return [input.name, input.amount !== null && input.amount !== undefined ? `${input.amount} ${input.unit}` : ""].filter(Boolean).join(" ");
}

// ---- 農薬 ----
// 防除の記録の資材には、記録した時点の使用基準の写し（standard）を持たせる。
// standard = { reg_no, product, target, method, ingredients: [総使用回数に数える有効成分（①〜⑤の順。数えないものは空）],
//              rows: [{ crop_name（アプリの品目）, crop（FAMIC の作物名）, dilution_text, liquid_text, timing_text, times_text,
//                       totals, dilution_min, dilution_max, liquid_min, liquid_max, preharvest_days, times_max, total_max }] }

// 作付の農薬の使用回数。登録番号ごとと、有効成分ごとに数える。1 件の記録で 1 回（同じ記録に同じ成分が 2 剤あっても 1 回）
export function pesticideCounts(logs, plantingId, excludeLogId = null) {
  const products = new Map();
  const ingredients = new Map();
  for (const log of logs) {
    if (log.id === excludeLogId || !(log.targets || []).some((target) => target.planting_id === plantingId)) {
      continue;
    }
    const regs = new Set();
    const names = new Set();
    for (const input of log.inputs || []) {
      if (input.kind !== "pesticide" || !input.reg_no) {
        continue;
      }
      regs.add(String(input.reg_no));
      (input.standard?.ingredients || []).filter(Boolean).forEach((name) => names.add(name));
    }
    regs.forEach((reg) => products.set(reg, (products.get(reg) || 0) + 1));
    names.forEach((name) => ingredients.set(name, (ingredients.get(name) || 0) + 1));
  }
  return { products, ingredients };
}

// 作付の、有効成分ごとの使用回数と上限の表。上限は、その作付の品目の使用基準の写しのうち、いちばん新しい記録のもの
export function usageTable(logs, plantingId, cropName) {
  const counts = pesticideCounts(logs, plantingId);
  const limits = new Map();
  const conditions = new Map();
  const productRows = new Map();
  const sorted = [...logs].filter((log) => (log.targets || []).some((target) => target.planting_id === plantingId)).sort((a, b) => a.date.localeCompare(b.date));
  for (const log of sorted) {
    for (const input of log.inputs || []) {
      // 使用基準の写しがない記録でも、本剤の名前は記録に入れた名前で出す（登録番号のままにしない）
      if (input.kind === "pesticide" && input.reg_no && !productRows.has(String(input.reg_no))) {
        productRows.set(String(input.reg_no), { name: input.name || String(input.reg_no), max: null });
      }
      const standard = input.kind === "pesticide" && input.standard;
      if (!standard) {
        continue;
      }
      const row = standard.rows?.find((item) => item.crop_name === cropName) || null;
      productRows.set(String(input.reg_no), { name: standard.product || input.name, max: row?.times_max ?? null });
      (standard.ingredients || []).forEach((name, k) => {
        if (name) {
          limits.set(name, row?.total_max?.[k] ?? null);
          const text = row?.totals?.[k] || "";
          if (text.includes("(")) {
            conditions.set(name, text);
          }
        }
      });
    }
  }
  return {
    ingredients: [...counts.ingredients.entries()].map(([name, count]) => ({ name, count, max: limits.get(name) ?? null, condition: conditions.get(name) || "" })),
    products: [...counts.products.entries()].map(([reg, count]) => ({ reg_no: reg, count, name: productRows.get(reg)?.name || reg, max: productRows.get(reg)?.max ?? null })),
  };
}

// 最後の防除と使用時期（収穫の何日前まで）から、基準を満たす最初の収穫日。防除がなければ null
export function firstHarvestDay(logs, plantingId, cropName) {
  let first = null;
  for (const log of logs) {
    if (!(log.targets || []).some((target) => target.planting_id === plantingId)) {
      continue;
    }
    for (const input of log.inputs || []) {
      const row = input.kind === "pesticide" && input.standard?.rows?.find((item) => item.crop_name === cropName);
      if (row?.preharvest_days) {
        const day = addDays(log.date, row.preharvest_days);
        if (!first || day > first) {
          first = day;
        }
      }
    }
  }
  return first;
}

// 防除の記録を入れるときの指摘。保存は止めない。選んだ作物名の基準に照らした結果だけを出し、
// 作物名の当てはめが正しいかは判定しない（指摘が出ないことを、正しい印と受け取られないように）。
// groups は品目のまとまりごとの { name, area, liters, row（選んだ作物名と使い方の基準。まだ選んでいなければ null）,
// plantings: [{ id, harvestStart }] }。countsOf(作付の ID) はその作付のこれまでの使用回数（pesticideCounts の結果）
export function sprayWarnings({ date, dilution, regNo, ingredients = [], groups, countsOf }) {
  const warnings = [];
  for (const group of groups) {
    const row = group.row;
    if (!row) {
      continue;
    }
    if (dilution && row.dilution_min && dilution < row.dilution_min) {
      warnings.push(`${group.name}: 希釈倍率 ${dilution} 倍は、基準（${row.dilution_min} 倍以上）より濃くなります`);
    }
    if (group.liters > 0 && group.area > 0 && row.liquid_min !== null && row.liquid_min !== undefined) {
      const per10a = (group.liters / group.area) * 1000;
      if (per10a < row.liquid_min - 1e-9 || per10a > row.liquid_max + 1e-9) {
        warnings.push(`${group.name}: 散布液量が 10 a あたり ${Math.round(per10a)} L で、基準（${row.liquid_min}〜${row.liquid_max} L）の外です`);
      }
    }
    let product = 0;
    const totals = new Map();
    let soonest = null;
    for (const planting of group.plantings) {
      const counts = countsOf(planting.id);
      product = Math.max(product, (counts.products.get(String(regNo)) || 0) + 1);
      ingredients.forEach((name, k) => {
        if (name) {
          totals.set(k, Math.max(totals.get(k) || 0, (counts.ingredients.get(name) || 0) + 1));
        }
      });
      if (planting.harvestStart && (!soonest || planting.harvestStart < soonest)) {
        soonest = planting.harvestStart;
      }
    }
    if (row.times_max && product > row.times_max) {
      warnings.push(`${group.name}: 本剤の使用回数が、この防除で ${product} 回になり、上限（${row.times_max} 回）を超えます`);
    }
    for (const [k, count] of totals) {
      const max = row.total_max?.[k];
      if (max && count > max) {
        warnings.push(`${group.name}: ${ingredients[k]} を含む農薬の使用回数が、この防除で ${count} 回になり、上限（${max} 回）を超えます`);
      }
      if ((row.totals?.[k] || "").includes("(")) {
        warnings.push(`${group.name}: ${ingredients[k]} の総使用回数には条件があります。確かめてください: ${row.totals[k]}`);
      }
    }
    if (row.preharvest_days && soonest) {
      const days = diffDays(date, soonest);
      if (days < row.preharvest_days) {
        warnings.push(`${group.name}: 収穫の開始（${soonest.slice(5).replace("-", "/")}）まで ${days} 日で、使用時期（収穫 ${row.preharvest_days} 日前まで）を満たしません`);
      }
    }
  }
  return [...new Set(warnings)];
}

// 製品の量を、g か mL にそろえる。そろえられない単位は null
export function toBaseAmount(amount, unit) {
  const value = Number(amount);
  if (amount === null || amount === undefined || amount === "" || !Number.isFinite(value)) {
    return null;
  }
  const scale = { kg: [1000, "g"], g: [1, "g"], L: [1000, "mL"], mL: [1, "mL"] }[unit];
  return scale ? { value: value * scale[0], unit: scale[1] } : null;
}

// 使用基準の希釈倍数・使用量の欄にある、面積あたりの使用量（粒剤など）。例: 「6kg/10a」「4~6kg/10a」「500mL/10a」
// 「1~2g/m2」「原液として3リットル/10a」。かっこの補足（「(少量散布)」「(1~2g/株)」）は読まない。
// 返り値は 1 ㎡ あたりの下限・上限（g か mL）。面積あたりでない基準（倍、g/株、穴当りなど）は null
export function parseUsage(text) {
  const t = String(text || "")
    .normalize("NFKC")
    .replace(/\s/g, "")
    .replace(/^原液として/, "")
    .replace(/\(.*$/, "")
    .replace(/リットル/g, "L");
  const match = /^(\d+(?:\.\d+)?)(?:~(\d+(?:\.\d+)?))?(kg|g|mL|ml|L)\/(\d+(?:\.\d+)?)?(a|m2)$/.exec(t);
  if (!match) {
    return null;
  }
  const [, low, high, rawUnit, per, areaUnit] = match;
  const m2 = Number(per || 1) * (areaUnit === "a" ? 100 : 1);
  const min = toBaseAmount(low, rawUnit === "ml" ? "mL" : rawUnit);
  const max = toBaseAmount(high ?? low, rawUnit === "ml" ? "mL" : rawUnit);
  return { min: min.value / m2, max: max.value / m2, unit: min.unit };
}

// 品目のまとまりごとの面積と使用基準の行から、面積あたりの使用量の基準の合計（g か mL）。
// どれかのまとまりが面積あたりの基準でないとき、単位がそろわないときは null
export function usageRange(groups) {
  let min = 0;
  let max = 0;
  let unit = null;
  for (const group of groups) {
    const usage = group.row ? parseUsage(group.row.dilution_text) : null;
    if (!usage || !group.area || (unit && usage.unit !== unit)) {
      return null;
    }
    unit = usage.unit;
    min += usage.min * group.area;
    max += usage.max * group.area;
  }
  return unit ? { min, max, unit } : null;
}

// 量を読みやすく。1000 g 以上は kg、1000 mL 以上は L
export function formatAmount(value, unit) {
  if (value >= 1000) {
    return `${Math.round(value / 100) / 10} ${unit === "g" ? "kg" : "L"}`;
  }
  return `${Math.round(value * 10) / 10} ${unit}`;
}

// 製品の量と、面積あたりの使用量の基準の合計を比べた指摘（超えるとき）。基準がなければ空
export function usageWarnings({ amount, unit, groups }) {
  const range = usageRange(groups);
  const used = toBaseAmount(amount, unit);
  if (!range || !used || used.unit !== range.unit || used.value <= 0) {
    return [];
  }
  const span = range.min === range.max ? formatAmount(range.max, range.unit) : `${formatAmount(range.min, range.unit)}〜${formatAmount(range.max, range.unit)}`;
  // 少なく使う分には基準を外れないので、超えるときだけ言う
  if (used.value > range.max * (1 + 1e-9)) {
    return [`使用量 ${formatAmount(used.value, used.unit)} は、この面積の基準（${span}）を超えます`];
  }
  return [];
}

// 記録の使用基準の写しから、品目のまとまりで選んだ作物名と使い方（use_key は「適用病害虫|使用方法」）。
// 品目で選んだ記録は品目の名前（crop_name）で、区画で選んだ記録はまとまりの名前（group）で探す。
// 使い方を写しの一番上に持つ形（品目ごとに選ぶ前の記録）も読む
export function standardChoice(standard, { cropName = "", groupName = "" }) {
  const row = (standard?.rows || []).find((item) => (cropName ? item.crop_name === cropName : item.group === groupName));
  if (!row?.crop) {
    return null;
  }
  const target = row.target ?? standard.target;
  const method = row.method ?? standard.method;
  return { crop: row.crop, use_key: target && method ? `${target}|${method}` : "" };
}

// 防除の記録を入れるときの、品目のまとまりの初めの選択。前回の選択を入れる。
// 1. その品目（区画）に同じ農薬を使った、いちばん新しい記録の作物名と使い方
// 2. なければ、その品目（区画）でいちばん新しく選んだ作物名（この農薬の作物名にあるときだけ。使い方は 1 つしかなければそれ）
// rows はこの農薬の使用基準の行（{ crop, target, method }）。見つからなければ null
export function previousChoice(logs, { regNo, cropName = "", groupName = "", excludeLogId = null }, rows) {
  const keysOf = (crop) => [...new Set(rows.filter((row) => row.crop === crop).map((row) => `${row.target}|${row.method}`))];
  const sorted = logs
    .filter((log) => log.id !== excludeLogId)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at || "").localeCompare(String(a.created_at || "")));
  let fallback = null;
  for (const log of sorted) {
    for (const input of log.inputs || []) {
      if (input.kind !== "pesticide" || !input.standard) {
        continue;
      }
      const choice = standardChoice(input.standard, { cropName, groupName });
      if (!choice || !keysOf(choice.crop).length) {
        continue;
      }
      if (String(input.reg_no) === String(regNo)) {
        return { crop: choice.crop, use_key: keysOf(choice.crop).includes(choice.use_key) ? choice.use_key : "" };
      }
      if (!fallback) {
        const keys = keysOf(choice.crop);
        fallback = { crop: choice.crop, use_key: keys.length === 1 ? keys[0] : "" };
      }
    }
  }
  return fallback;
}

// 選んだ品目の使用基準の行から、初めの希釈倍率。下限（いちばん濃くしてよい倍率）のうち、いちばん大きいもの。
// 薄くする分には基準を外れないので、どの組み合わせでも 1 つに決まる
export function defaultDilution(rows) {
  const lows = rows.filter(Boolean).map((row) => row.dilution_min).filter((value) => value > 0);
  return lows.length ? Math.max(...lows) : null;
}

// 工程表の同じ行で、日が重なる帯を上下の段に分ける（1 日の作業は、ほかの作業と同じ日に重ねられるため）。
// items は { start, end }（日付）。返り値は items と同じ順の { lane（何段目か）, lanes（そのまとまりの段の数） }。
// 段の数は、重なりのあるまとまりごとに数える（重なっていない帯は、行の高さいっぱいのまま）
export function stackLanes(items) {
  const order = items.map((item, i) => ({ ...item, i })).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const result = new Array(items.length);
  let cluster = [];
  let clusterEnd = null;
  let laneEnds = [];
  const close = () => {
    cluster.forEach((item) => (result[item.i].lanes = laneEnds.length));
    cluster = [];
    laneEnds = [];
  };
  for (const item of order) {
    if (clusterEnd !== null && item.start > clusterEnd) {
      close();
      clusterEnd = null;
    }
    let lane = laneEnds.findIndex((end) => end < item.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    result[item.i] = { lane, lanes: 1 };
    cluster.push(item);
    clusterEnd = clusterEnd === null || item.end > clusterEnd ? item.end : clusterEnd;
  }
  close();
  return result;
}

// 工程表の 1 行の帯の置き方。items は { start, end }（日付）。
// 1 日の作業はその日に描き、同じ日に 1 日の作業が複数あるときだけ、その日の中で上下の段に分ける。
// 何日かの作業は、1 日の作業がある日を除いた日に、普通の高さで描く（初日に 1 日の作業があれば、残りの日だけ）。
// 何日かの作業どうしが重なるとき、または 1 日の作業で全部の日が埋まる作業があるときは、帯が隠れないよう、
// 行の全部を stackLanes で上下の段に分ける。
// 返り値は描く帯（分かれた作業は複数）の [{ item（items の何番目か）, start, end, lane, lanes, cutStart, cutEnd }]。
// cutStart / cutEnd は、作業の本当の開始日・終了日ではない切れ目か
export function layoutBars(items) {
  const indexed = items.map((item, i) => ({ ...item, i }));
  const singles = indexed.filter((item) => item.start === item.end);
  const multis = indexed.filter((item) => item.start < item.end);
  const singleDays = new Map();
  singles.forEach((item) => singleDays.set(item.start, [...(singleDays.get(item.start) || []), item]));
  const segmentsOf = (item) => {
    const segments = [];
    let current = null;
    for (let day = item.start; day <= item.end; day = addDays(day, 1)) {
      if (singleDays.has(day)) {
        current = null;
      } else if (current) {
        current.end = day;
      } else {
        current = { start: day, end: day };
        segments.push(current);
      }
    }
    return segments;
  };
  const split = multis.map((item) => ({ item, segments: segmentsOf(item) }));
  const multisOverlap = multis.some((a, x) => multis.some((b, y) => x < y && a.start <= b.end && b.start <= a.end));
  if (multisOverlap || split.some(({ segments }) => !segments.length)) {
    return stackLanes(items).map((lane, i) => ({ item: i, start: items[i].start, end: items[i].end, ...lane, cutStart: false, cutEnd: false }));
  }
  const bars = [];
  for (const [day, list] of singleDays) {
    list.forEach((item, k) => bars.push({ item: item.i, start: day, end: day, lane: k, lanes: list.length, cutStart: false, cutEnd: false }));
  }
  for (const { item, segments } of split) {
    segments.forEach((segment) =>
      bars.push({ item: item.i, start: segment.start, end: segment.end, lane: 0, lanes: 1, cutStart: segment.start !== item.start, cutEnd: segment.end !== item.end })
    );
  }
  return bars.sort((a, b) => a.item - b.item || a.start.localeCompare(b.start));
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

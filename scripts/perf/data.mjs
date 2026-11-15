// 速さを測るための、作り物のデータ（?local=1 の保存の形）。本物のデータは使わない（公開のリポジトリなので）。
// scale は "now"（2026-11 の本番とほぼ同じ件数）か "1y"（1 年使ったときの見込み）。
// 件数の決め方は docs/performance.md の「測るデータ」
const AT = "2026-01-01T00:00:00Z";
const CROPS = ["キャベツ", "にんじん", "だいこん", "レタス", "ブロッコリー", "たまねぎ", "ばれいしょ", "かぼちゃ", "オクラ", "ゴーヤー", "とうがん", "ピーマン"];
const SCALES = {
  now: { plantingsPerBed: 1, logs: 110, logDays: 35, changes: 540, changeDays: 35, notes: 15 },
  "1y": { plantingsPerBed: 2, logs: 1300, logDays: 365, changes: 5000, changeDays: 365, notes: 100 },
};

// 毎回同じデータになるよう、決まった並びの乱数を使う
function random(seed) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const day = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return iso(date);
};
const uuid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function makeSeed(scale = "now") {
  const s = SCALES[scale];
  if (!s) {
    throw new Error(`scale は ${Object.keys(SCALES).join(" か ")}`);
  }
  const rand = random(42);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const outline = [[0, 0], [100, 0], [100, 60], [0, 60]];
  const fields = [
    { id: uuid("f0000001", 1), name: "試験の圃場", outline, note: "", active_plan_id: uuid("p0000001", 1), created_at: AT },
    { id: uuid("f0000001", 2), name: "試験の圃場 2", outline: [[0, 0], [30, 0], [30, 20], [0, 20]], note: "", active_plan_id: null, created_at: "2026-01-02T00:00:00Z" },
  ];
  const plans = [
    { id: uuid("p0000001", 1), field_id: fields[0].id, name: "プラン1" },
    { id: uuid("p0000001", 2), field_id: fields[0].id, name: "プラン2" },
    { id: uuid("p0000001", 3), field_id: fields[1].id, name: "プラン1" },
  ];
  const plan = plans[0].id;
  const zones = [{ id: uuid("a0000001", 1), plan_id: plan, kind: "tillable", name: "", shape: outline, created_at: AT }];
  // 区画 4 つ（2 × 2）に、畝を 26 本ずつ（いまの本番とほぼ同じ 104 本）
  const blocks = [];
  const beds = [];
  [[2, 2], [52, 2], [2, 32], [52, 32]].forEach(([x0, y0], b) => {
    const block = { id: uuid("b0000001", b + 1), plan_id: plan, zone_id: zones[0].id, name: "ABCD"[b], shape: [[x0, y0], [x0 + 46, y0], [x0 + 46, y0 + 26], [x0, y0 + 26]], start_date: null, end_date: null, created_at: AT };
    blocks.push(block);
    for (let i = 0; i < 26; i += 1) {
      const x = x0 + 1 + i * 1.7;
      beds.push({ id: uuid("c0000001", b * 100 + i + 1), plan_id: plan, block_id: block.id, seq: i + 1, shape: [[x, y0 + 2], [x + 1, y0 + 2], [x + 1, y0 + 24], [x, y0 + 24]], start_date: null, removed_on: null });
    }
  });
  const crops = Array.from({ length: 34 }, (_, i) => ({ id: uuid("d0000001", i + 1), name: i < CROPS.length ? CROPS[i] : `試験の品目 ${i + 1}`, mulch: i % 3 === 0, bed_width_cm: 100, aisle_width_cm: 70 }));
  const fertilizers = Array.from({ length: 11 }, (_, i) => ({ id: uuid("e0000001", i + 1), name: `試験の肥料 ${i + 1}`, n_pct: 8, p_pct: 8, k_pct: 8 }));
  // 作付と作業。作付ごとに、畝立て・定植・追肥・収穫。区画ごとに耕うんを 3 回
  const plantings = [];
  const works = [];
  let workNo = 0;
  blocks.forEach((block, b) => {
    for (let k = 0; k < 3; k += 1) {
      const start = -60 + k * 120 + b;
      works.push({ id: uuid("90000001", ++workNo), plan_id: plan, block_id: block.id, planting_id: null, work_type: "rotary", seq: k + 1, plan_start: day(start), plan_end: day(start + 1), note: "", cancelled_on: null, detail: {} });
    }
  });
  beds.forEach((bed, i) => {
    for (let k = 0; k < s.plantingsPerBed; k += 1) {
      const crop = crops[(i + k) % CROPS.length];
      const planting = { id: uuid("80000001", i * 10 + k + 1), plan_id: plan, bed_id: bed.id, seq: k + 1, crop_id: crop.id, crop_name: crop.name, note: "" };
      plantings.push(planting);
      const base = -40 + k * 150 + (i % 20);
      [["ridge", 0, 0], ["plant", 5, 5], ["topdress", 30, 30], ["harvest", 80, 95]].forEach(([type, from, to], n) => {
        works.push({ id: uuid("90000001", ++workNo), plan_id: plan, block_id: null, planting_id: planting.id, work_type: type, seq: n + 1, plan_start: day(base + from), plan_end: day(base + to), note: "", cancelled_on: null, detail: {} });
      });
    }
  });
  // 作業の記録。1 件に、畝を 1〜5 本と、資材を 0〜2 つ
  const workLogs = Array.from({ length: s.logs }, (_, i) => {
    const id = uuid("70000001", i + 1);
    const type = pick(["plant", "topdress", "spray", "weed", "water", "harvest"]);
    const count = 1 + Math.floor(rand() * 5);
    const first = Math.floor(rand() * (plantings.length - count));
    const targets = plantings.slice(first, first + count).map((planting, n) => ({
      id: uuid("71000001", i * 10 + n + 1),
      log_id: id,
      planting_id: planting.id,
      bed_id: planting.bed_id,
      block_id: null,
      work_id: null,
      label: `畝${n + 1} ${planting.crop_name}`,
      crop_name: planting.crop_name,
      area_m2: 22,
      spray_l: null,
    }));
    const inputs = Array.from({ length: type === "topdress" || type === "spray" ? 1 + Math.floor(rand() * 2) : 0 }, (_, n) => ({
      id: uuid("72000001", i * 10 + n + 1),
      log_id: id,
      seq: n + 1,
      kind: type === "spray" ? "pesticide" : "fertilizer",
      reg_no: null,
      standard: null,
      fertilizer_id: type === "spray" ? null : pick(fertilizers).id,
      name: type === "spray" ? `試験の農薬 ${n + 1}` : "試験の肥料",
      method: "",
      dilution: type === "spray" ? 1000 : null,
      amount: 2,
      unit: type === "spray" ? "L" : "kg",
      per_hole: null,
    }));
    const date = day(-Math.floor(rand() * s.logDays));
    return { id, field_id: fields[0].id, date, end_date: null, work_type: type, finishes: rand() < 0.5, spec: {}, note: rand() < 0.3 ? "試験のメモ" : "", created_at: `${date}T01:00:00.000Z`, targets, inputs };
  });
  // 変更の記録と、日ごとのメモ
  const changes = Array.from({ length: s.changes }, (_, i) => {
    const date = day(-Math.floor((i / s.changes) * s.changeDays));
    return {
      id: uuid("60000001", i + 1),
      field_id: fields[0].id,
      no: s.changes - i,
      at: `${date}T02:00:00.000Z`,
      last_at: `${date}T02:00:00.000Z`,
      day: date,
      plan_id: plan,
      plan_name: "プラン1",
      kind: pick(["bed.width", "work.shift", "planting.add", "work.transfer"]),
      target_kind: null,
      target_id: null,
      text: `試験の変更 ${s.changes - i}`,
      before: null,
      after: null,
    };
  });
  const notes = Array.from({ length: s.notes }, (_, i) => ({ day: day(-Math.floor((i / s.notes) * s.changeDays)), body: `試験のメモ ${i + 1}` }));
  return {
    data: { fields, plans, zones, blocks, beds, plantings, works, crops, fertilizers, workLogs, changes, notes },
    fieldId: fields[0].id,
    planId: plan,
  };
}

// field.load_field（起動の読み込み）が返す中身の、JSON にした大きさ（バイト）の見込み
export function loadFieldBytes({ data, fieldId, planId }) {
  const body = {
    fields: data.fields,
    crops: data.crops,
    fertilizers: data.fertilizers,
    plans: data.plans.filter((plan) => plan.field_id === fieldId),
    tables: Object.fromEntries(["zones", "blocks", "beds", "plantings", "works"].map((table) => [table, data[table].filter((row) => row.plan_id === planId)])),
    logs: data.workLogs.filter((log) => log.field_id === fieldId),
  };
  return Buffer.byteLength(JSON.stringify(body));
}

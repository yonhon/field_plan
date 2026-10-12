// 計画を返す道具。data は index.ts が DB から読んだもの（表ごとの行の配列と、アプリの更新の一覧）。
// 面積、苗数、肥料の量、日程の無理は、画面と同じ部品（lib/）で計算する。
import { plantingNumbers, summarize, cropLabel } from "./lib/crops.js";
import { polygonArea, rectSize } from "./lib/geometry.js";
import { harvestEnd, planProblems, worksRange } from "./lib/schedule.js";

class ToolInputError extends Error {}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ZONE_KINDS = { tillable: "有効圃場", shed: "物置", well: "井戸", path: "通路", residue: "残渣処理場", other: "その他" };
const TIME_ZONE = "Asia/Tokyo";
const DEFAULT_CHANGE_DAYS = 30;
const MAX_CHANGE_DAYS = 120;
const bySeq = (a, b) => a.seq - b.seq;
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function dateArg(value, name) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !YMD.test(value)) {
    throw new ToolInputError(`${name} は YYYY-MM-DD の形式で指定してください。`);
  }
  return value;
}

// 記録の文。値の変化があれば「（前 → 後）」を付ける（画面の journal.js と同じ形）
function changeText(entry) {
  if (entry.before !== null) {
    return `${entry.text}（${entry.before} → ${entry.after ?? "なし"}）`;
  }
  return entry.after !== null ? `${entry.text}（${entry.after}）` : entry.text;
}

const clock = (iso) => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE });

// プランの中身を、名前で引ける形にまとめる
function scope(data, plan) {
  const own = (rows) => rows.filter((row) => row.plan_id === plan.id);
  const zones = own(data.zones);
  const tillable = zones.filter((zone) => zone.kind === "tillable");
  // 名前のない有効圃場は、画面と同じく、描いた順の番号で呼ぶ
  const zoneName = (zone) => zone.name || (zone.kind === "tillable" ? `有効圃場${tillable.indexOf(zone) + 1}` : ZONE_KINDS[zone.kind]);
  const part = { plan, zones, zoneName, blocks: own(data.blocks), beds: own(data.beds), plantings: own(data.plantings), works: own(data.works) };
  part.typeLabel = (code) => data.workTypes.find((type) => type.code === code)?.label || code;
  part.cropOf = (planting) => data.crops.find((crop) => crop.id === planting.crop_id) || null;
  part.place = (work) => {
    if (work.block_id) {
      return part.blocks.find((block) => block.id === work.block_id)?.name || "";
    }
    const planting = part.plantings.find((item) => item.id === work.planting_id);
    const bed = planting && part.beds.find((item) => item.id === planting.bed_id);
    const block = bed && part.blocks.find((item) => item.id === bed.block_id);
    return bed ? `${block?.name || ""} 畝${bed.seq}` : "";
  };
  return part;
}

// どのプランの話か。名前（一部でもよい）で選ぶ。省いたときは、最後に変更のあったプラン。それもなければ先頭
function pickPlan(data, name) {
  if (!data.plans.length) {
    throw new ToolInputError("プランがまだありません。");
  }
  if (name != null && name !== "") {
    const exact = data.plans.find((plan) => plan.name === name);
    const partial = data.plans.filter((plan) => plan.name.includes(String(name)));
    if (exact || partial.length === 1) {
      return exact || partial[0];
    }
    throw new ToolInputError(`プラン「${name}」は${partial.length ? "複数あります" : "ありません"}。プランの名前: ${data.plans.map((plan) => plan.name).join("、")}`);
  }
  const recent = data.changes.find((entry) => data.plans.some((plan) => plan.id === entry.plan_id));
  return data.plans.find((plan) => plan.id === recent?.plan_id) || data.plans[0];
}

const workLine = (part, work) => ({
  work: part.typeLabel(work.work_type),
  start: work.plan_start,
  end: work.plan_end,
  ...(work.note ? { note: work.note } : {}),
});

const PLAN_ARG = { plan: { type: "string", description: "プランの名前（一部でもよい）。省くと、最後に変更のあったプラン。" } };

export const TOOLS = [
  {
    name: "list_plans",
    title: "プランの一覧",
    description: "プランの一覧と、それぞれの規模（有効圃場の面積、区画と畝の数、品目、作業の期間）、最後に変更のあった日を返す。最初に呼ぶ。",
    inputSchema: { type: "object", properties: {} },
    run(data) {
      return {
        field: data.field ? { name: data.field.name, area_sqm: data.field.outline?.length >= 3 ? round(polygonArea(data.field.outline)) : null } : null,
        plans: data.plans.map((plan) => {
          const part = scope(data, plan);
          const range = worksRange(part.works);
          const last = data.changes.find((entry) => entry.plan_id === plan.id);
          return {
            name: plan.name,
            tillable_area_sqm: round(part.zones.filter((zone) => zone.kind === "tillable").reduce((sum, zone) => sum + polygonArea(zone.shape), 0)),
            blocks: part.blocks.length,
            beds: part.beds.length,
            crops: [...new Set(part.plantings.map((planting) => planting.crop_name).filter(Boolean))],
            works_from: range?.start || null,
            works_until: range?.end || null,
            last_change: last ? { date: last.day, no: `#${last.no}` } : null,
          };
        }),
        note: "last_change が空のプランは、変更の記録を始める前に作ったか、まだ変更がないプランです。",
      };
    },
  },
  {
    name: "get_plan",
    title: "プランの配置と作付",
    description:
      "1 つのプランの全体を返す。区域、耕起対象区画（区画の作業を含む）、区画ごとの畝、畝ごとの作付（品目、苗数、肥料の量、作業の日付）、品目ごとの集計、日程の無理の指摘。",
    inputSchema: {
      type: "object",
      properties: { ...PLAN_ARG, block: { type: "string", description: "区画の名前。指定すると、その区画だけを返す。" } },
    },
    run(data, args) {
      const part = scope(data, pickPlan(data, args.plan));
      const blocks = args.block ? part.blocks.filter((block) => block.name === String(args.block)) : part.blocks;
      if (args.block && !blocks.length) {
        throw new ToolInputError(`区画「${args.block}」はありません。区画の名前: ${part.blocks.map((block) => block.name).join("、") || "（なし）"}`);
      }
      const problems = planProblems({ ...part, workTypes: data.workTypes, crops: data.crops });
      const where = (problem) => {
        if (problem.block_id) {
          return part.blocks.find((block) => block.id === problem.block_id)?.name || "";
        }
        const planting = part.plantings.find((item) => item.id === problem.planting_id);
        return `${part.place({ planting_id: planting.id })} 作付${planting.seq}${planting.crop_name ? `（${planting.crop_name}）` : ""}`;
      };
      return {
        plan: part.plan.name,
        other_plans: data.plans.filter((plan) => plan.id !== part.plan.id).map((plan) => plan.name),
        zones: part.zones.map((zone) => ({ name: part.zoneName(zone), kind: ZONE_KINDS[zone.kind], area_sqm: round(polygonArea(zone.shape)) })),
        blocks: blocks.map((block) => ({
          name: block.name,
          zone: part.zoneName(part.zones.find((zone) => zone.id === block.zone_id)),
          area_sqm: round(polygonArea(block.shape)),
          ...(block.start_date ? { exists_from: block.start_date } : {}),
          ...(block.end_date ? { exists_until: block.end_date } : {}),
          works_before_ridging: part.works.filter((work) => work.block_id === block.id).sort(bySeq).map((work) => workLine(part, work)),
          beds: part.beds
            .filter((bed) => bed.block_id === block.id)
            .sort(bySeq)
            .map((bed) => {
              const size = rectSize(bed.shape);
              return {
                no: bed.seq,
                width_cm: Math.round(size.width * 100),
                length_m: round(size.length),
                ...(bed.removed_on ? { removed_on: bed.removed_on } : {}),
                plantings: part.plantings
                  .filter((planting) => planting.bed_id === bed.id)
                  .sort(bySeq)
                  .map((planting) => {
                    const works = part.works.filter((work) => work.planting_id === planting.id).sort(bySeq);
                    const crop = part.cropOf(planting);
                    const fertilizer = crop ? data.fertilizers.find((item) => item.id === crop.fertilizer_id) || null : null;
                    const numbers = plantingNumbers(bed.shape, crop, fertilizer);
                    return {
                      no: planting.seq,
                      crop: crop ? cropLabel(crop) : planting.crop_name || "品目なし",
                      ...(numbers.seedlings !== null ? { seedlings: numbers.seedlings } : {}),
                      ...(numbers.nitrogenKg !== null ? { nitrogen_kg: round(numbers.nitrogenKg, 2) } : {}),
                      ...(numbers.fertilizerKg !== null ? { fertilizer: fertilizer.name, fertilizer_kg: round(numbers.fertilizerKg, 2) } : {}),
                      harvest_end: harvestEnd(works),
                      works: works.map((work) => workLine(part, work)),
                    };
                  }),
              };
            }),
        })),
        totals: (() => {
          const summary = summarize({ beds: part.beds, plantings: part.plantings, crops: data.crops, fertilizers: data.fertilizers });
          return {
            crops: summary.crops.map((row) => ({
              crop: row.name,
              plantings: row.count,
              area_sqm: round(row.area),
              ...(row.seedlings ? { seedlings: row.seedlings } : {}),
              ...(row.fertilizerKg ? { fertilizer: row.fertilizer, fertilizer_kg: round(row.fertilizerKg, 2) } : {}),
            })),
            fertilizers: summary.fertilizers.map((row) => ({ name: row.name, kg: round(row.kg, 2) })),
          };
        })(),
        problems: problems.map((problem) => ({ where: where(problem), message: problem.message })),
      };
    },
  },
  {
    name: "get_schedule",
    title: "期間を決めた作業の一覧",
    description: "計画した作業を、日付の順に返す。同じ日の同じ作業は、場所（区画や畝）をまとめて 1 件にする。期間を省くと、日付の入った作業をすべて返す。",
    inputSchema: {
      type: "object",
      properties: {
        ...PLAN_ARG,
        from: { type: "string", description: "この日以降にかかる作業（YYYY-MM-DD）。" },
        to: { type: "string", description: "この日以前にかかる作業（YYYY-MM-DD）。" },
      },
    },
    run(data, args) {
      const part = scope(data, pickPlan(data, args.plan));
      const from = dateArg(args.from, "from");
      const to = dateArg(args.to, "to");
      const dated = part.works.filter((work) => work.plan_start && work.plan_end && (!from || work.plan_end >= from) && (!to || work.plan_start <= to));
      const groups = new Map();
      for (const work of dated) {
        const planting = part.plantings.find((item) => item.id === work.planting_id);
        const key = `${work.plan_start}|${work.plan_end}|${work.work_type}|${planting?.crop_name || ""}`;
        if (!groups.has(key)) {
          groups.set(key, { start: work.plan_start, end: work.plan_end, work: part.typeLabel(work.work_type), ...(planting?.crop_name ? { crop: planting.crop_name } : {}), places: [] });
        }
        groups.get(key).places.push(part.place(work));
      }
      return {
        plan: part.plan.name,
        from,
        to,
        works: [...groups.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)),
        undated_works: part.works.filter((work) => !work.plan_start || !work.plan_end).length,
      };
    },
  },
  {
    name: "get_changes",
    title: "変更の記録とメモ",
    description:
      "日ごとの、計画の変更（#番号）、本人が書いたメモ（その日の変更の理由）、アプリの更新（A 番号）を、新しい日から順に返す。計画の変更は、すべてのプランの分を返す。期間を省くと、記録のある最近の 30 日ぶん。",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "この日以降（YYYY-MM-DD）。" },
        to: { type: "string", description: "この日以前（YYYY-MM-DD）。" },
        plan: { type: "string", description: "プランの名前（一部でもよい）。指定すると、計画の変更をそのプランの分に絞る。" },
        include_app_updates: { type: "boolean", description: "アプリの更新を含めるか。省くと含める。" },
      },
    },
    run(data, args) {
      const from = dateArg(args.from, "from");
      const to = dateArg(args.to, "to");
      const plan = args.plan != null && args.plan !== "" ? pickPlan(data, args.plan) : null;
      const withUpdates = args.include_app_updates !== false;
      const inRange = (day) => (!from || day >= from) && (!to || day <= to);
      const changes = data.changes.filter((entry) => inRange(entry.day) && (!plan || entry.plan_id === plan.id));
      const notes = data.notes.filter((note) => note.body && inRange(note.day));
      const updates = withUpdates ? data.updates.filter((update) => inRange(update.date)) : [];
      let days = [...new Set([...changes.map((entry) => entry.day), ...notes.map((note) => note.day), ...updates.map((update) => update.date)])].sort().reverse();
      const total = days.length;
      days = days.slice(0, from || to ? MAX_CHANGE_DAYS : DEFAULT_CHANGE_DAYS);
      return {
        days: days.map((day) => ({
          date: day,
          note: notes.find((note) => note.day === day)?.body || "",
          plan_changes: changes
            .filter((entry) => entry.day === day)
            .sort((a, b) => a.no - b.no)
            .map((entry) => ({ no: `#${entry.no}`, time: clock(entry.at), plan: entry.plan_name || "共通", text: changeText(entry) })),
          ...(withUpdates
            ? {
                app_updates: updates
                  .filter((update) => update.date === day)
                  .sort((a, b) => a.no - b.no)
                  .map((update) => ({ no: `A${update.no}`, title: update.title, body: update.body, reason: update.reason })),
              }
            : {}),
        })),
        plans_changed: [...new Set(changes.map((entry) => entry.plan_name).filter(Boolean))],
        ...(total > days.length ? { more_days: total - days.length, hint: "from と to で期間を絞ると、残りの日を読めます。" } : {}),
        note: "plan が「共通」の変更は、品目や縮尺など、どのプランにも効く変更です。",
      };
    },
  },
  {
    name: "get_crops",
    title: "品目の設定値と肥料",
    description: "登録してある品目の設定値（畝幅、条数、株間、窒素量、肥料、マルチ、栽培日数）と、肥料の銘柄と成分を返す。空の項目は、まだ決めていない値。",
    inputSchema: { type: "object", properties: {} },
    run(data) {
      const used = (crop) => data.plantings.filter((planting) => planting.crop_id === crop.id).length;
      return {
        crops: data.crops.map((crop) => ({
          name: cropLabel(crop),
          bed_width_cm: crop.bed_width_cm,
          aisle_width_cm: crop.aisle_width_cm,
          rows: crop.row_count,
          row_gap_cm: crop.row_gap_cm,
          plant_gap_cm: crop.plant_gap_cm,
          staggered: crop.staggered,
          mulch: crop.mulch,
          nitrogen_kg_per_10a: crop.n_kg_per_10a,
          fertilizer: data.fertilizers.find((item) => item.id === crop.fertilizer_id)?.name || null,
          days_from_planting_to_first_harvest: crop.grow_days,
          harvest_days: crop.harvest_days,
          ...(crop.note ? { note: crop.note } : {}),
          plantings_in_all_plans: used(crop),
        })),
        fertilizers: data.fertilizers.map((item) => ({ name: item.name, n_pct: item.n_pct, p_pct: item.p_pct, k_pct: item.k_pct })),
      };
    },
  },
];

const text = (value, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

// 道具を実行して MCP の結果を返す。道具の名前が違うときは null
export async function runTool(name, args, getData) {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) {
    return null;
  }
  try {
    return text(await tool.run(await getData(), args && typeof args === "object" ? args : {}));
  } catch (error) {
    if (error instanceof ToolInputError) {
      return text(error.message, true);
    }
    console.error(error);
    return text("計画の読み込みに失敗しました。しばらくしてからもう一度試してください。", true);
  }
}

// 計画と作業の記録を返す道具。data は index.ts が DB から読んだもの（表ごとの行の配列と、アプリの更新の一覧）。
// 圃場はいくつもある。品目と肥料のほかは、どの圃場の話かを毎回 field で選ぶ。
// 面積、苗数、肥料の量、日程の無理、農薬の使用回数は、画面と同じ部品（lib/）で計算する。
import { plantingNumbers, summarize, cropLabel } from "./lib/crops.js";
import { polygonArea, rectSize } from "./lib/geometry.js";
import { firstHarvestDay, inputText, logEnd, specText, usageTable } from "./lib/logs.js";
import { harvestEnd, isManagement, planProblems, workName, worksRange } from "./lib/schedule.js";

class ToolInputError extends Error {}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ZONE_KINDS = { tillable: "有効圃場", shed: "物置", well: "井戸", path: "通路", residue: "残渣処理場", other: "その他" };
const TIME_ZONE = "Asia/Tokyo";
const DEFAULT_CHANGE_DAYS = 30;
const MAX_CHANGE_DAYS = 120;
const MAX_RECORDS = 200;
const INPUT_KINDS = { pesticide: "農薬", fertilizer: "肥料", seed: "種苗", material: "資材" };
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

// どの圃場の話か。名前（一部でもよい）で選ぶ。省けない
function pickField(data, name) {
  const names = data.fields.map((field) => field.name).join("、") || "（なし）";
  if (name == null || name === "") {
    throw new ToolInputError(`field で圃場を選んでください。圃場の名前: ${names}`);
  }
  const exact = data.fields.find((field) => field.name === name);
  const partial = data.fields.filter((field) => field.name.includes(String(name)));
  if (exact || partial.length === 1) {
    return exact || partial[0];
  }
  throw new ToolInputError(`圃場「${name}」は${partial.length ? "複数あります" : "ありません"}。圃場の名前: ${names}`);
}

// 選んだ圃場のプラン、変更の記録、作業の記録だけにする。区域や畝などは、プランで絞る（scope）
function inField(data, name) {
  const field = pickField(data, name);
  return {
    ...data,
    field,
    plans: data.plans.filter((plan) => plan.field_id === field.id),
    changes: data.changes.filter((entry) => entry.field_id === field.id),
    workLogs: (data.workLogs || []).filter((log) => log.field_id === field.id),
  };
}

// 作業の記録をつなぐ「実際に使うプラン」。決まっていなければ null
const activePlanOf = (data) => data.plans.find((plan) => plan.id === data.field.active_plan_id) || null;

// 文字の絞り込み。省いたときは何でも通す。一部が合えばよい
const matchText = (value, query) => query == null || query === "" || String(value || "").includes(String(query));

const fieldArea = (field) => (field.outline?.length >= 3 ? round(polygonArea(field.outline)) : null);

// どのプランの話か。名前（一部でもよい）で選ぶ。省いたときは、最後に変更のあったプラン。それもなければ先頭
function pickPlan(data, name) {
  if (!data.plans.length) {
    throw new ToolInputError("この圃場には、プランがまだありません。");
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

// 計画の作業。管理作業（防除、追肥など）は management を付け、株の手入れ・その他は中身も名前に添える
const workLine = (part, work) => ({
  work: workName(part.typeLabel(work.work_type), work.detail?.spec),
  ...(isManagement(work.work_type) ? { management: true } : {}),
  start: work.plan_start,
  end: work.plan_end,
  ...(work.note ? { note: work.note } : {}),
  ...(work.cancelled_on ? { cancelled_on: work.cancelled_on } : {}),
});

const FIELD_ARG = { field: { type: "string", description: "圃場の名前（一部でもよい）。list_fields で確かめる。" } };
const PLAN_ARG = { plan: { type: "string", description: "プランの名前（一部でもよい）。省くと、その圃場で最後に変更のあったプラン。" } };

export const TOOLS = [
  {
    name: "list_fields",
    title: "圃場の一覧",
    description: "圃場の一覧と、それぞれの面積、プランの名前、最後に変更のあった日を返す。最初に呼ぶ。ほかの道具では、ここで確かめた圃場の名前を field に入れる。",
    inputSchema: { type: "object", properties: {} },
    run(data) {
      return {
        fields: data.fields.map((field) => {
          const last = data.changes.find((entry) => entry.field_id === field.id);
          const logs = (data.workLogs || []).filter((log) => log.field_id === field.id);
          return {
            name: field.name,
            area_sqm: fieldArea(field),
            plans: data.plans.filter((plan) => plan.field_id === field.id).map((plan) => plan.name),
            active_plan: data.plans.find((plan) => plan.id === field.active_plan_id)?.name || null,
            last_change: last ? { date: last.day, no: `#${last.no}` } : null,
            records: logs.length,
            last_record: logs.map(logEnd).sort().at(-1) || null,
          };
        }),
        note: "active_plan は「実際に使うプラン」。作業の記録は、このプランの区画と畝につないでいます。",
      };
    },
  },
  {
    name: "list_plans",
    title: "プランの一覧",
    description: "1 つの圃場のプランの一覧と、それぞれの規模（有効圃場の面積、区画と畝の数、品目、作業の期間）、最後に変更のあった日を返す。",
    inputSchema: { type: "object", properties: { ...FIELD_ARG }, required: ["field"] },
    run(all, args) {
      const data = inField(all, args.field);
      return {
        field: { name: data.field.name, area_sqm: fieldArea(data.field) },
        plans: data.plans.map((plan) => {
          const part = scope(data, plan);
          const range = worksRange(part.works);
          const last = data.changes.find((entry) => entry.plan_id === plan.id);
          return {
            name: plan.name,
            ...(plan.id === data.field.active_plan_id ? { active: true } : {}),
            tillable_area_sqm: round(part.zones.filter((zone) => zone.kind === "tillable").reduce((sum, zone) => sum + polygonArea(zone.shape), 0)),
            blocks: part.blocks.length,
            beds: part.beds.length,
            crops: [...new Set(part.plantings.map((planting) => planting.crop_name).filter(Boolean))],
            works_from: range?.start || null,
            works_until: range?.end || null,
            last_change: last ? { date: last.day, no: `#${last.no}` } : null,
          };
        }),
        note: "last_change が空のプランは、変更の記録を始める前に作ったか、まだ変更がないプランです。active が true のプランは「実際に使うプラン」で、作業の記録はこのプランにつないでいます。",
      };
    },
  },
  {
    name: "get_plan",
    title: "プランの配置と作付",
    description:
      "1 つのプランの全体を返す。区域、耕起対象区画（区画の作業を含む）、区画ごとの畝、畝ごとの作付（品目、苗数、肥料の量、作業の日付）、品目ごとの集計、日程の無理の指摘。取りやめた作業には cancelled_on（取りやめた日）が付く。",
    inputSchema: {
      type: "object",
      properties: { ...FIELD_ARG, ...PLAN_ARG, block: { type: "string", description: "区画の名前。指定すると、その区画だけを返す。" } },
      required: ["field"],
    },
    run(all, args) {
      const data = inField(all, args.field);
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
        field: data.field.name,
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
    description: "計画した作業を、日付の順に返す。同じ日の同じ作業は、場所（区画や畝）をまとめて 1 件にする。期間を省くと、日付の入った作業をすべて返す。取りやめた作業には cancelled_on（取りやめた日）が付く。実際に行ったかは get_records で確かめる。",
    inputSchema: {
      type: "object",
      properties: {
        ...FIELD_ARG,
        ...PLAN_ARG,
        from: { type: "string", description: "この日以降にかかる作業（YYYY-MM-DD）。" },
        to: { type: "string", description: "この日以前にかかる作業（YYYY-MM-DD）。" },
      },
      required: ["field"],
    },
    run(all, args) {
      const data = inField(all, args.field);
      const part = scope(data, pickPlan(data, args.plan));
      const from = dateArg(args.from, "from");
      const to = dateArg(args.to, "to");
      const dated = part.works.filter((work) => work.plan_start && work.plan_end && (!from || work.plan_end >= from) && (!to || work.plan_start <= to));
      const groups = new Map();
      for (const work of dated) {
        const planting = part.plantings.find((item) => item.id === work.planting_id);
        const key = `${work.plan_start}|${work.plan_end}|${workName(work.work_type, work.detail?.spec)}|${planting?.crop_name || ""}|${work.cancelled_on || ""}`;
        if (!groups.has(key)) {
          groups.set(key, {
            start: work.plan_start,
            end: work.plan_end,
            work: workName(part.typeLabel(work.work_type), work.detail?.spec),
            ...(isManagement(work.work_type) ? { management: true } : {}),
            ...(planting?.crop_name ? { crop: planting.crop_name } : {}),
            ...(work.cancelled_on ? { cancelled_on: work.cancelled_on } : {}),
            places: [],
          });
        }
        groups.get(key).places.push(part.place(work));
      }
      return {
        field: data.field.name,
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
      "日ごとの、計画の変更（#番号）、本人が書いたメモ（その日の変更の理由）、アプリの更新（A 番号）を、新しい日から順に返す。計画の変更は、選んだ圃場のすべてのプランの分を返す。メモとアプリの更新は、すべての圃場で共通。期間を省くと、記録のある最近の 30 日ぶん。",
    inputSchema: {
      type: "object",
      required: ["field"],
      properties: {
        ...FIELD_ARG,
        from: { type: "string", description: "この日以降（YYYY-MM-DD）。" },
        to: { type: "string", description: "この日以前（YYYY-MM-DD）。" },
        plan: { type: "string", description: "プランの名前（一部でもよい）。指定すると、計画の変更をそのプランの分に絞る。" },
        include_app_updates: { type: "boolean", description: "アプリの更新を含めるか。省くと含める。" },
      },
    },
    run(all, args) {
      const data = inField(all, args.field);
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
        field: data.field.name,
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
        note: "plan が「共通」の変更は、品目や縮尺など、その圃場のどのプランにも効く変更です。品目の変更は、どの圃場にも効きます。メモ（note）はすべての圃場で共通で、ほかの圃場の変更に触れていることがあります。",
      };
    },
  },
  {
    name: "get_crops",
    title: "品目の設定値と肥料",
    description: "登録してある品目の設定値（畝幅、条数、株間、窒素量、肥料、マルチ、栽培日数）と、肥料の銘柄と成分を返す。品目と肥料は、すべての圃場で共通。空の項目は、まだ決めていない値。plantings_in_all_plans は、すべての圃場のすべてのプランでの作付の数。",
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
  {
    name: "get_records",
    title: "作業の記録",
    description:
      "実際に行った作業の記録を、新しい日から順に返す。記録ごとに、作業をした日、作業、対象の畝（記録した時点の名前、品目、畝＋通路の面積）、仕様（株間など）、資材（農薬、肥料など）、メモ、つながる計画の作業。期間、品目、作業、場所で絞れる。取りやめた計画の作業も返す。",
    inputSchema: {
      type: "object",
      required: ["field"],
      properties: {
        ...FIELD_ARG,
        from: { type: "string", description: "この日以降（YYYY-MM-DD）。" },
        to: { type: "string", description: "この日以前（YYYY-MM-DD）。" },
        crop: { type: "string", description: "品目の名前（一部でもよい）。" },
        work: { type: "string", description: "作業の名前（一部でもよい。例: 防除、定植、灌水）。" },
        place: { type: "string", description: "場所（一部でもよい。例: 区画1、区画1 畝3）。" },
      },
    },
    run(all, args) {
      const data = inField(all, args.field);
      const from = dateArg(args.from, "from");
      const to = dateArg(args.to, "to");
      const active = activePlanOf(data);
      const part = active ? scope(data, active) : null;
      const typeLabel = (code) => data.workTypes.find((type) => type.code === code)?.label || code;
      const records = data.workLogs
        // 期間にかかる記録（何日かにわたる記録は、終えた日が from 以降で、始めた日が to 以前）
        .filter((log) => (!from || logEnd(log) >= from) && (!to || log.date <= to) && matchText(workName(typeLabel(log.work_type), log.spec), args.work))
        .map((log) => ({ log, targets: (log.targets || []).filter((target) => matchText(target.crop_name, args.crop) && matchText(target.label, args.place)) }))
        .filter((item) => item.targets.length)
        .sort((a, b) => b.log.date.localeCompare(a.log.date) || String(b.log.created_at).localeCompare(String(a.log.created_at)));
      const shown = records.slice(0, MAX_RECORDS);
      // 畝ごとの、つながる計画の作業（実際に使うプランの作業）
      const plannedOf = (target) => (part && target.work_id ? part.works.find((work) => work.id === target.work_id) || null : null);
      const cancelled = part
        ? part.works
            .filter((work) => work.cancelled_on && (!from || work.cancelled_on >= from) && (!to || work.cancelled_on <= to) && matchText(part.typeLabel(work.work_type), args.work))
            .map((work) => ({ work, place: part.place(work), crop: part.plantings.find((item) => item.id === work.planting_id)?.crop_name || "" }))
            .filter((item) => matchText(item.crop, args.crop) && matchText(item.place, args.place))
            .map(({ work, place, crop }) => ({
              cancelled_on: work.cancelled_on,
              work: part.typeLabel(work.work_type),
              place,
              ...(crop ? { crop } : {}),
              planned: { start: work.plan_start, end: work.plan_end },
              ...(work.cancel_note ? { note: work.cancel_note } : {}),
            }))
        : [];
      return {
        field: data.field.name,
        active_plan: active?.name || null,
        from,
        to,
        records: shown.map(({ log, targets }) => {
          const spec = specText(log.work_type, log.spec || {});
          const inputs = [...(log.inputs || [])].sort(bySeq);
          const linked = targets.some((target) => plannedOf(target));
          return {
            date: log.date,
            ...(logEnd(log) > log.date ? { end_date: logEnd(log), days: Math.round((Date.parse(logEnd(log)) - Date.parse(log.date)) / 86400000) + 1 } : {}),
            work: workName(typeLabel(log.work_type), log.spec),
            places: [...targets]
              .sort((a, b) => a.label.localeCompare(b.label, "ja", { numeric: true }))
              .map((target) => {
                const planned = plannedOf(target);
                return {
                  place: target.label,
                  ...(target.crop_name ? { crop: target.crop_name } : {}),
                  ...(target.area_m2 != null ? { area_sqm: round(Number(target.area_m2)) } : {}),
                  ...(target.spray_l != null ? { spray_liters: round(Number(target.spray_l), 2) } : {}),
                  ...(planned ? { planned: { start: planned.plan_start, end: planned.plan_end } } : {}),
                };
              }),
            ...((log.targets || []).length > targets.length ? { other_places: log.targets.length - targets.length } : {}),
            ...(spec ? { spec } : {}),
            ...(inputs.length
              ? {
                  inputs: inputs.map((input) => ({
                    kind: INPUT_KINDS[input.kind] || input.kind,
                    text: inputText(input),
                    ...(input.amount != null ? { amount: Number(input.amount), unit: input.unit } : {}),
                  })),
                }
              : {}),
            ...(log.note ? { note: log.note } : {}),
            ...(linked ? { completes_planned_work: Boolean(log.finishes) } : {}),
          };
        }),
        ...(records.length > shown.length ? { more_records: records.length - shown.length, hint: "from と to で期間を絞ると、残りの記録を読めます。" } : {}),
        cancelled_works: cancelled,
        note:
          "places の place は、記録した時点の名前です。planned は、その畝で、この記録がつながる計画の作業の予定日です（計画にない作業にはありません）。completes_planned_work が true なら、つながる計画の作業をこの記録で終えています。other_places は、同じ記録のうち、絞り込みに合わなかった畝の数です。何日かかかった作業は 1 件の記録で、date が始めた日、end_date が終えた日（days は日数）です。completes_planned_work が false で end_date がある記録は、作業の途中で、end_date まで進んだことを表します。以前は日ごとに 1 件ずつ記録していたので、古い記録には同じ作業が日ごとに並ぶことがあります。cancelled_works は、取りやめた計画の作業です。",
      };
    },
  },
  {
    name: "get_pesticide_usage",
    title: "農薬の使用回数",
    famic: true, // 農薬の使用基準（FAMIC）を使う。外せる（toolsFor）
    description:
      "実際に使うプランの作付ごとに、防除の記録から数えた農薬の使用回数（本剤ごとと、有効成分ごと）と、使用基準の上限、使用時期の基準を満たす最初の収穫日を返す。使用基準は、防除を記録した時点の農薬登録情報の写し。",
    inputSchema: {
      type: "object",
      required: ["field"],
      properties: {
        ...FIELD_ARG,
        crop: { type: "string", description: "品目の名前（一部でもよい）。" },
        place: { type: "string", description: "場所（一部でもよい。例: 区画1、区画1 畝3）。" },
      },
    },
    run(all, args) {
      const data = inField(all, args.field);
      const active = activePlanOf(data);
      if (!active) {
        throw new ToolInputError("この圃場には、実際に使うプランが決まっていません。防除の記録は、実際に使うプランの作付につなぎます。");
      }
      const part = scope(data, active);
      const logs = data.workLogs;
      const spraysOf = (planting) =>
        logs.filter((log) => (log.inputs || []).some((input) => input.kind === "pesticide") && (log.targets || []).some((target) => target.planting_id === planting.id));
      const plantings = part.plantings
        .map((planting) => ({ planting, place: part.place({ planting_id: planting.id }), sprays: spraysOf(planting) }))
        .filter((item) => item.sprays.length && matchText(item.planting.crop_name, args.crop) && matchText(item.place, args.place))
        .sort((a, b) => a.place.localeCompare(b.place, "ja", { numeric: true }) || a.planting.seq - b.planting.seq);
      return {
        field: data.field.name,
        active_plan: active.name,
        plantings: plantings.map(({ planting, place, sprays }) => {
          const table = usageTable(logs, planting.id, planting.crop_name);
          const harvestFrom = firstHarvestDay(logs, planting.id, planting.crop_name);
          return {
            place,
            crop: planting.crop_name || "品目なし",
            sprays: [...sprays]
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((log) => ({ date: log.date, ...(logEnd(log) > log.date ? { end_date: logEnd(log) } : {}), products: (log.inputs || []).filter((input) => input.kind === "pesticide").map(inputText) })),
            ingredients: table.ingredients.map((item) => ({
              name: item.name,
              count: item.count,
              max: item.max,
              ...(item.max && item.count >= item.max ? { reached_limit: true } : {}),
              ...(item.condition ? { condition: item.condition } : {}),
            })),
            products: table.products.map((item) => ({ name: item.name, reg_no: item.reg_no, count: item.count, max: item.max })),
            ...(harvestFrom ? { harvest_ok_from: harvestFrom } : {}),
          };
        }),
        note:
          "回数は、このアプリの防除の記録から数えた回数で、1 件の記録で 1 回です。max は使用基準の上限（記録した時点の写し）で、空は写しがないものです。condition は、上限に条件があるときの基準の文です。harvest_ok_from は、最後の防除と使用時期（収穫の何日前まで）から求めた、基準を満たす最初の収穫日です。登録内容は変わることがあるので、使う前に農薬のラベルで確かめてください。",
      };
    },
  },
];

// 公開する道具。famic が false なら、農薬の使用基準を使う道具を外す
export const toolsFor = ({ famic = true } = {}) => TOOLS.filter((tool) => famic || !tool.famic);

const text = (value, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

// 道具を実行して MCP の結果を返す。道具の名前が違うときは null
export async function runTool(name, args, getData, tools = TOOLS) {
  const tool = tools.find((item) => item.name === name);
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
    return text("データの読み込みに失敗しました。しばらくしてからもう一度試してください。", true);
  }
}

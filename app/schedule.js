import { rectSize } from "./geometry.js";
// 工程の日程の計算。日付は "YYYY-MM-DD" の文字列で扱う。

// DB の field.work_types と同じ初期値（DB を使わないモードで使う）
// scope は、その作業をふつうどこに付けるか。block は耕起対象区画（畝立ての前まで）、bed は畝（畝立てから後）
export const DEFAULT_WORK_TYPES = [
  { code: "subsoil", label: "心土破砕", sort: 10, default_days: 1, min_gap_days: 0, scope: "block" },
  { code: "rotary", label: "ロータリー", sort: 20, default_days: 1, min_gap_days: 0, scope: "block" },
  { code: "solar_prep", label: "太陽熱消毒の用意", sort: 30, default_days: 2, min_gap_days: 0, scope: "block" },
  { code: "solar", label: "太陽熱消毒", sort: 40, default_days: 28, min_gap_days: 0, scope: "block" },
  { code: "green_sow", label: "緑肥の播種", sort: 50, default_days: 1, min_gap_days: 50, scope: "block" },
  { code: "mow", label: "緑肥の伐採（モア）", sort: 60, default_days: 1, min_gap_days: 0, scope: "block" },
  { code: "amend", label: "堆肥・石灰・基肥", sort: 70, default_days: 1, min_gap_days: 0, scope: "block" },
  { code: "incorporate", label: "すき込み（ロータリー）", sort: 80, default_days: 1, min_gap_days: 21, scope: "block" },
  { code: "ridge", label: "畝立て", sort: 90, default_days: 2, min_gap_days: 0, scope: "bed" },
  { code: "mulch", label: "マルチ張り", sort: 100, default_days: 2, min_gap_days: 0, scope: "bed" },
  { code: "plant", label: "定植・播種", sort: 110, default_days: 3, min_gap_days: 0, scope: "bed" },
  { code: "harvest", label: "収穫", sort: 120, default_days: 30, min_gap_days: 0, scope: "bed" },
  { code: "residue", label: "残渣処理", sort: 130, default_days: 1, min_gap_days: 0, scope: "bed" },
  { code: "nursery_sow", label: "育苗の播種", sort: 85, default_days: 1, min_gap_days: 0, scope: "bed" },
  // ここから下は記録だけに使う（計画には置かない）
  { code: "water", label: "灌水", sort: 200, default_days: 1, min_gap_days: 0, scope: "bed", plannable: false },
  { code: "check", label: "発芽確認", sort: 210, default_days: 1, min_gap_days: 0, scope: "bed", plannable: false },
  { code: "weed", label: "除草", sort: 220, default_days: 1, min_gap_days: 0, scope: "bed", plannable: false },
  { code: "spray", label: "防除", sort: 230, default_days: 1, min_gap_days: 0, scope: "bed", plannable: false },
  { code: "topdress", label: "追肥", sort: 240, default_days: 1, min_gap_days: 0, scope: "bed", plannable: false },
  { code: "install", label: "資材の設置", sort: 250, default_days: 1, min_gap_days: 0, scope: "bed", plannable: false },
  { code: "other", label: "その他", sort: 260, default_days: 1, min_gap_days: 0, scope: "bed", plannable: false },
].sort((a, b) => a.sort - b.sort);

// 計画に置ける作業の種類か。DB の plannable が false のものは記録だけに使う
export const isPlannable = (type) => type.plannable !== false;

// 工程のひな形。区画は畝立ての前まで（「両方」は学校で習った順序）、畝は畝立てから収穫と残渣処理まで
export const TEMPLATES = {
  block: {
    green: { label: "緑肥のみ", codes: ["subsoil", "rotary", "green_sow", "mow", "amend", "incorporate"] },
    both: {
      label: "緑肥と太陽熱消毒の両方",
      codes: ["subsoil", "rotary", "solar_prep", "solar", "rotary", "green_sow", "mow", "amend", "incorporate"],
    },
    plain: { label: "緑肥、太陽熱消毒なし", codes: ["subsoil", "rotary", "amend", "rotary"] },
  },
  bed: {
    mulch: { label: "マルチあり", codes: ["ridge", "mulch", "plant", "harvest", "residue"] },
    bare: { label: "マルチなし（裸地）", codes: ["ridge", "plant", "harvest", "residue"] },
  },
};

// 作業の種類ごとの色（工程表、区画と畝の図、今週やること）
export const WORK_COLORS = {
  subsoil: "#8d6e63",
  rotary: "#a1887f",
  solar_prep: "#ffb74d",
  solar: "#f57c00",
  green_sow: "#81c784",
  mow: "#4c9a2a",
  amend: "#9575cd",
  incorporate: "#795548",
  ridge: "#4db6ac",
  mulch: "#455a64",
  plant: "#0b6b72",
  harvest: "#d81b60",
  residue: "#6d4c41",
  nursery_sow: "#7cb342",
  water: "#3b82c4",
  check: "#8d8a1e",
  weed: "#558b2f",
  spray: "#b3261e",
  topdress: "#8e24aa",
  install: "#78909c",
  other: "#90a4ae",
};

const HARVEST = "harvest";

// 作付の期間（最初の作業の開始日から、最後の作業の終了日まで）。日付がなければ null
export function worksRange(works) {
  const dated = works.filter((work) => work.plan_start && work.plan_end);
  if (!dated.length) {
    return null;
  }
  return {
    start: dated.map((work) => work.plan_start).sort()[0],
    end: dated.map((work) => work.plan_end).sort().at(-1),
  };
}

// 収穫完了予定日。収穫の作業の終了日。入っていなければ null
export function harvestEnd(works) {
  const ends = works.filter((work) => work.work_type === HARVEST && work.plan_end).map((work) => work.plan_end);
  return ends.length ? ends.sort().at(-1) : null;
}

// 区画や畝が、その日にあるか。start は始まる日（null なら最初から）、end はなくなる日（null ならずっと）
export function existsOn(start, end, date) {
  return (!start || start <= date) && (!end || date < end);
}

// 期間そのものに意味がある作業（太陽熱消毒など）は、目安より短いと警告する。収穫は、短くても無理ではないので見ない
const LONG_WORK_DAYS = 7;

const toUtc = (iso) => {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};

export function addDays(iso, days) {
  return new Date(toUtc(iso) + days * 864e5).toISOString().slice(0, 10);
}

// b が a の何日後か
export function diffDays(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 864e5);
}

export function localToday(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// 作業の日数。開始日と終了日の両方を数える
export function workDays(work) {
  return work.plan_start && work.plan_end ? diffDays(work.plan_start, work.plan_end) + 1 : null;
}

function typeMap(types) {
  return new Map(types.map((type) => [type.code, type]));
}

function durationOf(work, types) {
  const days = workDays(work);
  return days && days > 0 ? days : types.get(work.work_type)?.default_days || 1;
}

function gapAfter(work, types) {
  return types.get(work.work_type)?.min_gap_days || 0;
}

// 次の作業が nextStart に始められるように、すべての作業を逆算して並べる。
// 最後の作業のあとにあける日数（すき込みのあとの 21 日など）も見込む
export function scheduleBefore(works, workTypes, nextStart) {
  const types = typeMap(workTypes);
  const result = works.map((work) => ({ ...work }));
  let next = nextStart;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    const work = result[i];
    const days = durationOf(work, types); // 日付を書き換える前に、いまの日数を取っておく
    work.plan_end = addDays(next, -1 - gapAfter(work, types));
    work.plan_start = addDays(work.plan_end, 1 - days);
    next = work.plan_start;
  }
  return result;
}

// index 番目の作業を start に始め、それより前は逆算、後ろは順に並べる（定植・播種の日を決めて並べるときに使う）
export function scheduleAnchored(works, workTypes, index, start) {
  return [...scheduleBefore(works.slice(0, index), workTypes, start), ...scheduleForward(works.slice(index), workTypes, start)];
}

// 作業を始める日から順に、すき間なく並べる
export function scheduleForward(works, workTypes, startDate) {
  const types = typeMap(workTypes);
  const result = works.map((work) => ({ ...work }));
  let start = startDate;
  for (const work of result) {
    const days = durationOf(work, types);
    work.plan_start = start;
    work.plan_end = addDays(start, days - 1);
    start = addDays(work.plan_end, 1 + gapAfter(work, types));
  }
  return result;
}

// 品目に合わせた、作業の種類の目安。
// 品目に「定植・播種から収穫開始まで」の日数があれば、定植・播種のあとにあける日数をそこから決め、
// 「収穫の日数」があれば、収穫の標準の日数に使う。works は、その作付の作業（定植・播種の日数を見る）
export function typesForCrop(workTypes, crop, works = []) {
  if (!crop) {
    return workTypes;
  }
  const planted = works.find((work) => work.work_type === "plant");
  const base = workTypes.find((type) => type.code === "plant");
  const plantDays = (planted && workDays(planted) > 0 ? workDays(planted) : base?.default_days) || 1;
  return workTypes.map((type) => {
    if (type.code === "plant" && crop.grow_days != null) {
      return { ...type, min_gap_days: Math.max(crop.grow_days - plantDays, 0) };
    }
    if (type.code === HARVEST && crop.harvest_days != null) {
      return { ...type, default_days: crop.harvest_days };
    }
    return type;
  });
}

const monthDay = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

// 1 つの区画、または 1 つの作付の作業の並びから、無理を探す。index は works の中の位置
export function sequenceProblems(works, workTypes) {
  const types = typeMap(workTypes);
  const label = (work) => types.get(work.work_type)?.label || work.work_type;
  const problems = [];
  let previous = null;
  works.forEach((work, index) => {
    if (!work.plan_start || !work.plan_end) {
      problems.push({ index, message: "日付が入っていません。" });
      return;
    }
    const days = workDays(work);
    const type = types.get(work.work_type);
    if (days < 1) {
      problems.push({ index, message: "終了日が開始日より前です。" });
    } else if (type && type.code !== HARVEST && type.default_days >= LONG_WORK_DAYS && days < type.default_days) {
      problems.push({ index, message: `${type.label}は ${type.default_days} 日が目安です（いま ${days} 日）。` });
    }
    if (previous) {
      const gap = diffDays(previous.plan_end, work.plan_start) - 1;
      const needed = gapAfter(previous, types);
      if (gap < 0) {
        problems.push({ index, message: `前の作業（${label(previous)}）と重なっているか、順番が逆です。` });
      } else if (gap < needed) {
        problems.push({ index, message: `${label(previous)}のあとは ${needed} 日あけるのが目安です（いま ${gap} 日）。` });
      }
    }
    previous = work;
  });
  return problems;
}

// プラン全体から、日程の無理を探す。
// 並びの無理に加えて、区画の作業と畝の作業のつながり、作付どうしの重なり、区画や畝がある期間とのずれを見る。
// 戻り値は { block_id または planting_id, work_id（特定の作業でなければ null）, message }
export function planProblems({ blocks, beds, plantings, works, workTypes, crops = [] }) {
  const types = typeMap(workTypes);
  const label = (work) => types.get(work.work_type)?.label || work.work_type;
  const bySeq = (a, b) => a.seq - b.seq;
  const problems = [];
  const add = (owner, work, message) => problems.push({ block_id: null, planting_id: null, ...owner, work_id: work?.id || null, message });
  // 並びの中の指摘を入れる。日付のない作業は、1 つずつ挙げずに件数だけにする
  const addSequence = (owner, list, localTypes = workTypes) => {
    const found = sequenceProblems(list, localTypes);
    const dated = found.filter((problem) => list[problem.index].plan_start && list[problem.index].plan_end);
    dated.forEach((problem) => add(owner, list[problem.index], problem.message));
    if (found.length > dated.length) {
      add(owner, null, `日付の入っていない作業が ${found.length - dated.length} 件あります。`);
    }
  };

  for (const block of blocks) {
    const owner = { block_id: block.id };
    const blockWorks = works.filter((work) => work.block_id === block.id).sort(bySeq);
    addSequence(owner, blockWorks);
    const range = worksRange(blockWorks);
    if (range && block.start_date && range.start < block.start_date) {
      add(owner, null, `区画が始まる日（${monthDay(block.start_date)}）より前に作業があります。`);
    }
    if (range && block.end_date && range.end >= block.end_date) {
      add(owner, null, `区画がなくなる日（${monthDay(block.end_date)}）以降に作業があります。`);
    }
    // 区画でいちばん最後に終わる作業。畝の最初の作業は、このあとに始める
    const last = blockWorks.filter((work) => work.plan_start && work.plan_end).sort((a, b) => a.plan_end.localeCompare(b.plan_end)).at(-1);

    for (const bed of beds.filter((item) => item.block_id === block.id)) {
      let previous = null; // 前の作付 { end: 収穫完了予定日 }
      for (const planting of plantings.filter((item) => item.bed_id === bed.id).sort(bySeq)) {
        const mine = { planting_id: planting.id };
        const own = works.filter((work) => work.planting_id === planting.id).sort(bySeq);
        // 品目を登録してある作付は、その品目の日数で見る
        const crop = crops.find((item) => item.id === planting.crop_id);
        addSequence(mine, own, typesForCrop(workTypes, crop, own));
        if (crop && crop.bed_width_cm > 0) {
          const width = Math.round(rectSize(bed.shape).width * 100);
          if (Math.abs(width - crop.bed_width_cm) >= 1) {
            add(mine, null, `畝幅が、品目の設定（${crop.bed_width_cm} cm）と違います（いま ${width} cm）。`);
          }
        }
        const span = worksRange(own);
        if (span) {
          const first = own.find((work) => work.plan_start === span.start);
          if (!previous && last) {
            const gap = diffDays(last.plan_end, span.start) - 1;
            const needed = gapAfter(last, types);
            if (gap < 0) {
              add(mine, first, `区画の作業（${label(last)}、${monthDay(last.plan_end)} まで）が終わる前に始まっています。`);
            } else if (gap < needed) {
              add(mine, first, `区画の${label(last)}のあとは ${needed} 日あけるのが目安です（いま ${gap} 日）。`);
            }
          }
          if (previous && !previous.end) {
            add(mine, first, "前の作付の収穫完了予定日が決まっていません。");
          } else if (previous && span.start <= previous.end) {
            add(mine, first, `前の作付の収穫完了予定日（${monthDay(previous.end)}）より前に始まっています。`);
          } else if (previous && previous.last && span.start <= previous.last) {
            // 収穫のあとの残渣処理などが、まだ終わっていない
            add(mine, first, `前の作付の作業が終わる日（${monthDay(previous.last)}）より前に始まっています。`);
          }
          if (bed.start_date && span.start < bed.start_date) {
            add(mine, null, `畝ができる日（${monthDay(bed.start_date)}）より前に作業があります。`);
          }
          if (bed.removed_on && span.end >= bed.removed_on) {
            add(mine, null, `畝をなくす日（${monthDay(bed.removed_on)}）以降に作業があります。`);
          }
        }
        previous = { end: harvestEnd(own), last: span?.end || null };
      }
    }
  }
  return problems;
}

// today から days 日のあいだにかかる作業。なければ、次に来る作業を 1 日ぶん返す
export function dueWorks(works, today, days = 7) {
  const until = addDays(today, days - 1);
  const dated = works.filter((work) => work.plan_start && work.plan_end).sort((a, b) => a.plan_start.localeCompare(b.plan_start));
  const due = dated.filter((work) => work.plan_start <= until && work.plan_end >= today);
  if (due.length) {
    return { due, upcoming: [] };
  }
  const next = dated.find((work) => work.plan_start > until);
  return { due: [], upcoming: next ? dated.filter((work) => work.plan_start === next.plan_start) : [] };
}

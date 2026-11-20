// 「収支」のタブ。作付ごとの収支の一覧（docs の 7.2）。いまは、収支の数字のうち作業時間だけを出す。
// 売上と経費の列は、収量・単価・資材の単価を入れられるようにしてから足す。
// 作業時間の分け方（作付の詳細と区画の頭も、ここの timeAllocation を使う）:
// - 計測は、計画の作業（work_ids）か、つないだ実績（log_id）を通して、作付か区画に付ける。
//   1 件の計測に作付がいくつもあるときは、畝＋通路の面積の比で分ける（区画の作業は区画の面積）。
// - 区画の時間 = 区画全体にした作業 + 中の作付でした作業。
// - 作付の時間 = その作付でした作業 + 区画全体にした作業を、その日にある畝の作付に面積の比で分けた分。
//   畝立ての前の作業（その日に作付がない）は、その区画で次に入る作付に分ける。どの作付もない時期の作業は、区画にだけ残す。
// 計測は圃場ごとに持つので、この一覧も開いている圃場だけの合計（ほかの圃場の時間は足さない）
import { draw } from "./draw.js";
import { escapeHtml } from "./html.js";
import { polygonArea } from "./geometry.js";
import { bedAreas, logEnd, plantingStart } from "./logs.js";
import { existsOn } from "./schedule.js";
import { SESSION_KINDS, allocateMinutes, formatMinutes, splitMinutes } from "./work-time.js";

const $ = (id) => document.getElementById(id);

let ctx = null; // { state, typeLabel, openDetail }
const state = () => ctx.state;
const bySeq = (a, b) => a.seq - b.seq;

// 作付の期間（始まりと終わりの日）。始まりは plantingStart、終わりは計画の作業の終わりと記録の日のうち、いちばん遅い日
function plantingSpan(planting) {
  const s = state();
  const ends = [
    ...s.works.filter((work) => work.planting_id === planting.id && !work.cancelled_on).map((work) => work.plan_end || work.plan_start),
    ...(s.logs || []).filter((log) => (log.targets || []).some((target) => target.planting_id === planting.id)).map(logEnd),
  ].filter(Boolean);
  return { start: plantingStart(planting, s.works, s.logs || []), end: ends.sort().at(-1) || null };
}

// その日に、区画全体の作業を分ける畝の作付。その日にある畝（なければ、あとでできる畝）ごとに、
// その日に畝にある作付、なければ次に入る作付。どちらもない畝は入れない
function blockPlantingsOn(blockId, date) {
  const s = state();
  const block = s.blocks.find((item) => item.id === blockId);
  if (!block) {
    return [];
  }
  const all = s.beds.filter((bed) => bed.block_id === blockId);
  let beds = all.filter((bed) => existsOn(bed.start_date, bed.removed_on, date));
  if (!beds.length) {
    beds = all.filter((bed) => bed.start_date && bed.start_date > date);
  }
  const chosen = [];
  for (const bed of beds) {
    const list = s.plantings.filter((planting) => planting.bed_id === bed.id).sort(bySeq);
    const spans = list.map((planting) => ({ planting, ...plantingSpan(planting) }));
    const current = spans.find((item) => (!item.start || item.start <= date) && (!item.end || date <= item.end));
    const next = spans.find((item) => item.start && item.start > date);
    const planting = (current || next)?.planting;
    if (planting) {
      chosen.push({ bed, planting });
    }
  }
  const areas = bedAreas(block, chosen.map((item) => item.bed));
  return chosen.map((item) => ({ id: item.planting.id, weight: areas.get(item.bed.id) }));
}

// 計測の持ち主（作付か区画）。key は "planting:ID" か "block:ID"
function ownersOf(session, area) {
  if ((session.work_ids || []).length) {
    return session.work_ids
      .map((id) => state().works.find((work) => work.id === id))
      .filter(Boolean)
      .map((work) => {
        if (work.block_id) {
          return { key: `block:${work.block_id}`, weight: area.blocks.get(work.block_id) };
        }
        const planting = state().plantings.find((item) => item.id === work.planting_id);
        return { key: `planting:${work.planting_id}`, weight: planting ? area.beds.get(planting.bed_id) : null };
      });
  }
  const log = session.log_id && (state().logs || []).find((item) => item.id === session.log_id);
  if (log) {
    return (log.targets || [])
      .filter((target) => target.planting_id || target.block_id)
      .map((target) => ({ key: target.planting_id ? `planting:${target.planting_id}` : `block:${target.block_id}`, weight: Number(target.area_m2) || null }));
  }
  return [];
}

// 畝の ID → 畝＋通路の面積（区画の中のすべての畝で求める）。区画の ID → 区画の面積
function areas() {
  const beds = new Map();
  for (const block of state().blocks) {
    for (const [id, area] of bedAreas(block, state().beds.filter((bed) => bed.block_id === block.id))) {
      beds.set(id, area);
    }
  }
  return { beds, blocks: new Map(state().blocks.map((block) => [block.id, polygonArea(block.shape)])) };
}

// 開いている圃場の作業時間を、作付と区画に分ける（work-time.js の allocateMinutes の返り値）。
// 作業時間は実際に使うプランの作業につないでいるので、ほかのプランを開いているときは null
export function timeAllocation() {
  const s = state();
  if (!ctx || !s.field || s.field.active_plan_id !== s.plan?.id) {
    return null;
  }
  const area = areas();
  const work = (s.sessions || []).filter((session) => session.field_id === s.field.id && session.kind === "work");
  return allocateMinutes(work, {
    ownersOf: (session) => ownersOf(session, area),
    plantingBlock: (id) => {
      const planting = s.plantings.find((item) => item.id === id);
      return s.beds.find((bed) => bed.id === planting?.bed_id)?.block_id || null;
    },
    blockPlantings: blockPlantingsOn,
  });
}

// 作業の種類ごとの内訳の文。区画全体の作業から分けた分は「（区画）」を付ける。例: 収穫 0:45、防除（区画） 0:20
export function typesText(types, typeLabel = ctx.typeLabel) {
  return [...types.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, minutes]) => {
      const shared = key.startsWith("block:");
      const code = shared ? key.slice(6) : key;
      return `${typeLabel(code) || "作業"}${shared ? "（区画）" : ""} ${formatMinutes(minutes)}`;
    })
    .join("、");
}

function plantingPlace(id) {
  const planting = state().plantings.find((item) => item.id === id);
  const bed = planting && state().beds.find((item) => item.id === planting.bed_id);
  const block = bed && state().blocks.find((item) => item.id === bed.block_id);
  return {
    place: bed ? `${block?.name || ""} 畝${bed.seq}${planting.seq > 1 ? `・作付 ${planting.seq}` : ""}` : "（もうない作付）",
    crop: planting?.crop_name || "",
    sort: [block?.name || "", bed?.seq ?? 0, planting?.seq ?? 0],
    open: Boolean(planting),
  };
}

const compareSort = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return typeof a[i] === "number" && typeof b[i] === "number" ? a[i] - b[i] : String(a[i] ?? "").localeCompare(String(b[i] ?? ""), "ja");
    }
  }
  return 0;
};

export function renderRevenue() {
  if (!ctx || !state().field || $("revenueView").hidden) {
    return;
  }
  const allocation = timeAllocation();
  if (!allocation) {
    draw($("revenueBody"), '<p class="muted">開いているプランは、実際に使うプランではありません。作業時間は、実際に使うプランの作業につないでいるので、実際に使うプランを開くと出ます。</p>');
    return;
  }
  const sessions = (state().sessions || []).filter((session) => session.field_id === state().field.id);
  const commonMinutes = (kind) => splitMinutes(sessions.filter((session) => session.kind === kind), () => []).unassigned;
  const rows = [...allocation.plantings.entries()]
    .map(([id, item]) => ({ id, ...item, total: item.direct + item.fromBlock, ...plantingPlace(id) }))
    .sort((a, b) => compareSort(a.sort, b.sort));
  // 区画全体の作業のうち、分ける作付がなかった分（区画にだけ残る）
  const left = [...allocation.blocks.entries()]
    .map(([id, item]) => ({ id, minutes: item.own - item.shared, name: state().blocks.find((block) => block.id === id)?.name || "（もうない区画）" }))
    .filter((item) => item.minutes > 0.5);
  const assigned = rows.reduce((sum, row) => sum + row.total, 0) + left.reduce((sum, item) => sum + item.minutes, 0);
  const body =
    rows
      .map(
        (row) =>
          `<tr${row.open ? ` data-planting="${escapeHtml(row.id)}" class="is-link"` : ""}>` +
          `<td>${escapeHtml(row.place)}</td><td>${escapeHtml(row.crop)}</td>` +
          `<td class="num">${formatMinutes(row.total)}</td><td class="num">${row.fromBlock ? formatMinutes(row.fromBlock) : ""}</td>` +
          `<td class="muted">${escapeHtml(typesText(row.types))}</td></tr>`
      )
      .join("") +
    left
      .map(
        (item) =>
          `<tr><td>${escapeHtml(item.name)} の区画の作業</td><td></td><td class="num">${formatMinutes(item.minutes)}</td><td></td>` +
          '<td class="muted">その日に分ける作付がなかった、区画全体の作業</td></tr>'
      )
      .join("");
  draw(
    $("revenueBody"),
    '<div class="table-scroll"><table class="work-table revenue-table"><thead><tr><th>場所</th><th>品目</th><th class="num">作業時間</th><th class="num">うち区画の作業</th><th>内訳</th></tr></thead>' +
      `<tbody>${body || '<tr><td colspan="5" class="muted">作業時間を測った作付はまだありません。「今日」のタブの「始める」で測ります。</td></tr>'}</tbody>` +
      `<tfoot><tr><th colspan="2">作付と区画の合計</th><td class="num">${formatMinutes(assigned)}</td><td></td><td></td></tr>` +
      `<tr><th colspan="2">${SESSION_KINDS.prep}</th><td class="num">${formatMinutes(commonMinutes("prep"))}</td><td></td><td class="muted">どの作付にも分けない時間</td></tr>` +
      `<tr><th colspan="2">${SESSION_KINDS.move}</th><td class="num">${formatMinutes(commonMinutes("move"))}</td><td></td><td class="muted">どの作付にも分けない時間</td></tr>` +
      `<tr><th colspan="2">実績につないでいない作業</th><td class="num">${formatMinutes(allocation.unassigned)}</td><td></td><td class="muted">計画にない作業。「今日」のタブの「直す」で、その日の実績につなげます</td></tr></tfoot>` +
      "</table></div>"
  );
}

export function initRevenue(context) {
  ctx = context;
  $("revenueBody").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-planting]");
    if (row) {
      ctx.openDetail("planting", row.dataset.planting);
    }
  });
}

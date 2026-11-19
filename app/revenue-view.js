// 「収支」のタブ。作付ごとの収支の一覧（docs の 7.2）。いまは、収支の数字のうち作業時間だけを出す。
// 売上と経費の列は、収量・単価・資材の単価を入れられるようにしてから足す。
// 計測（work-time.js）は、計画の作業（work_ids）か、つないだ実績（log_id）を通して作付と区画に分ける。
// 1 件の計測に作付がいくつもあるときは、畝＋通路の面積の比で分ける（区画の作業は区画の面積）。
// 計測は圃場ごとに持つので、この一覧も開いている圃場だけの合計（ほかの圃場の時間は足さない）
import { draw } from "./draw.js";
import { escapeHtml } from "./html.js";
import { polygonArea } from "./geometry.js";
import { bedAreas } from "./logs.js";
import { SESSION_KINDS, formatMinutes, splitMinutes } from "./work-time.js";

const $ = (id) => document.getElementById(id);

let ctx = null; // { state, typeLabel, openDetail }
const state = () => ctx.state;

// 畝の ID → 畝＋通路の面積。区画の ID → 区画の面積
function areas() {
  const beds = new Map();
  for (const block of state().blocks) {
    const list = state().beds.filter((bed) => bed.block_id === block.id);
    for (const [id, area] of bedAreas(block, list)) {
      beds.set(id, area);
    }
  }
  const blocks = new Map(state().blocks.map((block) => [block.id, polygonArea(block.shape)]));
  return { beds, blocks };
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

function ownerName(key) {
  const [kind, id] = key.split(":");
  if (kind === "block") {
    const block = state().blocks.find((item) => item.id === id);
    return { place: `${block?.name || "（もうない区画）"} の区画の作業`, crop: "", sort: [block?.name || "", -1] };
  }
  const planting = state().plantings.find((item) => item.id === id);
  const bed = planting && state().beds.find((item) => item.id === planting.bed_id);
  const block = bed && state().blocks.find((item) => item.id === bed.block_id);
  return {
    place: bed ? `${block?.name || ""} 畝${bed.seq}${planting.seq > 1 ? `・作付 ${planting.seq}` : ""}` : "（もうない作付）",
    crop: planting?.crop_name || "",
    sort: [block?.name || "", bed?.seq ?? 0, planting?.seq ?? 0],
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
  const active = state().field.active_plan_id === state().plan.id;
  const sessions = (state().sessions || []).filter((session) => session.field_id === state().field.id);
  const area = areas();
  const work = sessions.filter((session) => session.kind === "work");
  const common = sessions.filter((session) => session.kind !== "work");
  const total = splitMinutes(work, (session) => ownersOf(session, area));
  // 作業の種類ごとの内訳。持ち主と種類の組で分ける
  const byType = splitMinutes(work, (session) => ownersOf(session, area).map((owner) => ({ ...owner, key: `${owner.key}|${session.work_type || ""}` })));
  const rows = [...total.minutes.entries()]
    .map(([key, minutes]) => ({ key, minutes, ...ownerName(key) }))
    .sort((a, b) => compareSort(a.sort, b.sort));
  const typesOf = (key) =>
    [...byType.minutes.entries()]
      .filter(([pair]) => pair.startsWith(`${key}|`))
      .sort((a, b) => b[1] - a[1])
      .map(([pair, minutes]) => `${escapeHtml(ctx.typeLabel(pair.slice(key.length + 1)) || "作業")} ${formatMinutes(minutes)}`)
      .join("、");
  const commonMinutes = (kind) => splitMinutes(common.filter((session) => session.kind === kind), () => []).unassigned;
  const assigned = [...total.minutes.values()].reduce((sum, minutes) => sum + minutes, 0);
  const body = rows
    .map((row) => {
      const [kind, id] = row.key.split(":");
      const open = kind === "planting" && state().plantings.some((item) => item.id === id);
      return (
        `<tr${open ? ` data-planting="${escapeHtml(id)}" class="is-link"` : ""}>` +
        `<td>${escapeHtml(row.place)}</td><td>${escapeHtml(row.crop)}</td>` +
        `<td class="num">${formatMinutes(row.minutes)}</td><td class="muted">${typesOf(row.key)}</td></tr>`
      );
    })
    .join("");
  draw(
    $("revenueBody"),
    (active ? "" : '<p class="muted">開いているプランは、実際に使うプランではありません。作業時間は、実際に使うプランの作業につないでいるので、このプランの作付には出ません。</p>') +
      '<div class="table-scroll"><table class="work-table revenue-table"><thead><tr><th>場所</th><th>品目</th><th class="num">作業時間</th><th>内訳</th></tr></thead>' +
      `<tbody>${body || '<tr><td colspan="4" class="muted">作業時間を測った作付はまだありません。「今日」のタブの「始める」で測ります。</td></tr>'}</tbody>` +
      `<tfoot><tr><th colspan="2">作付と区画の合計</th><td class="num">${formatMinutes(assigned)}</td><td></td></tr>` +
      `<tr><th colspan="2">${SESSION_KINDS.prep}</th><td class="num">${formatMinutes(commonMinutes("prep"))}</td><td class="muted">どの作付にも分けない時間</td></tr>` +
      `<tr><th colspan="2">${SESSION_KINDS.move}</th><td class="num">${formatMinutes(commonMinutes("move"))}</td><td class="muted">どの作付にも分けない時間</td></tr>` +
      `<tr><th colspan="2">実績につないでいない作業</th><td class="num">${formatMinutes(total.unassigned)}</td><td class="muted">計画にない作業。「今日」のタブの「直す」で、その日の実績につなげます</td></tr></tfoot>` +
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

// 「収支」のタブ。作付ごとの収支の一覧（docs の 7.2）。行はプランのすべての作付で、収量と売上の見込み、収穫量の実績、作業時間を出す。
// 経費の列は、資材の単価を入れられるようにしてから足す。
// 収量と売上の見込み（作付の詳細、苗と肥料の集計も、ここの plantingRevenue を使う。計算は revenue.js）と、市況の読み込みも置く。
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
import { cropLabel, plantingNumbers, plantingSpec } from "./crops.js";
import { bedAreas, logEnd, plantingStart } from "./logs.js";
import { forecast, harvestActual, harvestWindow, marketEstimate } from "./revenue.js";
import { existsOn, localToday } from "./schedule.js";
import { COMMON_KINDS, SESSION_KINDS, allocateMinutes, formatMinutes, splitMinutes } from "./work-time.js";

const $ = (id) => document.getElementById(id);

let ctx = null; // { state, typeLabel, openDetail, setStatus, onMarket }
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

// ---- 市況（品目の想定単価の推定に使う。revenue.js の marketEstimate） ----
// state.market = { items: [{ item_name, days }] | null, prices: Map(品目名 → [{ sale_date, avg_price }]), at, failedAt, loading }。
// 起動のときの読み込み（load_field）とは別に、あとから読む。届いたら ctx.onMarket で描き直す（{ prices } は、品目の市況を読んだか）。メモリにだけ持つ（field-cache には入れない）
const MARKET_FRESH_MS = 6 * 60 * 60 * 1000; // 市況は 1 日 1 回増えるので、これより古ければ読み直す
const MARKET_RETRY_MS = 5 * 60 * 1000; // 読めなかったあと、これより前には読み直さない（描き直しのたびに読まない）

function market() {
  const s = state();
  if (!s.market) {
    s.market = { items: null, prices: new Map(), at: 0, failedAt: 0, loading: false };
  }
  return s.market;
}

// 品目に結んだ市況の品目名のうち、まだ読んでいないものと、品目名の一覧を読む。古くなっていれば読み直す。
// 起動や読み直しのあと（app.js の refreshViews）、アプリに戻ったとき、品目の市況での品目名を変えたときに呼ぶ
export async function loadMarket() {
  if (!ctx || !state().store?.marketPrices) {
    return;
  }
  const m = market();
  const now = Date.now();
  if (m.loading || now - m.failedAt < MARKET_RETRY_MS) {
    return;
  }
  const stale = now - m.at > MARKET_FRESH_MS;
  const names = [...new Set(state().crops.map((crop) => (crop.market_item_name || "").trim()).filter(Boolean))];
  const missing = stale ? names : names.filter((name) => !m.prices.has(name));
  if (!stale && !missing.length) {
    return;
  }
  m.loading = true;
  try {
    const [items, rows] = await Promise.all([stale ? state().store.marketItems() : m.items, state().store.marketPrices(missing)]);
    const prices = new Map(missing.map((name) => [name, []]));
    for (const row of rows) {
      prices.get(row.item_name)?.push(row);
    }
    m.items = items;
    if (stale) {
      m.prices = prices;
      m.at = now;
    } else {
      prices.forEach((list, name) => m.prices.set(name, list));
    }
  } catch (error) {
    m.failedAt = now;
    ctx.setStatus?.(`市況を読めませんでした: ${error.message}`);
    return;
  } finally {
    m.loading = false;
  }
  // 見込みを描き直すのは、品目に結んだ市況を読んだときだけ。品目名の一覧だけなら、台帳の候補だけ（起動のたびに全部を描き直さない）
  ctx.onMarket?.({ prices: missing.length > 0 });
}

// 市況の品目名の一覧（取引のあった日数つき）。まだ読んでいなければ null
export const marketItems = () => (ctx ? state().market?.items || null : null);

// 何件もの作付の見込みを出すときに、作付ごとの作業と記録、畝の面積を 1 回だけ集める（作付ごとに全体をなめ直さない）。
// 面積は、作付の詳細の頭と同じく、今日ある区画の畝で分けた畝＋通路の面積
function revenueIndex() {
  const s = state();
  const today = localToday();
  const push = (map, key, item) => (map.has(key) ? map.get(key).push(item) : map.set(key, [item]));
  const works = new Map();
  for (const work of s.works) {
    if (work.planting_id) {
      push(works, work.planting_id, work);
    }
  }
  const logs = new Map();
  for (const log of s.logs || []) {
    for (const id of new Set((log.targets || []).map((target) => target.planting_id).filter(Boolean))) {
      push(logs, id, log);
    }
  }
  const beds = new Map(s.beds.map((bed) => [bed.id, bed]));
  const blocks = new Map(s.blocks.map((block) => [block.id, block]));
  const areas = new Map();
  for (const block of s.blocks) {
    const live = s.beds.filter((bed) => bed.block_id === block.id && existsOn(bed.start_date, bed.removed_on, today));
    bedAreas(block, live).forEach((area, id) => areas.set(id, area));
  }
  return { works, logs, beds, blocks, areas, crops: new Map(s.crops.map((crop) => [crop.id, crop])) };
}

// 作付の畝＋通路の面積（㎡）。今日ない畝は、その畝だけで求める
function plantingArea(bed, index) {
  const block = bed && index.blocks.get(bed.block_id);
  if (!block) {
    return null;
  }
  return index.areas.get(bed.id) ?? bedAreas(block, [bed]).get(bed.id) ?? null;
}

// 1 つの作付の収量と売上の見込み（revenue.js の forecast）と、収穫量の実績。
// 実績は、実際に使うプランを開いているときだけ（記録は実際に使うプランの作付につないでいる）。それ以外は actual が null。
// marketLoading は、市況での品目名を結んであるのに、まだ市況を読んでいないとき。
// 何件も続けて出すときは、revenueIndex() を 1 回作って渡す
export function plantingRevenue(planting, index = revenueIndex()) {
  const s = state();
  const bed = index.beds.get(planting.bed_id);
  const crop = index.crops.get(planting.crop_id) || null;
  const logs = index.logs.get(planting.id) || [];
  const areaM2 = plantingArea(bed, index);
  const seedlings = bed && crop ? plantingNumbers(bed.shape, crop, null, plantingSpec(planting, crop, logs)).seedlings : null;
  const window = harvestWindow(index.works.get(planting.id) || []);
  const marketName = (crop?.market_item_name || "").trim();
  const prices = marketName ? s.market?.prices.get(marketName) : undefined;
  const estimate = prices ? marketEstimate(prices, window) : null;
  const active = Boolean(s.field) && s.field.active_plan_id === s.plan?.id;
  return {
    ...forecast(planting, crop, { seedlings, areaM2, estimate }),
    crop,
    areaM2,
    seedlings,
    window,
    marketName,
    marketLoading: Boolean(marketName) && prices === undefined,
    actual: active ? harvestActual(planting.id, logs) : null,
  };
}

// 収穫量の実績から見た売上（実績の収穫量 × 出荷率 × 単価）。収穫量か単価がなければ null
export const actualSales = (item) => (item.actual?.kg && item.price ? (item.actual.kg * item.rate.pct * item.price.yen) / 100 : null);

// 作付の品目の呼び名。苗と肥料の集計（crops.js の summarize）と同じ名前にする
export const plantingCropName = (planting, crop) => (crop ? cropLabel(crop) : planting.crop_name || "品目なし");

// 作付の並びの見込みを、品目ごとに足す。苗と肥料の集計の窓と、「収支」のタブの品目ごとの合計で使う。
// 収量か売上の分からない作付は、その合計に入れず、数を missingYield、missingSales に数える
export function revenueByCrop(plantings, index = revenueIndex()) {
  const byCrop = new Map();
  for (const planting of plantings) {
    const item = plantingRevenue(planting, index);
    const name = plantingCropName(planting, item.crop);
    if (!byCrop.has(name)) {
      byCrop.set(name, { name, count: 0, yieldKg: 0, salesYen: 0, harvestKg: 0, missingYield: 0, missingSales: 0 });
    }
    const row = byCrop.get(name);
    row.count += 1;
    row.yieldKg += item.yieldKg ?? 0;
    row.salesYen += item.salesYen ?? 0;
    row.harvestKg += item.actual?.kg ?? 0;
    row.missingYield += item.yieldKg === null ? 1 : 0;
    row.missingSales += item.salesYen === null ? 1 : 0;
  }
  return [...byCrop.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

const PRICE_FROM = { planting: "作付", crop: "品目", market: "市況" };

// 単価の出どころの短い名前。市況から推した単価は、どの期間の市況かも添える（revenue.js の marketEstimate の widen）:
// 収穫の時期の市況なら「市況・収穫期」、前後に広げたなら「市況・前後 14 日」、足りずに全期間なら「市況・全期間」
export function priceSource(price) {
  if (price.from !== "market") {
    return PRICE_FROM[price.from];
  }
  const widen = price.estimate.widen;
  return widen === "all" ? "市況・全期間" : widen ? `市況・前後 ${widen} 日` : "市況・収穫期";
}

// 市況から推した単価の、指したときに出す説明。日数と、使った取引日の月、25〜75 % の幅
export function priceTitle(price) {
  const estimate = price.from === "market" ? price.estimate : null;
  if (!estimate) {
    return "";
  }
  const month = (iso) => iso.slice(0, 7).replace("-", "/");
  const where = estimate.widen === "all" ? "収穫の時期の市況が足りないため、市況のある全期間" : estimate.widen ? `収穫の時期の前後 ${estimate.widen} 日` : "収穫の時期";
  return `${where}の卸値の中央値（${estimate.days} 日分、${month(estimate.from)}〜${month(estimate.to)}、幅 ${formatYen(estimate.low)}〜${formatYen(estimate.high)} 円）`;
}
export const formatYen = (value) => (value === null || value === undefined ? "" : Math.round(value).toLocaleString("ja-JP"));
export const formatKg = (value, digits = 1) =>
  value === null || value === undefined ? "" : value.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });

// 作付ごとの表。行はプランのすべての作付（作業時間だけが残った、もうない作付も）。作業時間と収穫の実績の列は、実際に使うプランのときだけ
function plantingTable(allocation, index) {
  const s = state();
  const active = Boolean(allocation);
  const ids = [...new Set([...s.plantings.map((planting) => planting.id), ...(allocation ? allocation.plantings.keys() : [])])];
  const rows = ids
    .map((id) => {
      const planting = s.plantings.find((item) => item.id === id);
      const time = allocation?.plantings.get(id);
      return { id, item: planting ? plantingRevenue(planting, index) : null, time, ...plantingPlace(id) };
    })
    .sort((a, b) => compareSort(a.sort, b.sort));
  const columns = active ? 11 : 6;
  const body = rows
    .map(({ id, item, time, place, crop, open }) => {
      const cells = item
        ? `<td class="num">${formatKg(item.yieldKg)}</td><td class="num">${item.rate.pct} %</td>` +
          `<td class="num"${item.price?.estimate ? ` title="${escapeHtml(priceTitle(item.price))}"` : ""}>` +
          `${item.price ? `${formatYen(item.price.yen)}<span class="muted">（${escapeHtml(priceSource(item.price))}）</span>` : ""}</td>` +
          `<td class="num">${formatYen(item.salesYen)}</td>`
        : "<td></td><td></td><td></td><td></td>";
      const actual = active
        ? `<td class="num">${item?.actual?.count ? formatKg(item.actual.kg) : ""}</td><td class="num">${item ? formatYen(actualSales(item)) : ""}</td>` +
          `<td class="num">${time ? formatMinutes(time.direct + time.fromBlock) : ""}</td><td class="num">${time?.fromBlock ? formatMinutes(time.fromBlock) : ""}</td>` +
          `<td class="muted">${time ? escapeHtml(typesText(time.types)) : ""}</td>`
        : "";
      return `<tr${open ? ` data-planting="${escapeHtml(id)}" class="is-link"` : ""}><td>${escapeHtml(place)}</td><td>${escapeHtml(crop)}</td>${cells}${actual}</tr>`;
    })
    .join("");
  const head =
    '<tr><th>場所</th><th>品目</th><th class="num">収量の見込み（kg）</th><th class="num">出荷率</th><th class="num">単価（円/kg）</th><th class="num">売上の見込み（円）</th>' +
    (active ? '<th class="num">収穫量（kg）</th><th class="num">収穫量から見た売上（円）</th><th class="num">作業時間</th><th class="num">うち区画の作業</th><th>作業時間の内訳</th>' : "") +
    "</tr>";
  return (
    `<div class="table-scroll"><table class="work-table revenue-table"><thead>${head}</thead>` +
    `<tbody>${body || `<tr><td colspan="${columns}" class="muted">このプランには、まだ作付がありません。</td></tr>`}</tbody>` +
    (active ? `<tfoot>${timeFoot(allocation)}</tfoot>` : "") +
    "</table></div>"
  );
}

// 作業時間の合計の行（区画にだけ残った時間、作付と区画の合計、どの作付にも分けない時間、実績につないでいない作業）。
// 作業時間の列（9 列目）にそろえる
function timeFoot(allocation) {
  const sessions = (state().sessions || []).filter((session) => session.field_id === state().field.id);
  const commonMinutes = (kind) => splitMinutes(sessions.filter((session) => session.kind === kind), () => []).unassigned;
  // 区画全体の作業のうち、分ける作付がなかった分（区画にだけ残る）
  const left = [...allocation.blocks.entries()]
    .map(([id, item]) => ({ id, minutes: item.own - item.shared, name: state().blocks.find((block) => block.id === id)?.name || "（もうない区画）" }))
    .filter((item) => item.minutes > 0.5);
  const assigned =
    [...allocation.plantings.values()].reduce((sum, item) => sum + item.direct + item.fromBlock, 0) + left.reduce((sum, item) => sum + item.minutes, 0);
  const row = (label, minutes, note) =>
    `<tr><th colspan="8">${label}</th><td class="num">${formatMinutes(minutes)}</td><td></td><td class="muted">${note}</td></tr>`;
  return (
    left.map((item) => row(`${escapeHtml(item.name)} の区画の作業`, item.minutes, "その日に分ける作付がなかった、区画全体の作業")).join("") +
    row("作業時間: 作付と区画の合計", assigned, "") +
    COMMON_KINDS.map((kind) => row(SESSION_KINDS[kind], commonMinutes(kind), "どの作付にも分けない時間")).join("") +
    row("実績につないでいない作業", allocation.unassigned, "計画にない作業。「今日」のタブの「直す」で、その日の実績につなげます")
  );
}

// 品目ごとの合計の表
function cropTable(active, index) {
  const crops = revenueByCrop(state().plantings, index);
  if (!crops.length) {
    return "";
  }
  const sum = (key) => crops.reduce((total, row) => total + row[key], 0);
  const missing = (count) => (count ? `<span class="muted">（${count} 件は値なし）</span>` : "");
  const body = crops
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.name)}</td><td class="num">${row.count}</td>` +
        `<td class="num">${formatKg(row.yieldKg)}${missing(row.missingYield)}</td><td class="num">${formatYen(row.salesYen)}${missing(row.missingSales)}</td>` +
        (active ? `<td class="num">${formatKg(row.harvestKg)}</td>` : "") +
        "</tr>"
    )
    .join("");
  return (
    '<h3 class="revenue-subhead">品目ごとの合計</h3><div class="table-scroll"><table class="work-table revenue-table revenue-crops">' +
    `<thead><tr><th>品目</th><th class="num">作付の数</th><th class="num">収量の見込み（kg）</th><th class="num">売上の見込み（円）</th>${active ? '<th class="num">収穫量（kg）</th>' : ""}</tr></thead>` +
    `<tbody>${body}</tbody>` +
    `<tfoot><tr><th>合計</th><td class="num">${sum("count")}</td><td class="num">${formatKg(sum("yieldKg"))}</td><td class="num">${formatYen(sum("salesYen"))}</td>` +
    `${active ? `<td class="num">${formatKg(sum("harvestKg"))}</td>` : ""}</tr></tfoot></table></div>`
  );
}

export function renderRevenue() {
  if (!ctx || !state().field || $("revenueView").hidden) {
    return;
  }
  // 作業時間と収穫の実績は、実際に使うプランの作業と作付につないでいるので、ほかのプランでは見込みだけを出す
  const allocation = timeAllocation();
  const index = revenueIndex();
  draw(
    $("revenueBody"),
    (allocation ? "" : '<p class="muted">開いているプランは、実際に使うプランではありません。見込みだけを出します。作業時間と収穫量は、実際に使うプランを開くと出ます。</p>') +
      plantingTable(allocation, index) +
      cropTable(Boolean(allocation), index)
  );
}

export function initRevenue(context) {
  ctx = context;
  // アプリに戻ったときに、古くなった市況を読み直す（loadMarket が、古いかを確かめる）
  document.addEventListener("app-returned", () => loadMarket());
  // 起動のときは、圃場を読み終えてからここへ来る（app.js の loadFieldData では、まだ ctx がない）
  loadMarket();
  $("revenueBody").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-planting]");
    if (row) {
      ctx.openDetail("planting", row.dataset.planting);
    }
  });
}

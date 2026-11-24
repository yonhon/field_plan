// 作付ごとの収量と売上の見込み、収穫量の実績、市況からの単価の推定（docs の段 1）。画面に頼らない計算だけを置く。
// 値は、作付に入っていればその値、なければ品目の設定値を使う（条数や株間と同じ）。金額は税抜き。
//   収量   = 苗数 × 1 株あたりの収量（g）÷ 1,000、または 畝＋通路の面積 × 10 a あたりの収量 ÷ 1,000 ㎡
//   出荷量 = 収量 × 出荷率（空なら 100 %）
//   売上   = 出荷量を収穫の期間の日に均等に分け、日ごとの単価（作付 → 品目 → その日の市況からの推定の順）を掛けて足す。
//            収穫の計画のない作付には出さない
import { bedAreas } from "./logs.js";
import { addDays, existsOn } from "./schedule.js";

const TEN_ARES_SQM = 1000;

// 値が入っているか（0 以上の数）。null と空の文字は Number で 0 になるので、先に除く
const filled = (value) => value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;

// 収量の見込み。作付の 1 株あたり → 作付の 10 a あたり → 品目の 1 株あたり → 品目の 10 a あたり の順に、最初に値のある方法で出す。
// 1 株あたりは、苗数が分かるときだけ使う（分からなければ次の方法へ）。面積が分からなければ 10 a あたりは使えない。
// 返り値: { kg, method: "plant" | "area", from: "planting" | "crop", value }。どれも使えなければ null
export function resolveYield(planting, crop, { seedlings = null, areaM2 = null } = {}) {
  for (const [from, row] of [
    ["planting", planting],
    ["crop", crop],
  ]) {
    if (!row) {
      continue;
    }
    if (filled(row.yield_g_per_plant) && seedlings > 0) {
      const value = Number(row.yield_g_per_plant);
      return { kg: (seedlings * value) / 1000, method: "plant", from, value };
    }
    if (filled(row.yield_kg_per_10a) && areaM2 > 0) {
      const value = Number(row.yield_kg_per_10a);
      return { kg: (areaM2 * value) / TEN_ARES_SQM, method: "area", from, value };
    }
  }
  return null;
}

// 作付の畝＋通路の面積（㎡）。作付が始まる日（date）に区画にある畝で分ける（logs.js の bedAreas）。
// その日に畝がまだない（またはもうない）ときは、畝ができる日（start_date）にある畝で分ける。それでも決まらなければ、その畝だけで求める。
// beds は同じ区画のすべての畝。今日の畝で分けると、これから作る畝やなくした畝の作付が、区画の端までの隙間を全部持って大きく出た（2026-11-24）
export function plantingBedArea(block, beds, bed, date) {
  const on = (day) => beds.filter((item) => existsOn(item.start_date, item.removed_on, day));
  let live = on(date);
  if (!live.some((item) => item.id === bed.id) && bed.start_date) {
    live = on(bed.start_date);
  }
  if (!live.some((item) => item.id === bed.id)) {
    live = [bed];
  }
  return bedAreas(block, live).get(bed.id) ?? null;
}

// 作付の見込みの記録（field.planting_forecasts の行）に持つ値
export const FORECAST_KEYS = ["yield_kg_per_10a", "yield_g_per_plant", "shippable_pct", "price_yen_per_kg"];

// 作付の見込みの記録の並びから、いま使う値を決める。項目ごとに、いちばん新しい記録（set_on、同じ日なら created_at）のうち、
// その項目が入っているものの値。返り値: { values: { 項目: { value, set_on, id } }, latest（いちばん新しい記録か null）, count }。
// values を作付の値として resolveYield などに渡す（入っていない項目は、品目の値を使う）
export function effectiveForecast(entries) {
  // created_at は、DB では必ず入る（not null、既定は今の時刻）。画面で足す行にも入れる（forecast-editor.js）
  const sorted = [...entries].sort((a, b) => b.set_on.localeCompare(a.set_on) || b.created_at.localeCompare(a.created_at));
  const values = {};
  for (const key of FORECAST_KEYS) {
    const hit = sorted.find((entry) => filled(entry[key]));
    if (hit) {
      values[key] = { value: Number(hit[key]), set_on: hit.set_on, id: hit.id };
    }
  }
  return { values, latest: sorted[0] || null, count: sorted.length };
}

// effectiveForecast の値を、作付の値（resolveYield などの planting）の形にする
export const forecastValues = (effective) => Object.fromEntries(Object.entries(effective.values).map(([key, item]) => [key, item.value]));

// 出荷率（%）。作付 → 品目。どちらも空なら 100 %（from: "default"）
export function resolveRate(planting, crop) {
  if (planting && filled(planting.shippable_pct)) {
    return { pct: Number(planting.shippable_pct), from: "planting" };
  }
  if (crop && filled(crop.shippable_pct)) {
    return { pct: Number(crop.shippable_pct), from: "crop" };
  }
  return { pct: 100, from: "default" };
}

// 単価（円/kg、税抜き）。作付 → 品目 → 市況からの推定（estimate は marketEstimate の返り値）。どれもなければ null
export function resolvePrice(planting, crop, estimate = null) {
  if (planting && filled(planting.price_yen_per_kg)) {
    return { yen: Number(planting.price_yen_per_kg), from: "planting" };
  }
  if (crop && filled(crop.price_yen_per_kg)) {
    return { yen: Number(crop.price_yen_per_kg), from: "crop" };
  }
  if (estimate && estimate.yen !== null) {
    return { yen: estimate.yen, from: "market", estimate };
  }
  return null;
}

// 収穫の期間の日（ISO の日付）の並び。window.days（harvestWindow が作る）があればそれ。終わりが始まりより前なら、始まりの 1 日
export function daysOf(window) {
  if (window.days) {
    return window.days;
  }
  const days = [];
  for (let day = window.start; day <= window.end || !days.length; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

// 1 つの作付の見込み。分からない値は null。
// 売上は、収穫の計画（window）がある作付だけに出す。出荷量を収穫の期間の日に均等に分け、日ごとの単価を掛けて足す。
// 日ごとの単価は、作付か品目に単価があればその値、なければ marketOn(日付)（その日の市況からの推定。marketEstimate の返り値）。
// 1 日でも単価が分からなければ、売上は null。monthly は 月（YYYY-MM）→ その月の売上。
// price は、日ごとの単価の平均。市況からのときは estimate に、日ごとの推定のまとめ（widen はいちばん広げた日数、counts は広げた日数ごとの日数）。
// 収穫の計画がないときは、売上を出さず、単価だけを作付 → 品目 → estimate（市況の全期間）の順に出す
export function forecast(planting, crop, { seedlings = null, areaM2 = null, window = null, marketOn = null, estimate = null } = {}) {
  const yieldInfo = resolveYield(planting, crop, { seedlings, areaM2 });
  const rate = resolveRate(planting, crop);
  const manual = resolvePrice(planting, crop, null);
  const yieldKg = yieldInfo ? yieldInfo.kg : null;
  const shippedKg = yieldKg === null ? null : (yieldKg * rate.pct) / 100;
  const result = { yieldKg, shippedKg, salesYen: null, monthly: null, yield: yieldInfo, rate, price: manual };
  if (!window) {
    result.price = resolvePrice(planting, crop, estimate);
    return result;
  }
  const days = daysOf(window);
  const estimates = manual ? null : days.map((day) => (marketOn ? marketOn(day) : null));
  const daily = manual ? days.map(() => manual.yen) : estimates.map((item) => (item ? item.yen : null));
  if (daily.some((yen) => yen === null)) {
    result.price = null;
    return result;
  }
  if (!manual) {
    const counts = {};
    estimates.forEach((item) => (counts[item.widen] = (counts[item.widen] || 0) + 1));
    const widen = [...MARKET_WIDEN_DAYS, "all"].filter((step) => counts[step]).at(-1);
    result.price = { yen: daily.reduce((sum, yen) => sum + yen, 0) / days.length, from: "market", estimate: { widen, counts, days: days.length } };
  }
  if (shippedKg !== null) {
    const perDay = shippedKg / days.length;
    result.monthly = new Map();
    days.forEach((day, i) => {
      const month = day.slice(0, 7);
      result.monthly.set(month, (result.monthly.get(month) || 0) + perDay * daily[i]);
    });
    result.salesYen = [...result.monthly.values()].reduce((sum, yen) => sum + yen, 0);
  }
  return result;
}

// 1 件の収穫の記録を、作付ごとの量に分ける。畝ごとに入れた量（target.harvest_kg）はそのまま使い、
// 記録の収穫量（spec.harvest_kg）から畝ごとの量を引いた残りを、量を入れていない畝に、畝＋通路の面積（area_m2）の比で分ける
// （面積が分からなければ等分）。記録の収穫量が空なら、畝ごとの量の合計を収穫量とみなす（残りは 0）。
// 返り値: [{ planting_id, kg, measured }]。measured は畝ごとに入れた量か。作付のない対象（区画）は返さない
export function splitHarvest(log) {
  const targets = (log.targets || []).filter((target) => target.planting_id);
  const entered = targets.filter((target) => filled(target.harvest_kg));
  const others = targets.filter((target) => !filled(target.harvest_kg));
  const enteredKg = entered.reduce((sum, target) => sum + Number(target.harvest_kg), 0);
  const total = filled(log.spec?.harvest_kg) ? Number(log.spec.harvest_kg) : enteredKg;
  const rest = Math.max(total - enteredKg, 0);
  const areaSum = others.reduce((sum, target) => sum + (Number(target.area_m2) || 0), 0);
  return [
    ...entered.map((target) => ({ planting_id: target.planting_id, kg: Number(target.harvest_kg), measured: true })),
    ...others.map((target) => ({
      planting_id: target.planting_id,
      kg: areaSum > 0 ? (rest * (Number(target.area_m2) || 0)) / areaSum : rest / others.length,
      // 対象が 1 本だけなら、記録の収穫量はその畝で量った量
      measured: targets.length === 1,
    })),
  ];
}

// 作付の収穫量の実績。kg は合計、splitKg はそのうち面積の比で分けた量、count は収穫量の入った収穫の記録の件数、
// unmeasured は収穫量の入っていない収穫の記録の件数。
// 記録の収穫量（spec.harvest_kg）も、この作付の畝の量（target.harvest_kg）も空の記録は、量を量らずに収穫だけを
// 記録したものとして、kg に数えない（0 kg とは分ける。0 と入れた記録は 0 kg として数える）
export function harvestActual(plantingId, logs) {
  const result = { kg: 0, splitKg: 0, count: 0, unmeasured: 0 };
  for (const log of logs) {
    if (log.work_type !== "harvest") {
      continue;
    }
    const parts = splitHarvest(log).filter((part) => part.planting_id === plantingId);
    if (!parts.length) {
      continue;
    }
    // parts があるので、log.targets はある
    const own = log.targets.filter((target) => target.planting_id === plantingId);
    if (!filled(log.spec?.harvest_kg) && !own.some((target) => filled(target.harvest_kg))) {
      result.unmeasured += 1;
      continue;
    }
    result.count += 1;
    for (const part of parts) {
      result.kg += part.kg;
      if (!part.measured) {
        result.splitKg += part.kg;
      }
    }
  }
  return result;
}

// 収穫の計画の期間。取りやめていない収穫の作業すべて（作付の作業と、区画の作業の写し。logs.js の withBlockShares）の日を合わせる。
// start はいちばん早い始まり、end はいちばん遅い終わり、days は収穫の作業のある日（重なった日は 1 日。作業の間の日は入れない）。なければ null
export function harvestWindow(works) {
  const harvests = works.filter((work) => work.work_type === "harvest" && !work.cancelled_on && work.plan_start);
  if (!harvests.length) {
    return null;
  }
  const days = new Set();
  for (const work of harvests) {
    for (const day of daysOf({ start: work.plan_start, end: work.plan_end || work.plan_start })) {
      days.add(day);
    }
  }
  const sorted = [...days].sort();
  return { start: sorted[0], end: sorted.at(-1), days: sorted };
}

// ---- 市況からの単価の推定 ----

// 推定に要る取引日の数。これに満たなければ、期間を前後に広げる
export const MARKET_MIN_DAYS = 5;
// 期間の前後に広げる日数の段階。最後まで足りなければ、品目の全期間を使う。
// 最初から前後 7 日に広げる（2026-11-24）。その日だけの市況は、その年の台風や曜日（休み明けは高い、など）に左右されやすく、
// 数日で穫り終える品目では、それがそのまま単価になるため。7 日なら曜日の並びを 2 回り含み、季節の動きはぼかしすぎない
export const MARKET_WIDEN_DAYS = [7, 14, 30, 45];

// 年の中の何日目か（0〜364）。うるう日は 2 月 28 日と同じに扱う
function dayOfYear(iso) {
  const month = Number(iso.slice(5, 7));
  const day = Math.min(Number(iso.slice(8, 10)), month === 2 ? 28 : 31);
  return Math.round((Date.UTC(2001, month - 1, day) - Date.UTC(2001, 0, 1)) / 86400000);
}

// 並べた値の分位点（0〜1）。間は直線で補う
function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

// 市況の中値から、収穫の期間の単価を推す。prices は 1 品目の [{ sale_date, avg_price }]（円/kg、卸値）。
// 年は問わず、期間を前後 7 日に広げた月日に入る取引日の中値を集め、その中央値を単価にする（年をまたぐ期間も扱う）。
// 取引日が MARKET_MIN_DAYS に満たなければ、前後 14、30、45 日と広げ、それでも足りなければ品目の全期間を使う。
// 返り値: { yen, low, high（25 % と 75 % の点）, days, widen（広げた日数。全期間なら "all"）, from, to（使った取引日の最初と最後） }。
// 取引日が 1 日もなければ null
export function marketEstimate(prices, window) {
  const rows = (prices || []).filter((row) => row.sale_date && Number(row.avg_price) > 0);
  if (!rows.length) {
    return null;
  }
  const summary = (picked, widen) => {
    const values = picked.map((row) => Number(row.avg_price)).sort((a, b) => a - b);
    const dates = picked.map((row) => row.sale_date).sort();
    return {
      yen: quantile(values, 0.5),
      low: quantile(values, 0.25),
      high: quantile(values, 0.75),
      days: picked.length,
      widen,
      from: dates[0],
      to: dates.at(-1),
    };
  };
  if (window?.start) {
    const start = dayOfYear(window.start);
    // 終わりが空か、始まりより前なら、始まりの 1 日
    const end = [window.start, window.end || window.start].sort()[1];
    // 始まりから何日目までか。1 年（365 日）以上なら、どの日も入る（364 日目まで入れれば、どの月日も入る）
    const span = addDays(window.start, 365) <= end ? 364 : (dayOfYear(end) - start + 365) % 365;
    for (const widen of MARKET_WIDEN_DAYS) {
      const from = (start - widen + 365) % 365;
      const picked = rows.filter((row) => (dayOfYear(row.sale_date) - from + 365) % 365 <= span + 2 * widen);
      if (picked.length >= MARKET_MIN_DAYS) {
        return summary(picked, widen);
      }
    }
  }
  return summary(rows, "all");
}

// 市況の品目名の候補の並べ方。カタカナとひらがなをそろえ、品目名と同じもの、含むもの、含まれるもの、そのほかの順
const toHiragana = (text) => String(text).replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const normalize = (text) => toHiragana(text).replace(/[\s（）()・]/g, "");
export function rankMarketItems(cropName, items) {
  const key = normalize(cropName);
  const score = (name) => {
    const value = normalize(name);
    return value === key ? 0 : value.includes(key) ? 1 : key.includes(value) && value ? 2 : 3;
  };
  return [...items].sort((a, b) => score(a.item_name) - score(b.item_name) || String(a.item_name).localeCompare(String(b.item_name), "ja"));
}

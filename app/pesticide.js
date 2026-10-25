// 防除の記録で使う、農薬の使用基準（FAMIC の農薬登録情報）。
// この部分は切り離せるように、1 つのファイルにまとめている。config.js の famic を false にするか、
// DB を使わないモードでは使わない（防除の記録は、名前と量を文字と数で入れるだけになる）。
// 農薬の情報の扱いには責任が伴うので、ほかの人に使ってもらうときは、ここを外すこと。
import { defaultDilution, pesticideCounts, sprayWarnings } from "./logs.js";

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEARCH_DELAY_MS = 300;
export const NOTICE_URL = "https://www.acis.famic.go.jp/ddata/soukaisuu.pdf";

let ctx = null; // { state, refresh }
let timer = null;

const state = () => ctx.state;

export function famicEnabled() {
  return Boolean(ctx && state().store.famic && window.FIELD_PLAN_CONFIG?.famic !== false);
}

// 検索の文字。全角にそろえ、ひらがなをカタカナにする（DB の name_search と同じ形）
export function searchKey(text) {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

// 有効成分ごとの行を、登録番号ごとの農薬にまとめる。ingredients は総使用回数に数える有効成分（①〜⑤の順）
export function groupProducts(rows) {
  const products = new Map();
  for (const row of [...rows].sort((a, b) => a.reg_no - b.reg_no || a.ord - b.ord)) {
    if (!products.has(row.reg_no)) {
      products.set(row.reg_no, { reg_no: row.reg_no, name: row.name, kind: row.kind, use_type: row.use_type, formulation: row.formulation, ingredients: [], names: [] });
    }
    const product = products.get(row.reg_no);
    product.ingredients[row.ord - 1] = row.count_ingredient || "";
    product.names.push(row.ingredient);
  }
  return [...products.values()].map((product) => ({ ...product, ingredients: Array.from(product.ingredients, (name) => name || "") }));
}

// ---- 検索 ----

// 農薬の名前の欄に打った文字で探す。少し待ってから探し、結果は results の欄だけを描き直す
export function search(input, query, box) {
  clearTimeout(timer);
  const key = searchKey(query);
  if (key.length < 2 && !/^\d+$/.test(key)) {
    input._results = [];
    box.innerHTML = "";
    return;
  }
  timer = setTimeout(async () => {
    try {
      input._results = groupProducts(await state().store.searchPesticides(key)).slice(0, 20);
    } catch (error) {
      box.innerHTML = `<li class="muted">探せませんでした: ${escapeHtml(error.message)}</li>`;
      return;
    }
    box.innerHTML = resultsHtml(input);
  }, SEARCH_DELAY_MS);
}

export function resultsHtml(input) {
  const results = input._results || [];
  if (!results.length) {
    return "";
  }
  return results
    .map(
      (product) =>
        `<li><button type="button" class="famic-result" data-act="famic-pick" data-reg="${product.reg_no}">${escapeHtml(product.name)}` +
        `<small>登録番号 ${product.reg_no}・${escapeHtml(product.use_type)}・${escapeHtml(product.formulation)}</small></button></li>`
    )
    .join("");
}

// 探した中から農薬を選ぶ。登録番号と名前を入れ、品目の使用基準を読み込む
export async function pick(input, regNo, groups) {
  const product = (input._results || []).find((item) => item.reg_no === Number(regNo));
  if (!product) {
    return;
  }
  Object.assign(input, { reg_no: String(product.reg_no), name: product.name, _product: product, _results: [], _uses: null, use_key: "" });
  await ensureUses(input, groups);
}

export function unpick(input) {
  Object.assign(input, { reg_no: null, standard: null, _product: null, _uses: null, use_key: "" });
}

// 品目のまとまりに対応する FAMIC の作物名。品目の画面で決めた名前（作付の品目の設定値）
export function famicCropsOf(plantingIds, data) {
  const names = new Set();
  for (const id of plantingIds) {
    const planting = data.plantings.find((item) => item.id === id);
    const crop = planting && state().crops.find((item) => item.id === planting.crop_id);
    (crop?.famic_crops || []).forEach((name) => names.add(name));
  }
  return [...names];
}

// 選んだ農薬の、品目の作物名の使用基準を読み込む（まだ読んでいない作物名があるときだけ）
export async function ensureUses(input, groups) {
  if (!input.reg_no) {
    return;
  }
  const crops = [...new Set(groups.flatMap((group) => group.famicCrops))];
  const loaded = input._uses?.crops || [];
  const products = input._product ? null : await state().store.loadProducts([input.reg_no]);
  if (products) {
    input._product = groupProducts(products)[0] || { reg_no: Number(input.reg_no), name: input.name, ingredients: input.standard?.ingredients || [], missing: true };
    // 最新の登録情報にない登録番号は、失効している可能性がある
    input._product.missing = !products.length;
  }
  if (crops.every((crop) => loaded.includes(crop)) && input._uses) {
    if (products) {
      ctx.refresh();
    }
    return;
  }
  const rows = await state().store.loadUses(input.reg_no, crops);
  input._uses = { crops, rows };
  // 使い方・適用病害虫は、前に選んだもの（記録を直すとき）か、選べるものが 1 つならそれ
  const keys = useKeys(input, groups);
  if (!keys.some((item) => item.key === input.use_key)) {
    const saved = input.standard ? `${input.standard.target}|${input.standard.method}` : "";
    input.use_key = keys.some((item) => item.key === saved) ? saved : keys.length === 1 ? keys[0].key : "";
  }
  ctx.refresh();
}

// 使い方・適用病害虫の選択肢。選んだ品目の作物名の行にある組み合わせ
export function useKeys(input) {
  const seen = new Map();
  for (const row of input._uses?.rows || []) {
    const key = `${row.target}|${row.method}`;
    if (!seen.has(key)) {
      seen.set(key, { key, label: `${row.target}／${row.method}`, method: row.method });
    }
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, "ja"));
}

// 品目のまとまりの使用基準の行。作物名は、品目の画面で決めた順に探す（先の名前ほど優先）
export function rowFor(input, group) {
  if (!input.use_key || !input._uses) {
    return null;
  }
  const [target, method] = input.use_key.split("|");
  for (const crop of group.famicCrops) {
    const row = input._uses.rows.find((item) => item.crop === crop && item.target === target && item.method === method);
    if (row) {
      return row;
    }
  }
  return null;
}

// 記録に写す使用基準
export function snapshot(input, groups) {
  if (!input.reg_no || !input.use_key) {
    return input.standard || null;
  }
  const [target, method] = input.use_key.split("|");
  return {
    reg_no: input.reg_no,
    product: input._product?.name || input.name,
    target,
    method,
    ingredients: input._product?.ingredients || input.standard?.ingredients || [],
    rows: groups
      .map((group) => {
        const row = rowFor(input, group);
        return row
          ? {
              crop_name: group.cropName,
              crop: row.crop,
              dilution_text: row.dilution_text,
              liquid_text: row.liquid_text,
              timing_text: row.timing_text,
              times_text: row.times_text,
              totals: row.totals,
              dilution_min: row.dilution_min,
              dilution_max: row.dilution_max,
              liquid_min: row.liquid_min,
              liquid_max: row.liquid_max,
              preharvest_days: row.preharvest_days,
              times_max: row.times_max,
              total_max: row.total_max,
            }
          : null;
      })
      .filter(Boolean),
  };
}

// 初めの希釈倍率。選んだ品目の使用基準の下限のうち、いちばん大きいもの。どの品目に合わせたかも返す
export function suggestedDilution(input, groups) {
  const rows = groups.map((group) => ({ group, row: rowFor(input, group) })).filter((item) => item.row);
  const value = defaultDilution(rows.map((item) => item.row));
  return value ? { value, by: rows.find((item) => item.row.dilution_min === value)?.group.name || "" } : null;
}

// ---- 描画 ----

// 農薬の行の、検索の結果・選んだ農薬・使い方の選択
export function pickerHtml(input, i, groups) {
  const keys = useKeys(input, groups);
  const picked = input.reg_no
    ? `<p class="muted famic-picked">登録番号 ${escapeHtml(input.reg_no)}${input._product?.missing ? '・<strong class="famic-warn">最新の登録情報にありません（失効している可能性があります）</strong>' : ""}` +
      ` <button type="button" class="text-btn" data-act="famic-unpick" data-i="${i}">選び直す</button></p>`
    : '<p class="muted">名前の一部か登録番号を入れると、農薬登録情報から探せます。一覧にない農薬は、名前だけでも入れられます。</p>';
  const select = input.reg_no
    ? keys.length
      ? `<label>使い方・適用病害虫<select data-in="${i}" data-k="use_key"><option value="">選んでください</option>` +
        keys.map((item) => `<option value="${escapeHtml(item.key)}"${item.key === input.use_key ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("") +
        "</select></label>"
      : `<p class="muted">${groups.some((group) => group.famicCrops.length) ? "選んだ品目の作物名には、この農薬の使用基準がありません。" : "対象の品目に、FAMIC の作物名が決まっていません（品目の画面で決めます）。"}</p>`
    : "";
  return `<ul class="famic-results" data-results="${i}">${resultsHtml(input)}</ul>${picked}${select}`;
}

// 品目のまとまりごとの使用基準と、基準散布量、使用回数
export function standardsHtml(inputs, groups, logs, excludeLogId) {
  const pesticides = inputs.filter((input) => input.kind === "pesticide" && input.reg_no && input.use_key);
  if (!pesticides.length || !groups.length) {
    return "";
  }
  return groups
    .map((group) => {
      const lines = pesticides.map((input) => {
        const row = rowFor(input, group);
        if (!row) {
          return `<span class="famic-warn">${escapeHtml(input.name)}: この品目には使用基準がありません</span>`;
        }
        const counts = group.plantingIds.map((id) => pesticideCounts(logs, id, excludeLogId));
        const product = Math.max(0, ...counts.map((item) => item.products.get(String(input.reg_no)) || 0)) + 1;
        const ingredients = (input._product?.ingredients || [])
          .map((name, k) => {
            if (!name) {
              return "";
            }
            const count = Math.max(0, ...counts.map((item) => item.ingredients.get(name) || 0)) + 1;
            const max = row.total_max?.[k];
            return `${name} ${count} 回目${max ? `（上限 ${max} 回）` : ""}`;
          })
          .filter(Boolean);
        const liquid =
          row.liquid_min !== null && row.liquid_min !== undefined && group.area
            ? `この面積の基準散布量 <b>${((row.liquid_min * group.area) / 1000).toFixed(1)}〜${((row.liquid_max * group.area) / 1000).toFixed(1)} L</b>`
            : "";
        return (
          `<span>${escapeHtml(input.name)}: ${escapeHtml([row.dilution_text, row.liquid_text, row.timing_text].filter((text) => text && text !== "-").join("・"))}</span>` +
          `<span class="muted">本剤 ${product} 回目（${escapeHtml(row.times_text)}）${ingredients.length ? `・${escapeHtml(ingredients.join("・"))}` : ""}</span>` +
          (liquid ? `<span>${liquid}</span>` : "")
        );
      });
      return `<div class="famic-group"><strong>${escapeHtml(group.name)}</strong><span class="muted">${group.area ? `${group.area.toFixed(1)} ㎡` : ""}</span>${lines.join("")}</div>`;
    })
    .join("");
}

// 基準散布量の合計（L）。最初の農薬の散布液量の基準で求める。求められなければ null
export function baselineLiters(inputs, groups) {
  const input = inputs.find((item) => item.kind === "pesticide" && item.reg_no && item.use_key);
  if (!input) {
    return null;
  }
  let low = 0;
  let high = 0;
  for (const group of groups) {
    const row = rowFor(input, group);
    if (!row || row.liquid_min === null || row.liquid_min === undefined || !group.area) {
      return null;
    }
    low += (row.liquid_min * group.area) / 1000;
    high += (row.liquid_max * group.area) / 1000;
  }
  return groups.length ? { low, high } : null;
}

// 防除の指摘（4.6）。農薬ごとに、品目のまとまりの基準と照らす
export function warnings({ inputs, groups, date, sprayOf, logs, excludeLogId, harvestStartOf }) {
  const out = [];
  for (const input of inputs) {
    if (input.kind !== "pesticide" || !input.reg_no) {
      continue;
    }
    if (input._product?.missing) {
      out.push(`${input.name}: 登録番号 ${input.reg_no} は最新の農薬登録情報にありません（失効している可能性があります）`);
    }
    if (!input.use_key) {
      continue;
    }
    const list = sprayWarnings({
      date,
      dilution: input.dilution,
      regNo: input.reg_no,
      ingredients: input._product?.ingredients || [],
      groups: groups.map((group) => ({
        name: group.name,
        area: group.area,
        liters: sprayOf(group.key),
        row: rowFor(input, group),
        plantings: group.plantingIds.map((id) => ({ id, harvestStart: harvestStartOf(id) })),
      })),
      countsOf: (id) => pesticideCounts(logs, id, excludeLogId),
    });
    out.push(...list.map((text) => (inputs.filter((item) => item.kind === "pesticide").length > 1 ? `${input.name}・${text}` : text)));
  }
  return out;
}

export function initPesticide(context) {
  ctx = context;
}

// 防除の記録で使う、農薬の使用基準（FAMIC の農薬登録情報）。
// この部分は切り離せるように、1 つのファイルにまとめている。config.js の famic を false にするか、
// DB を使わないモードでは使わない（防除の記録は、名前と量を文字と数で入れるだけになる）。
// 農薬の情報の扱いには責任が伴うので、ほかの人に使ってもらうときは、ここを外すこと。
import { defaultDilution, formatAmount, inputText, parseUsage, pesticideCounts, previousChoice, sprayWarnings, standardChoice, usageRange, usageWarnings } from "./logs.js";
import { draw } from "./draw.js";
import { UNKNOWN_PRODUCT, codesText, describeHtml, iconsHtml, productCodes } from "./rac.js";
import { escapeHtml } from "./html.js";

const SEARCH_DELAY_MS = 300;
export const NOTICE_URL = "https://www.acis.famic.go.jp/ddata/soukaisuu.pdf";

let ctx = null; // { state, refresh, redraw, notify, draftId }
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

// ---- 作用機構分類（RAC コード）のアイコン ----
// 農薬名を出すところでは、名前の後ろに必ずアイコンを付ける（nameHtml）。文字しか出せない所は nameText。
// コードの表（有効成分 → コード）は 1 回だけ読む。製品の有効成分と用途は、検索や使用基準で読んだものを覚え、
// 実績に出てくる登録番号で、まだ読んでいないものはまとめて読む。読み終えたら、画面を描き直す

let racCodes = null; // 成分 → [{ committee, code }]
const products = new Map(); // 登録番号 → { names, use_type }。最新の登録情報にないものは { missing: true }
const asked = new Set(); // 読みに行った登録番号（失敗しても、何度も読みに行かない）
let racLoading = null;

function remember(product) {
  products.set(String(product.reg_no), { names: product.names, use_type: product.use_type });
}

// コードの表と、regNos のうち、まだ読んでいない農薬を読む。新しく読めたら、画面を描き直す
export function primeRac(regNos = []) {
  if (!famicEnabled()) {
    return Promise.resolve();
  }
  const wanted = [...new Set(regNos.filter(Boolean).map(String))].filter((reg) => !products.has(reg) && !asked.has(reg));
  if ((racCodes || racLoading) && !wanted.length) {
    return racLoading || Promise.resolve();
  }
  wanted.forEach((reg) => asked.add(reg));
  const loading = (racLoading || Promise.resolve())
    .then(async () => {
      let changed = false;
      if (!racCodes) {
        const map = new Map();
        for (const row of await state().store.loadRacCodes()) {
          if (!map.has(row.ingredient)) {
            map.set(row.ingredient, []);
          }
          map.get(row.ingredient).push({ committee: row.committee, code: row.code });
        }
        racCodes = map;
        changed = true;
      }
      if (wanted.length) {
        groupProducts(await state().store.loadProducts(wanted)).forEach(remember);
        wanted.filter((reg) => !products.has(reg)).forEach((reg) => products.set(reg, { missing: true }));
        changed = true;
      }
      if (changed) {
        ctx.redraw?.();
      }
    })
    .catch((error) => ctx.notify?.(`農薬の作用機構分類を読めませんでした: ${error.message}`))
    .finally(() => {
      if (racLoading === loading) {
        racLoading = null;
      }
    });
  racLoading = loading;
  return loading;
}

// 製品のアイコンに出すコード。まだ読んでいなければ null（読み始める）
function codesFor(regNo, product) {
  if (!regNo) {
    return UNKNOWN_PRODUCT;
  }
  const info = product?.names ? product : products.get(String(regNo));
  if (!racCodes || !info) {
    primeRac([regNo]);
    return null;
  }
  return info.missing ? [{ committee: "IRAC", code: "?", ingredients: [] }] : productCodes(info.names, info.use_type, racCodes);
}

// 農薬名と、その後ろのアイコン（HTML）。product は検索の結果のように、有効成分と用途を持つもの（なければ登録番号で探す）
export function nameHtml(name, regNo, product = null) {
  const text = escapeHtml(name);
  if (!famicEnabled()) {
    return text;
  }
  const list = codesFor(regNo, product);
  // 読み終えるまでは、空のアイコンの入れ物を置く（読み終えたら描き直す）
  return `<span class="pesticide-name">${text}${list ? iconsHtml(list) : '<span class="rac-icons"></span>'}</span>`;
}

// 文字しか出せない所の農薬名。「アルバリン顆粒水溶剤（IRAC 4A）」
export function nameText(name, regNo) {
  const list = famicEnabled() ? codesFor(regNo) : null;
  return list ? `${name}（${codesText(list)}）` : name;
}

// 実績の一覧などの、資材 1 つの行（HTML）。農薬は名前の後ろにアイコンを付ける
export function inputHtml(input) {
  if (input.kind !== "pesticide" || !famicEnabled()) {
    return escapeHtml(inputText(input));
  }
  const rest = inputText({ ...input, name: "-" }).replace(/^-\s*/, "");
  return `${nameHtml(input.name || "農薬", input.reg_no)}${rest ? ` ${escapeHtml(rest)}` : ""}`;
}

// 有効成分 1 つのアイコン（使用回数の表の成分の行）。表になければ「?」
export function ingredientIconsHtml(name) {
  if (!famicEnabled() || !racCodes) {
    return "";
  }
  return iconsHtml(productCodes([name], "", racCodes));
}

// ---- 検索 ----

// 農薬の名前の欄に打った文字で探す。少し待ってから探し、結果は results の欄だけを描き直す
export function search(input, query, box) {
  clearTimeout(timer);
  const key = searchKey(query);
  if (key.length < 2 && !/^\d+$/.test(key)) {
    input._results = [];
    draw(box, "");
    return;
  }
  timer = setTimeout(async () => {
    try {
      input._results = groupProducts(await state().store.searchPesticides(key)).slice(0, 20);
      input._results.forEach(remember);
      await primeRac();
    } catch (error) {
      draw(box, `<li class="muted">探せませんでした: ${escapeHtml(error.message)}</li>`);
      return;
    }
    draw(box, resultsHtml(input));
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
        `<li><button type="button" class="famic-result" data-act="famic-pick" data-reg="${product.reg_no}">${nameHtml(product.name, product.reg_no, product)}` +
        `<small>登録番号 ${product.reg_no}・${escapeHtml(product.use_type)}・${escapeHtml(product.formulation)}</small></button></li>`
    )
    .join("");
}

// ---- 作物名と使い方の選択 ----
// 農薬を選んだら、その農薬に登録されている作物名の中から、品目のまとまり（区画で選ぶときは区画）ごとに、
// 当てはまると判断した作物名と、使い方・適用病害虫をユーザーが選ぶ。システムは当てはめの正誤を判定せず、
// 選んだ作物名の基準を使う。初めの値は前回の選択（logs.js の previousChoice）。
// input.choices = { まとまりの key: { crop, use_key } }、input._prefilled = 前回の選択を入れたまとまりの key

// 探した中から農薬を選ぶ。登録番号と名前を入れ、この農薬の使用基準をすべて読み込む
export async function pick(input, regNo, groups) {
  const product = (input._results || []).find((item) => item.reg_no === Number(regNo));
  if (!product) {
    return;
  }
  Object.assign(input, { reg_no: String(product.reg_no), name: product.name, _product: product, _results: [], _uses: null, choices: {}, _prefilled: new Set(), _filters: {} });
  await ensureUses(input, groups);
}

export function unpick(input) {
  Object.assign(input, { reg_no: null, standard: null, _product: null, _uses: null, choices: {}, _prefilled: new Set(), _filters: {} });
}

// 選んだ農薬の、使用基準の行をすべて読み込む（読んでいなければ）。読み終えたら、まとまりの初めの選択を入れる
export async function ensureUses(input, groups) {
  if (!input.reg_no) {
    return;
  }
  input.choices ||= {};
  input._prefilled ||= new Set();
  input._filters ||= {};
  let changed = false;
  if (!input._product) {
    const rows = await state().store.loadProducts([input.reg_no]);
    input._product = groupProducts(rows)[0] || { reg_no: Number(input.reg_no), name: input.name, ingredients: input.standard?.ingredients || [] };
    // 最新の登録情報にない登録番号は、失効している可能性がある
    input._product.missing = !rows.length;
    if (rows.length) {
      remember(input._product);
    }
    changed = true;
  }
  if (!input._uses) {
    input._uses = { rows: await state().store.loadUses(input.reg_no) };
    changed = true;
  }
  changed = fillChoices(input, groups) || changed;
  if (changed) {
    ctx.refresh();
  }
}

// まだ選んでいないまとまりに、初めの選択を入れる。記録を直すときは、その記録の写しの選択。
// 新しく入れるときは、前回の選択。入れたら true
export function fillChoices(input, groups) {
  if (!input._uses) {
    return false;
  }
  let changed = false;
  const rows = input._uses.rows;
  for (const group of groups) {
    if (input.choices[group.key]?.crop) {
      continue;
    }
    const where = { cropName: group.cropName, groupName: group.name };
    const saved = standardChoice(input.standard, where);
    const choice =
      saved && rows.some((row) => row.crop === saved.crop)
        ? saved
        : previousChoice(state().logs || [], { regNo: input.reg_no, ...where, excludeLogId: ctx.draftId?.() }, rows);
    if (choice) {
      input.choices[group.key] = { crop: choice.crop, use_key: useKeys(input, choice.crop).some((item) => item.key === choice.use_key) ? choice.use_key : "" };
      if (!saved) {
        input._prefilled.add(group.key);
      }
      changed = true;
    }
  }
  if (changed) {
    syncMethod(input, groups);
  }
  return changed;
}

// この農薬に登録されている作物名。名前の順
export function cropsOf(input) {
  return [...new Set((input._uses?.rows || []).map((row) => row.crop))].sort((a, b) => a.localeCompare(b, "ja"));
}

// 作物名の行にある、使い方・適用病害虫の組み合わせ。適用病害虫が空の登録（展着剤の「添加」など）は、指定なしと書く
export function useKeys(input, crop) {
  const seen = new Map();
  for (const row of input._uses?.rows || []) {
    if (row.crop !== crop) {
      continue;
    }
    const key = `${row.target}|${row.method}`;
    if (!seen.has(key)) {
      const label = row.target ? `${row.target}／${row.method}` : `${row.method}（適用病害虫の指定なし）`;
      seen.set(key, { key, label, method: row.method });
    }
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, "ja"));
}

// まとまりで選んだ作物名と使い方の、使用基準の行。まだ選んでいなければ null
export function rowFor(input, group) {
  const choice = input.choices?.[group.key];
  if (!choice?.crop || !choice.use_key || !input._uses) {
    return null;
  }
  const [target, method] = choice.use_key.split("|");
  return input._uses.rows.find((row) => row.crop === choice.crop && row.target === target && row.method === method) || null;
}

// 作物名を選ぶ。使い方が 1 つしかなければ、それも選ぶ
export function chooseCrop(input, groupKey, crop, groups) {
  const keys = useKeys(input, crop);
  input.choices[groupKey] = { crop, use_key: keys.length === 1 ? keys[0].key : "" };
  input._prefilled.delete(groupKey);
  syncMethod(input, groups);
}

export function resetCrop(input, groupKey) {
  input.choices[groupKey] = { crop: "", use_key: "" };
  input._prefilled.delete(groupKey);
}

export function chooseUse(input, groupKey, useKey, groups) {
  input.choices[groupKey] = { ...input.choices[groupKey], use_key: useKey };
  input._prefilled.delete(groupKey);
  syncMethod(input, groups);
}

// 記録の「使い方」の欄は、最初のまとまりで選んだ使用方法にする
function syncMethod(input, groups) {
  const first = groups.map((group) => input.choices[group.key]?.use_key).find(Boolean);
  if (first) {
    input.method = first.split("|")[1];
  }
}

// 作物名と使い方を選び終えていないまとまり（保存の前に確かめる）。[{ input, group }]
export function missingChoices(inputs, groups) {
  return inputs
    .filter((input) => input.kind === "pesticide" && input.reg_no)
    .flatMap((input) => groups.filter((group) => !rowFor(input, group)).map((group) => ({ input, group })));
}

// 記録に写す使用基準。登録番号、農薬名、有効成分はいつも写す。まとまりごとに、選んだ作物名と使い方と基準を写す
export function snapshot(input, groups) {
  if (!input.reg_no) {
    return input.standard || null;
  }
  if (!input._uses) {
    // 使用基準を読めていない（直す前のまま保存した）ときは、前の写しを残す
    return input.standard || null;
  }
  return {
    reg_no: input.reg_no,
    product: input._product?.name || input.name,
    ingredients: input._product?.ingredients || input.standard?.ingredients || [],
    rows: groups
      .map((group) => {
        const row = rowFor(input, group);
        return row
          ? {
              crop_name: group.cropName,
              group: group.name,
              crop: row.crop,
              target: row.target,
              method: row.method,
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

// 面積あたりの使用量で使う農薬（粒剤など）か。選んだ使用基準が面積あたりの使用量（「6kg/10a」など）で、
// 希釈倍数がないもの。まだ選んでいなければ、剤型（粒剤、粉剤など）で決める。希釈倍率と散布液の量は入れない
export function areaDosed(input, groups) {
  if (input.kind !== "pesticide" || !input.reg_no) {
    return false;
  }
  const rows = groups.map((group) => rowFor(input, group)).filter(Boolean);
  if (rows.length) {
    return rows.every((row) => !row.dilution_min && parseUsage(row.dilution_text));
  }
  return /粒|粉/.test(input._product?.formulation || "");
}

// 面積あたりの使用量の基準の合計（g か mL）。最初の、面積あたりの使用量の農薬で求める。求められなければ null
export function baselineUsage(inputs, groups) {
  const input = inputs.find((item) => areaDosed(item, groups));
  return input ? usageRange(groups.map((group) => ({ area: group.area, row: rowFor(input, group) }))) : null;
}

// 初めの希釈倍率。選んだ品目の使用基準の下限のうち、いちばん大きいもの。どの品目に合わせたかも返す
export function suggestedDilution(input, groups) {
  const rows = groups.map((group) => ({ group, row: rowFor(input, group) })).filter((item) => item.row);
  const value = defaultDilution(rows.map((item) => item.row));
  return value ? { value, by: rows.find((item) => item.row.dilution_min === value)?.group.name || "" } : null;
}

// ---- 描画 ----

// 作物名の一覧。絞り込みの文字を含むものだけ
export function cropListHtml(input, i, group) {
  const filter = (input._filters?.[group.key] || "").trim().normalize("NFKC");
  const crops = cropsOf(input).filter((crop) => !filter || crop.includes(filter));
  return crops.length
    ? crops
        .map((crop) => `<li><button type="button" class="famic-crop" data-act="famic-crop" data-i="${i}" data-g="${escapeHtml(group.key)}" data-crop="${escapeHtml(crop)}">${escapeHtml(crop)}</button></li>`)
        .join("")
    : '<li class="muted">合う作物名がありません。</li>';
}

// まとまり 1 つぶんの、作物名と使い方の選択
function choiceHtml(input, i, group) {
  const choice = input.choices?.[group.key] || { crop: "", use_key: "" };
  const head = `<div class="famic-choice-head"><strong>${escapeHtml(group.name)}</strong>${input._prefilled?.has(group.key) ? '<span class="muted">前回の選択を入れています</span>' : ""}</div>`;
  if (!choice.crop) {
    const many = cropsOf(input).length > 8;
    return (
      `<div class="famic-choice">${head}<p class="muted">この農薬に登録されている作物名から、当てはまるものを選んでください。</p>` +
      (many
        ? `<input type="text" class="famic-crop-filter" data-famic-filter="${i}" data-g="${escapeHtml(group.key)}" value="${escapeHtml(input._filters?.[group.key] || "")}" placeholder="作物名を絞り込む（例: レタス）" autocomplete="off" />`
        : "") +
      `<ul class="famic-crop-list" data-crop-list="${i}|${escapeHtml(group.key)}">${cropListHtml(input, i, group)}</ul></div>`
    );
  }
  const keys = useKeys(input, choice.crop);
  return (
    `<div class="famic-choice">${head}` +
    `<p class="famic-chosen">作物名: <b>${escapeHtml(choice.crop)}</b> <button type="button" class="text-btn" data-act="famic-crop-reset" data-i="${i}" data-g="${escapeHtml(group.key)}">選び直す</button></p>` +
    `<label>使い方・適用病害虫<select data-in="${i}" data-k="use_key" data-g="${escapeHtml(group.key)}"><option value="">選んでください</option>` +
    keys.map((item) => `<option value="${escapeHtml(item.key)}"${item.key === choice.use_key ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("") +
    "</select></label></div>"
  );
}

// 農薬の行の、検索の結果・選んだ農薬・まとまりごとの作物名と使い方
export function pickerHtml(input, i, groups) {
  const picked = input.reg_no
    ? `<p class="muted famic-picked">${nameHtml(input._product?.name || input.name, input.reg_no, input._product?.names ? input._product : null)}・登録番号 ${escapeHtml(input.reg_no)}${input._product?.missing ? '・<strong class="famic-warn">最新の登録情報にありません（失効している可能性があります）</strong>' : ""}` +
      ` <button type="button" class="text-btn" data-act="famic-unpick" data-i="${i}">選び直す</button></p>`
    : '<p class="muted">名前の一部か登録番号を入れると、農薬登録情報から探せます。一覧にない農薬は、名前だけでも入れられます。</p>';
  let choices = "";
  if (input.reg_no) {
    choices = !input._uses
      ? '<p class="muted">使用基準を読み込んでいます…</p>'
      : !groups.length
        ? '<p class="muted">対象を選ぶと、品目ごとに作物名を選べます。</p>'
        : `<div class="famic-choices">${groups.map((group) => choiceHtml(input, i, group)).join("")}` +
          '<p class="muted famic-own">作物名の当てはめは、ご自身の判断です。システムは当てはめが正しいかを確かめません。使う前に、農薬のラベルで確かめてください。</p></div>';
  }
  return `<ul class="famic-results" data-results="${i}">${resultsHtml(input)}</ul>${picked}${choices}`;
}

// 品目のまとまりごとの使用基準と、基準散布量、使用回数
export function standardsHtml(inputs, groups, logs, excludeLogId) {
  const pesticides = inputs.filter((input) => input.kind === "pesticide" && input.reg_no && input._uses);
  if (!pesticides.length || !groups.length) {
    return "";
  }
  return groups
    .map((group) => {
      const lines = pesticides.map((input) => {
        const row = rowFor(input, group);
        if (!row) {
          return `<span class="muted">${nameHtml(input.name, input.reg_no)}: 作物名と使い方・適用病害虫を選ぶと、基準が出ます</span>`;
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
        const usage = parseUsage(row.dilution_text);
        const span = (low, high, unit) => (low === high ? formatAmount(high, unit) : `${formatAmount(low, unit)}〜${formatAmount(high, unit)}`);
        const liquid =
          row.liquid_min !== null && row.liquid_min !== undefined && group.area
            ? `この面積の基準散布量 <b>${((row.liquid_min * group.area) / 1000).toFixed(1)}〜${((row.liquid_max * group.area) / 1000).toFixed(1)} L</b>`
            : usage && group.area
              ? `この面積の基準使用量 ${escapeHtml(row.dilution_text)} × ${group.area.toFixed(1)} ㎡ → <b>${span(usage.min * group.area, usage.max * group.area, usage.unit)}</b>`
              : "";
        return (
          `<span>${nameHtml(input.name, input.reg_no)}（${escapeHtml(row.crop)}）: ${escapeHtml([row.dilution_text, row.liquid_text, row.timing_text].filter((text) => text && text !== "-").join("・"))}</span>` +
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
  const input = inputs.find((item) => item.kind === "pesticide" && item.reg_no && item._uses);
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

// 防除の指摘（4.6）。農薬ごとに、品目のまとまりで選んだ作物名の基準と照らす。HTML の文の一覧（農薬名にアイコンを付ける）
export function warnings({ inputs, groups, date, sprayOf, logs, excludeLogId, harvestStartOf }) {
  const out = [];
  for (const input of inputs) {
    if (input.kind !== "pesticide" || !input.reg_no) {
      continue;
    }
    if (input._product?.missing) {
      out.push(`${nameHtml(input.name, input.reg_no)}: 登録番号 ${escapeHtml(input.reg_no)} は最新の農薬登録情報にありません（失効している可能性があります）`);
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
    // 面積あたりの使用量の農薬（粒剤など）は、製品の量を、選んだ品目の面積の基準の合計と比べる
    list.push(...usageWarnings({ amount: input.amount, unit: input.unit, groups: groups.map((group) => ({ area: group.area, row: rowFor(input, group) })) }));
    out.push(...list.map((text) => (inputs.filter((item) => item.kind === "pesticide").length > 1 ? `${nameHtml(input.name, input.reg_no)}・${escapeHtml(text)}` : escapeHtml(text))));
  }
  return out;
}

// ---- アイコンの説明 ----
// アイコンを指すと説明を出し、離れると消す。クリック（スマホではタップ）すると出したままにし、外をクリックすると消す。
// アイコンは、検索の結果のボタンや、実績の一覧の行の中にある。アイコンのクリックは、画面全体で先に受け、
// ボタンや行の処理（農薬を選ぶ、実績の窓を開く）には渡さない。
// 説明の箱は 1 つだけで、描き直す一覧の外に置く。入力の窓（モーダル）を開いているときは、窓の外が操作できなくなるので、
// 窓の中に移してから出す。Popover の仕組みで、いちばん手前に出す

const ICON = "svg.rac-icon[data-rac]";
let pop = null; // { el, icon, pinned }

function iconOf(target) {
  const icon = target instanceof Element ? target.closest(ICON) : null;
  // 説明の箱の中の見出しのアイコンは除く
  return icon && !icon.closest(".rac-popover") ? icon : null;
}

function popoverBox() {
  if (!pop) {
    const el = document.createElement("div");
    el.className = "rac-popover";
    el.id = "racPopover";
    el.setAttribute("popover", "manual");
    el.setAttribute("role", "tooltip");
    document.body.append(el);
    pop = { el, icon: null, pinned: false };
  }
  return pop;
}

function hidePopover() {
  if (pop?.el.matches(":popover-open")) {
    pop.el.hidePopover();
  }
  if (pop) {
    pop.icon = null;
    pop.pinned = false;
  }
}

// アイコンの下に出す。下に入らなければ上に出す。左右は画面からはみ出さないようにする
function place(el, icon) {
  const rect = icon.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const gap = 6;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8));
  const below = rect.bottom + gap;
  const top = below + box.height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - gap - box.height);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function showPopover(icon, pinned) {
  const box = popoverBox();
  const [committee, code] = icon.dataset.rac.split(":");
  const ingredients = icon.dataset.ingredients ? icon.dataset.ingredients.split("・") : [];
  const host = icon.closest("dialog[open]") || document.body;
  if (box.el.parentElement !== host) {
    hidePopover();
    host.append(box.el);
  }
  draw(box.el, describeHtml(committee, code, ingredients));
  if (!box.el.matches(":popover-open")) {
    box.el.showPopover();
  }
  place(box.el, icon);
  Object.assign(box, { icon, pinned });
}

let popoverReady = false;

function initRacPopover() {
  if (popoverReady || typeof document === "undefined") {
    return;
  }
  popoverReady = true;
  document.addEventListener("pointerover", (event) => {
    const icon = event.pointerType === "mouse" && iconOf(event.target);
    if (icon && !pop?.pinned) {
      showPopover(icon, false);
    }
  });
  document.addEventListener("pointerout", (event) => {
    const icon = event.pointerType === "mouse" && iconOf(event.target);
    if (icon && pop?.icon === icon && !pop.pinned && !icon.contains(event.relatedTarget)) {
      hidePopover();
    }
  });
  // 先に受ける（capture）。アイコンなら、下のボタンや行には渡さない
  document.addEventListener(
    "click",
    (event) => {
      const icon = iconOf(event.target);
      if (icon) {
        event.preventDefault();
        event.stopPropagation();
        if (pop?.pinned && pop.icon === icon) {
          hidePopover();
        } else {
          showPopover(icon, true);
        }
      } else if (pop?.icon && !pop.el.contains(event.target)) {
        hidePopover();
      }
    },
    true
  );
  // Esc は説明だけを閉じる。入力の窓（モーダル）には渡さない（窓が閉じて、入れかけの内容が消えるため）
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && pop?.icon && pop.el.matches(":popover-open")) {
        event.preventDefault();
        event.stopPropagation();
        hidePopover();
      }
    },
    true
  );
  // スクロールしたら、出したままのものはアイコンに付いていく。アイコンが描き直しで消えていれば閉じる
  const follow = () => {
    if (!pop?.icon) {
      return;
    }
    if (!pop.pinned || !pop.icon.isConnected) {
      hidePopover();
    } else {
      place(pop.el, pop.icon);
    }
  };
  document.addEventListener("scroll", follow, true);
  window.addEventListener("resize", follow);
}

export function initPesticide(context) {
  ctx = context;
  initRacPopover();
}

// 農薬の作用機構分類（RAC コード）のアイコン。農薬名の後ろに付ける。
// 形と色は、現代農業 2018 年 6 月号「RAC コードでローテーション防除」の表にならう。
//   IRAC（殺虫剤）: ボトルのフタ。上の角が大きく丸く、下は平ら
//   FRAC（殺菌剤）: 袋。四角の上下に帯がある
//   HRAC（除草剤）: 斜めの葉。y = x^10 と、それを (0.5, 0.5) で点対称にした曲線にはさまれた形（表にないので新しく作った）
// 塗り方は 3 通り。濃い色で塗って白い文字 / 淡い色で塗って濃い色の枠 / 白地に黒い枠（色の系統のないもの）。
// 作用機構の近いグループは同じ系統の色にし、同じ系統の中では後のものほど淡くする。
// 表にないコードは、同じグループ（数字が同じ、M・P などの頭文字が同じ）の色にし、なければ白地に黒い枠にする。
// FAMIC の部分（4.7）と一緒に切り離す。データは pesticide.js が読む

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const COMMITTEES = ["IRAC", "FRAC", "HRAC"];

const INK = "#221f1f"; // 濃い文字
const LINE = "#231f20"; // 黒い枠
const WHITE = "#ffffff";
// [塗り, 枠, 文字]
const OUTLINE = [WHITE, LINE, INK];
const NONE = ["#e6e7e8", "#939598", "#58595b"]; // 分類の対象外（−）と、表にない成分（?）
const UNKNOWN = ["#939598", "#939598", WHITE]; // 作用機構が不明（UN）

const IRAC = {
  "1A": ["#d2232a", "#d2232a", WHITE], "1B": ["#dd6d55", "#d2232a", INK],
  "2A": ["#f7941d", "#f7941d", WHITE], "2B": ["#fbb161", "#f7941d", INK],
  "3A": ["#ef5ba1", "#ef5ba1", WHITE],
  "4A": ["#f8ed00", "#f8ed00", INK], "4C": ["#faf499", "#f8ed00", INK], "4D": ["#fcf7c0", "#f8ed00", INK], "4E": ["#fdfadc", "#f8ed00", INK],
  5: ["#8dc63f", "#8dc63f", WHITE], 6: ["#c4df9b", "#8dc63f", INK],
  "7C": ["#00a1e4", "#00a1e4", WHITE],
  "10A": ["#4dbdec", "#24408f", "#3a4d96"], "10B": ["#9ed5f4", "#24408f", "#3a4d96"],
  "11A": ["#40ad49", "#40ad49", WHITE],
  14: ["#ccc4a9", "#706322", INK],
  15: ["#0194b1", "#00a1e4", WHITE], 16: ["#4dbdec", "#00a1e4", INK], 17: ["#acdbf5", "#00a1e4", "#00a0e3"], 18: ["#c7e6f8", "#00a1e4", INK],
  23: ["#5eadc5", "#007697", WHITE],
  28: ["#8f53a1", "#8f53a1", WHITE],
  UN: UNKNOWN,
};
const FRAC = {
  1: ["#6ec9c4", "#5ac4bf", WHITE],
  39: ["#d58f7d", "#b72f2f", INK], 7: ["#c86b5a", "#b72f2f", WHITE], 11: ["#b72f2f", "#b72f2f", WHITE],
  21: ["#b8796b", "#983233", INK], 45: ["#d7b3a9", "#983233", "#973133"],
  16.1: ["#e7b4d3", "#cf4b9b", INK], 16.2: ["#da82b6", "#cf4b9b", WHITE], 16.3: ["#cf4b9b", "#cf4b9b", WHITE],
  P1: ["#e6dabf", "#a78337", INK], P2: ["#ceb78b", "#a78337", INK], P3: ["#a78337", "#a78337", WHITE], P7: ["#b69654", "#a78337", INK],
  U18: ["#e07e27", "#e07e27", WHITE],
  M: ["#00936f", "#00936f", WHITE],
  24: ["#efb886", "#e07e27", INK], 25: ["#e8a060", "#e07e27", WHITE], 41: ["#e07e27", "#e07e27", WHITE],
  12: ["#857673", "#5b514f", WHITE], 2: ["#695c5a", "#5b514f", WHITE],
  3: ["#a4cf9a", "#6fb966", INK], 17: ["#5bb355", "#6fb966", WHITE],
  19: ["#f2c59b", "#e07e27", "#e07e26"],
  // 表にないもの。同じ作用機構の色にする
  "11A": ["#b72f2f", "#b72f2f", WHITE], // C: 呼吸（QoI）
  5: ["#a4cf9a", "#6fb966", INK], 18: ["#a4cf9a", "#6fb966", INK], // G: ステロール生合成
  BM: ["#dfe8d2", "#7f9a6a", INK], // 生物由来
  UN: UNKNOWN,
};
// 作用機構のまとまりで色を決めた。脂質は橙、アミノ酸は緑、微小管は青、オーキシンは紫、光合成は黄、色素は桃、PPO は赤
const HRAC = {
  1: ["#e07e27", "#e07e27", WHITE], 15: ["#efb886", "#e07e27", INK], 30: ["#f8dcc0", "#e07e27", INK],
  2: ["#40ad49", "#40ad49", WHITE], 9: ["#00936f", "#00936f", WHITE], 10: ["#9fd8c4", "#00936f", INK],
  3: ["#00a1e4", "#00a1e4", WHITE], 23: ["#9ed5f4", "#00a1e4", INK],
  4: ["#8f53a1", "#8f53a1", WHITE],
  5: ["#f8ed00", "#f8ed00", INK], 6: ["#faf499", "#f8ed00", INK], 22: ["#fcf7c0", "#f8ed00", INK],
  27: ["#cf4b9b", "#cf4b9b", WHITE], 13: ["#da82b6", "#cf4b9b", WHITE], 12: ["#e7b4d3", "#cf4b9b", INK], 34: ["#f3d6e8", "#cf4b9b", INK],
  14: ["#d2232a", "#d2232a", WHITE],
  29: ["#ccc4a9", "#706322", INK],
  0: UNKNOWN,
};
const TABLES = { IRAC, FRAC, HRAC };

// コードの色。[塗り, 枠, 文字]
export function iconColors(committee, code) {
  if (code === "-" || code === "?") {
    return NONE;
  }
  const table = TABLES[committee] || {};
  const family = code.match(/^\d+/)?.[0];
  return (
    table[code] ||
    (/^UN/.test(code) && table.UN) ||
    (committee === "FRAC" && /^M\d+$/.test(code) && table.M) ||
    (committee === "FRAC" && /^P\d+$/.test(code) && table.P2) ||
    (committee === "FRAC" && /^BM/.test(code) && table.BM) ||
    // 同じ数字のグループ（4F なら 4E と同じ色にする。グループの最後のものがいちばん淡い）
    (committee === "IRAC" && family && Object.entries(table).filter(([key]) => key.match(/^\d+/)?.[0] === family && /[A-Z]$/.test(key)).pop()?.[1]) ||
    OUTLINE
  );
}

// ---- 形（寸法は元の表の pt） ----
const round = (n) => Math.round(n * 100) / 100;
const PAD = 0.5;

// 葉の形。単位正方形の (0,0) から (1,1) へ y = x^10 で進み、それを (0.5, 0.5) で点対称にした
// y = 1 - (1 - x)^10 で戻る。画面では左下から右上へ
function leafPath(size) {
  const steps = 32;
  const lower = [];
  for (let i = 0; i <= steps; i++) {
    const x = 1 - (1 - i / steps) ** 3; // x^10 は 1 の近くで急に上がるので、そこを細かく取る
    lower.push([x, x ** 10]);
  }
  // 点対称に写すと、(1,1) から (0,0) へ戻る順に並ぶ
  const upper = lower.map(([x, y]) => [1 - x, 1 - y]);
  const points = [...lower, ...upper.slice(1)].map(([x, y]) => `${round(PAD + x * size)} ${round(PAD + (1 - y) * size)}`);
  return `M${points.join(" L")} Z`;
}
const LEAF_SIZE = 20;
const LEAF = leafPath(LEAF_SIZE);

const SHAPES = {
  // 上の角は半径 8 の曲線、下の角はとがる
  IRAC: {
    w: 19.9,
    h: 18.6,
    draw: (fill, line) => {
      const [x0, y0, w, h] = [PAD, PAD, 19.9, 18.6];
      const d =
        `M${x0 + 8} ${y0} C${x0 + 8} ${y0} ${x0} ${y0} ${x0} ${y0 + 8} L${x0} ${y0 + h} L${round(x0 + w)} ${y0 + h} ` +
        `L${round(x0 + w)} ${y0 + 8} C${round(x0 + w)} ${y0 + 8} ${round(x0 + w)} ${y0} ${round(x0 + w - 8)} ${y0} Z`;
      return `<path d="${d}" fill="${fill}" stroke="${line}" stroke-width="0.6"/>`;
    },
    textY: (h) => PAD + h / 2,
  },
  // 外の四角（帯の色）の中に、上下 2 pt ずつ帯を残して、中の四角（塗りの色）
  FRAC: {
    w: 18.6,
    h: 20.6,
    draw: (fill, line, band) =>
      `<rect x="${PAD}" y="${PAD}" width="18.6" height="20.6" fill="${band}" stroke="${line}" stroke-width="0.6"/>` +
      `<rect x="${PAD}" y="${PAD + 2}" width="18.6" height="16.7" fill="${fill}" stroke="${line}" stroke-width="0.6"/>`,
    textY: (h) => PAD + h / 2,
  },
  HRAC: {
    w: LEAF_SIZE,
    h: LEAF_SIZE,
    draw: (fill, line) => `<path d="${LEAF}" fill="${fill}" stroke="${line}" stroke-width="0.6" stroke-linejoin="round"/>`,
    textY: (h) => PAD + h / 2,
  },
};

const FONTS = {
  IRAC: "'UD新ゴ','Hiragino Sans','Yu Gothic','Meiryo',Arial,sans-serif",
  FRAC: "'UD黎ミン','Hiragino Mincho ProN','Yu Mincho','MS PMincho','Times New Roman',serif",
  HRAC: "'UD新ゴ','Hiragino Sans','Yu Gothic','Meiryo',Arial,sans-serif",
};

// 元の表の書き方。作用機構が不明（UN）は「不明」、未分類（NC）は「未」
const LABELS = { "-": "−", UN: "不明", NC: "未" };
export const codeLabel = (code) => LABELS[code] || code;

// 文字の大きさ。元の表は、2 文字まで 11.6 pt、3 文字 10.2 pt、4 文字と、漢字 2 文字（不明）は 9.2 pt
function fontSize(committee, label) {
  const n = [...label].length;
  const wide = n >= 2 && /[^\x20-\x7e]/.test(label.replace("−", ""));
  const size = wide ? 9 : n <= 2 ? 11.4 : n === 3 ? 10 : 9;
  return committee === "HRAC" ? size - 1.4 : size;
}

// 文字の幅の見積もり（pt）。収まらないときだけ、横に縮める
function textWidth(label, size) {
  const em = (c) => (/[^\x20-\x7e−]/.test(c) ? 1 : /[MW]/.test(c) ? 0.86 : /[A-Z]/.test(c) ? 0.68 : c === "." ? 0.3 : 0.58);
  return [...label].reduce((sum, c) => sum + em(c), 0) * size;
}

// アイコン 1 つの SVG。title は、指したときに出る説明
export function iconSvg(committee, code, title = "") {
  const kind = SHAPES[committee] ? committee : "IRAC";
  const shape = SHAPES[kind];
  const label = codeLabel(code);
  const [fill, line, ink] = iconColors(committee, code);
  // FRAC の帯は、色のあるものは白、枠だけのものは灰色
  const band = fill === WHITE ? "#939598" : WHITE;
  const size = fontSize(kind, label);
  const w = round(shape.w + PAD * 2);
  const h = round(shape.h + PAD * 2);
  const maxText = shape.w - (kind === "HRAC" ? 7 : 2.5);
  const fit = textWidth(label, size) > maxText ? ` textLength="${maxText}" lengthAdjust="spacingAndGlyphs"` : "";
  const text = title || `${committee || "分類"} ${label}`;
  return (
    `<svg class="rac-icon rac-${kind.toLowerCase()}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(text)}" data-rac="${escapeHtml(`${committee}:${code}`)}">` +
    `<title>${escapeHtml(text)}</title>${shape.draw(fill, line, band)}` +
    `<text x="${round(w / 2)}" y="${round(shape.textY(shape.h))}" dominant-baseline="central" text-anchor="middle" font-family="${FONTS[kind]}" font-weight="${kind === "FRAC" ? 900 : 700}" font-size="${size}" fill="${ink}"${fit}>${escapeHtml(label)}</text></svg>`
  );
}

// ---- 製品のコード ----

// 用途から、どの委員会のコードを出すか。殺虫殺菌剤なら IRAC と FRAC。用途で決まらなければ null（すべて出す）
export function committeesOf(useType = "") {
  const out = [];
  if (/殺虫|殺そ/.test(useType)) {
    out.push("IRAC");
  }
  if (/殺菌/.test(useType)) {
    out.push("FRAC");
  }
  if (/除草/.test(useType)) {
    out.push("HRAC");
  }
  return out.length ? out : null;
}

// 製品のアイコンに出すコード。[{ committee, code, ingredients: [成分] }]。
// names は有効成分（①〜⑤の順）、codes は 成分 → [{ committee, code }] の Map。
// - 用途に合う委員会のコードを出す（殺菌剤の中の硫黄なら FRAC の M2 だけ）。合うものがなければ、その成分のコードをすべて出す
// - 表にない成分は「?」。ただし用途が「その他」（展着剤、フェロモン剤など。表が対象にしていない）なら「−」
// - 分類の対象外（−）は、ほかにコードがあれば出さない。何もなければ「−」を 1 つ
export function productCodes(names, useType, codes) {
  const wanted = committeesOf(useType);
  const fallback = wanted?.[0] || "IRAC";
  const found = new Map();
  const add = (committee, code, ingredient) => {
    const key = `${committee}:${code}`;
    if (!found.has(key)) {
      found.set(key, { committee, code, ingredients: [] });
    }
    if (ingredient && !found.get(key).ingredients.includes(ingredient)) {
      found.get(key).ingredients.push(ingredient);
    }
  };
  for (const name of names || []) {
    const rows = codes.get(name);
    if (!rows?.length) {
      add(fallback, useType === "その他" ? "-" : "?", name);
      continue;
    }
    const picked = wanted ? rows.filter((row) => wanted.includes(row.committee)) : rows;
    for (const row of picked.length ? picked : rows) {
      add(row.committee || fallback, row.code, name);
    }
  }
  const list = [...found.values()];
  const real = list.filter((item) => item.code !== "-");
  return real.length ? real : [{ committee: fallback, code: "-", ingredients: list.flatMap((item) => item.ingredients) }];
}

// 名前だけで入れた農薬（登録番号のないもの）。分類は分からないので「−」
export const UNKNOWN_PRODUCT = [{ committee: "IRAC", code: "-", ingredients: [] }];

function title({ committee, code, ingredients }) {
  const what = code === "-" ? "作用機構分類なし" : code === "?" ? "作用機構分類の表にない成分" : `${committee} ${code}`;
  return ingredients.length ? `${what}（${ingredients.join("・")}）` : what;
}

// 製品のアイコンを並べた HTML。list は productCodes の結果
export function iconsHtml(list) {
  return `<span class="rac-icons">${list.map((item) => iconSvg(item.committee, item.code, title(item))).join("")}</span>`;
}

// 文字しか出せない所に書き添える形。「IRAC 4A・FRAC 3」
export function codesText(list) {
  const real = list.filter((item) => item.code !== "-");
  return real.length ? real.map((item) => (item.code === "?" ? "分類不明" : `${item.committee} ${item.code}`)).join("・") : "作用機構分類なし";
}

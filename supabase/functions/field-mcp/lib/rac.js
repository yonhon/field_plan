// 農薬の作用機構分類（RAC コード）のアイコン。農薬名の後ろに付ける。
// 形と色は、現代農業 2018 年 6 月号「RAC コードでローテーション防除」の表にならう。
//   IRAC（殺虫剤）: ボトルのフタ。上の角が大きく丸く、下は平ら
//   FRAC（殺菌剤）: 袋。四角の上下に帯がある
//   HRAC（除草剤）: 斜めの葉。y = x^10 と、それを (0.5, 0.5) で点対称にした曲線にはさまれた形（表にないので新しく作った）
// 塗り方は 3 通り。濃い色で塗って白い文字 / 淡い色で塗って濃い色の枠 / 白地に黒い枠（色の系統のないもの）。
// 作用機構の近いグループは同じ系統の色にし、同じ系統の中では後のものほど淡くする。
// 表にないコードは、同じグループ（数字が同じ、M・P などの頭文字が同じ）の色にし、なければ白地に黒い枠にする。
// FAMIC の部分（4.7）と一緒に切り離す。データは pesticide.js が読む
import { escapeHtml } from "./html.js";

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

// アイコン 1 つの SVG。title は読み上げの文、ingredients は説明に添える有効成分
export function iconSvg(committee, code, title = "", ingredients = []) {
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
    // 説明は、指すかクリックしたときに出す（pesticide.js）。ブラウザーの小さな説明（title）と二重にならないよう、title は付けない
    `<svg class="rac-icon rac-${kind.toLowerCase()}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(text)}" data-rac="${escapeHtml(`${committee}:${code}`)}"` +
    `${ingredients.length ? ` data-ingredients="${escapeHtml(ingredients.join("・"))}"` : ""}>${shape.draw(fill, line, band)}` +
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
  return `<span class="rac-icons">${list.map((item) => iconSvg(item.committee, item.code, title(item), item.ingredients)).join("")}</span>`;
}

// ---- 説明 ----
// アイコンを指すかクリックしたときに出す説明。クロップライフジャパンの日本語訳の分類表の文による。
//   IRAC: 殺虫剤の作用機構分類 Ver.11.3（2025 年 1 月）の「主要グループと一次作用部位」。主要グループ（数字）ごと
//   FRAC: FRAC の作用機構分類（2025 年 5 月）の「作用機構」と「標的部位」
//   HRAC: 除草剤の作用機構分類（2025 年 7 月）の「作用機構」。3 と 23 は、定義の変わった 2026 年 2 月版の国内の表による

// [主要グループと一次作用部位, 作用の種類]
const IRAC_GROUPS = {
  1: ["アセチルコリンエステラーゼ（AChE）阻害剤", "神経作用"],
  2: ["GABA作動性塩素イオンチャネルブロッカー", "神経作用"],
  3: ["ナトリウムチャネルモジュレーター", "神経作用"],
  4: ["ニコチン性アセチルコリン受容体（nAChR）競合的モジュレーター", "神経作用"],
  5: ["ニコチン性アセチルコリン受容体（nAChR）アロステリックモジュレーター 部位Ⅰ", "神経作用"],
  6: ["グルタミン酸作動性塩素イオンチャネル（GluCl）アロステリックモジュレーター", "神経および筋肉作用"],
  7: ["幼若ホルモン受容体モジュレーター", "生育調節"],
  8: ["多様な非特異的（マルチサイト）阻害剤", ""],
  9: ["弦音器官TRPVチャネルモジュレーター", "神経作用"],
  10: ["CHS1に作用するダニ類成長阻害剤", "生育調節"],
  11: ["微生物由来昆虫中腸内膜破壊剤", ""],
  12: ["ミトコンドリアATP合成酵素阻害剤", "エネルギー代謝"],
  13: ["プロトン勾配を攪乱する酸化的リン酸化脱共役剤", "エネルギー代謝"],
  14: ["ニコチン性アセチルコリン受容体（nAChR）チャネルブロッカー", "神経作用"],
  15: ["CHS1に作用するキチン生合成阻害剤", "生育調節"],
  16: ["キチン生合成阻害剤 タイプ1", "生育調節"],
  17: ["脱皮阻害剤 ハエ目昆虫", "生育調節"],
  18: ["脱皮ホルモン（エクダイソン）受容体アゴニスト", "生育調節"],
  19: ["オクトパミン受容体アゴニスト", "神経作用"],
  20: ["ミトコンドリア電子伝達系複合体Ⅲ阻害剤 Qo部位", "エネルギー代謝"],
  21: ["ミトコンドリア電子伝達系複合体Ⅰ阻害剤（METI）", "エネルギー代謝"],
  22: ["電位依存性ナトリウムチャネルブロッカー", "神経作用"],
  23: ["アセチルCoAカルボキシラーゼ阻害剤", "脂質合成、生育調節"],
  24: ["ミトコンドリア電子伝達系複合体Ⅳ阻害剤", "エネルギー代謝"],
  25: ["ミトコンドリア電子伝達系複合体Ⅱ阻害剤", "エネルギー代謝"],
  28: ["リアノジン受容体モジュレーター", "神経および筋肉作用"],
  29: ["弦音器官ニコチンアミダーゼ阻害剤", "神経作用"],
  30: ["GABA作動性塩化物イオンチャネルアロステリックモジュレーター", "神経作用"],
  31: ["バキュロウイルス", "宿主特異的閉塞性病原性ウイルス"],
  32: ["ニコチン性アセチルコリン受容体（nAChR）アロステリックモジュレーター 部位Ⅱ", "神経作用"],
  33: ["カルシウム活性化カリウムチャネル（KCa2）モジュレーター", "神経作用"],
  34: ["ミトコンドリア電子伝達系複合体Ⅲ阻害剤 Qi部位", "エネルギー代謝"],
  35: ["RNA干渉を介した標的抑制因子", ""],
  36: ["弦音器官モジュレーター 標的部位未特定", "神経作用"],
  37: ["小胞アセチルコリントランスポーター（VAChT）阻害剤", "神経作用"],
  UN: ["作用機構が不明あるいは不確定な剤", ""],
  UNB: ["作用機構が不明あるいは不確定な細菌剤（Bt剤を除く）", ""],
  UNE: ["作用機構が不明あるいは不確定な植物エッセンス（合成物、抽出物あるいは未精製油を含む）", ""],
  UNF: ["作用機構が不明あるいは不確定な真菌剤", ""],
  UNM: ["作用機構が不明あるいは不確定な非特異的な機械的・物理的攪乱剤", ""],
  UNP: ["作用機構が不明あるいは不確定なペプチド", ""],
  UNV: ["作用機構が不明あるいは不確定なウイルス剤（バキュロウイルスを除く）", ""],
};

const FRAC_MECHANISMS = {
  A: "核酸合成代謝",
  B: "細胞骨格とモータータンパク質",
  C: "呼吸",
  D: "アミノ酸およびタンパク質生合成",
  E: "シグナル伝達",
  F: "脂質生合成または輸送／細胞膜の構造または機能",
  G: "細胞膜のステロール生合成",
  H: "細胞壁生合成",
  I: "細胞壁のメラニン合成",
  P: "宿主植物の抵抗性誘導",
  U: "作用機構不明",
  NC: "特定されない",
  M: "多作用点接触活性",
  BM1: "複数の作用機構を有する生物農薬：植物抽出物",
  BM2: "複数の作用機構を有する生物農薬：微生物農薬",
  BM3: "複数の作用機構を有する生物農薬：植物または微生物由来の代謝産物、またはこれらの合成物",
};
// [作用機構の記号, 標的部位]
const FRAC_SITES = {
  4: ["A", "RNAポリメラーゼⅠ"],
  8: ["A", "アデノシンデアミナーゼ"],
  32: ["A", "DNA/RNA生合成（提案中）"],
  31: ["A", "DNAトポイソメラーゼ タイプⅡ（ジャイレース）"],
  52: ["A", "デノボピリミジン生合成におけるジヒドロオロト酸デヒドロゲナーゼ阻害"],
  1: ["B", "チューブリン重合"],
  10: ["B", "チューブリン重合"],
  22: ["B", "チューブリン重合"],
  20: ["B", "細胞分裂（作用点不明）"],
  43: ["B", "スペクトリン様タンパク質の非局在化"],
  47: ["B", "アクチン/ミオシン/フィンブリン機能"],
  50: ["B", "アクチン/ミオシン/フィンブリン機能"],
  53: ["B", "チューブリンダイナミクスモジュレーター"],
  39: ["C", "複合体Ⅰ：NADH酸化還元酵素"],
  7: ["C", "複合体Ⅱ：コハク酸脱水素酵素"],
  11: ["C", "複合体Ⅲ：チトクロームbc1（ユビキノール酸化酵素）Qo部位（cyt b遺伝子）"],
  "11A": ["C", "複合体Ⅲ：チトクロームbc1（ユビキノール酸化酵素）Qo部位（cyt b遺伝子）"],
  21: ["C", "複合体Ⅲ：ユビキノン還元酵素 Qi部位"],
  29: ["C", "酸化的リン酸化の脱共役"],
  30: ["C", "酸化的リン酸化、ATP合成酵素の阻害"],
  38: ["C", "ATP輸送（提案中）"],
  45: ["C", "複合体Ⅲ：ユビキノン還元酵素（Qi、Qo部位、スチグマテリン結合様式）"],
  9: ["D", "メチオニン生合成（cgs遺伝子）（提案中）"],
  23: ["D", "タンパク質生合成（リボソーム 翻訳終了段階）"],
  24: ["D", "タンパク質生合成（リボソーム 翻訳開始段階）"],
  25: ["D", "タンパク質生合成（リボソーム 翻訳開始段階）"],
  41: ["D", "タンパク質生合成（リボソーム ポリペプチド伸長段階）"],
  54: ["D", "ロイシル-tRNA合成（LeuRNA）"],
  13: ["E", "シグナル伝達（作用機構不明）"],
  12: ["E", "浸透圧シグナル伝達におけるMAP/ヒスチジンキナーゼ（os-2、HOG1）"],
  2: ["E", "浸透圧シグナル伝達におけるMAP/ヒスチジンキナーゼ（os-1、Daf1）"],
  6: ["F", "リン脂質生合成、メチルトランスフェラーゼ"],
  14: ["F", "細胞脂質の過酸化（提案中）"],
  28: ["F", "細胞膜透過性、脂肪酸（提案中）"],
  48: ["F", "エルゴステロール結合"],
  49: ["F", "脂質恒常性および輸送/貯蔵"],
  51: ["F", "細胞膜脂質画分との相互作用、細胞膜への複数の作用"],
  3: ["G", "ステロール生合成のC14位の脱メチル化酵素（erg11/cyp51）"],
  5: ["G", "ステロール生合成におけるΔ14還元酵素及びΔ8→Δ7-イソメラーゼ（erg24、erg2）"],
  17: ["G", "ステロール生合成系のC4位脱メチル化における3-ケト還元酵素（erg27）"],
  18: ["G", "ステロール生合成系のスクワレンエポキシダーゼ（erg1）"],
  19: ["H", "キチン合成酵素"],
  40: ["H", "セルロース合成酵素"],
  16.1: ["I", "メラニン生合成の還元酵素"],
  16.2: ["I", "メラニン生合成の脱水酵素"],
  16.3: ["I", "メラニン生合成のポリケタイド合成酵素"],
  P1: ["P", "サリチル酸シグナル伝達"],
  P2: ["P", "サリチル酸シグナル伝達"],
  P3: ["P", "サリチル酸シグナル伝達"],
  P4: ["P", "多糖類エリシター"],
  P5: ["P", "アントラキノンエリシター"],
  P6: ["P", "微生物エリシター"],
  P7: ["P", "ホスホナート"],
  P8: ["P", "サリチル酸シグナル伝達"],
  P9: ["P", "ペプチドエリシター"],
  P10: ["P", "ディフェンスプライミング物質"],
  27: ["U", "不明"],
  34: ["U", "不明"],
  35: ["U", "不明"],
  36: ["U", "不明"],
  37: ["U", "不明"],
  U6: ["U", "不明"],
  U12: ["U", "細胞膜の崩壊（提案中）"],
  U13: ["U", "不明"],
  U14: ["U", "不明"],
  U16: ["U", "複合体Ⅲ：チトクロームbc1、結合部位不明（提案中）"],
  U17: ["U", "不明"],
  U18: ["U", "不明（トレハラーゼ阻害）"],
  U19: ["U", "不明"],
  UN: ["U", "不明"],
  NC: ["NC", "不明"],
  BM1: ["BM1", "細胞壁、膜を介したイオン輸送における複数の効果など（植物抽出物によって異なる）"],
  BM2: ["BM2", "複数の作用が報告されている：競合、菌寄生、抗菌作用、殺菌性リポペプチドによる細胞膜破壊、溶菌酵素、抵抗性誘導"],
  BM3: ["BM3", "β(1,3)グルカン合成酵素およびキチン合成酵素の阻害とそれに伴う細胞壁生合成の阻害、膜、膜機能、ミトコンドリアおよび酸化過程の破壊"],
};

const HRAC_MECHANISMS = {
  1: "アセチルCoAカルボキシラーゼ（ACCase）阻害",
  2: "アセト乳酸合成酵素（ALS）阻害（アセトヒドロキシ酸合成酵素（AHAS）阻害）",
  3: "微小管（α-チューブリン）重合阻害",
  4: "インドール酢酸様活性（合成オーキシン）",
  5: "光合成（光化学系Ⅱ）阻害 - セリン264バインダー",
  6: "光合成（光化学系Ⅱ）阻害 - ヒスチジン215バインダー",
  9: "5-エノールピルビルシキミ酸-3-リン酸（EPSP）合成酵素阻害",
  10: "グルタミン合成酵素阻害",
  12: "白化：カロチノイド生合成経路のフィトエン不飽和化酵素（PDS）阻害",
  13: "白化：1-デオキシ-D-キシルロース-5-リン酸（DOXP）合成酵素阻害",
  14: "プロトポルフィリノーゲン酸化酵素（PPO）阻害",
  15: "超長鎖脂肪酸合成（VLCFAs）阻害",
  18: "DHP（ジヒドロプテロイン酸）合成酵素阻害",
  19: "オーキシン移動阻害",
  22: "光化学系Ⅰ電子転換",
  23: "微小管形成阻害（詳細不明）",
  24: "アンカップリング（膜破壊）",
  27: "白化：4-ヒドロキシフェニルピルビン酸ジオキシゲナーゼ（4-HPPD）阻害",
  28: "ジヒドロオロト酸デヒドロゲナーゼ（DHODH）阻害",
  29: "細胞壁（セルロース）合成阻害",
  30: "脂肪酸チオエステラーゼ（FAT）阻害",
  31: "セリン-スレオニンプロテインホスファターゼ阻害",
  32: "ソラネシル二リン酸合成酵素阻害",
  33: "ホモゲンチジン酸ソラネシルトランスフェラーゼ（HST）阻害",
  34: "リコペンシクラーゼ阻害",
  0: "不明",
};

// FRAC の表の書き方（JCPA の表は「BM02」でなく「BM2」、「M01」でなく「M1」）
const fracKey = (code) => code.replace(/^(BM|M)0(\d)$/, "$1$2");

// 説明の行。[{ label, text }]。表にないコードは、分からないと書く
export function describe(committee, code) {
  if (code === "-") {
    return [{ label: "", text: "作用機構分類の対象外です（天敵、展着剤、フェロモン剤など）。" }];
  }
  if (code === "?") {
    return [{ label: "", text: "この成分は、作用機構分類の表にありません。" }];
  }
  if (committee === "IRAC") {
    const key = /^UN/.test(code) ? code : code.match(/^\d+/)?.[0];
    const group = IRAC_GROUPS[key];
    return group
      ? [{ label: "主要グループと一次作用部位", text: group[1] ? `${group[0]}（${group[1]}）` : group[0] }]
      : [{ label: "", text: "説明の表にないコードです。" }];
  }
  if (committee === "FRAC") {
    const key = fracKey(code);
    const site = FRAC_SITES[key] || (/^M\d+$/.test(key) ? ["M", "多作用点接触活性"] : null);
    return site
      ? [
          { label: "作用機構", text: `${site[0].length === 1 ? `${site[0]}：` : ""}${FRAC_MECHANISMS[site[0]]}` },
          { label: "作用点", text: site[1] },
        ]
      : [{ label: "", text: "説明の表にないコードです。" }];
  }
  if (committee === "HRAC") {
    const mechanism = HRAC_MECHANISMS[code];
    return mechanism ? [{ label: "作用機構", text: mechanism }] : [{ label: "", text: "説明の表にないコードです。" }];
  }
  return [];
}

const COMMITTEE_NAMES = { IRAC: "殺虫剤", FRAC: "殺菌剤", HRAC: "除草剤" };

// 説明の箱の中身（HTML）。ingredients はその製品で、このコードを持つ有効成分
export function describeHtml(committee, code, ingredients = []) {
  const head =
    code === "-" ? "作用機構分類なし" : code === "?" ? "分類不明" : `${committee} ${codeLabel(code) === code ? code : `${code}（${codeLabel(code)}）`}`;
  const sub = COMMITTEE_NAMES[committee] && code !== "-" && code !== "?" ? `<span class="rac-pop-kind">${COMMITTEE_NAMES[committee]}の作用機構分類</span>` : "";
  const lines = describe(committee, code)
    .map((line) => `<p>${line.label ? `<span class="rac-pop-label">${escapeHtml(line.label)}：</span>` : ""}${escapeHtml(line.text)}</p>`)
    .join("");
  const names = ingredients.length ? `<p class="rac-pop-ingredients">有効成分：${escapeHtml(ingredients.join("・"))}</p>` : "";
  return `<div class="rac-pop-head">${iconSvg(committee, code)}<strong>${escapeHtml(head)}</strong>${sub}</div>${lines}${names}`;
}

// 文字しか出せない所に書き添える形。「IRAC 4A・FRAC 3」
export function codesText(list) {
  const real = list.filter((item) => item.code !== "-");
  return real.length ? real.map((item) => (item.code === "?" ? "分類不明" : `${item.committee} ${item.code}`)).join("・") : "作用機構分類なし";
}

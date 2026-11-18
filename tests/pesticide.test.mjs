// 防除の記録の、農薬の使用基準の部分（app/pesticide.js）のテスト。実行: node --test "tests/*.test.mjs"
// 使用回数の数え方と指摘の判定は logs.js にあり、tests/logs.test.mjs が確かめる。ここでは、
// 品目のまとまりごとにどの基準の行を使うか、記録に何を写すか、それを logs.js の計算にどう渡すかを確かめる。
// FAMIC の部分を使わない状態（initPesticide を呼ばない）で読むので、農薬名にアイコンは付かない
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  areaDosed,
  baselineLiters,
  baselineUsage,
  chooseCrop,
  chooseUse,
  cropsOf,
  fillChoices,
  groupProducts,
  missingChoices,
  resetCrop,
  rowFor,
  searchKey,
  snapshot,
  suggestedDilution,
  unpick,
  useKeys,
  warnings,
} from "../app/pesticide.js";

// 液剤（希釈して散布する）の使用基準の行
const LIQUID = [
  {
    crop: "レタス",
    target: "アブラムシ類",
    method: "散布",
    dilution_text: "1000~2000倍",
    liquid_text: "100~300L/10a",
    timing_text: "収穫7日前まで",
    times_text: "3回以内",
    totals: ["3回以内", "2回以内(定植後は1回以内)"],
    dilution_min: 1000,
    dilution_max: 2000,
    liquid_min: 100,
    liquid_max: 300,
    preharvest_days: 7,
    times_max: 3,
    total_max: [3, 2],
  },
  { crop: "レタス", target: "ヨトウムシ類", method: "散布", dilution_text: "2000倍", dilution_min: 2000, dilution_max: 2000, liquid_min: 100, liquid_max: 300, times_max: 3, total_max: [3, 2] },
  { crop: "キャベツ", target: "アブラムシ類", method: "散布", dilution_text: "1500倍", dilution_min: 1500, dilution_max: 1500, liquid_min: 100, liquid_max: 300, times_max: 2, total_max: [3, 2] },
];

// 粒剤（面積あたりの使用量で使う）の使用基準の行
const GRANULE = [
  { crop: "レタス", target: "ネキリムシ類", method: "株元散布", dilution_text: "6kg/10a", dilution_min: null, liquid_min: null, liquid_max: null },
  { crop: "キャベツ", target: "ネキリムシ類", method: "株元散布", dilution_text: "4~6kg/10a", dilution_min: null, liquid_min: null, liquid_max: null },
];

// 品目のまとまり 2 つ。面積は ㎡
const GROUPS = [
  { key: "g1", name: "レタス", cropName: "レタス", area: 100, plantingIds: ["p1"] },
  { key: "g2", name: "キャベツ", cropName: "キャベツ", area: 50, plantingIds: ["p2"] },
];

const liquid = (choices = {}, extra = {}) => ({
  kind: "pesticide",
  reg_no: "100",
  name: "テスト乳剤",
  _product: { reg_no: 100, name: "テスト乳剤", formulation: "乳剤", ingredients: ["成分A", "成分B"] },
  _uses: { rows: LIQUID },
  choices,
  _prefilled: new Set(),
  ...extra,
});

const granule = (choices = {}, extra = {}) => ({
  kind: "pesticide",
  reg_no: "200",
  name: "テスト粒剤",
  _product: { reg_no: 200, name: "テスト粒剤", formulation: "粒剤", ingredients: ["成分C"] },
  _uses: { rows: GRANULE },
  choices,
  _prefilled: new Set(),
  ...extra,
});

const BOTH_LIQUID = { g1: { crop: "レタス", use_key: "アブラムシ類|散布" }, g2: { crop: "キャベツ", use_key: "アブラムシ類|散布" } };
const BOTH_GRANULE = { g1: { crop: "レタス", use_key: "ネキリムシ類|株元散布" }, g2: { crop: "キャベツ", use_key: "ネキリムシ類|株元散布" } };

test("検索の文字: 全角・半角をそろえ、ひらがなをカタカナにする", () => {
  assert.equal(searchKey(" あるばりん "), "アルバリン");
  assert.equal(searchKey("ｱﾙﾊﾞﾘﾝ"), "アルバリン");
  assert.equal(searchKey("１２３"), "123");
});

test("有効成分ごとの行を、登録番号ごとの農薬にまとめる。数えない成分も、成分の順の位置を空けて残す", () => {
  const rows = [
    { reg_no: 200, ord: 1, name: "乙剤", kind: "殺菌剤", use_type: "殺菌剤", formulation: "水和剤", ingredient: "成分X", count_ingredient: "成分X" },
    { reg_no: 100, ord: 2, name: "甲剤", kind: "殺虫剤", use_type: "殺虫剤", formulation: "乳剤", ingredient: "成分B", count_ingredient: "成分B" },
    { reg_no: 100, ord: 1, name: "甲剤", kind: "殺虫剤", use_type: "殺虫剤", formulation: "乳剤", ingredient: "展着成分", count_ingredient: null },
  ];
  const products = groupProducts(rows);
  assert.deepEqual(
    products.map((product) => [product.reg_no, product.ingredients, product.names]),
    [
      [100, ["", "成分B"], ["展着成分", "成分B"]],
      [200, ["成分X"], ["成分X"]],
    ]
  );
  assert.deepEqual(products[0], { reg_no: 100, name: "甲剤", kind: "殺虫剤", use_type: "殺虫剤", formulation: "乳剤", ingredients: ["", "成分B"], names: ["展着成分", "成分B"] });
  // 1 番目の成分の行が抜けていても、2 番目の成分は 2 番目の位置に入る（上限の total_max[k] と位置で対応するため）
  assert.deepEqual(groupProducts([{ ...rows[1] }])[0].ingredients, ["", "成分B"]);
  // 元の配列は並べ替えない
  assert.equal(rows[0].reg_no, 200);
});

test("作物名と使い方の一覧: 名前の順。同じ使い方は 1 つにまとめ、適用病害虫が空の登録は指定なしと書く", () => {
  const input = liquid();
  assert.deepEqual(cropsOf(input), ["キャベツ", "レタス"]);
  assert.deepEqual(
    useKeys(input, "レタス").map((item) => item.key),
    ["アブラムシ類|散布", "ヨトウムシ類|散布"]
  );
  assert.deepEqual(useKeys(input, "トマト"), []);
  const spreader = { _uses: { rows: [{ crop: "野菜類", target: "", method: "添加" }, { crop: "野菜類", target: "", method: "添加" }] } };
  assert.deepEqual(useKeys(spreader, "野菜類"), [{ key: "|添加", label: "添加（適用病害虫の指定なし）", method: "添加" }]);
  assert.deepEqual(cropsOf({}), []);
});

test("まとまりで選んだ作物名と使い方の、使用基準の行", () => {
  const input = liquid(BOTH_LIQUID);
  assert.equal(rowFor(input, GROUPS[0]), LIQUID[0]);
  assert.equal(rowFor(input, GROUPS[1]), LIQUID[2]);
  // 同じ作物名で、適用病害虫の違う行を選び分ける
  assert.equal(rowFor(liquid({ g1: { crop: "レタス", use_key: "ヨトウムシ類|散布" } }), GROUPS[0]), LIQUID[1]);
  // 作物名と使い方の組み合わせが登録にないとき
  assert.equal(rowFor(liquid({ g1: { crop: "キャベツ", use_key: "ヨトウムシ類|散布" } }), GROUPS[0]), null);
  assert.equal(rowFor(liquid({ g1: { crop: "レタス", use_key: "アブラムシ類|株元散布" } }), GROUPS[0]), null);
  // まだ選んでいないとき
  assert.equal(rowFor(liquid({ g1: { crop: "レタス", use_key: "" } }), GROUPS[0]), null);
  assert.equal(rowFor(liquid({ g1: { crop: "", use_key: "アブラムシ類|散布" } }), GROUPS[0]), null);
  assert.equal(rowFor(liquid({}), GROUPS[0]), null);
  assert.equal(rowFor(liquid(BOTH_LIQUID, { _uses: null }), GROUPS[0]), null);
  assert.equal(rowFor({ ...liquid(BOTH_LIQUID), choices: undefined }, GROUPS[0]), null);
  // 適用病害虫が空の登録
  const spreader = { choices: { g1: { crop: "野菜類", use_key: "|添加" } }, _uses: { rows: [{ crop: "野菜類", target: "", method: "添加" }] } };
  assert.equal(rowFor(spreader, GROUPS[0]), spreader._uses.rows[0]);
});

test("作物名と使い方を選ぶ: 使い方が 1 つなら一緒に選ぶ。記録の使い方の欄は、最初のまとまりの使用方法", () => {
  const input = liquid({}, { _prefilled: new Set(["g1", "g2"]) });
  // キャベツの使い方は 1 つだけ
  chooseCrop(input, "g2", "キャベツ", GROUPS);
  assert.deepEqual(input.choices.g2, { crop: "キャベツ", use_key: "アブラムシ類|散布" });
  assert.equal(input.method, "散布");
  assert.ok(!input._prefilled.has("g2"));
  // レタスの使い方は 2 つあるので、選ばずに待つ
  chooseCrop(input, "g1", "レタス", GROUPS);
  assert.deepEqual(input.choices.g1, { crop: "レタス", use_key: "" });
  assert.ok(!input._prefilled.has("g1"));
  chooseUse(input, "g1", "ヨトウムシ類|散布", GROUPS);
  assert.deepEqual(input.choices.g1, { crop: "レタス", use_key: "ヨトウムシ類|散布" });
  assert.equal(rowFor(input, GROUPS[0]), LIQUID[1]);

  // 最初のまとまりの使用方法を、記録の使い方にする（あとのまとまりではない）
  const mixed = granule({}, { _uses: { rows: [...GRANULE, { crop: "キャベツ", target: "アブラムシ類", method: "散布" }] } });
  chooseCrop(mixed, "g1", "レタス", GROUPS);
  chooseCrop(mixed, "g2", "キャベツ", GROUPS);
  chooseUse(mixed, "g2", "アブラムシ類|散布", GROUPS);
  assert.equal(mixed.method, "株元散布");

  resetCrop(input, "g1");
  assert.deepEqual(input.choices.g1, { crop: "", use_key: "" });
  assert.equal(rowFor(input, GROUPS[0]), null);

  unpick(input);
  assert.equal(input.reg_no, null);
  assert.deepEqual(input.choices, {});
  assert.equal(input._uses, null);
});

test("記録を直すときの初めの選択は、その記録の写しの選択。前回の選択の印は付けない", () => {
  const standard = {
    rows: [
      { crop_name: "レタス", group: "レタス", crop: "レタス", target: "ヨトウムシ類", method: "散布" },
      { crop_name: "キャベツ", group: "キャベツ", crop: "キャベツ", target: "アブラムシ類", method: "散布" },
    ],
  };
  const input = liquid({}, { standard });
  assert.equal(fillChoices(input, GROUPS), true);
  assert.deepEqual(input.choices, { g1: { crop: "レタス", use_key: "ヨトウムシ類|散布" }, g2: { crop: "キャベツ", use_key: "アブラムシ類|散布" } });
  assert.equal(input._prefilled.size, 0);
  assert.equal(input.method, "散布");
  // 選んであるまとまりは変えない。何も変えなければ false
  assert.equal(fillChoices(input, GROUPS), false);
  const kept = liquid({ g1: { crop: "レタス", use_key: "アブラムシ類|散布" } }, { standard });
  fillChoices(kept, GROUPS);
  assert.deepEqual(kept.choices.g1, { crop: "レタス", use_key: "アブラムシ類|散布" });
  // 写しの使い方が今の登録にないときは、作物名だけを選ぶ
  const gone = liquid({}, { standard: { rows: standard.rows.map((row) => ({ ...row, target: "ハダニ類" })) } });
  fillChoices(gone, GROUPS);
  assert.deepEqual(gone.choices, { g1: { crop: "レタス", use_key: "" }, g2: { crop: "キャベツ", use_key: "" } });
  // 使用基準を読めていなければ、何もしない
  assert.equal(fillChoices(liquid({}, { standard, _uses: null }), GROUPS), false);
});

test("作物名と使い方を選び終えていないまとまり", () => {
  const done = liquid(BOTH_LIQUID);
  const half = granule({ g1: BOTH_GRANULE.g1 });
  const fertilizer = { kind: "fertilizer", name: "肥料", choices: {} };
  const unnamed = { kind: "pesticide", reg_no: null, name: "手で入れた農薬", choices: {} };
  const missing = missingChoices([done, half, fertilizer, unnamed], GROUPS);
  assert.deepEqual(
    missing.map((item) => [item.input.name, item.group.key]),
    [["テスト粒剤", "g2"]]
  );
  assert.deepEqual(missingChoices([liquid({})], GROUPS).map((item) => item.group.key), ["g1", "g2"]);
});

test("記録に写す使用基準: まとまりごとに、選んだ作物名と使い方と基準。選んでいないまとまりは写さない", () => {
  const input = liquid({ g1: BOTH_LIQUID.g1 });
  assert.deepEqual(snapshot(input, GROUPS), {
    reg_no: "100",
    product: "テスト乳剤",
    ingredients: ["成分A", "成分B"],
    rows: [
      {
        crop_name: "レタス",
        group: "レタス",
        crop: "レタス",
        target: "アブラムシ類",
        method: "散布",
        dilution_text: "1000~2000倍",
        liquid_text: "100~300L/10a",
        timing_text: "収穫7日前まで",
        times_text: "3回以内",
        totals: ["3回以内", "2回以内(定植後は1回以内)"],
        dilution_min: 1000,
        dilution_max: 2000,
        liquid_min: 100,
        liquid_max: 300,
        preharvest_days: 7,
        times_max: 3,
        total_max: [3, 2],
      },
    ],
  });
  assert.deepEqual(
    snapshot(liquid(BOTH_LIQUID), GROUPS).rows.map((row) => [row.crop_name, row.crop, row.times_max]),
    [
      ["レタス", "レタス", 3],
      ["キャベツ", "キャベツ", 2],
    ]
  );
  // 製品を読めていないときは、記録の名前と、前の写しの有効成分
  const old = { reg_no: "100", product: "テスト乳剤", ingredients: ["成分A", "成分B"], rows: [] };
  const noProduct = liquid(BOTH_LIQUID, { name: "記録の名前", _product: null, standard: old });
  assert.equal(snapshot(noProduct, GROUPS).product, "記録の名前");
  assert.deepEqual(snapshot(noProduct, GROUPS).ingredients, ["成分A", "成分B"]);
  assert.deepEqual(snapshot(liquid(BOTH_LIQUID, { _product: null }), GROUPS).ingredients, []);
  // 使用基準を読めていない（直す前のまま保存した）ときは、前の写しを残す
  assert.equal(snapshot(liquid(BOTH_LIQUID, { _uses: null, standard: old }), GROUPS), old);
  assert.equal(snapshot(liquid(BOTH_LIQUID, { _uses: null }), GROUPS), null);
  // 登録番号のない農薬（名前を手で入れた）は、写しを作らない
  assert.equal(snapshot({ kind: "pesticide", reg_no: null, standard: old }, GROUPS), old);
  assert.equal(snapshot({ kind: "pesticide", reg_no: null }, GROUPS), null);
});

test("面積あたりの使用量で使う農薬か: 選んだ基準で決める。選ぶ前は剤型で決める", () => {
  assert.equal(areaDosed(granule(BOTH_GRANULE), GROUPS), true);
  assert.equal(areaDosed(liquid(BOTH_LIQUID), GROUPS), false);
  // 選んだまとまりだけで決める
  assert.equal(areaDosed(granule({ g1: BOTH_GRANULE.g1 }), GROUPS), true);
  // 1 つでも希釈倍数の基準があれば、面積あたりではない
  const mixed = granule(
    { g1: BOTH_GRANULE.g1, g2: { crop: "キャベツ", use_key: "アブラムシ類|散布" } },
    { _uses: { rows: [...GRANULE, LIQUID[2]] } }
  );
  assert.equal(areaDosed(mixed, GROUPS), false);
  // 面積あたりでない使用量（株あたりなど）は、面積あたりではない
  const perPlant = granule({ g1: BOTH_GRANULE.g1 }, { _uses: { rows: [{ ...GRANULE[0], dilution_text: "1~2g/株" }] } });
  assert.equal(areaDosed(perPlant, GROUPS), false);
  // 選ぶ前は剤型（粒剤、粉剤）
  assert.equal(areaDosed(granule({}), GROUPS), true);
  assert.equal(areaDosed(granule({}, { _product: { ...granule()._product, formulation: "粉剤" } }), GROUPS), true);
  assert.equal(areaDosed(liquid({}), GROUPS), false);
  assert.equal(areaDosed(granule({}, { _product: null }), GROUPS), false);
  // 農薬でないもの、登録番号のないもの
  assert.equal(areaDosed({ ...granule(BOTH_GRANULE), kind: "fertilizer" }, GROUPS), false);
  assert.equal(areaDosed({ ...granule(BOTH_GRANULE), reg_no: null }, GROUPS), false);
});

test("面積あたりの使用量の基準の合計: 最初の、面積あたりの使用量の農薬で求める", () => {
  // レタス 6kg/10a × 100 ㎡ = 600 g、キャベツ 4〜6kg/10a × 50 ㎡ = 200〜300 g
  assert.deepEqual(baselineUsage([liquid(BOTH_LIQUID), granule(BOTH_GRANULE)], GROUPS), { min: 800, max: 900, unit: "g" });
  assert.deepEqual(baselineUsage([granule(BOTH_GRANULE)], GROUPS.slice(0, 1)), { min: 600, max: 600, unit: "g" });
  // 面積あたりの農薬がない、または、選んでいないまとまりがあるとき
  assert.equal(baselineUsage([liquid(BOTH_LIQUID)], GROUPS), null);
  assert.equal(baselineUsage([granule({ g1: BOTH_GRANULE.g1 })], GROUPS), null);
  assert.equal(baselineUsage([], GROUPS), null);
});

test("初めの希釈倍率: 選んだ品目の基準の下限のうち、いちばん大きいもの。どのまとまりに合わせたか", () => {
  // レタス 1000 倍以上、キャベツ 1500 倍以上 → 1500 倍（キャベツ）
  assert.deepEqual(suggestedDilution(liquid(BOTH_LIQUID), GROUPS), { value: 1500, by: "キャベツ" });
  assert.deepEqual(suggestedDilution(liquid({ g1: BOTH_LIQUID.g1 }), GROUPS), { value: 1000, by: "レタス" });
  assert.deepEqual(
    suggestedDilution(liquid({ g1: { crop: "レタス", use_key: "ヨトウムシ類|散布" }, g2: BOTH_LIQUID.g2 }), GROUPS),
    { value: 2000, by: "レタス" }
  );
  assert.equal(suggestedDilution(liquid({}), GROUPS), null);
  assert.equal(suggestedDilution(granule(BOTH_GRANULE), GROUPS), null);
});

test("基準散布量の合計（L）: 10 a あたりの散布液量 × 面積", () => {
  // レタス 100〜300 L/10a × 100 ㎡ = 10〜30 L、キャベツ × 50 ㎡ = 5〜15 L
  assert.deepEqual(baselineLiters([liquid(BOTH_LIQUID)], GROUPS), { low: 15, high: 45 });
  // 使用基準を読めていない農薬と、農薬でない資材は飛ばす
  const notLoaded = liquid(BOTH_LIQUID, { _uses: null });
  const fertilizer = { kind: "fertilizer", reg_no: "1", _uses: { rows: [] } };
  assert.deepEqual(baselineLiters([fertilizer, notLoaded, liquid(BOTH_LIQUID)], GROUPS), { low: 15, high: 45 });
  // 1 つのまとまりでも求められなければ null
  assert.equal(baselineLiters([liquid({ g1: BOTH_LIQUID.g1 })], GROUPS), null);
  assert.equal(baselineLiters([liquid(BOTH_LIQUID)], [GROUPS[0], { ...GROUPS[1], area: 0 }]), null);
  assert.equal(baselineLiters([granule(BOTH_GRANULE)], GROUPS), null);
  assert.equal(baselineLiters([liquid(BOTH_LIQUID)], []), null);
  assert.equal(baselineLiters([], GROUPS), null);
  // 散布液量の基準が 0 L から始まるときも求める
  const zero = liquid(BOTH_LIQUID, { _uses: { rows: LIQUID.map((row) => ({ ...row, liquid_min: 0 })) } });
  assert.deepEqual(baselineLiters([zero], GROUPS), { low: 0, high: 45 });
});

// 防除の記録。作付 p1 に、農薬 100 を 3 回使った
const LOGS = ["l1", "l2", "l3"].map((id, i) => ({
  id,
  date: `2026-03-0${i + 1}`,
  targets: [{ planting_id: "p1" }],
  inputs: [{ kind: "pesticide", reg_no: "100", standard: { ingredients: ["成分A", "成分B"] } }],
}));

const context = (inputs, extra = {}) => ({
  inputs,
  groups: GROUPS,
  date: "2026-03-20",
  sprayOf: () => 0,
  logs: [],
  excludeLogId: null,
  harvestStartOf: () => null,
  ...extra,
});

test("防除の指摘: まとまりごとに、選んだ基準と、作付のこれまでの使用回数を照らす", () => {
  assert.deepEqual(warnings(context([liquid(BOTH_LIQUID, { dilution: 2000 })])), [
    "レタス: 成分B の総使用回数には条件があります。確かめてください: 2回以内(定植後は1回以内)",
  ]);
  // 基準より濃い希釈倍率。まとまりごとの基準で言う
  const strong = warnings(context([liquid(BOTH_LIQUID, { dilution: 1200 })]));
  assert.ok(strong.includes("キャベツ: 希釈倍率 1200 倍は、基準（1500 倍以上）より濃くなります"));
  assert.ok(!strong.some((text) => text.startsWith("レタス: 希釈倍率")));
  // まとまりごとの散布液量（sprayOf はまとまりの key で引く）。キャベツは 5 L / 50 ㎡ = 10 a あたり 100 L で基準の中
  const spray = warnings(context([liquid(BOTH_LIQUID, { dilution: 2000 })], { sprayOf: (key) => (key === "g1" ? 1 : 5) }));
  assert.ok(spray.includes("レタス: 散布液量が 10 a あたり 10 L で、基準（100〜300 L）の外です"));
  assert.ok(!spray.some((text) => text.startsWith("キャベツ: 散布液量")));
  // これまでの記録から、作付ごとの使用回数を数える（p1 はレタスのまとまり）
  const used = warnings(context([liquid(BOTH_LIQUID, { dilution: 2000 })], { logs: LOGS }));
  assert.ok(used.includes("レタス: 本剤の使用回数が、この防除で 4 回になり、上限（3 回）を超えます"));
  assert.ok(used.includes("レタス: 成分A を含む農薬の使用回数が、この防除で 4 回になり、上限（3 回）を超えます"));
  assert.ok(used.includes("レタス: 成分B を含む農薬の使用回数が、この防除で 4 回になり、上限（2 回）を超えます"));
  assert.ok(!used.some((text) => text.startsWith("キャベツ: 本剤")));
  // 直している記録は数えない
  const editing = warnings(context([liquid(BOTH_LIQUID, { dilution: 2000 })], { logs: LOGS, excludeLogId: "l3" }));
  assert.ok(!editing.some((text) => text.includes("本剤の使用回数")));
  assert.ok(!editing.some((text) => text.includes("成分A を含む")));
  assert.ok(editing.includes("レタス: 成分B を含む農薬の使用回数が、この防除で 3 回になり、上限（2 回）を超えます"));
  // 収穫の開始は、作付ごとに harvestStartOf で引く
  const harvest = warnings(context([liquid(BOTH_LIQUID, { dilution: 2000 })], { harvestStartOf: (id) => (id === "p1" ? "2026-03-25" : null) }));
  assert.ok(harvest.includes("レタス: 収穫の開始（03/25）まで 5 日で、使用時期（収穫 7 日前まで）を満たしません"));
  // 作物名を選んでいないまとまりは、何も言わない
  assert.deepEqual(warnings(context([liquid({}, { dilution: 100 })], { logs: LOGS })), []);
});

test("防除の指摘: 失効の可能性、粒剤の使用量。農薬が 2 つ以上なら、どの農薬の指摘かを頭に付ける", () => {
  const gone = liquid({}, { _product: { reg_no: 100, name: "テスト乳剤", ingredients: [], missing: true } });
  assert.deepEqual(warnings(context([gone])), ["テスト乳剤: 登録番号 100 は最新の農薬登録情報にありません（失効している可能性があります）"]);
  // 粒剤の量は、選んだ品目の面積の基準の合計（800〜900 g）と比べる
  assert.deepEqual(warnings(context([granule(BOTH_GRANULE, { amount: 1, unit: "kg" })])), ["使用量 1 kg は、この面積の基準（800 g〜900 g）を超えます"]);
  assert.deepEqual(warnings(context([granule(BOTH_GRANULE, { amount: 900, unit: "g" })])), []);
  // 農薬が 2 つ。肥料などは数えない
  const two = warnings(
    context([liquid(BOTH_LIQUID, { dilution: 1200 }), granule(BOTH_GRANULE, { amount: 1, unit: "kg" }), { kind: "fertilizer", name: "肥料", amount: 10, unit: "kg" }])
  );
  assert.ok(two.includes("テスト乳剤・キャベツ: 希釈倍率 1200 倍は、基準（1500 倍以上）より濃くなります"));
  assert.ok(two.includes("テスト粒剤・使用量 1 kg は、この面積の基準（800 g〜900 g）を超えます"));
  const one = warnings(context([liquid(BOTH_LIQUID, { dilution: 1200 }), { kind: "fertilizer", name: "肥料" }]));
  assert.ok(one.includes("キャベツ: 希釈倍率 1200 倍は、基準（1500 倍以上）より濃くなります"));
  // 登録番号のない農薬（名前を手で入れた）は照らさない
  assert.deepEqual(warnings(context([{ kind: "pesticide", reg_no: null, name: "手で入れた農薬", dilution: 1 }])), []);
  // 名前は HTML として安全に入れる
  const tagged = liquid({}, { name: "<b>剤", _product: { missing: true, ingredients: [] } });
  assert.deepEqual(warnings(context([tagged])), ["&lt;b&gt;剤: 登録番号 100 は最新の農薬登録情報にありません（失効している可能性があります）"]);
});

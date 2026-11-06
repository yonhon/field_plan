import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { codesText, committeesOf, describe, describeHtml, iconColors, iconSvg, iconsHtml, productCodes } from "../app/rac.js";

const codes = new Map([
  ["ジノテフラン", [{ committee: "IRAC", code: "4A" }]],
  ["エトフェンプロックス", [{ committee: "IRAC", code: "3A" }]],
  ["ピメトロジン", [{ committee: "IRAC", code: "9B" }]],
  ["硫黄", [{ committee: "IRAC", code: "UN" }, { committee: "FRAC", code: "M2" }]],
  ["アゾキシストロビン", [{ committee: "FRAC", code: "11" }]],
  ["グリホサートカリウム塩", [{ committee: "HRAC", code: "9" }]],
  ["BT(生菌)", [{ committee: "IRAC", code: "11A" }]],
  ["マシン油", [{ committee: "IRAC", code: "UNM" }, { committee: "FRAC", code: "NC" }]],
  ["ヤマウチアシボソトゲダニ", [{ committee: "IRAC", code: "-" }]],
]);
const pick = (list) => list.map((item) => `${item.committee} ${item.code}`);

test("用途から出す委員会", () => {
  assert.deepEqual(committeesOf("殺虫剤"), ["IRAC"]);
  assert.deepEqual(committeesOf("殺虫殺菌剤"), ["IRAC", "FRAC"]);
  assert.deepEqual(committeesOf("除草剤"), ["HRAC"]);
  assert.deepEqual(committeesOf("殺そ剤"), ["IRAC"]);
  assert.equal(committeesOf("その他"), null);
  assert.equal(committeesOf("植物成長調整剤"), null);
});

test("製品のコード: 有効成分の順に、用途に合う委員会のコード", () => {
  assert.deepEqual(pick(productCodes(["ジノテフラン"], "殺虫剤", codes)), ["IRAC 4A"]);
  assert.deepEqual(pick(productCodes(["エトフェンプロックス", "ピメトロジン"], "殺虫剤", codes)), ["IRAC 3A", "IRAC 9B"]);
  // 殺菌剤の中の硫黄は FRAC だけ。殺虫殺菌剤なら両方
  assert.deepEqual(pick(productCodes(["硫黄"], "殺菌剤", codes)), ["FRAC M2"]);
  assert.deepEqual(pick(productCodes(["硫黄"], "殺虫殺菌剤", codes)), ["IRAC UN", "FRAC M2"]);
  assert.deepEqual(pick(productCodes(["ジノテフラン", "アゾキシストロビン"], "殺虫殺菌剤", codes)), ["IRAC 4A", "FRAC 11"]);
  // 用途に合うコードがなければ、その成分のコードをすべて出す
  assert.deepEqual(pick(productCodes(["BT(生菌)"], "殺菌剤", codes)), ["IRAC 11A"]);
  // 同じコードは 1 つにまとめ、成分を並べる
  const merged = productCodes(["ジノテフラン", "ジノテフラン"], "殺虫剤", codes);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].ingredients, ["ジノテフラン"]);
});

test("製品のコード: 分類の対象外と、表にない成分", () => {
  // 天敵は「−」
  assert.deepEqual(pick(productCodes(["ヤマウチアシボソトゲダニ"], "殺虫剤", codes)), ["IRAC -"]);
  // ほかにコードがあれば「−」は出さない
  assert.deepEqual(pick(productCodes(["ヤマウチアシボソトゲダニ", "ジノテフラン"], "殺虫剤", codes)), ["IRAC 4A"]);
  // 表にない成分は「?」。用途が「その他」（展着剤など）なら「−」
  assert.deepEqual(pick(productCodes(["シクロピラニル"], "除草剤", codes)), ["HRAC ?"]);
  assert.deepEqual(pick(productCodes(["ポリオキシエチレン脂肪酸エステル"], "その他", codes)), ["IRAC -"]);
});

test("色: 元の表の色と、表にないコードの色", () => {
  assert.deepEqual(iconColors("IRAC", "4A"), ["#f8ed00", "#f8ed00", "#221f1f"]);
  assert.deepEqual(iconColors("IRAC", "1A"), ["#d2232a", "#d2232a", "#ffffff"]);
  // 同じ数字のグループのうち、いちばん淡い色
  assert.deepEqual(iconColors("IRAC", "4F"), iconColors("IRAC", "4E"));
  // M・P・BM は頭文字のグループの色
  assert.deepEqual(iconColors("FRAC", "M5"), iconColors("FRAC", "M"));
  assert.deepEqual(iconColors("FRAC", "P8"), iconColors("FRAC", "P2"));
  assert.deepEqual(iconColors("FRAC", "BM2"), iconColors("FRAC", "BM"));
  assert.deepEqual(iconColors("IRAC", "UNM"), iconColors("IRAC", "UN"));
  // 系統のないものは白地に黒い枠
  assert.deepEqual(iconColors("IRAC", "9B"), ["#ffffff", "#231f20", "#221f1f"]);
  assert.deepEqual(iconColors("FRAC", "53"), ["#ffffff", "#231f20", "#221f1f"]);
  assert.deepEqual(iconColors("HRAC", "33"), ["#ffffff", "#231f20", "#221f1f"]);
  assert.deepEqual(iconColors("IRAC", "-"), iconColors("FRAC", "?"));
});

test("アイコンの SVG", () => {
  const svg = iconSvg("IRAC", "4A", "IRAC 4A（ジノテフラン）", ["ジノテフラン"]);
  // 説明は自前の箱で出すので、ブラウザーの小さな説明（title）は付けない
  assert.doesNotMatch(svg, /<title>/);
  assert.match(svg, /aria-label="IRAC 4A（ジノテフラン）"/);
  assert.match(svg, /data-ingredients="ジノテフラン"/);
  assert.match(svg, />4A<\/text>/);
  assert.match(svg, /class="rac-icon rac-irac"/);
  // 元の表の書き方
  assert.match(iconSvg("IRAC", "UN"), />不明<\/text>/);
  assert.match(iconSvg("FRAC", "NC"), />未<\/text>/);
  assert.match(iconSvg("HRAC", "-"), />−<\/text>/);
  // 形
  assert.match(iconSvg("FRAC", "3"), /class="rac-icon rac-frac"/);
  assert.equal((iconSvg("FRAC", "3").match(/<rect /g) || []).length, 2);
  assert.match(iconSvg("HRAC", "9"), /class="rac-icon rac-hrac"/);
  // 葉は左下から始まり、(0.5, 0.5) で点対称（画面の座標では、中心 (10.5, 10.5) で点対称）
  const leaf = iconSvg("HRAC", "9");
  assert.match(leaf, /d="M0.5 20.5 /);
  const points = leaf.match(/<path d="M([^"]+) Z"/)[1].split(" L").map((pair) => pair.split(" ").map(Number));
  const has = ([x, y]) => points.some(([px, py]) => Math.abs(px - x) < 0.02 && Math.abs(py - y) < 0.02);
  assert.ok(points.every(([x, y]) => has([21 - x, 21 - y])), "点対称");
  assert.ok(has([0.5, 20.5]) && has([20.5, 0.5]), "左下と右上の先");
  // 幅の広い文字は、枠に収まるよう縮める。短いものは縮めない
  assert.match(iconSvg("IRAC", "UNM"), /textLength=/);
  assert.match(iconSvg("FRAC", "16.1"), /textLength=/);
  assert.doesNotMatch(iconSvg("IRAC", "4A"), /textLength=/);
  // 文字は HTML に使えない文字を escape する
  assert.match(iconSvg("IRAC", "4A", '<b>"x"</b>'), /&lt;b&gt;&quot;x&quot;&lt;\/b&gt;/);
});

test("並べた HTML と、文字だけの書き添え", () => {
  const list = productCodes(["ジノテフラン", "アゾキシストロビン"], "殺虫殺菌剤", codes);
  assert.equal((iconsHtml(list).match(/<svg /g) || []).length, 2);
  assert.equal(codesText(list), "IRAC 4A・FRAC 11");
  assert.equal(codesText(productCodes(["ヤマウチアシボソトゲダニ"], "殺虫剤", codes)), "作用機構分類なし");
  assert.equal(codesText(productCodes(["シクロピラニル"], "除草剤", codes)), "分類不明");
});

test("説明: IRAC は主要グループと一次作用部位、FRAC は作用機構と作用点、HRAC は作用機構", () => {
  assert.deepEqual(describe("IRAC", "4A"), [{ label: "主要グループと一次作用部位", text: "ニコチン性アセチルコリン受容体（nAChR）競合的モジュレーター（神経作用）" }]);
  // サブグループは主要グループの説明
  assert.deepEqual(describe("IRAC", "4E"), describe("IRAC", "4A"));
  assert.match(describe("IRAC", "UNM")[0].text, /機械的・物理的攪乱剤/);
  assert.deepEqual(describe("FRAC", "11"), [
    { label: "作用機構", text: "C：呼吸" },
    { label: "作用点", text: "複合体Ⅲ：チトクロームbc1（ユビキノール酸化酵素）Qo部位（cyt b遺伝子）" },
  ]);
  assert.deepEqual(describe("FRAC", "M5"), [
    { label: "作用機構", text: "M：多作用点接触活性" },
    { label: "作用点", text: "多作用点接触活性" },
  ]);
  assert.equal(describe("FRAC", "BM02")[0].text, "複数の作用機構を有する生物農薬：微生物農薬");
  assert.deepEqual(describe("HRAC", "9"), [{ label: "作用機構", text: "5-エノールピルビルシキミ酸-3-リン酸（EPSP）合成酵素阻害" }]);
  assert.match(describe("IRAC", "-")[0].text, /対象外/);
  assert.match(describe("HRAC", "?")[0].text, /表にありません/);
  // 箱の中身
  const html = describeHtml("FRAC", "3", ["ジフェノコナゾール"]);
  assert.match(html, /FRAC 3/);
  assert.match(html, /殺菌剤の作用機構分類/);
  assert.match(html, /作用機構：<\/span>G：細胞膜のステロール生合成/);
  assert.match(html, /有効成分：ジフェノコナゾール/);
  assert.match(describeHtml("IRAC", "UN"), /IRAC UN（不明）/);
});

// 2025 年 6 月版の RAC コード検索表に出てくるコード（scripts/import_rac.py が入れるもの）は、すべて説明がある
test("説明: いまの表に出てくるコードには、すべて説明がある", () => {
  const used = {
    IRAC: "10A 10B 11A 12C 12D 13 14 15 16 17 18 1A 1B 20B 20D 21A 22A 22B 23 24A 24B 25A 25B 28 29 2B 30 33 34 36 3A 4A 4C 4D 4E 4F 5 6 7C 8A 8B 8C 8F 9B 9D UN UNF UNM 3B 7A 7B 2A",
    FRAC: "1 10 11 11A 12 14 16.1 16.3 17 18 19 2 20 21 22 24 25 27 28 29 3 31 32 36 39 4 40 41 43 45 49 50 52 53 6 7 9 BM2 BM3 M1 M10 M11 M2 M3 M4 M5 M7 M9 NC P1 P2 P3 P7 P8 U13 U14 U16 U17 U18 U6 UN",
    HRAC: "0 1 10 12 14 15 18 2 22 23 27 29 3 30 31 33 4 5 6 9",
  };
  const missing = Object.entries(used).flatMap(([committee, codes]) =>
    codes.split(" ").filter((code) => describe(committee, code)[0].text === "説明の表にないコードです。").map((code) => `${committee} ${code}`)
  );
  assert.deepEqual(missing, []);
});

// 農薬名を出すところでは、必ず pesticide.js の nameHtml（アイコン付き）を通す。名前をそのまま escape して出していないか
test("農薬名を、アイコンなしで HTML に出していない", () => {
  const dir = new URL("../app/", import.meta.url);
  const found = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".js"))) {
    readFileSync(new URL(file, dir), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/escapeHtml\((input|product|first\.input)\.name\)/.test(line)) {
          found.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(found, []);
});

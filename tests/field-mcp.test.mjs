// MCP サーバー（supabase/functions/field-mcp）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP, LIB, SHARED } from "../scripts/sync-mcp-lib.mjs";
import { createDataSource } from "../supabase/functions/field-mcp/data.js";
import { createMcpHandler } from "../supabase/functions/field-mcp/mcp.js";

const TOKEN = "t".repeat(40);
const BASE = "https://example.supabase.co/functions/v1/field-mcp";
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const work = (id, owner, type, seq, start, end) => ({
  id, plan_id: "plan1", block_id: null, planting_id: null, ...owner, work_type: type, seq, plan_start: start, plan_end: end, note: "",
});

// 圃場 1 に、有効圃場 1 つ、区画 1 つ、畝 2 本。畝 1 は品目を登録した作付、畝 2 は名前だけの作付。
// 圃場 2 は、空のプランが 1 つだけ
const DATA = {
  fields: [
    { id: "f1", name: "圃場 1", outline: rect(0, 0, 30, 50) },
    { id: "f2", name: "別の圃場", outline: [] },
  ],
  plans: [
    { id: "plan1", field_id: "f1", name: "案 A", created_at: "2026-10-01" },
    { id: "plan2", field_id: "f1", name: "案 B", created_at: "2026-10-02" },
    { id: "plan3", field_id: "f2", name: "案 C", created_at: "2026-10-03" },
  ],
  zones: [
    { id: "z1", plan_id: "plan1", kind: "tillable", name: "", shape: rect(2, 2, 12, 24) },
    { id: "z2", plan_id: "plan1", kind: "shed", name: "", shape: rect(20, 2, 3, 2) },
  ],
  blocks: [{ id: "b1", plan_id: "plan1", zone_id: "z1", name: "区画1", shape: rect(2, 2, 12, 24), start_date: null, end_date: null }],
  beds: [
    { id: "bed1", plan_id: "plan1", block_id: "b1", seq: 1, shape: rect(2.6, 2, 0.7, 24), start_date: null, removed_on: null },
    { id: "bed2", plan_id: "plan1", block_id: "b1", seq: 2, shape: rect(3.9, 2, 1.0, 24), start_date: null, removed_on: null },
  ],
  plantings: [
    { id: "p1", plan_id: "plan1", bed_id: "bed1", seq: 1, crop_id: "c1", crop_name: "葉ネギ" },
    { id: "p2", plan_id: "plan1", bed_id: "bed2", seq: 1, crop_id: null, crop_name: "名前だけの品目" },
  ],
  works: [
    work("w1", { block_id: "b1" }, "subsoil", 1, "2027-04-01", "2027-04-01"),
    work("w2", { block_id: "b1" }, "rotary", 2, "2027-04-02", "2027-04-02"),
    work("w3", { planting_id: "p1" }, "ridge", 1, "2027-04-10", "2027-04-11"),
    work("w4", { planting_id: "p1" }, "plant", 2, "2027-04-12", "2027-04-14"),
    work("w5", { planting_id: "p1" }, "harvest", 3, "2027-05-20", "2027-06-10"),
    work("w6", { planting_id: "p2" }, "ridge", 1, "2027-04-10", "2027-04-11"),
    work("w7", { planting_id: "p2" }, "plant", 2, null, null),
  ],
  workTypes: [
    { code: "subsoil", label: "心土破砕", sort: 10, default_days: 1, min_gap_days: 0, scope: "block" },
    { code: "rotary", label: "ロータリー", sort: 20, default_days: 1, min_gap_days: 0, scope: "block" },
    { code: "ridge", label: "畝立て", sort: 90, default_days: 2, min_gap_days: 0, scope: "bed" },
    { code: "plant", label: "定植・播種", sort: 110, default_days: 3, min_gap_days: 0, scope: "bed" },
    { code: "harvest", label: "収穫", sort: 120, default_days: 30, min_gap_days: 0, scope: "bed" },
  ],
  crops: [
    { id: "c1", name: "葉ネギ", variety: "", bed_width_cm: 70, aisle_width_cm: 60, row_count: 3, row_gap_cm: 15, plant_gap_cm: 15, staggered: false, mulch: true, n_kg_per_10a: 12, fertilizer_id: "fz1", grow_days: 40, harvest_days: 20, note: "" },
  ],
  fertilizers: [{ id: "fz1", name: "化成 15", n_pct: 15, p_pct: 15, k_pct: 15 }],
  changes: [
    { id: "ch4", no: 4, field_id: "f2", at: "2026-10-13T01:00:00Z", last_at: "2026-10-13T01:00:00Z", day: "2026-10-13", plan_id: "plan3", plan_name: "案 C", kind: "plan.add", target_kind: null, target_id: null, text: "プラン「案 C」を作成", before: null, after: null },
    { id: "ch3", no: 3, field_id: "f1", at: "2026-10-12T06:20:00Z", last_at: "2026-10-12T06:20:00Z", day: "2026-10-12", plan_id: "plan1", plan_name: "案 A", kind: "bed.width", target_kind: "bed", target_id: "bed2", text: "区画1 畝2の畝幅を変更", before: "70 cm", after: "100 cm" },
    { id: "ch2", no: 2, field_id: "f1", at: "2026-10-12T06:02:00Z", last_at: "2026-10-12T06:02:00Z", day: "2026-10-12", plan_id: "plan1", plan_name: "案 A", kind: "bed.add", target_kind: "block", target_id: "b1", text: "区画1に畝を 2 本追加", before: null, after: null },
    { id: "ch1", no: 1, field_id: "f1", at: "2026-10-11T03:00:00Z", last_at: "2026-10-11T03:00:00Z", day: "2026-10-11", plan_id: null, plan_name: "", kind: "crops.add", target_kind: "crop", target_id: "c1", text: "品目「葉ネギ」を追加", before: null, after: null },
  ],
  notes: [{ day: "2026-10-12", body: "水はけを見て、#3 で畝幅を広げた。" }],
  updates: [
    { no: 1, date: "2026-10-11", title: "圃場図", body: "外形と区域を描ける。", reason: "紙の図面しかなかった。" },
    { no: 2, date: "2026-10-12", title: "記録の画面", body: "変更が残る。", reason: "あとで記事にしたい。" },
  ],
};

function setup({ token = TOKEN, data = DATA } = {}) {
  const handle = createMcpHandler({ getData: async () => data, token });
  const post = (body, path = `/${TOKEN}`) =>
    handle(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const call = async (name, args = {}) => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const { result } = await res.json();
    return { isError: Boolean(result.isError), text: result.content[0].text, data: result.isError ? null : JSON.parse(result.content[0].text) };
  };
  // 圃場 1 の話として呼ぶ
  const inField = (name, args = {}) => call(name, { field: "圃場 1", ...args });
  return { handle, post, call, inField };
}

test("lib/ の写しは、app/ の部品と同じ内容", () => {
  for (const name of SHARED) {
    assert.equal(readFileSync(join(LIB, name), "utf8"), readFileSync(join(APP, name), "utf8"), `${name} が古い。node scripts/sync-mcp-lib.mjs を実行する`);
  }
});

test("合言葉が違う呼び出しには、何もないのと同じ 404 を返す", async () => {
  const { post } = setup();
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "/wrong")).status, 404);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "")).status, 404);
  // 合言葉が未設定か短いサーバーは、誰も通さない
  const open = setup({ token: "" });
  assert.equal((await open.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "/")).status, 404);
  const short = setup({ token: "short" });
  assert.equal((await short.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "/short")).status, 404);
});

test("初期化と、道具の一覧", async () => {
  const { post, handle } = setup();
  const init = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
  assert.equal(init.result.serverInfo.name, "inoo-farm-field-plan");
  assert.match(init.result.instructions, /計画で、実際に行った作業の記録ではありません/);
  const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["list_fields", "list_plans", "get_plan", "get_schedule", "get_changes", "get_crops"]);
  assert.ok(list.result.tools.every((tool) => tool.run === undefined && tool.inputSchema.type === "object"));
  // コネクタの登録時の確認（GET）には、名前だけを返す
  const probe = await handle(new Request(`${BASE}/${TOKEN}`, { method: "GET" }));
  assert.equal((await probe.json()).transport, "streamable-http");
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
});

test("list_fields と、圃場の選び方", async () => {
  const { call } = setup();
  const { data } = await call("list_fields");
  assert.deepEqual(data.fields, [
    { name: "圃場 1", area_sqm: 1500, plans: ["案 A", "案 B"], last_change: { date: "2026-10-12", no: "#3" } },
    { name: "別の圃場", area_sqm: null, plans: ["案 C"], last_change: { date: "2026-10-13", no: "#4" } },
  ]);
  // 圃場は省けない。名前の一部でも選べる
  for (const tool of ["list_plans", "get_plan", "get_schedule", "get_changes"]) {
    assert.match((await call(tool)).text, /field で圃場を選んでください。圃場の名前: 圃場 1、別の圃場/);
  }
  assert.equal((await call("list_plans", { field: "別の" })).data.field.name, "別の圃場");
  assert.match((await call("list_plans", { field: "圃場" })).text, /複数あります/);
  assert.match((await call("list_plans", { field: "ない" })).text, /圃場「ない」はありません/);
  // ほかの圃場のプランは選べない
  assert.match((await call("get_plan", { field: "圃場 1", plan: "案 C" })).text, /ありません。プランの名前: 案 A、案 B/);
  const other = (await call("get_plan", { field: "別の圃場" })).data;
  assert.deepEqual([other.field, other.plan, other.other_plans, other.blocks], ["別の圃場", "案 C", [], []]);
});

test("list_plans: 規模と、最後に変更のあった日", async () => {
  const { data } = await setup().inField("list_plans");
  assert.equal(data.field.area_sqm, 1500);
  const [a, b] = data.plans;
  assert.deepEqual([a.name, a.tillable_area_sqm, a.blocks, a.beds], ["案 A", 288, 1, 2]);
  assert.deepEqual(a.crops, ["葉ネギ", "名前だけの品目"]);
  assert.deepEqual([a.works_from, a.works_until], ["2027-04-01", "2027-06-10"]);
  assert.deepEqual(a.last_change, { date: "2026-10-12", no: "#3" });
  assert.deepEqual([b.name, b.beds, b.last_change], ["案 B", 0, null]);
});

test("get_plan: 配置、作付、苗数と肥料、集計", async () => {
  const { inField: call } = setup();
  const { data } = await call("get_plan");
  // プランを省くと、最後に変更のあったプラン
  assert.equal(data.plan, "案 A");
  assert.deepEqual(data.other_plans, ["案 B"]);
  assert.deepEqual(data.zones.map((zone) => `${zone.name}/${zone.kind}`), ["有効圃場1/有効圃場", "物置/物置"]);
  const block = data.blocks[0];
  assert.deepEqual([block.name, block.zone, block.area_sqm], ["区画1", "有効圃場1", 288]);
  assert.deepEqual(block.works_before_ridging.map((item) => item.work), ["心土破砕", "ロータリー"]);
  const [bed1, bed2] = block.beds;
  assert.deepEqual([bed1.no, bed1.width_cm, bed1.length_m], [1, 70, 24]);
  // 24 m ÷ 0.15 m = 160 株 × 3 条。16.8 ㎡ × 12 kg ÷ 1,000 ÷ 15%
  const planting = bed1.plantings[0];
  assert.deepEqual([planting.crop, planting.seedlings, planting.nitrogen_kg, planting.fertilizer, planting.fertilizer_kg], ["葉ネギ", 480, 0.2, "化成 15", 1.34]);
  assert.equal(planting.harvest_end, "2027-06-10");
  assert.deepEqual(planting.works.map((item) => `${item.work} ${item.start}`), ["畝立て 2027-04-10", "定植・播種 2027-04-12", "収穫 2027-05-20"]);
  // 品目を登録していない作付は、名前だけ。苗数は出ない
  assert.equal(bed2.plantings[0].crop, "名前だけの品目");
  assert.equal(bed2.plantings[0].seedlings, undefined);
  assert.equal(bed2.plantings[0].harvest_end, null);
  assert.deepEqual(data.totals.fertilizers, [{ name: "化成 15", kg: 1.34 }]);
  assert.ok(data.problems.some((problem) => /日付の入っていない作業が 1 件/.test(problem.message) && problem.where.includes("畝2")));

  assert.equal((await call("get_plan", { plan: "B" })).data.plan, "案 B");
  assert.match((await call("get_plan", { plan: "案" })).text, /複数あります/);
  assert.match((await call("get_plan", { plan: "ない" })).text, /ありません。プランの名前: 案 A、案 B/);
  assert.match((await call("get_plan", { block: "区画9" })).text, /区画「区画9」はありません/);
});

test("get_schedule: 同じ日の同じ作業は、場所をまとめる", async () => {
  const { inField: call } = setup();
  const all = (await call("get_schedule")).data;
  assert.equal(all.undated_works, 1);
  assert.deepEqual(all.works.map((item) => `${item.start} ${item.work} ${item.places.join("+")}`), [
    "2027-04-01 心土破砕 区画1",
    "2027-04-02 ロータリー 区画1",
    "2027-04-10 畝立て 区画1 畝1",
    "2027-04-10 畝立て 区画1 畝2",
    "2027-04-12 定植・播種 区画1 畝1",
    "2027-05-20 収穫 区画1 畝1",
  ]);
  // 期間にかかる作業だけ。収穫は 5/20〜6/10 なので、6/1 からの指定にも入る
  const june = (await call("get_schedule", { from: "2027-06-01", to: "2027-06-30" })).data;
  assert.deepEqual(june.works.map((item) => item.work), ["収穫"]);
  assert.match((await call("get_schedule", { from: "6/1" })).text, /YYYY-MM-DD/);
});

test("get_changes: 日ごとの変更、メモ、アプリの更新", async () => {
  const { inField: call } = setup();
  const { data } = await call("get_changes");
  assert.deepEqual(data.days.map((day) => day.date), ["2026-10-12", "2026-10-11"]);
  const [latest, first] = data.days;
  assert.equal(latest.note, "水はけを見て、#3 で畝幅を広げた。");
  // その日の中は、番号の小さい順（起きた順）。時刻は日本時間
  assert.deepEqual(latest.plan_changes.map((entry) => `${entry.no} ${entry.time} ${entry.plan} ${entry.text}`), [
    "#2 15:02 案 A 区画1に畝を 2 本追加",
    "#3 15:20 案 A 区画1 畝2の畝幅を変更（70 cm → 100 cm）",
  ]);
  assert.deepEqual(latest.app_updates.map((update) => update.no), ["A2"]);
  assert.deepEqual(first.plan_changes.map((entry) => entry.plan), ["共通"]);
  assert.equal(first.app_updates[0].reason, "紙の図面しかなかった。");
  assert.deepEqual(data.plans_changed, ["案 A"]);

  const only = (await call("get_changes", { from: "2026-10-12", include_app_updates: false })).data;
  assert.deepEqual(only.days.map((day) => day.date), ["2026-10-12"]);
  assert.equal(only.days[0].app_updates, undefined);
  // プランを指定すると、共通の変更は外れる（メモとアプリの更新は残る）
  const planB = (await call("get_changes", { plan: "案 B" })).data;
  assert.ok(planB.days.every((day) => day.plan_changes.length === 0));
  // 計画の変更は選んだ圃場の分だけ。メモはすべての圃場で共通
  const other = (await call("get_changes", { field: "別の圃場" })).data;
  assert.deepEqual(other.days.flatMap((day) => day.plan_changes.map((entry) => entry.no)), ["#4"]);
  assert.equal(other.days.find((day) => day.date === "2026-10-12").note, "水はけを見て、#3 で畝幅を広げた。");
});

test("get_crops: 設定値と肥料", async () => {
  const { data } = await setup().call("get_crops");
  const crop = data.crops[0];
  assert.deepEqual([crop.name, crop.rows, crop.plant_gap_cm, crop.fertilizer, crop.days_from_planting_to_first_harvest, crop.plantings_in_all_plans], ["葉ネギ", 3, 15, "化成 15", 40, 1]);
  assert.deepEqual(data.fertilizers, [{ name: "化成 15", n_pct: 15, p_pct: 15, k_pct: 15 }]);
});

test("道具の名前が違う、読み込みに失敗した", async () => {
  const { post } = setup();
  const unknown = await (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } })).json();
  assert.equal(unknown.error.code, -32602);
  const broken = createMcpHandler({ getData: async () => { throw new Error("db down"); }, token: TOKEN });
  const res = await broken(new Request(`${BASE}/${TOKEN}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_fields" } }) }));
  const { result } = await res.json();
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /db down/);
});

test("データは短いあいだだけ覚えておく", async () => {
  let reads = 0;
  let clock = 0;
  const source = createDataSource({ query: async () => { reads += 1; return DATA; }, now: () => clock });
  await source.getData();
  await source.getData();
  assert.equal(reads, 1);
  clock = 31_000;
  await source.getData();
  assert.equal(reads, 2);
});

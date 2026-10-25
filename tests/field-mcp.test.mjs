// MCP サーバー（supabase/functions/field-mcp）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP, LIB, SHARED } from "../scripts/sync-mcp-lib.mjs";
import { createDataSource, loadUpdates } from "../supabase/functions/field-mcp/data.js";
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
    { id: "f1", name: "圃場 1", outline: rect(0, 0, 30, 50), active_plan_id: "plan1" },
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
    { ...work("w2", { block_id: "b1" }, "rotary", 2, "2027-04-02", "2027-04-02"), cancelled_on: "2027-04-02", cancel_note: "雨で中止" },
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
    { code: "spray", label: "防除", sort: 200, default_days: 1, min_gap_days: 0, scope: "bed" },
    { code: "water", label: "灌水", sort: 210, default_days: 1, min_gap_days: 0, scope: "bed" },
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
  // 作業の記録。畝立て（計画の作業を終えた）、2 本の畝への防除、計画にない灌水
  workLogs: [
    {
      id: "l1", field_id: "f1", date: "2027-04-11", work_type: "ridge", finishes: true, spec: { bed_width_cm: 70, height_cm: 20 }, note: "", created_at: "2027-04-11T09:00:00Z",
      targets: [{ id: "x1", log_id: "l1", planting_id: "p1", bed_id: "bed1", block_id: "b1", work_id: "w3", label: "区画1 畝1 葉ネギ", crop_name: "葉ネギ", area_m2: 31.2, spray_l: null }],
      inputs: [],
    },
    {
      id: "l2", field_id: "f1", date: "2027-04-20", work_type: "spray", finishes: false, spec: {}, note: "", created_at: "2027-04-20T09:00:00Z",
      targets: [
        { id: "x2", log_id: "l2", planting_id: "p1", bed_id: "bed1", block_id: "b1", work_id: null, label: "区画1 畝1 葉ネギ", crop_name: "葉ネギ", area_m2: 31.2, spray_l: 3.12 },
        { id: "x3", log_id: "l2", planting_id: "p2", bed_id: "bed2", block_id: "b1", work_id: null, label: "区画1 畝2 名前だけの品目", crop_name: "名前だけの品目", area_m2: 31.2, spray_l: 3.12 },
      ],
      inputs: [
        {
          id: "i1", log_id: "l2", seq: 0, kind: "pesticide", reg_no: "12345", name: "テスト乳剤", method: "散布", dilution: 2000, amount: 3.1, unit: "mL",
          standard: { reg_no: "12345", product: "テスト乳剤", ingredients: ["成分A", ""], rows: [{ crop_name: "葉ネギ", times_max: 2, total_max: [3, null], totals: ["3回以内(植付前は1回以内)", ""], preharvest_days: 14 }] },
        },
      ],
    },
    {
      id: "l3", field_id: "f1", date: "2027-04-25", work_type: "water", finishes: false, spec: {}, note: "夕方", created_at: "2027-04-25T09:00:00Z",
      targets: [{ id: "x4", log_id: "l3", planting_id: "p2", bed_id: "bed2", block_id: "b1", work_id: null, label: "区画1 畝2 名前だけの品目", crop_name: "名前だけの品目", area_m2: 31.2, spray_l: null }],
      inputs: [],
    },
  ],
  updates: [
    { no: 1, date: "2026-10-11", title: "圃場図", body: "外形と区域を描ける。", reason: "紙の図面しかなかった。" },
    { no: 2, date: "2026-10-12", title: "記録の画面", body: "変更が残る。", reason: "あとで記事にしたい。" },
  ],
};

function setup({ token = TOKEN, data = DATA, famic = true } = {}) {
  const handle = createMcpHandler({ getData: async () => data, token, famic });
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
  assert.match(init.result.instructions, /作業の記録（get_records）は実際に行ったことなので、「行った」と書いてかまいません/);
  assert.match(init.result.instructions, /get_pesticide_usage/);
  const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["list_fields", "list_plans", "get_plan", "get_schedule", "get_changes", "get_crops", "get_records", "get_pesticide_usage"]);
  assert.ok(list.result.tools.every((tool) => tool.run === undefined && tool.famic === undefined && tool.inputSchema.type === "object"));
  // 農薬の使用基準（FAMIC）を外すと、農薬の使用回数の道具と、その説明がなくなる
  const without = setup({ famic: false });
  const initWithout = await (await without.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json();
  assert.doesNotMatch(initWithout.result.instructions, /get_pesticide_usage/);
  const listWithout = await (await without.post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.ok(!listWithout.result.tools.some((tool) => tool.name === "get_pesticide_usage"));
  const callWithout = await (await without.post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_pesticide_usage", arguments: { field: "圃場 1" } } })).json();
  assert.equal(callWithout.error.code, -32602);
  // コネクタの登録時の確認（GET）には、名前だけを返す
  const probe = await handle(new Request(`${BASE}/${TOKEN}`, { method: "GET" }));
  assert.equal((await probe.json()).transport, "streamable-http");
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
});

test("list_fields と、圃場の選び方", async () => {
  const { call } = setup();
  const { data } = await call("list_fields");
  assert.deepEqual(data.fields, [
    { name: "圃場 1", area_sqm: 1500, plans: ["案 A", "案 B"], active_plan: "案 A", last_change: { date: "2026-10-12", no: "#3" }, records: 3, last_record: "2027-04-25" },
    { name: "別の圃場", area_sqm: null, plans: ["案 C"], active_plan: null, last_change: { date: "2026-10-13", no: "#4" }, records: 0, last_record: null },
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
  // 取りやめた作業には、取りやめた日
  assert.equal(all.works[1].cancelled_on, "2027-04-02");
  assert.equal(all.works[0].cancelled_on, undefined);
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

test("get_records: 記録を新しい順に、絞り込みと、取りやめた作業", async () => {
  const { inField, call } = setup();
  const all = (await inField("get_records")).data;
  assert.equal(all.active_plan, "案 A");
  assert.deepEqual(all.records.map((item) => [item.date, item.work]), [["2027-04-25", "灌水"], ["2027-04-20", "防除"], ["2027-04-11", "畝立て"]]);
  // 畝立ては計画の作業につながり、その作業を終えた。仕様は画面と同じ文
  const ridge = all.records[2];
  assert.equal(ridge.completes_planned_work, true);
  assert.equal(ridge.spec, "実畦の幅 70cm・畝の高さ 20cm");
  assert.deepEqual(ridge.places, [{ place: "区画1 畝1 葉ネギ", crop: "葉ネギ", area_sqm: 31.2, planned: { start: "2027-04-10", end: "2027-04-11" } }]);
  // 防除は、資材と散布した液の量
  const spray = all.records[1];
  assert.deepEqual(spray.inputs, [{ kind: "農薬", text: "テスト乳剤 2000 倍 散布", amount: 3.1, unit: "mL" }]);
  assert.equal(spray.places[0].spray_liters, 3.12);
  assert.equal(spray.completes_planned_work, undefined);
  assert.equal(spray.places[0].planned, undefined);
  // 計画にない灌水は、メモだけ
  assert.equal(all.records[0].note, "夕方");
  // 取りやめた計画の作業
  assert.deepEqual(all.cancelled_works, [{ cancelled_on: "2027-04-02", work: "ロータリー", place: "区画1", planned: { start: "2027-04-02", end: "2027-04-02" }, note: "雨で中止" }]);
  // 品目で絞ると、同じ記録のほかの畝は数だけ
  const negi = (await inField("get_records", { crop: "葉ネギ" })).data;
  assert.deepEqual(negi.records.map((item) => item.work), ["防除", "畝立て"]);
  assert.equal(negi.records[0].other_places, 1);
  assert.deepEqual(negi.cancelled_works, []);
  // 作業、場所、期間で絞る
  assert.deepEqual((await inField("get_records", { work: "防除" })).data.records.map((item) => item.date), ["2027-04-20"]);
  assert.deepEqual((await inField("get_records", { place: "畝2" })).data.records.map((item) => item.date), ["2027-04-25", "2027-04-20"]);
  assert.deepEqual((await inField("get_records", { from: "2027-04-12", to: "2027-04-24" })).data.records.map((item) => item.date), ["2027-04-20"]);
  assert.match((await inField("get_records", { from: "4/1" })).text, /YYYY-MM-DD/);
  // 記録のない圃場
  assert.deepEqual((await call("get_records", { field: "別の圃場" })).data.records, []);
});

test("get_pesticide_usage: 作付ごとの使用回数と上限", async () => {
  const { inField, call } = setup();
  const usage = (await inField("get_pesticide_usage")).data;
  assert.deepEqual(usage.plantings.map((item) => [item.place, item.crop]), [["区画1 畝1", "葉ネギ"], ["区画1 畝2", "名前だけの品目"]]);
  const negi = usage.plantings[0];
  assert.deepEqual(negi.sprays, [{ date: "2027-04-20", products: ["テスト乳剤 2000 倍 散布"] }]);
  assert.deepEqual(negi.ingredients, [{ name: "成分A", count: 1, max: 3, condition: "3回以内(植付前は1回以内)" }]);
  assert.deepEqual(negi.products, [{ name: "テスト乳剤", reg_no: "12345", count: 1, max: 2 }]);
  assert.equal(negi.harvest_ok_from, "2027-05-04");
  // 使用基準の写しにない品目は、上限が空
  assert.equal(usage.plantings[1].ingredients[0].max, null);
  assert.equal(usage.plantings[1].harvest_ok_from, undefined);
  assert.equal((await inField("get_pesticide_usage", { crop: "葉ネギ" })).data.plantings.length, 1);
  // 実際に使うプランがない圃場
  assert.match((await call("get_pesticide_usage", { field: "別の圃場" })).text, /実際に使うプランが決まっていません/);
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

test("アプリの更新の一覧は、公開しているものを読む。読めなければ、配備したときの写し", async () => {
  const bundled = [{ no: 1, date: "2026-10-11", title: "古い写し" }];
  const published = [...bundled, { no: 2, date: "2026-10-24", title: "公開した新しい項目" }];
  const respond = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await loadUpdates({ url: "u", bundled, fetch: respond(200, published) }), published);
    // 読めない、形が違う、写しより短い（古いものがためてあった）ときは写し
    assert.equal(await loadUpdates({ url: "u", bundled, fetch: respond(404, null) }), bundled);
    assert.equal(await loadUpdates({ url: "u", bundled, fetch: async () => { throw new Error("offline"); } }), bundled);
    assert.equal(await loadUpdates({ url: "u", bundled, fetch: respond(200, { not: "list" }) }), bundled);
    assert.equal(await loadUpdates({ url: "u", bundled: published, fetch: respond(200, bundled) }), published);
  } finally {
    console.error = quiet;
  }
});

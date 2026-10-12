// Supabase Edge Function のエントリーポイント。
// 配備: supabase functions deploy field-mcp --no-verify-jwt
// 接続先: https://<project-ref>.supabase.co/functions/v1/field-mcp/<FIELD_MCP_TOKEN>
// SUPABASE_DB_URL は Edge Functions の実行環境に自動で設定される。
// 画面と同じ計算をするために、lib/ に app/ の部品の写しを置いている（scripts/sync-mcp-lib.mjs で写す）。
import postgres from "npm:postgres@3.4.5";
import { createDataSource } from "./data.js";
import { createMcpHandler } from "./mcp.js";
import updates from "./lib/updates.json" with { type: "json" };

const sql = postgres(Deno.env.get("SUPABASE_DB_URL") ?? "", { max: 1, prepare: false });

// 表を、行ごとの JSON にして読む。日付は "YYYY-MM-DD"、数は数、図形は配列で届く
const rows = async (table: string, order: string) =>
  (await sql.unsafe(`select to_jsonb(t) as row from field.${table} t order by ${order}`)).map((r) => r.row);

const source = createDataSource({
  query: async () => {
    const fields = await rows("fields", "created_at");
    return {
      field: fields[0] ?? null,
      plans: await rows("plans", "created_at"),
      zones: await rows("zones", "created_at"),
      blocks: await rows("blocks", "created_at"),
      beds: await rows("beds", "seq"),
      plantings: await rows("plantings", "seq"),
      works: await rows("works", "seq"),
      workTypes: await rows("work_types", "sort"),
      crops: await rows("crops", "name"),
      fertilizers: await rows("fertilizers", "name"),
      changes: await rows("changes", "no desc"),
      notes: await rows("day_notes", "day desc"),
      updates,
    };
  },
});

// 呼び出しの記録。応答を返した後も書き込みを続けられるよう EdgeRuntime.waitUntil を使う
// deno-lint-ignore no-explicit-any
const edgeRuntime = (globalThis as any).EdgeRuntime;
// deno-lint-ignore no-explicit-any
const logAccess = (e: any) => {
  const write = sql`insert into field.mcp_access_log (method, status, authorized, rpc_method, tool, accept, user_agent)
                    values (${e.method}, ${e.status}, ${e.authorized}, ${e.rpc_method}, ${e.tool}, ${e.accept}, ${e.user_agent})`
    .catch((err: unknown) => console.error("mcp_access_log", err));
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(write);
};

const handle = createMcpHandler({
  getData: () => source.getData(),
  token: Deno.env.get("FIELD_MCP_TOKEN") ?? "",
  logAccess,
});

Deno.serve(handle);

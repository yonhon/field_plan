// MCP（Model Context Protocol）サーバー。Streamable HTTP トランスポートのステートレス実装。
// クライアントが POST した JSON-RPC メッセージに、JSON で応答する（SSE は使わない）。
import { TOOLS, runTool } from "./tools.js";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "inoo-farm-field-plan", title: "いのーファーム 圃場計画", version: "0.1.0" };
const MIN_TOKEN_LENGTH = 32;

const INSTRUCTIONS = [
  "いのーファームの圃場の計画を返すサーバーです。返すのは計画で、実際に行った作業の記録ではありません。文章にするときは「計画した」「予定している」と書いてください。",
  "計画は「プラン」ごとにあります。配置の案を比べるために、プランが複数あることがあります。まず list_plans で、プランの一覧と、最近変更のあったプランを確認してください。",
  "圃場の中の入れ物は 4 つです。「有効圃場」は耕してよい場所、「耕起対象区画」は有効圃場を分けたもので畝立ての前までの作業（心土破砕、緑肥、太陽熱消毒など）を持ち、「畝」は区画の中の四角形、「作付」は 1 本の畝での畝立てから収穫までの 1 回ぶんです。同じ畝に、時期をずらして作付が複数あることがあります。",
  "配置と作付の全体は get_plan、期間を決めた作業の一覧は get_schedule、品目ごとの設定値は get_crops で確認できます。苗数と肥料の量は、畝の寸法と品目の設定値から計算した値です。",
  "いつ、何を決めたか、なぜそうしたかは get_changes で確認できます。「#41」のような番号は計画の変更、「A12」のような番号はアプリ（計画を作る道具）の更新です。日ごとのメモは、本人がその日の変更の理由を書いたものです。メモが番号に触れているときは、その番号の行と合わせて読んでください。",
  "変更の記録は、記録の仕組みを入れた日より後の分しかありません。それより前に作った計画は、get_plan には出ますが、get_changes には出ません。",
  "書かれていないことを補わず、日付と番号を添えて答えてください。理由が書かれていない変更に、理由を作って足さないでください。",
  "ウェブサイトや SNS に載せる文章を作るときは、書く前に、出したくない情報（圃場の場所、区域の名前、面積、時期など）があるかを本人に確かめてください。",
].join("\n");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

const publicTool = ({ run, ...rest }) => rest;

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// URL の末尾が合言葉と一致するか。ハッシュ同士を比べ、一致する文字数が応答時間に出ないようにする
async function isAuthorized(req, token) {
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    return false; // 合言葉が未設定か短すぎるときは、誰も通さない
  }
  const given = new URL(req.url).pathname.split("/").filter(Boolean).pop() || "";
  const [a, b] = await Promise.all([sha256(given), sha256(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function handleMessage(msg, getData) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && msg.id, -32600, "Invalid Request");
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) {
    return null; // notifications/initialized など。応答しない
  }
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS.map(publicTool) } };
    case "tools/call": {
      const result = await runTool(params.name, params.arguments, getData);
      return result ? { jsonrpc: "2.0", id, result } : rpcError(id, -32602, `Unknown tool: ${params.name}`);
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// 何の呼び出しだったかを記録用にまとめる（本文や合言葉は含めない）
function describe(body) {
  const first = Array.isArray(body) ? body[0] : body;
  const method = first && typeof first.method === "string" ? first.method : null;
  const tool = method === "tools/call" && first.params && typeof first.params.name === "string" ? first.params.name : null;
  return { rpc_method: method, tool };
}

// getData: 計画のデータを読む関数（tools.js の道具に渡す）
// token: 接続先 URL の末尾に付ける合言葉。一致しない呼び出しには、関数がないのと同じ 404 を返す
// logAccess: 呼び出しの記録（省略可）。合言葉が違う呼び出しも記録する
export function createMcpHandler({ getData, token, logAccess = null }) {
  async function respond(req, info) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    info.authorized = await isAuthorized(req, token);
    if (!info.authorized) {
      return new Response("Not Found", { status: 404, headers: CORS });
    }
    const wantsStream = (req.headers.get("accept") || "").includes("text/event-stream");
    if ((req.method === "GET" && !wantsStream) || req.method === "HEAD") {
      // claude.ai はコネクタの登録時に GET で接続先を確かめる。サーバーの名前だけを返す
      return json({ name: SERVER_INFO.name, title: SERVER_INFO.title, transport: "streamable-http" });
    }
    if (req.method !== "POST") {
      // ステートレスなので、サーバーから送る SSE ストリーム（GET）やセッション削除（DELETE）は提供しない
      return new Response("Method Not Allowed", { status: 405, headers: { ...CORS, Allow: "POST, GET, OPTIONS" } });
    }
    let body;
    try {
      body = await req.json();
    } catch (_) {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }
    Object.assign(info, describe(body));
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    const responses = (await Promise.all(messages.map((m) => handleMessage(m, getData)))).filter(Boolean);
    if (!responses.length) {
      return new Response(null, { status: 202, headers: CORS });
    }
    return json(batch ? responses : responses[0]);
  }

  return async function handle(req) {
    const info = { authorized: false, rpc_method: null, tool: null };
    const res = await respond(req, info);
    if (logAccess && req.method !== "OPTIONS") {
      try {
        logAccess({
          method: req.method,
          status: res.status,
          ...info,
          accept: (req.headers.get("accept") || "").slice(0, 200),
          user_agent: (req.headers.get("user-agent") || "").slice(0, 200),
        });
      } catch (_) {
        // 記録の失敗で応答を止めない
      }
    }
    return res;
  };
}

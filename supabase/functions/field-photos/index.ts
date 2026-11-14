// Google フォトで選んだ写真を、画面に渡す Supabase Edge Function。
// Google フォトの Picker API で選んだ写真（mediaItems の baseUrl）は、Google のログインの印（アクセストークン）を付けて読む。
// ブラウザーから直接読めない（CORS を許していない）ときに、画面がこの関数を通して読む（app/google-photos.js の download）。
// 配備: supabase functions deploy field-photos
// 呼べるのは、field.owners にいる利用者だけ（field-weather と同じ確かめ方）。読みに行く先は、Google フォトの写真の置き場に限る
// （だれでも、どこでも読める中継にしない）。写真は中継するだけで、残さない
// 呼び方（POST の JSON）: { url: "https://lh3.googleusercontent.com/...=w2048-h2048", token: "Google のアクセストークン" } → 写真の中身
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// 呼んだ利用者が field.owners にいるか。確かめた結果は、関数が動いているあいだ 5 分覚えておく
const OWNER_TTL_MS = 5 * 60 * 1000;
const owners = new Map<string, number>();

async function isOwner(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization) {
    return false;
  }
  if ((owners.get(authorization) ?? 0) > Date.now()) {
    return true;
  }
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/is_owner`, {
    method: "POST",
    headers: {
      apikey: Deno.env.get("SUPABASE_ANON_KEY") || request.headers.get("apikey") || "",
      Authorization: authorization,
      "Content-Type": "application/json",
      "Content-Profile": "field",
    },
    body: "{}",
  });
  if (!response.ok || (await response.json()) !== true) {
    return false;
  }
  if (owners.size >= 100) {
    owners.clear();
  }
  owners.set(authorization, Date.now() + OWNER_TTL_MS);
  return true;
}

// 読みに行ってよい先。Picker API の baseUrl は lh3.googleusercontent.com（ほかの番号の lh も念のため許す）
export function allowedUrl(text: string) {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && /^lh\d*\.googleusercontent\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

if (import.meta.main) {
  Deno.serve(async (request) => {
    if (request.method === "OPTIONS") {
      return new Response("ok", { headers: CORS });
    }
    try {
      if (!(await isOwner(request))) {
        return reply({ error: "この関数は、ログインした本人だけが使えます" }, 403);
      }
      const body = await request.json().catch(() => ({}));
      if (!allowedUrl(String(body.url ?? "")) || !body.token) {
        return reply({ error: "Google フォトの写真の url と token を指定してください" }, 400);
      }
      const response = await fetch(body.url, { headers: { Authorization: `Bearer ${body.token}` } });
      if (!response.ok) {
        return reply({ error: `Google フォトから写真を読めませんでした（${response.status}）` }, 502);
      }
      return new Response(response.body, {
        headers: { ...CORS, "Content-Type": response.headers.get("content-type") || "image/jpeg", "Cache-Control": "no-store" },
      });
    } catch (error) {
      return reply({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}

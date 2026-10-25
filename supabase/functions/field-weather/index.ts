// 2 週間気温予報を、画面に渡す Supabase Edge Function。
// 気象庁の 2 週間気温予報のデータは、ブラウザーから直接は読めない（CORS を許していない）ので、ここで読んで返す。
// 配備: supabase functions deploy field-weather（JWT を確かめる。画面からログインした利用者だけが呼べる）
// 呼び方（POST の JSON）:
//   { station: 47662 } → { report, days: [{ date, max, min, max_lower, max_upper, min_lower, min_upper }] }
//   { list: true }     → { stations: [{ no, name, fuk }] }（地点の一覧）
const BASE = "https://www.data.jma.go.jp/cpd/twoweek";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// 地点の一覧。ページの部品（bundle.js）に埋め込まれている。日本語の一覧が先にある
async function stations() {
  const text = await (await fetch(`${BASE}/top/js/bundle.js`)).text();
  const block = /stnData:\[(.*?)\]/s.exec(text)?.[1] ?? "";
  return [...block.matchAll(/\{No:(\d+),Name:"([^"]+)",Fuk:(\d+)/g)].map((m) => ({ no: Number(m[1]), name: m[2], fuk: Number(m[3]) }));
}

type Item = { yy: number; mm: number; dd: number; elem: number; fcst?: number; lower?: number; upper?: number };

// 地点の予報。wk1（2〜8 日目）と wk2（8〜12 日目）の、日最高気温（elem 2）と日最低気温（elem 3）
async function forecast(station: number) {
  const response = await fetch(`${BASE}/data/Latest/data_${station}.json`);
  if (!response.ok) {
    return null;
  }
  const json = await response.json();
  const days = new Map<string, Record<string, unknown>>();
  for (const item of [...(json.wk1 ?? []), ...(json.wk2 ?? [])] as Item[]) {
    if (item.fcst === undefined || (item.elem !== 2 && item.elem !== 3)) {
      continue;
    }
    const date = `${item.yy}-${String(item.mm).padStart(2, "0")}-${String(item.dd).padStart(2, "0")}`;
    const day = days.get(date) ?? { date };
    const key = item.elem === 2 ? "max" : "min";
    day[key] = item.fcst;
    day[`${key}_lower`] = item.lower ?? null;
    day[`${key}_upper`] = item.upper ?? null;
    days.set(date, day);
  }
  const r = json.reportDate;
  return {
    report: r ? `${r.yy}-${String(r.mm).padStart(2, "0")}-${String(r.dd).padStart(2, "0")}T${String(r.hh).padStart(2, "0")}:00:00+09:00` : null,
    days: [...days.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  try {
    const body = await request.json().catch(() => ({}));
    if (body.list) {
      return reply({ stations: await stations() });
    }
    const station = Number(String(body.station ?? "").replace(/\D/g, ""));
    if (!station) {
      return reply({ error: "station を指定してください" }, 400);
    }
    const result = await forecast(station);
    return result ? reply(result) : reply({ error: "この地点の 2 週間気温予報を読めませんでした" }, 404);
  } catch (error) {
    return reply({ error: String(error) }, 502);
  }
});

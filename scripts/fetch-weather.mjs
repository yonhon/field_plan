// 気象の値（アメダスの日ごとの観測値）を、気象庁から取って DB の field.weather_daily に入れる。
// 圃場の「気象」の欄で選んだ観測所の、10 日前から昨日までのうち、まだ入っていない日を取る（昨日の分は毎回取り直す）。
// 気象庁の 10 分ごとの値は 11 日前までしか残らないので、毎日動かして取りこぼさないようにする。
// 計算は画面と同じ部品（app/weather.js）を使う。アプリも、開いたときに同じことをする（こちらが止まったときの予備）。
//
// 使い方: FIELD_IMPORTER_EMAIL=... FIELD_IMPORTER_PASSWORD=... node scripts/fetch-weather.mjs
// 取り込み係の利用者でログインする。GitHub Actions（.github/workflows/weather.yml）が毎日動かす
import { readFileSync } from "node:fs";
import { addDays, localToday } from "../app/schedule.js";
import { FETCH_DAYS, fetchDay } from "../app/weather.js";

const config = readFileSync(new URL("../app/config.js", import.meta.url), "utf8");
const url = /supabaseUrl:\s*"([^"]+)"/.exec(config)[1];
const key = /supabaseAnonKey:\s*"([^"]+)"/.exec(config)[1];

async function call(method, path, body, token, prefer) {
  const response = await fetch(url + path, {
    method,
    headers: {
      apikey: key,
      "Content-Type": "application/json",
      "Accept-Profile": "field",
      "Content-Profile": "field",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path.split("?")[0]}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// 日本時間の今日（GitHub Actions の時計は UTC）
const today = localToday(new Date(Date.now() + 9 * 3600 * 1000 + new Date().getTimezoneOffset() * 60000));
const from = addDays(today, -FETCH_DAYS);
const to = addDays(today, -1);

const { access_token: token } = await call("POST", "/auth/v1/token?grant_type=password", {
  email: process.env.FIELD_IMPORTER_EMAIL,
  password: process.env.FIELD_IMPORTER_PASSWORD,
});
const stations = (await call("POST", "/rest/v1/rpc/weather_stations", {}, token)).map((row) => (typeof row === "string" ? row : row.weather_stations));
if (!stations.length) {
  console.log("観測所が選ばれていません");
  process.exit(0);
}
const have = await call("GET", `/rest/v1/weather_daily?select=station,date&station=in.(${stations.join(",")})&date=gte.${from}&date=lte.${to}`, undefined, token);
const known = new Set(have.filter((row) => row.date < to).map((row) => `${row.station}|${row.date}`));
const rows = [];
const missing = [];
for (const station of stations) {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (known.has(`${station}|${day}`)) {
      continue;
    }
    const value = await fetchDay(station, day);
    if (value.temp_mean === null && value.precip === null) {
      missing.push(`${station} ${day}`);
      continue;
    }
    rows.push({ station, date: day, ...value, source: "amedas", fetched_at: new Date().toISOString() });
  }
}
if (rows.length) {
  await call("POST", "/rest/v1/weather_daily?on_conflict=station,date", rows, token, "resolution=merge-duplicates,return=minimal");
}
console.log(`観測所 ${stations.length} か所、${from}〜${to}: ${rows.length} 日分を入れました${missing.length ? `。取れなかった日: ${missing.join("、")}` : ""}`);

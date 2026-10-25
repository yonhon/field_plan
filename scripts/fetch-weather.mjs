// 気象の値（アメダスの観測所の日ごとの観測値）を、気象庁から取って DB の field.weather_daily に入れる。
// 圃場の「気象」の欄で選んだ観測所について、気象庁の過去の気象データの日別の表（正式な値。品質を確かめた値で、
// 昨日の分まで、いつの日の分も取れる）を、月ごとに読んで入れる（source は jma）。正式な値は、ほかの値を上書きする。
// 日別の表の地点が見つからない観測所と、日別の表にまだない日は、アプリと同じ表示用の JSON で補う（source は amedas）。
// 計算と読み取りは、画面と同じ部品（app/weather.js）を使う。
//
// 使い方: FIELD_IMPORTER_EMAIL=... FIELD_IMPORTER_PASSWORD=... node scripts/fetch-weather.mjs [YYYY-MM-DD]
//   日付を渡すと、その日の月から読む（古い分を入れ直すとき）。渡さなければ、前の月と今月を読む（あとで直された値も拾う）。
// 取り込み係の利用者でログインする。GitHub Actions（.github/workflows/weather.yml）が毎日動かす
import { readFileSync } from "node:fs";
import { addDays, localToday } from "../app/schedule.js";
import { ETRN, FETCH_DAYS, fetchDay, matchEtrnPoint, parseEtrnDaily, parseEtrnPoints, parseStations } from "../app/weather.js";

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

async function text(address) {
  const response = await fetch(address);
  if (!response.ok) {
    throw new Error(`${address}: ${response.status}`);
  }
  return response.text();
}

// 日本時間の今日（GitHub Actions の時計は UTC）
const today = localToday(new Date(Date.now() + 9 * 3600 * 1000 + new Date().getTimezoneOffset() * 60000));
const yesterday = addDays(today, -1);
const firstMonth = process.argv[2] ? `${process.argv[2].slice(0, 7)}-01` : `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;

const { access_token: token } = await call("POST", "/auth/v1/token?grant_type=password", {
  email: process.env.FIELD_IMPORTER_EMAIL,
  password: process.env.FIELD_IMPORTER_PASSWORD,
});
const codes = (await call("POST", "/rest/v1/rpc/weather_stations", {}, token)).map((row) => (typeof row === "string" ? row : row.weather_stations));
if (!codes.length) {
  console.log("観測所が選ばれていません");
  process.exit(0);
}

const table = parseStations(JSON.parse(await text("https://www.jma.go.jp/bosai/amedas/const/amedastable.json")));
const pointsOf = new Map(); // 府県の番号 → 日別の表の地点の一覧
const rows = [];
const notes = [];
for (const code of codes) {
  const station = table.find((item) => item.code === code);
  const prec = code.slice(0, 2); // アメダスの観測所の番号の上 2 桁が、府県の番号
  if (station && !pointsOf.has(prec)) {
    pointsOf.set(prec, parseEtrnPoints(await text(`${ETRN}/select/prefecture.php?prec_no=${prec}&block_no=&year=&month=&day=&view=`)));
  }
  const point = station ? matchEtrnPoint(pointsOf.get(prec), station) : null;
  const official = new Set();
  if (point) {
    for (let month = firstMonth; month <= today; month = `${addDays(`${month.slice(0, 7)}-28`, 4).slice(0, 7)}-01`) {
      const [year, m] = month.split("-").map(Number);
      const page = await text(`${ETRN}/view/daily_${point.kind}1.php?prec_no=${prec}&block_no=${point.block}&year=${year}&month=${m}&day=&view=`);
      for (const day of parseEtrnDaily(page, point.kind, year, m)) {
        if (day.date <= yesterday) {
          rows.push({ station: code, ...day, source: "jma", fetched_at: new Date().toISOString() });
          official.add(day.date);
        }
      }
    }
  } else {
    notes.push(`${station?.name || code}: 日別の表の地点が見つからないので、表示用の JSON で取りました`);
  }
  // 日別の表にまだない直近の日は、表示用の JSON で補う（DB に正式な値があれば、それを残す）
  const recent = addDays(today, -FETCH_DAYS);
  const have = await call("GET", `/rest/v1/weather_daily?select=date,source&station=eq.${code}&date=gte.${recent}&date=lte.${yesterday}`, undefined, token);
  const kept = new Set(have.filter((row) => row.source !== "amedas" && row.date < yesterday).map((row) => row.date));
  for (let day = recent; day <= yesterday; day = addDays(day, 1)) {
    if (official.has(day) || kept.has(day)) {
      continue;
    }
    const value = await fetchDay(code, day);
    if (value.temp_mean !== null || value.precip !== null) {
      rows.push({ station: code, date: day, ...value, source: "amedas", fetched_at: new Date().toISOString() });
    }
  }
}
for (let i = 0; i < rows.length; i += 500) {
  await call("POST", "/rest/v1/weather_daily?on_conflict=station,date", rows.slice(i, i + 500), token, "resolution=merge-duplicates,return=minimal");
}
const jma = rows.filter((row) => row.source === "jma").length;
console.log(`観測所 ${codes.length} か所、${firstMonth}〜${yesterday}: 正式な値 ${jma} 日分、表示用の JSON ${rows.length - jma} 日分を入れました`);
notes.forEach((note) => console.log(note));

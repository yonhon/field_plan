"""気象庁の「過去の気象データ・ダウンロード」の CSV（日別）を、DB の field.weather_daily に入れる。

アプリは、開いたときに直近 10 日ほどの観測値を気象庁から取る。それより前に取りこぼした日を、この CSV で埋める。
CSV は、地点を 1 つ選び、日別値の「日平均気温」「日最高気温」「日最低気温」「降水量の日合計」を選んで落とす。

使い方:
  SUPABASE_DB_URL=... python scripts/import_jma_csv.py <CSV のパス> <アメダスの観測所の番号> [--dry-run]
観測所の番号は、アプリの「気象」の欄で選んだもの（気象庁のアメダスの地点番号。例: 44132）。
"""

import csv
import io
import os
import re
import sys

ELEMENTS = {
    "平均気温(℃)": "temp_mean",
    "最高気温(℃)": "temp_max",
    "最低気温(℃)": "temp_min",
    "降水量の合計(mm)": "precip",
}


def number(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def parse(text):
    """CSV の文から、[(日付, {temp_mean, temp_max, temp_min, precip})] を返す"""
    rows = list(csv.reader(io.StringIO(text)))
    head = next((i for i, row in enumerate(rows) if row and row[0] == "年月日"), None)
    if head is None:
        raise SystemExit("「年月日」の行が見つかりません。気象庁の過去の気象データの CSV か確かめてください")
    names = rows[head]
    # 要素の名前の下の行に「品質情報」「均質番号」などが並ぶ。そこが空の列が、値の列
    first = next(i for i in range(head + 1, len(rows)) if rows[i] and re.match(r"\d{4}/\d{1,2}/\d{1,2}", rows[i][0]))
    sub = rows[head + 1 : first]
    columns = {}
    for col, name in enumerate(names):
        key = ELEMENTS.get(name.strip())
        if key and key not in columns and all(col >= len(row) or not row[col].strip() for row in sub):
            columns[key] = col
    if not columns:
        raise SystemExit(f"平均気温・最高気温・最低気温・降水量の合計の列が見つかりません: {names}")
    out = []
    for row in rows[first:]:
        match = re.match(r"(\d{4})/(\d{1,2})/(\d{1,2})", row[0] if row else "")
        if not match:
            continue
        date = f"{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
        out.append((date, {key: number(row[col]) if col < len(row) else None for key, col in columns.items()}))
    return out


def main():
    args = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    if len(args) != 2:
        raise SystemExit(__doc__)
    path, station = args
    raw = open(path, "rb").read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp932")
    days = parse(text)
    print(f"{len(days)} 日分（{days[0][0]}〜{days[-1][0]}）" if days else "値のある日がありません")
    if "--dry-run" in sys.argv or not days:
        return
    import psycopg

    with psycopg.connect(os.environ["SUPABASE_DB_URL"]) as conn, conn.transaction():
        for date, value in days:
            conn.execute(
                "insert into field.weather_daily (station, date, temp_mean, temp_max, temp_min, precip, source)"
                " values (%s, %s, %s, %s, %s, %s, 'csv')"
                " on conflict (station, date) do update set temp_mean = excluded.temp_mean, temp_max = excluded.temp_max,"
                " temp_min = excluded.temp_min, precip = excluded.precip, source = 'csv', fetched_at = now()",
                (station, date, value.get("temp_mean"), value.get("temp_max"), value.get("temp_min"), value.get("precip")),
            )
    print("入れました")


if __name__ == "__main__":
    main()

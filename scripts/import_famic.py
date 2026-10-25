"""FAMIC の農薬登録情報（CSV）を、DB の field.famic_* に取り込む。

配布ページ（https://www.acis.famic.go.jp/ddata/index2.htm）にある ZIP のファイル名を、
field.famic_imports の最新の版と比べ、替わっていれば取ってきて、表を丸ごと入れ替える。
列の名前や数が前と違えば、取り込まずに失敗として終わる（形式が変わったときに、黙って壊れた値を入れないため）。

使い方:
  FIELD_IMPORTER_EMAIL=... FIELD_IMPORTER_PASSWORD=... python scripts/import_famic.py [--force]
    取り込み係の利用者でログインし、Supabase の API で入れる（GitHub Actions はこちら）。
    途中の表（famic_*_next）に分けて入れ、DB の関数 field.famic_finish() が本番の表と入れ替える。
  SUPABASE_DB_URL=... python scripts/import_famic.py [--force]
    DB に直接つないで入れる（手元から流すとき）。
GitHub Actions（.github/workflows/famic.yml）が週に 1 回動かす。
"""

import csv
import io
import json
import os
import re
import sys
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

PAGE = "https://www.acis.famic.go.jp/ddata/index2.htm"
CHUNK = 5000  # API で 1 回に入れる行数
PRODUCT_COLUMNS = [
    "reg_no", "ord", "kind", "name", "holder", "ingredient", "count_ingredient", "concentration",
    "mix_count", "use_type", "formulation", "registered_on", "name_search",
]
USE_COLUMNS = [
    "reg_no", "use_type", "kind", "name", "holder", "crop", "place", "target", "purpose", "dilution_text",
    "liquid_text", "timing_text", "times_text", "method", "fumigation_time", "fumigation_temp", "soil", "region",
    "applied_name", "mix_count", "totals", "dilution_min", "dilution_max", "liquid_min", "liquid_max",
    "preharvest_days", "times_max", "total_max",
]
BASIC_HEADER = [
    "登録番号", "農薬の種類", "農薬の名称", "登録を有する者の名称", "有効成分",
    "総使用回数における有効成分", "濃度", "混合数", "用途", "剤型名", "登録年月日",
]
USES_HEADER = [
    "登録番号", "用途", "農薬の種類", "農薬の名称", "登録を有する者の略称", "作物名", "適用場所",
    "適用病害虫雑草名", "使用目的", "希釈倍数使用量", "散布液量", "使用時期", "本剤の使用回数",
    "使用方法", "くん蒸時間", "くん蒸温度", "適用土壌", "適用地帯名", "適用農薬名", "混合数",
    "有効成分①を含む農薬の総使用回数", "有効成分②を含む農薬の総使用回数", "有効成分③を含む農薬の総使用回数",
    "有効成分④を含む農薬の総使用回数", "有効成分⑤を含む農薬の総使用回数",
]
NUMBER = r"(\d+(?:\.\d+)?)"


def normalize(text):
    return unicodedata.normalize("NFKC", text or "").strip()


def katakana(text):
    """検索用。ひらがなをカタカナにそろえる"""
    return "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in text)


def to_int(text):
    try:
        return int(text)
    except ValueError:
        return None


def dilution_range(text):
    """「1000倍」「1000~2000倍」から、下限と上限の倍率。読めなければ (None, None)"""
    match = re.fullmatch(NUMBER + r"(?:~" + NUMBER + r")?倍", text)
    if not match:
        return None, None
    low = float(match.group(1))
    return low, float(match.group(2)) if match.group(2) else low


def liquid_range(text):
    """「100~300リットル/10a」から、10 a あたりの散布液量（L）の下限と上限。最初に出てくるものを読む"""
    match = re.search(NUMBER + r"(?:~" + NUMBER + r")?リットル/10a", text)
    if not match:
        return None, None
    low = float(match.group(1))
    return low, float(match.group(2)) if match.group(2) else low


def preharvest_days(text):
    """「収穫7日前まで」は 7、「収穫前日まで」は 1。どちらもなければ None"""
    match = re.search(r"収穫(\d+)日前まで", text)
    if match:
        return int(match.group(1))
    return 1 if "収穫前日まで" in text else None


def times_limit(text):
    """「5回以内」「1回」「3回以内(植付前は1回以内…)」から、上限の回数。かっこの中の条件は読まない"""
    match = re.match(r"(\d+)回", text)
    return int(match.group(1)) if match else None


def page_files():
    raw = urllib.request.urlopen(PAGE, timeout=60).read()
    html = raw.decode("utf-8") if b"charset=utf-8" in raw[:3000].lower() else raw.decode("cp932", errors="replace")
    return sorted(set(re.findall(r"datacsv/(R\d+\.zip)", html)))


def read_zip(name):
    data = urllib.request.urlopen(f"https://www.acis.famic.go.jp/ddata/datacsv/{name}", timeout=120).read()
    rows = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for member in archive.namelist():
            rows.extend(csv.reader(io.StringIO(archive.read(member).decode("cp932"))))
    return rows


def parse(files):
    products, uses = [], []
    for name in files:
        rows = read_zip(name)
        header = rows[0]
        if header == BASIC_HEADER:
            order = {}
            for row in rows[1:]:
                if len(row) != len(BASIC_HEADER):
                    raise SystemExit(f"{name}: 列の数が {len(row)} の行があります（{len(BASIC_HEADER)} のはず）")
                cells = [normalize(cell) for cell in row]
                reg_no = to_int(cells[0])
                if reg_no is None:
                    continue
                order[reg_no] = order.get(reg_no, 0) + 1
                products.append((
                    reg_no, order[reg_no], cells[1], cells[2], cells[3], cells[4], cells[5], cells[6],
                    to_int(cells[7]), cells[8], cells[9], cells[10], katakana(cells[2]),
                ))
        elif header == USES_HEADER:
            for row in rows[1:]:
                if len(row) != len(USES_HEADER):
                    raise SystemExit(f"{name}: 列の数が {len(row)} の行があります（{len(USES_HEADER)} のはず）")
                cells = [normalize(cell) for cell in row]
                reg_no = to_int(cells[0])
                if reg_no is None:
                    continue
                totals = cells[20:25]
                d_min, d_max = dilution_range(cells[9])
                l_min, l_max = liquid_range(cells[10])
                uses.append((
                    reg_no, cells[1], cells[2], cells[3], cells[4], cells[5], cells[6], cells[7], cells[8],
                    cells[9], cells[10], cells[11], cells[12], cells[13], cells[14], cells[15], cells[16],
                    cells[17], cells[18], to_int(cells[19]), totals, d_min, d_max, l_min, l_max,
                    preharvest_days(cells[11]), times_limit(cells[12]), [times_limit(total) for total in totals],
                ))
        else:
            raise SystemExit(f"{name}: 列の名前が、登録基本部とも登録適用部とも違います: {header}")
    if not products or not uses:
        raise SystemExit("登録基本部か登録適用部が見つかりませんでした")
    return products, uses


class Api:
    """取り込み係でログインした Supabase の API。URL と公開キーは app/config.js から読む"""

    def __init__(self, email, password):
        config = (Path(__file__).resolve().parent.parent / "app" / "config.js").read_text(encoding="utf-8")
        self.url = re.search(r'supabaseUrl:\s*"([^"]+)"', config).group(1)
        self.key = re.search(r'supabaseAnonKey:\s*"([^"]+)"', config).group(1)
        token = self.call("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password}, auth=False)
        self.token = token["access_token"]

    def call(self, method, path, body=None, auth=True, prefer=None):
        headers = {"apikey": self.key, "Content-Type": "application/json", "Accept-Profile": "field", "Content-Profile": "field"}
        if auth:
            headers["Authorization"] = f"Bearer {self.token}"
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                text = response.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as error:
            raise SystemExit(f"{method} {path.split('?')[0]}: {error.code} {error.read().decode()[:500]}")


def import_with_api(files, force):
    api = Api(os.environ["FIELD_IMPORTER_EMAIL"], os.environ["FIELD_IMPORTER_PASSWORD"])
    latest = api.call("GET", "/rest/v1/famic_imports?select=files&order=id.desc&limit=1")
    if latest and sorted(latest[0]["files"]) == files and not force:
        print(f"変わっていません: {', '.join(files)}")
        return
    products, uses = parse(files)
    api.call("POST", "/rest/v1/rpc/famic_begin", {})
    for table, columns, rows in (("famic_products_next", PRODUCT_COLUMNS, products), ("famic_uses_next", USE_COLUMNS, uses)):
        for start in range(0, len(rows), CHUNK):
            chunk = [dict(zip(columns, row)) for row in rows[start : start + CHUNK]]
            api.call("POST", f"/rest/v1/{table}", chunk, prefer="return=minimal")
    api.call("POST", "/rest/v1/rpc/famic_finish", {"files": files, "products": len(products), "uses": len(uses)})
    print(f"取り込みました: {', '.join(files)}（基本部 {len(products)} 行、適用部 {len(uses)} 行）")


def main():
    force = "--force" in sys.argv
    files = page_files()
    if not files:
        raise SystemExit("配布ページに ZIP が見つかりませんでした")
    if not os.environ.get("SUPABASE_DB_URL"):
        import_with_api(files, force)
        return
    import psycopg

    with psycopg.connect(os.environ["SUPABASE_DB_URL"]) as conn:
        latest = conn.execute("select files from field.famic_imports order by id desc limit 1").fetchone()
        if latest and sorted(latest[0]) == files and not force:
            print(f"変わっていません: {', '.join(files)}")
            return
        products, uses = parse(files)
        with conn.transaction():
            conn.execute("truncate field.famic_uses, field.famic_products")
            with conn.cursor() as cur:
                with cur.copy(
                    "copy field.famic_products (reg_no, ord, kind, name, holder, ingredient, count_ingredient, concentration,"
                    " mix_count, use_type, formulation, registered_on, name_search) from stdin"
                ) as copy:
                    for row in products:
                        copy.write_row(row)
                with cur.copy(
                    "copy field.famic_uses (reg_no, use_type, kind, name, holder, crop, place, target, purpose, dilution_text,"
                    " liquid_text, timing_text, times_text, method, fumigation_time, fumigation_temp, soil, region,"
                    " applied_name, mix_count, totals, dilution_min, dilution_max, liquid_min, liquid_max,"
                    " preharvest_days, times_max, total_max) from stdin"
                ) as copy:
                    for row in uses:
                        copy.write_row(row)
            conn.execute(
                "insert into field.famic_imports (files, products, uses) values (%s, %s, %s)",
                (files, len(products), len(uses)),
            )
    print(f"取り込みました: {', '.join(files)}（基本部 {len(products)} 行、適用部 {len(uses)} 行）")


if __name__ == "__main__":
    main()

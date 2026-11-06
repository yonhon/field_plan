"""農薬の作用機構分類（RAC コード）の表を、DB の field.rac_codes に取り込む。

クロップライフジャパンの「RACコード検索表」（Excel。登録番号ごとに、有効成分①〜⑤とその RAC コード）を読み、
有効成分ごとに、IRAC（殺虫剤）、FRAC（殺菌剤）、HRAC（除草剤）のどのコードかを決めて、表を丸ごと入れ替える。
ファイルのハッシュが、field.rac_imports の最新の版と同じなら、取り込まない。

どの委員会のコードかは、次の順に決める。
  1. 表に「21A(I*), 39(F*)」のように印があれば、印のとおり。
  2. 印がなければ、その成分を含む製品の用途（殺虫剤・殺菌剤・除草剤）が 1 つだけなら、その用途。
  3. それでも決まらないものは、COMMITTEE に書いたとおり。書いていなければ、取り込まずに失敗として終わる。
表にない成分は、IRAC などの原表で確かめて MANUAL に書く。取り込みの最後に、FAMIC の有効成分のうち
コードの表にないものを知らせる（GitHub Actions では警告として出る）。

使い方:
  FIELD_IMPORTER_EMAIL=... FIELD_IMPORTER_PASSWORD=... python scripts/import_rac.py [--force]
    取り込み係の利用者でログインし、Supabase の API で入れる（GitHub Actions はこちら）。
  SUPABASE_DB_URL=... python scripts/import_rac.py [--force] [--dry-run]
    DB に直接つないで入れる（手元から流すとき）。--dry-run は、入れたあとに取り消す。
.github/workflows/famic.yml が、FAMIC の取り込みのあとに動かす。
"""

import hashlib
import json
import os
import re
import sys
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from io import BytesIO

from import_famic import Api

URL = "https://www.croplifejapan.org/assets/file/labo/mechanism/mechanism_rac.xlsx"
HEADER = ["頭文字", "製品名", "登録番号", "列1", "用途"] + [f"{name}-{i}" for i in range(1, 6) for name in ("有効成分", "RACコード")]
USE_COMMITTEE = {"殺虫剤": "IRAC", "殺菌剤": "FRAC", "除草剤": "HRAC"}
MARK_COMMITTEE = {"I": "IRAC", "F": "FRAC", "H": "HRAC", "植": ""}

# 製品の用途だけでは委員会が決まらない成分（殺虫殺菌剤にしか出てこない、など）。IRAC・FRAC の原表で確かめた
COMMITTEE = {
    "BT(生菌)": "IRAC",  # 11A
    "クロチアニジン": "IRAC",  # 4A
    "クロルピクリン": "IRAC",  # 8B（土壌くん蒸剤）
    "シアントラニリプロール": "IRAC",  # 28
    "ジクロルプロップ": "HRAC",  # 4（オーキシン類。植物成長調整剤として登録）
    "ブトルアリン": "HRAC",  # 3（ジニトロアニリン系。植物成長調整剤として登録）
    "リン化亜鉛": "IRAC",  # 24A（殺そ剤）
}

# 表にない成分。IRAC の分類表（Ver.11.3）などで確かめた。表にある成分でも、ここに書けばこちらを使う
MANUAL = {
    "イソシクロセラム": [("IRAC", "30")],
    "ジンプロピリダズ": [("IRAC", "36")],
    "スピロピジオン": [("IRAC", "23")],
    "ヤマウチアシボソトゲダニ": [("IRAC", "-")],  # 天敵
    "シンメチリン": [("HRAC", "30")],  # クロップライフジャパンの除草剤のコード表（2026年2月版）
    "青枯病菌感染性バクテリオファージRKP180": [("FRAC", "-")],  # 生物農薬（RKP181 と同じ）
}

# 用途が「その他」の製品にしか入っていない成分（展着剤、フェロモン剤など）は、表が対象にしていないので知らせない。
# 画面では、分類の対象外（−）として出す
UNMATCHED_SQL = (
    "select p.ingredient, string_agg(distinct p.use_type, '・'), count(distinct p.reg_no) from field.famic_products p"
    " where not exists (select 1 from field.rac_codes r where r.ingredient = p.ingredient)"
    " group by 1 having bool_or(p.use_type <> 'その他') order by 1"
)

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def normalize(text):
    return unicodedata.normalize("NFKC", text or "").strip()


def col_index(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_xlsx(data):
    """xlsx の各シートを、行（文字のリスト）の並びで返す。ふりがなは読まない"""
    z = zipfile.ZipFile(BytesIO(data))
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            parts = [si.find("m:t", NS)] + [r.find("m:t", NS) for r in si.findall("m:r", NS)]
            shared.append("".join(t.text or "" for t in parts if t is not None))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheets = {}
    for sheet in ET.fromstring(z.read("xl/workbook.xml")).find("m:sheets", NS):
        path = rels[sheet.get(REL)].lstrip("/")
        path = path if path.startswith("xl/") else "xl/" + path
        rows = []
        for row in ET.fromstring(z.read(path)).iter(f"{{{NS['m']}}}row"):
            cells = {}
            for c in row.findall("m:c", NS):
                v = c.find("m:v", NS)
                if c.get("t") == "s" and v is not None:
                    value = shared[int(v.text)]
                elif c.get("t") == "inlineStr":
                    value = "".join(t.text or "" for t in c.iter(f"{{{NS['m']}}}t"))
                else:
                    value = v.text if v is not None else ""
                cells[col_index(c.get("r"))] = normalize(value)
            if cells:
                rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
        sheets[sheet.get("name")] = rows
    return sheets


def clean_code(text):
    """「「-(生)」」は '-'。Excel の数の誤差（16.100000000000001）を直す。'3.0' は '3'"""
    text = text.strip().strip("「」").strip()
    if text.startswith("-"):
        return "-"
    if re.fullmatch(r"\d+\.\d+", text):
        return f"{round(float(text), 3):g}"
    return text


def parse_code(text):
    """コードの欄を [(委員会 or None, コード)] にする。委員会の印がなければ None"""
    text = text.replace("「", "").replace("」", "")
    if "*)" not in text:
        return [(None, clean_code(text))]
    out = []
    for part in text.split(","):
        match = re.fullmatch(r"\s*(.+?)\s*\((I|F|H|植)\*\)\s*", part)
        if not match:
            raise SystemExit(f"コードの欄を読めません: {text}")
        out.append((MARK_COMMITTEE[match.group(2)], clean_code(match.group(1))))
    return out


def parse(data):
    """(版, [{ ingredient, committee, code, source }])"""
    sheets = read_xlsx(data)
    name = next((key for key in sheets if key.startswith("RACコード検索表")), None)
    if not name:
        raise SystemExit(f"「RACコード検索表」のシートがありません: {list(sheets)}")
    rows = sheets[name]
    edition = next((m.group(0) for row in rows[:3] for cell in row if (m := re.search(r"\d{4}年\d+月版", cell))), None)
    header_at = next((i for i, row in enumerate(rows[:10]) if "登録番号" in row), None)
    if edition is None or header_at is None or rows[header_at][1 : 1 + len(HEADER)] != HEADER:
        raise SystemExit(f"表の形が変わっています（版: {edition}、見出し: {rows[header_at] if header_at is not None else None}）")
    uses = defaultdict(set)  # 成分 → 含む製品の用途
    codes = {}  # 成分 → コードの欄
    for row in rows[header_at + 1 :]:
        row = row + [""] * 16
        if not row[3].isdigit():
            continue
        for i in range(6, 16, 2):
            if row[i]:
                uses[row[i]].add(row[5])
                if codes.setdefault(row[i], row[i + 1]) != row[i + 1]:
                    raise SystemExit(f"{row[i]} のコードが製品によって違います: {codes[row[i]]} と {row[i + 1]}")
    out = []
    undecided = []
    for ingredient, text in sorted(codes.items()):
        if ingredient in MANUAL:
            continue
        for committee, code in parse_code(text):
            if committee is None:
                found = {USE_COMMITTEE[use] for use in uses[ingredient] if use in USE_COMMITTEE}
                if ingredient in COMMITTEE:
                    committee = COMMITTEE[ingredient]
                elif len(found) == 1:
                    committee = found.pop()
                elif code == "-":
                    committee = ""
                else:
                    undecided.append(f"{ingredient}（{code}、用途: {'・'.join(sorted(uses[ingredient]))}）")
                    continue
            out.append({"ingredient": ingredient, "committee": committee, "code": code, "source": "jcpa"})
    if undecided:
        raise SystemExit("委員会が決まらない成分があります。COMMITTEE に書いてください:\n  " + "\n  ".join(undecided))
    for ingredient, pairs in MANUAL.items():
        out += [{"ingredient": ingredient, "committee": committee, "code": code, "source": "manual"} for committee, code in pairs]
    keys = [(item["ingredient"], item["committee"]) for item in out]
    if len(keys) != len(set(keys)):
        raise SystemExit("同じ成分と委員会の組が 2 つあります")
    return edition, out


def report(unmatched):
    if not unmatched:
        print("FAMIC の有効成分は、すべてコードの表にあります")
        return
    prefix = "::warning::" if os.environ.get("GITHUB_ACTIONS") else ""
    lines = [f"{row[0]}（{row[1]}、{row[2]} 製品）" for row in unmatched]
    print(f"{prefix}コードの表にない有効成分が {len(lines)} あります。原表で確かめて MANUAL に書いてください: " + "、".join(lines))


def main():
    force = "--force" in sys.argv
    request = urllib.request.Request(URL, headers={"User-Agent": "field-plan-import"})
    data = urllib.request.urlopen(request, timeout=120).read()
    # MANUAL や COMMITTEE を書き換えたときも取り込み直すよう、それらもハッシュに含める
    sha = hashlib.sha256(data + json.dumps([MANUAL, COMMITTEE], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    if not os.environ.get("SUPABASE_DB_URL"):
        api = Api(os.environ["FIELD_IMPORTER_EMAIL"], os.environ["FIELD_IMPORTER_PASSWORD"])
        latest = api.call("GET", "/rest/v1/rac_imports?select=sha256&order=id.desc&limit=1")
        if latest and latest[0]["sha256"] == sha and not force:
            print("変わっていません")
        else:
            edition, rows = parse(data)
            api.call("POST", "/rest/v1/rpc/rac_replace", {"edition": edition, "sha256": sha, "codes": rows})
            print(f"取り込みました: {edition}（{len(rows)} 行）")
        report([(row["ingredient"], row["use_types"], row["products"]) for row in api.call("POST", "/rest/v1/rpc/rac_unmatched", {})])
        return
    import psycopg

    with psycopg.connect(os.environ["SUPABASE_DB_URL"]) as conn:
        latest = conn.execute("select sha256 from field.rac_imports order by id desc limit 1").fetchone()
        if latest and latest[0] == sha and not force:
            print("変わっていません")
        else:
            edition, rows = parse(data)
            with conn.transaction() as tx:
                conn.execute("truncate field.rac_codes")
                with conn.cursor() as cur:
                    cur.executemany(
                        "insert into field.rac_codes (ingredient, committee, code, source) values (%(ingredient)s, %(committee)s, %(code)s, %(source)s)",
                        rows,
                    )
                conn.execute("insert into field.rac_imports (edition, sha256, codes) values (%s, %s, %s)", (edition, sha, len(rows)))
                print(f"取り込みました: {edition}（{len(rows)} 行）")
                report(conn.execute(UNMATCHED_SQL).fetchall())
                if "--dry-run" in sys.argv:
                    print("--dry-run なので取り消します")
                    raise psycopg.Rollback(tx)
                return
        report(conn.execute(UNMATCHED_SQL).fetchall())


if __name__ == "__main__":
    main()

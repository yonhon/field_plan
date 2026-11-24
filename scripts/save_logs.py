"""本番の DB に、作業の記録（実績）をまとめて入れる。

アプリと同じ保存の関数 field.save_work_log を、持ち主としてログインした扱い（auth.uid）で、
1 回の操作の ID（ヘッダー x-op-id と同じ）を付けて呼ぶ。アプリの「変更の履歴」にも 1 行残す。
こうすると、変更の記録（field.audit_log）に利用者と操作の ID が残り、アプリの変更の履歴にも出る。
DB に直接 insert すると、どちらも残らない（2026-11-10 に日記から起こした 12 件がそうなった）。

  SUPABASE_DB_URL=... python scripts/save_logs.py records.json [--dry-run]

records.json の形:
  {
    "field": "圃場の名前か ID",
    "text": "変更の履歴に出す文（例: 日記から、8 月の防除と追肥の実績を入れた）",
    "logs": [{ "log": {...}, "targets": [...], "inputs": [...] }, ...]
  }
log、targets、inputs は、画面が save_work_log に渡すのと同じ形（app/log-view.js の buildLog）。
log の field_id は入れなくてよい（field で決まる）。id を入れると、その記録を置き換える。
--dry-run は、保存してから取り消す（何も残らない）。入れる前に、形が通るかを確かめるのに使う。
"""

import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

import psycopg


class DryRun(Exception):
    pass


def main():
    args = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    if len(args) != 1 or not os.environ.get("SUPABASE_DB_URL"):
        print(__doc__)
        sys.exit(2)
    with open(args[0], encoding="utf-8") as file:
        data = json.load(file)
    if not data.get("logs") or not str(data.get("text", "")).strip():
        sys.exit("logs と text を入れてください")

    with psycopg.connect(os.environ["SUPABASE_DB_URL"]) as conn:
        field = conn.execute(
            "select id, name, active_plan_id from field.fields where id::text = %s or name = %s", (data["field"], data["field"])
        ).fetchall()
        if len(field) != 1:
            sys.exit(f"圃場「{data['field']}」が 1 つに決まりません（{len(field)} 件）")
        field_id, field_name, plan_id = field[0]
        plan_name = conn.execute("select name from field.plans where id = %s", (plan_id,)).fetchone()[0] if plan_id else ""
        owners = [row[0] for row in conn.execute("select user_id from field.owners").fetchall()]
        if len(owners) != 1:
            sys.exit(f"持ち主が 1 人に決まりません（{len(owners)} 人）")
        op_id = str(uuid.uuid4())
        # 変更の履歴の日付は、画面と同じく日本の日付
        day = datetime.now(timezone(timedelta(hours=9))).date().isoformat()
        saved = []
        try:
            with conn.transaction():
                # 画面からの保存と同じに、持ち主としてログインした役割で、操作の ID を付けて書く（RLS も効く）
                conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(owners[0]), "role": "authenticated"}),))
                conn.execute("select set_config('request.headers', %s, true)", (json.dumps({"x-op-id": op_id}),))
                conn.execute("set local role authenticated")
                for item in data["logs"]:
                    log = {**item["log"], "field_id": str(field_id)}
                    row = conn.execute(
                        "select field.save_work_log(%s::jsonb, %s::jsonb, %s::jsonb)",
                        (json.dumps(log, ensure_ascii=False), json.dumps(item.get("targets", []), ensure_ascii=False), json.dumps(item.get("inputs", []), ensure_ascii=False)),
                    ).fetchone()[0]
                    saved.append(row)
                conn.execute(
                    "insert into field.changes (field_id, day, plan_id, plan_name, kind, text) values (%s, %s, %s, %s, 'logs.import', %s)",
                    (field_id, day, plan_id, plan_name, f"{data['text'].strip()}（{len(saved)} 件）"),
                )
                # 変更の記録は、ログインした役割では読めない（画面からも読めない）。役割を戻してから、利用者と操作の ID が付いたかを確かめる
                conn.execute("reset role")
                recorded = conn.execute("select count(*), count(*) filter (where user_id is not null) from field.audit_log where op_id = %s", (op_id,)).fetchone()
                for row in saved:
                    print(f"{row['date']} {row['work_type']} {', '.join(target['label'] for target in row['targets'])}  id={row['id']}")
                print(f"圃場「{field_name}」に {len(saved)} 件。操作の ID {op_id}。変更の記録 {recorded[0]} 行（利用者あり {recorded[1]} 行）")
                if dry_run:
                    raise DryRun()
        except DryRun:
            print("--dry-run なので、取り消しました（何も残っていません）")


if __name__ == "__main__":
    main()

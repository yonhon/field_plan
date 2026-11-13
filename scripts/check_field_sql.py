# field.sql を、空の DB（手元の Docker の Postgres）で流す。Supabase が持っているもの（auth、cron、storage、役割）は、代わりを先に作る。
# 使い方（README の 12 章）:
#   docker run -d --rm --name fp-empty -e POSTGRES_PASSWORD=local -p 127.0.0.1:55432:5432 postgres:17-alpine
#   python scripts/check_field_sql.py sql/field.sql [--times N] [--whole] [--dump out.txt]
# 文ごとに流して失敗した文を出す。--whole は、SQL Editor と同じにファイル全体を 1 回で流す。--dump は、できた定義を書き出す
import re, sys
import psycopg

ADMIN = "postgresql://postgres:local@127.0.0.1:55432/postgres"
DB = "postgresql://postgres:local@127.0.0.1:55432/empty_test"

STUBS = """
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select case when current_setting('test.uid', true) <> '' then 'authenticated' end $$;
create schema cron;
create table cron.job (jobname text primary key, schedule text, command text);
create function cron.schedule(name text, sched text, cmd text) returns bigint language sql as $$
  insert into cron.job values (name, sched, cmd) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning 1::bigint $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
"""


def statements(text):
    """文に分ける。$$ … $$ の中、文字列の中、注釈の中の ; では切らない"""
    out, start, i, dollar, quote = [], 0, 0, None, False
    n = len(text)
    while i < n:
        if dollar:
            if text.startswith(dollar, i):
                i += len(dollar)
                dollar = None
                continue
        elif quote:
            if text[i] == "'":
                quote = False
        elif text.startswith("--", i):
            j = text.find("\n", i)
            if j < 0:
                break
            i = j
            continue
        elif text[i] == "'":
            quote = True
        elif text[i] == "$":
            m = re.match(r"\$[A-Za-z_]*\$", text[i : i + 40])
            if m:
                dollar = m.group(0)
                i += len(dollar)
                continue
        elif text[i] == ";":
            body = text[start : i + 1]
            lead = len(body) - len(body.lstrip())
            line = text.count("\n", 0, start + lead) + 1
            if re.sub(r"--.*", "", body).strip(" \n\t;"):
                out.append((line, body))
            start = i + 1
        i += 1
    return out


def main():
    path = sys.argv[1]
    times = int(sys.argv[sys.argv.index("--times") + 1]) if "--times" in sys.argv else 1
    sql = open(path, encoding="utf-8").read()
    with psycopg.connect(ADMIN, autocommit=True) as c:
        c.execute("drop database if exists empty_test")
        c.execute("create database empty_test")
    with psycopg.connect(DB, autocommit=True) as c:
        c.execute(STUBS)
        items = statements(sql)
        print(f"{len(items)} statements")
        for run in range(1, times + 1):
            failed = 0
            for line, body in items:
                try:
                    c.execute(body)
                except Exception as e:
                    failed += 1
                    first = re.sub(r"--.*", "", body).strip().split("\n")[0][:100]
                    print(f"run {run} line {line}: {str(e).splitlines()[0]}\n    {first}")
            print(f"run {run}: {failed} failed")
        row = c.execute(
            """select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='field' and c.relkind='r'),
          (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='field' and c.relkind='r' and c.relrowsecurity),
          (select count(*) from pg_policies where schemaname='field'),
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='field'),
          (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='field' and not t.tgisinternal),
          (select count(*) from pg_indexes where schemaname='field'),
          (select count(*) from information_schema.columns where table_schema='field')"""
        ).fetchone()
        print("tables, rls, policies, functions, triggers, indexes, columns:", row)
        if "--dump" in sys.argv:
            out = sys.argv[sys.argv.index("--dump") + 1]
            dump(c, out)
        check_copy_plan(c)
    if "--whole" in sys.argv:
        # SQL Editor と同じに、ファイルを 1 つの問い合わせとして流す
        with psycopg.connect(ADMIN, autocommit=True) as c:
            c.execute("drop database if exists empty_test")
            c.execute("create database empty_test")
        with psycopg.connect(DB, autocommit=True) as c:
            c.execute(STUBS)
            for run in (1, 2):
                try:
                    c.execute(sql)
                    print(f"whole file, run {run}: ok")
                except Exception as e:
                    print(f"whole file, run {run}: FAILED: {str(e).splitlines()[0]}")
                    break


OWNER = "00000000-0000-4000-8000-000000000001"
OTHER = "00000000-0000-4000-8000-000000000002"
SHAPE = "[[0, 0], [1, 0], [1, 1], [0, 1]]"

# 元のプランと写しを、ID を除いて比べるための形。行は、親の並び順でたどって番号に直す
PLAN_SHAPE = """
with z as (select *, row_number() over (order by name, id) n from field.zones where plan_id = %(p)s),
     b as (select b.*, z.n zn, row_number() over (order by b.name, b.id) n from field.blocks b join z on z.id = b.zone_id where b.plan_id = %(p)s),
     d as (select d.*, b.n bn, row_number() over (order by b.n, d.seq) n from field.beds d join b on b.id = d.block_id where d.plan_id = %(p)s),
     g as (select g.*, d.n dn, row_number() over (order by d.n, g.seq) n from field.plantings g join d on d.id = g.bed_id where g.plan_id = %(p)s),
     w as (select w.*, b.n bn, g.n gn from field.works w left join b on b.id = w.block_id left join g on g.id = w.planting_id where w.plan_id = %(p)s)
select jsonb_build_object(
  'zones', (select jsonb_agg(to_jsonb(z) - 'id' - 'plan_id' order by n) from z),
  'blocks', (select jsonb_agg(to_jsonb(b) - 'id' - 'plan_id' - 'zone_id' order by n) from b),
  'beds', (select jsonb_agg(to_jsonb(d) - 'id' - 'plan_id' - 'block_id' order by n) from d),
  'plantings', (select jsonb_agg(to_jsonb(g) - 'id' - 'plan_id' - 'bed_id' order by n) from g),
  'works', (select jsonb_agg(to_jsonb(w) - 'id' - 'plan_id' - 'block_id' - 'planting_id' order by bn nulls last, gn nulls last, seq) from w))
"""
COUNTS = "select (select count(*) from field.plans), (select count(*) from field.zones), (select count(*) from field.blocks), (select count(*) from field.beds), (select count(*) from field.plantings), (select count(*) from field.works)"


def check_copy_plan(c):
    """field.copy_plan() を、本人（field.owners にいる利用者）と他人の両方で呼んで確かめる"""
    c.execute("insert into auth.users (id) values (%s), (%s) on conflict do nothing", (OWNER, OTHER))
    c.execute("insert into field.owners (user_id) values (%s) on conflict do nothing", (OWNER,))
    field = c.execute("insert into field.fields (name) values ('試験の圃場') returning id").fetchone()[0]
    plan = c.execute("insert into field.plans (field_id, name, note) values (%s, '元のプラン', 'メモ') returning id", (field,)).fetchone()[0]
    zones = [c.execute("insert into field.zones (plan_id, kind, name, shape) values (%s, 'tillable', %s, %s) returning id", (plan, name, SHAPE)).fetchone()[0] for name in ("z1", "z2")]
    blocks = [c.execute("insert into field.blocks (plan_id, zone_id, name, shape) values (%s, %s, %s, %s) returning id", (plan, zone, name, SHAPE)).fetchone()[0] for zone, name in ((zones[0], "A"), (zones[0], "B"), (zones[1], "C"))]
    beds = [c.execute("insert into field.beds (plan_id, block_id, seq, shape) values (%s, %s, %s, %s) returning id", (plan, block, seq, SHAPE)).fetchone()[0] for block, seq in ((blocks[0], 1), (blocks[0], 2), (blocks[2], 1))]
    plantings = [c.execute("insert into field.plantings (plan_id, bed_id, seq, crop_name) values (%s, %s, %s, %s) returning id", (plan, bed, seq, name)).fetchone()[0] for bed, seq, name in ((beds[0], 1, "葉もの"), (beds[0], 2, "根もの"), (beds[2], 1, "豆"))]
    kind = c.execute("select code from field.work_types order by sort limit 1").fetchone()[0]
    for block, planting, seq in ((blocks[0], None, 1), (None, plantings[0], 1), (None, plantings[0], 2), (None, plantings[2], 1), (blocks[2], None, 1)):
        c.execute("insert into field.works (plan_id, block_id, planting_id, work_type, seq, plan_start, plan_end) values (%s, %s, %s, %s, %s, '2026-04-01', '2026-04-02')", (plan, block, planting, kind, seq))
    before = c.execute(COUNTS).fetchone()
    source = c.execute(PLAN_SHAPE, {"p": plan}).fetchone()[0]

    def as_user(uid, sql, args=()):
        # 画面と同じに、ログインした利用者の役割で呼ぶ（RLS が効く）。失敗したら、その文を取り消す
        with c.transaction():
            c.execute("select set_config('test.uid', %s, true)", (uid,))
            c.execute("set local role authenticated")
            return c.execute(sql, args).fetchone()

    ok = True

    def expect(label, passed):
        nonlocal ok
        ok = ok and passed
        print(f"copy_plan: {'ok  ' if passed else 'FAIL'} {label}")

    copy = as_user(OWNER, "select (field.copy_plan(%s, '写し')).id", (plan,))[0]
    after = c.execute(COUNTS).fetchone()
    expect("行の数が、プラン 1 つ分だけ増える", after == tuple(n * 2 if i else n + 1 for i, n in enumerate(before)))
    expect("中身が、ID を除いて元と同じ（親子のつながりも同じ）", c.execute(PLAN_SHAPE, {"p": copy}).fetchone()[0] == source)
    expect("元のプランは変わらない", c.execute(PLAN_SHAPE, {"p": plan}).fetchone()[0] == source)
    row = c.execute("select name, field_id = %s, copying from field.plans where id = %s", (field, copy)).fetchone()
    expect("名前と圃場が合い、コピーの途中の印は付かない", row == ("写し", True, False))
    shared = c.execute(
        "select count(*) from (select id from field.zones union all select id from field.blocks union all select id from field.beds union all select id from field.plantings union all select id from field.works) t group by id having count(*) > 1"
    ).fetchall()
    expect("ID は、どの行も新しい", not shared)

    # 途中で失敗したら、何も残らない。作業の写しで失敗させる（プランの行も、区域から作付までも、取り消される）
    c.execute("create function field.zz_fail() returns trigger language plpgsql as $$ begin raise exception '保存の失敗'; end $$")
    c.execute("create trigger zz_fail before insert on field.works for each row execute function field.zz_fail()")
    try:
        as_user(OWNER, "select (field.copy_plan(%s, '失敗する写し')).id", (plan,))
        failed = False
    except Exception:
        failed = True
    c.execute("drop trigger zz_fail on field.works")
    c.execute("drop function field.zz_fail()")
    expect("途中で失敗したら、何も残らない", failed and c.execute(COUNTS).fetchone() == after)

    for label, uid, args in (("他人は、コピーできない", OTHER, (plan, "他人の写し")), ("名前が空なら断る", OWNER, (plan, " ")), ("ないプランは断る", OWNER, (OTHER, "写し"))):
        try:
            as_user(uid, "select (field.copy_plan(%s, %s)).id", args)
            refused = False
        except Exception:
            refused = True
        expect(label, refused and c.execute(COUNTS).fetchone() == after)
    print("copy_plan:", "all ok" if ok else "FAILED")


SCHEMA_SQL = """
select 'column', table_name || '.' || column_name, data_type || ' null=' || is_nullable || ' default=' || coalesce(column_default, '') from information_schema.columns where table_schema = 'field'
union all select 'constraint', c.relname || '.' || con.conname, pg_get_constraintdef(con.oid) from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'field'
union all select 'index', tablename || '.' || indexname, indexdef from pg_indexes where schemaname = 'field'
union all select 'policy', tablename || '.' || policyname, cmd || ' ' || roles::text || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '') from pg_policies where schemaname = 'field'
union all select 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'field'
union all select 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'field' and not t.tgisinternal
union all select 'rls', c.relname, c.relrowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'field' and c.relkind = 'r'
union all select 'grant', table_name || '.' || grantee, string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'field' and grantee in ('anon', 'authenticated', 'PUBLIC') group by table_name, grantee
order by 1, 2
"""


def dump(c, out):
    rows = c.execute(SCHEMA_SQL).fetchall()
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write(" | ".join(str(x) for x in r) + "\n")
    print(f"dumped {len(rows)} schema rows to {out}")


if __name__ == "__main__":
    main()

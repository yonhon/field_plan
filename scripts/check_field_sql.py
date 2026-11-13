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
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
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

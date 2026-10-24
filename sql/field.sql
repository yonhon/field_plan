-- 圃場計画のテーブル。Supabase のプロジェクトは agri_db、inoo_farm と共用で、専用の field スキーマに置く。
-- 読み書きするのはブラウザーの画面（Supabase Auth でログインした本人）だけ。
--   1. field スキーマを API の公開対象に加える（Integrations > Data API > Settings > Exposed schemas）
--   2. RLS を有効にして、field.owners に登録した利用者だけに読み書きを許す
-- 図形はすべて、圃場の基準点を原点としたメートル座標の多角形 [[x, y], ...] で持つ（x は東、y は北）。
-- 面積、苗数、施肥量は画面で計算し、DB には元の値だけを置く。
-- 何度実行してもよい。

create schema if not exists field;

-- 読み書きを許す利用者。ログイン用の利用者を作ったあと、その ID を 1 行入れる（README を参照）
create table if not exists field.owners (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create or replace function field.is_owner() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from field.owners where user_id = auth.uid());
$$;

-- 圃場。いくつも持てる。外形、下絵、プランは圃場ごと。品目、肥料、作業の種類、開発日誌のメモは共通
create table if not exists field.fields (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  outline jsonb not null default '[]',   -- 外形の多角形
  base_lat double precision,             -- 基準点（原点）の緯度と経度。分からなければ空
  base_lng double precision,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- 畝を見る視点。視点 1 と視点 2 が見る向き（度。東が 0、北が 90）の 2 つ組。空なら、南からと西から
alter table field.fields add column if not exists view_dirs jsonb;

-- 作図の下絵（集成図や航空写真）。画像は非公開のストレージに置き、ここには位置合わせの値を持つ
create table if not exists field.backdrops (
  id uuid primary key default gen_random_uuid(),
  field_id uuid not null references field.fields (id) on delete cascade,
  storage_path text not null,
  m_per_px double precision not null default 1,  -- 画像の 1 画素が何メートルか
  origin_px jsonb not null default '[0, 0]',     -- 基準点が画像のどの画素にあるか
  rotation_deg double precision not null default 0,  -- 画像の上が北から何度ずれているか（時計回り）
  created_at timestamptz not null default now()
);

-- 図形に合わせて置いた下絵か。true なら、縮尺・向き・位置を変えても図形は変わらない。
-- false は、その上で図形を描いた下絵で、縮尺や向きを変えると図形も一緒に伸び縮み・回転する
alter table field.backdrops add column if not exists fitted boolean;
-- 入れたときにあった下絵は、圃場の最初の 1 枚のほかを、図形に合わせて置いた下絵とみなす
update field.backdrops b set fitted = exists (
  select 1 from field.backdrops older where older.field_id = b.field_id and older.created_at < b.created_at
) where fitted is null;
alter table field.backdrops alter column fitted set default false;
alter table field.backdrops alter column fitted set not null;

-- プラン。圃場の外形と下絵は共通で、区域の配置を何通りか作って比べられる
create table if not exists field.plans (
  id uuid primary key default gen_random_uuid(),
  field_id uuid not null references field.fields (id) on delete cascade,
  name text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- 区域。有効圃場（耕起する場所）と、耕起しない場所（物置、井戸、通路、残渣処理場など）
create table if not exists field.zones (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references field.plans (id) on delete cascade,
  kind text not null check (kind in ('tillable', 'shed', 'well', 'path', 'residue', 'other')),
  name text not null default '',
  shape jsonb not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- 耕起対象区画。有効圃場を線で分けて作る。畝立ての前までの作業は、この区画ごとに計画する。
-- 畝をなくしたあとの場所を、あとの日付から別の区画に設定し直せるよう、始まる日となくなる日を持つ
create table if not exists field.blocks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references field.plans (id) on delete cascade,
  zone_id uuid not null references field.zones (id) on delete cascade,
  name text not null default '',
  shape jsonb not null,
  start_date date,                     -- この日から区画がある。空なら最初から
  end_date date,                       -- この日に区画がなくなる（別の区画に置き換わる）。空ならずっと
  created_at timestamptz not null default now()
);

-- 作業の種類。標準の日数と、次の作業までに空ける日数は、日付の自動入力と（今後の）逆算、警告に使う
create table if not exists field.work_types (
  code text primary key,
  label text not null,
  sort int not null,
  default_days int not null default 1,    -- 作業そのものにかかる標準の日数
  min_gap_days int not null default 0,    -- 終わってから次の作業までに空ける最低の日数
  scope text not null default 'block' check (scope in ('block', 'bed'))  -- ふつう区画に付けるか、畝に付けるか
);

insert into field.work_types (code, label, sort, default_days, min_gap_days, scope) values
  ('subsoil',       '心土破砕',               10,  1,  0, 'block'),
  ('rotary',        'ロータリー',             20,  1,  0, 'block'),
  ('solar_prep',    '太陽熱消毒の用意',       30,  2,  0, 'block'),
  ('solar',         '太陽熱消毒',             40, 28,  0, 'block'),
  ('green_sow',     '緑肥の播種',             50,  1, 50, 'block'),
  ('mow',           '緑肥の伐採（モア）',     60,  1,  0, 'block'),
  ('amend',         '堆肥・石灰・基肥',       70,  1,  0, 'block'),
  ('incorporate',   'すき込み（ロータリー）', 80,  1, 21, 'block'),
  ('ridge',         '畝立て',                 90,  2,  0, 'bed'),
  ('mulch',         'マルチ張り',            100,  2,  0, 'bed'),
  ('plant',         '定植・播種',            110,  3,  0, 'bed'),
  ('harvest',       '収穫',                  120, 30,  0, 'bed'),
  ('residue',       '残渣処理',              130,  1,  0, 'bed')
on conflict (code) do nothing;

-- 肥料の銘柄。成分は % で持つ
create table if not exists field.fertilizers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  n_pct numeric not null,
  p_pct numeric not null default 0,
  k_pct numeric not null default 0
);

-- 品目ごとの設定値。作付に割り当てると、畝の寸法とこの値から苗数と施肥量を計算する。空の値は計算に使わない
create table if not exists field.crops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  variety text not null default '',
  bed_width_cm int,                    -- 畝幅
  aisle_width_cm int,                  -- 左右の隙間（通路幅）
  row_count int,                       -- 条数
  row_gap_cm int,                      -- 条間
  plant_gap_cm numeric,                -- 株間
  staggered boolean not null default false,  -- 千鳥植え
  mulch boolean not null default false,
  n_kg_per_10a numeric,                -- 基肥の窒素量
  fertilizer_id uuid references field.fertilizers (id) on delete set null,
  grow_days int,                       -- 定植・播種から収穫開始までの日数
  harvest_days int,                    -- 収穫の日数
  note text not null default ''
);

-- 畝。区画の中に置く四角形。まわりの隙間が通路になる。
-- 収穫が終わったあとの日付でなくせるよう、なくなる日を持つ
create table if not exists field.beds (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references field.plans (id) on delete cascade,
  block_id uuid not null references field.blocks (id) on delete cascade,
  seq int not null,                    -- 区画の中の番号
  shape jsonb not null,
  start_date date,                     -- この日から畝がある。空なら区画と同じ
  removed_on date,                     -- この日に畝がなくなる。空ならずっと
  created_at timestamptz not null default now()
);

-- 作付。1 本の畝で、畝立てから収穫までの 1 回ぶん。収穫が終わったあとに、同じ畝へ次の作付を置ける。
-- 条数などは、値が空なら品目の設定値を使い、入っていればその作付だけ上書きする
create table if not exists field.plantings (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references field.plans (id) on delete cascade,
  bed_id uuid not null references field.beds (id) on delete cascade,
  seq int not null,                    -- その畝で何回目の作付か
  crop_id uuid references field.crops (id) on delete set null,
  crop_name text not null default '',  -- 品目の名前（品目の設定値を作るまでは、これだけを使う）
  row_count int,
  row_gap_cm int,
  plant_gap_cm numeric,
  staggered boolean,
  mulch boolean,
  n_kg_per_10a numeric,
  fertilizer_id uuid references field.fertilizers (id) on delete set null,
  note text not null default ''
);

-- 作業。畝立ての前までは区画に、畝立てから後は作付に付ける（どちらか一方）
create table if not exists field.works (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references field.plans (id) on delete cascade,
  block_id uuid references field.blocks (id) on delete cascade,
  planting_id uuid references field.plantings (id) on delete cascade,
  work_type text not null references field.work_types (code),
  seq int not null,                    -- 区画または作付の中の順番
  plan_start date,
  plan_end date,
  actual_start date,
  actual_end date,
  note text not null default '',
  check ((block_id is null) <> (planting_id is null))
);

-- 変更の記録。計画を変えるたびに、何を変えたかを 1 行ずつ残す。プランからは独立していて、番号は全体の通し番号。
-- 文は、その時点の名前で書く（あとで名前を変えても、記録の文は変わらない）
create table if not exists field.changes (
  id uuid primary key default gen_random_uuid(),
  field_id uuid not null references field.fields (id) on delete cascade,
  no bigint generated by default as identity unique,  -- メモから「#41」のように指す番号
  at timestamptz not null default now(),              -- 最初に変えた時刻
  last_at timestamptz not null default now(),         -- まとめた行で、最後に変えた時刻
  day date not null,                                  -- 変えた日（画面を使っている場所の日付）
  plan_id uuid references field.plans (id) on delete set null,  -- どのプランでの変更か。品目など共通のものは空
  plan_name text not null default '',
  kind text not null,                                 -- 操作の種類。例: bed.width
  target_kind text,                                   -- 相手の種類と ID。画面で開くために持つ（消えた相手のこともある）
  target_id uuid,
  text text not null,
  before text,                                        -- 変える前と後の値（あれば）
  after text
);

-- 圃場を消しても、開発日誌の記録は残す（圃場の欄が空になる）
alter table field.changes alter column field_id drop not null;
alter table field.changes drop constraint if exists changes_field_id_fkey;
alter table field.changes add constraint changes_field_id_fkey
  foreign key (field_id) references field.fields (id) on delete set null;

create index if not exists changes_day_idx on field.changes (field_id, day);

-- 開発日誌のメモ。日ごとに 1 つ、なぜそうしたかを手で書く。アプリの開発日誌なので、すべての圃場で共通
create table if not exists field.dev_notes (
  day date primary key,
  body text not null default '',
  updated_at timestamptz not null default now()
);

-- 圃場ごとだったころのメモの表。中身を dev_notes に写したあと、2026-10-24 に消した
drop table if exists field.day_notes;

-- MCP サーバー（field-mcp）への呼び出しの記録。合言葉が違う呼び出しも残るので、URL が漏れていないかを確かめられる。
-- 画面からは読み書きしない（許可を作らない）
create table if not exists field.mcp_access_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  method text not null,
  status int not null,
  authorized boolean not null,
  rpc_method text,
  tool text,
  accept text,
  user_agent text
);

create index if not exists works_plan_start_idx on field.works (plan_start);

-- 操作の記録。計画の表の行を足す・変える・消すたびに、DB が変える前と後の行をそのまま残す。
-- 開発日誌のための変更の記録（changes）とは別で、事故を調べたり、消えた行を戻したりするために使う。
-- 画面からは読み書きしない（許可を作らない）。DB が一緒に消した行（区画を消したときの畝など）も残る。
-- 1 年より古い行は、毎日消す（下の cron.schedule）
create table if not exists field.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,              -- 画面から変えた利用者。DB に直接つないで変えたときは空
  db_role text not null,     -- authenticated（画面）、postgres（直接）など
  table_name text not null,
  op text not null check (op in ('insert', 'update', 'delete')),
  row_id text,               -- 変えた行の ID（作業の種類は code）
  old_row jsonb,             -- 変える前の行。足したときは空
  new_row jsonb              -- 変えたあとの行。消したときは空
);

create index if not exists audit_log_at_idx on field.audit_log (at);
create index if not exists audit_log_row_idx on field.audit_log (table_name, row_id);

create or replace function field.write_audit_log() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  old_row jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_row jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
begin
  -- 中身の変わらない上書き（画面が同じ行を保存し直したとき）は残さない
  if tg_op = 'UPDATE' and old_row = new_row then
    return null;
  end if;
  insert into field.audit_log (user_id, db_role, table_name, op, row_id, old_row, new_row)
  values (
    -- この関数は持ち主の権限で動くので、current_user では見分けられない。画面からは auth.role() が入る
    auth.uid(), coalesce(auth.role(), session_user), tg_table_name, lower(tg_op),
    coalesce(new_row ->> 'id', old_row ->> 'id', new_row ->> 'code', old_row ->> 'code'),
    old_row, new_row
  );
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'fields', 'backdrops', 'plans', 'zones', 'blocks', 'beds', 'plantings', 'works',
    'crops', 'fertilizers', 'work_types'
  ] loop
    execute format('drop trigger if exists write_audit_log on field.%I', t);
    execute format(
      'create trigger write_audit_log after insert or update or delete on field.%I '
      'for each row execute function field.write_audit_log()', t);
  end loop;
end $$;

-- 毎日 3:30（日本時間）に、1 年より古い操作の記録を消す。同じ名前で登録し直すと、置き換わる
select cron.schedule(
  'field-audit-log-purge', '30 18 * * *',
  $$delete from field.audit_log where at < now() - interval '1 year'$$
);

-- 権限。ログインした利用者にだけスキーマを見せ、行は field.owners の利用者にだけ許す
revoke all on schema field from public, anon;
revoke all on all tables in schema field from public, anon;
alter default privileges in schema field revoke all on tables from public, anon;

grant usage on schema field to authenticated;
grant select, insert, update, delete on all tables in schema field to authenticated;
revoke all on field.owners from authenticated;
revoke all on field.mcp_access_log from authenticated;
revoke all on field.audit_log from authenticated;
revoke all on function field.write_audit_log() from public, anon, authenticated;
revoke all on function field.is_owner() from public, anon;
grant execute on function field.is_owner() to authenticated;

alter table field.owners enable row level security;
alter table field.mcp_access_log enable row level security;
alter table field.audit_log enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'fields', 'backdrops', 'plans', 'zones', 'blocks', 'work_types',
    'fertilizers', 'crops', 'beds', 'plantings', 'works', 'changes', 'dev_notes'
  ] loop
    execute format('alter table field.%I enable row level security', t);
    execute format('drop policy if exists owner_all on field.%I', t);
    execute format(
      'create policy owner_all on field.%I for all to authenticated '
      'using (field.is_owner()) with check (field.is_owner())', t);
  end loop;
end $$;

-- 下絵の画像の置き場。地番や氏名が写っていることがあるので、非公開にする
insert into storage.buckets (id, name, public) values ('field-plan', 'field-plan', false)
on conflict (id) do nothing;

drop policy if exists field_plan_owner_all on storage.objects;
create policy field_plan_owner_all on storage.objects for all to authenticated
  using (bucket_id = 'field-plan' and field.is_owner())
  with check (bucket_id = 'field-plan' and field.is_owner());

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
  note text not null default '',
  check ((block_id is null) <> (planting_id is null))
);

-- 実績の日は作業の記録（work_logs）から求めるので、作業には持たない。2026-10 に消した
alter table field.works drop column if exists actual_start;
alter table field.works drop column if exists actual_end;
-- やらないことにした作業。取りやめた日と理由。空なら取りやめていない
alter table field.works add column if not exists cancelled_on date;
alter table field.works add column if not exists cancel_note text not null default '';

-- 作業の種類のうち、計画に置けるもの。false は記録だけに使う（灌水、防除など）
alter table field.work_types add column if not exists plannable boolean not null default true;

insert into field.work_types (code, label, sort, default_days, min_gap_days, scope, plannable) values
  ('nursery_sow', '育苗の播種',   85, 1, 0, 'bed', true),
  ('water',       '灌水',        200, 1, 0, 'bed', false),
  ('check',       '発芽確認',    210, 1, 0, 'bed', false),
  ('weed',        '除草',        220, 1, 0, 'bed', false),
  ('spray',       '防除',        230, 1, 0, 'bed', false),
  ('topdress',    '追肥',        240, 1, 0, 'bed', false),
  ('install',     '資材の設置',  250, 1, 0, 'bed', false),
  ('other',       'その他',      260, 1, 0, 'bed', false)
on conflict (code) do nothing;

-- 実際に使うプラン。作業の記録は、このプランの畝・作付・作業につなぐ。空なら記録を入れられない
alter table field.fields add column if not exists active_plan_id uuid references field.plans (id) on delete set null;

-- 作業の記録。1 日の 1 作業で 1 行。プランではなく圃場に付けるので、プランを消しても残る
create table if not exists field.work_logs (
  id uuid primary key default gen_random_uuid(),
  field_id uuid not null references field.fields (id) on delete cascade,
  date date not null,                  -- 作業をした日。2 日がかりの作業は日ごとに 1 行
  work_type text not null references field.work_types (code),
  finishes boolean not null default false,  -- この記録で、つながる計画の作業を終えたか
  spec jsonb not null default '{}',    -- 実際の仕様（株間、条間など）。作業の種類ごとに項目が違う
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists work_logs_field_date_idx on field.work_logs (field_id, date);

-- 記録の対象。1 件の記録に畝（作付）を何本でも付ける。区画の作業では区画を付ける。
-- つながる計画の作業は、作付ごとに違うので、ここに持つ。先が消えても記録は残り、label の名前で読める
create table if not exists field.work_log_targets (
  id uuid primary key default gen_random_uuid(),
  log_id uuid not null references field.work_logs (id) on delete cascade,
  planting_id uuid references field.plantings (id) on delete set null,
  bed_id uuid references field.beds (id) on delete set null,
  block_id uuid references field.blocks (id) on delete set null,
  work_id uuid references field.works (id) on delete set null,  -- つながる計画の作業
  label text not null default '',      -- 記録した時点の名前。例: 区画A 畝3 キャベツ
  crop_name text not null default '',  -- 記録した時点の品目の名前
  area_m2 numeric,                     -- 記録した時点の畝＋通路（区画の作業では区画）の面積
  spray_l numeric                      -- 防除で、この畝に散布した液の量（L）
);

create index if not exists work_log_targets_log_idx on field.work_log_targets (log_id);
create index if not exists work_log_targets_planting_idx on field.work_log_targets (planting_id);

-- 記録で使った資材
create table if not exists field.work_log_inputs (
  id uuid primary key default gen_random_uuid(),
  log_id uuid not null references field.work_logs (id) on delete cascade,
  seq int not null default 0,
  kind text not null check (kind in ('pesticide', 'fertilizer', 'seed', 'material')),
  reg_no text,                         -- 農薬の登録番号
  standard jsonb,                      -- 記録した時点の農薬の使用基準の写し
  fertilizer_id uuid references field.fertilizers (id) on delete set null,
  name text not null default '',       -- 名前。銘柄を選ばないもの、名前が分からないものは文字で入れる
  method text not null default '',     -- 使い方（散布、土壌混和、浸漬など）
  dilution numeric,                    -- 希釈倍率（倍）
  amount numeric,                      -- 使った製品の量
  unit text not null default ''
);

create index if not exists work_log_inputs_log_idx on field.work_log_inputs (log_id);

-- 記録を 1 件、対象と資材ごと保存する。対象と資材は、渡したもので置き換える。
-- 画面から呼ぶ。呼んだ利用者の権限で動くので、RLS がそのまま効く
create or replace function field.save_work_log(log jsonb, targets jsonb, inputs jsonb) returns uuid
language plpgsql set search_path = ''
as $$
declare
  new_id uuid := coalesce((log ->> 'id')::uuid, gen_random_uuid());
begin
  insert into field.work_logs (id, field_id, date, work_type, finishes, spec, note)
  values (
    new_id, (log ->> 'field_id')::uuid, (log ->> 'date')::date, log ->> 'work_type',
    coalesce((log ->> 'finishes')::boolean, false), coalesce(log -> 'spec', '{}'::jsonb), coalesce(log ->> 'note', '')
  )
  on conflict (id) do update set
    date = excluded.date, work_type = excluded.work_type, finishes = excluded.finishes,
    spec = excluded.spec, note = excluded.note;

  delete from field.work_log_targets where log_id = new_id;
  insert into field.work_log_targets (id, log_id, planting_id, bed_id, block_id, work_id, label, crop_name, area_m2, spray_l)
  select
    coalesce((t ->> 'id')::uuid, gen_random_uuid()), new_id,
    (t ->> 'planting_id')::uuid, (t ->> 'bed_id')::uuid, (t ->> 'block_id')::uuid, (t ->> 'work_id')::uuid,
    coalesce(t ->> 'label', ''), coalesce(t ->> 'crop_name', ''), (t ->> 'area_m2')::numeric, (t ->> 'spray_l')::numeric
  from jsonb_array_elements(coalesce(targets, '[]'::jsonb)) as t;

  delete from field.work_log_inputs where log_id = new_id;
  insert into field.work_log_inputs (id, log_id, seq, kind, reg_no, standard, fertilizer_id, name, method, dilution, amount, unit)
  select
    coalesce((i ->> 'id')::uuid, gen_random_uuid()), new_id, coalesce((i ->> 'seq')::int, 0), i ->> 'kind',
    i ->> 'reg_no', i -> 'standard', (i ->> 'fertilizer_id')::uuid, coalesce(i ->> 'name', ''),
    coalesce(i ->> 'method', ''), (i ->> 'dilution')::numeric, (i ->> 'amount')::numeric, coalesce(i ->> 'unit', '')
  from jsonb_array_elements(coalesce(inputs, '[]'::jsonb)) as i;

  return new_id;
end;
$$;

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

-- ---- 農薬の使用基準（FAMIC の農薬登録情報） ----
-- FAMIC が配布する CSV（登録基本部、登録適用部）を、scripts/import_famic.py が丸ごと入れ替える。
-- 文字は NFKC でそろえる（半角カナを全角に）。画面からは読むだけ

-- 取り込んだ版。ファイル名に反映日が入る
create table if not exists field.famic_imports (
  id bigint generated always as identity primary key,
  files text[] not null,
  imported_at timestamptz not null default now(),
  products int not null,
  uses int not null
);

-- 登録基本部。有効成分ごとに 1 行（混合剤は複数行）。ord は登録番号の中の順番で、適用部の「有効成分①〜⑤を含む農薬の総使用回数」の番号にあたる
create table if not exists field.famic_products (
  reg_no int not null,                 -- 登録番号
  ord int not null,
  kind text not null default '',       -- 農薬の種類
  name text not null default '',       -- 農薬の名称
  holder text not null default '',     -- 登録を有する者の名称
  ingredient text not null default '', -- 有効成分
  count_ingredient text not null default '',  -- 総使用回数における有効成分。空なら回数に数えない
  concentration text not null default '',
  mix_count int,
  use_type text not null default '',   -- 用途（殺虫剤など）
  formulation text not null default '',  -- 剤型名
  registered_on text not null default '',
  name_search text not null default '', -- 検索用。カタカナにそろえた名前
  primary key (reg_no, ord)
);

-- 登録適用部。作物ごとの使用基準。*_text は CSV の文のまま、数の列はそこから読み取った値（読めなければ空）
create table if not exists field.famic_uses (
  id bigint generated always as identity primary key,
  reg_no int not null,
  use_type text not null default '',
  kind text not null default '',
  name text not null default '',
  holder text not null default '',
  crop text not null default '',       -- 作物名（「野菜類」のようなまとめた名前もある）
  place text not null default '',      -- 適用場所
  target text not null default '',     -- 適用病害虫雑草名
  purpose text not null default '',    -- 使用目的
  dilution_text text not null default '',  -- 希釈倍数使用量
  liquid_text text not null default '',    -- 散布液量
  timing_text text not null default '',    -- 使用時期
  times_text text not null default '',     -- 本剤の使用回数
  method text not null default '',     -- 使用方法
  fumigation_time text not null default '',
  fumigation_temp text not null default '',
  soil text not null default '',
  region text not null default '',
  applied_name text not null default '',
  mix_count int,
  totals text[] not null default '{}', -- 有効成分①〜⑤を含む農薬の総使用回数（文のまま）
  dilution_min numeric,                -- 希釈倍数の下限・上限（倍）
  dilution_max numeric,
  liquid_min numeric,                  -- 散布液量の下限・上限（L/10 a）
  liquid_max numeric,
  preharvest_days int,                 -- 収穫の何日前まで使えるか
  times_max int,                       -- 本剤の使用回数の上限
  total_max int[] not null default '{}'  -- 有効成分①〜⑤の総使用回数の上限
);

create index if not exists famic_uses_reg_crop_idx on field.famic_uses (reg_no, crop);

-- 適用部にある作物名の一覧（品目の画面で、FAMIC の作物名を選ぶときの候補）
create or replace view field.famic_crop_names with (security_invoker = on) as
  select distinct crop from field.famic_uses where crop <> '' order by crop;

-- 品目に対応する FAMIC の作物名（複数）。防除の記録で選べる使用基準は、この作物名の行だけ
alter table field.crops add column if not exists famic_crops text[] not null default '{}';

-- 入れ替えの途中の表。取り込み係がここに分けて入れ、field.famic_finish() が本番の表と入れ替える
create table if not exists field.famic_products_next (like field.famic_products including all);
create table if not exists field.famic_uses_next (like field.famic_uses including all);

-- ---- 取り込み係 ----
-- GitHub Actions が、この利用者でログインして、気象の値と FAMIC の登録情報を入れる。
-- 許すのは、気象の値の読み書き、FAMIC の入れ替え（下の関数を通す）、観測所の番号の読み取りだけ。
-- DB の接続文字列を GitHub に置かずに済むようにするため
create table if not exists field.importers (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create or replace function field.is_importer() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from field.importers where user_id = auth.uid());
$$;

-- 気象の値を取る観測所の番号（どの圃場かは返さない）
create or replace function field.weather_stations() returns setof text
language sql stable security definer set search_path = ''
as $$
  select distinct station
  from field.fields f, lateral (values (f.weather ->> 'temp_station'), (f.weather ->> 'rain_station')) as v (station)
  where station is not null and station <> '' and (field.is_importer() or field.is_owner());
$$;

-- FAMIC の入れ替えを始める（途中の表を空にする）
create or replace function field.famic_begin() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not field.is_importer() then
    raise exception '取り込み係だけが呼べます';
  end if;
  truncate field.famic_products_next, field.famic_uses_next;
end;
$$;

-- FAMIC の入れ替えを終える。途中の表の行数が、取り込み係の数えた行数と合えば、本番の表と入れ替えて版を残す
create or replace function field.famic_finish(files text[], products int, uses int) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  got_products int := (select count(*) from field.famic_products_next);
  got_uses int := (select count(*) from field.famic_uses_next);
begin
  if not field.is_importer() then
    raise exception '取り込み係だけが呼べます';
  end if;
  if got_products <> products or got_uses <> uses then
    raise exception '行数が合いません（基本部 % / %、適用部 % / %）', got_products, products, got_uses, uses;
  end if;
  truncate field.famic_uses, field.famic_products;
  insert into field.famic_products select * from field.famic_products_next;
  insert into field.famic_uses (
    reg_no, use_type, kind, name, holder, crop, place, target, purpose, dilution_text, liquid_text, timing_text,
    times_text, method, fumigation_time, fumigation_temp, soil, region, applied_name, mix_count, totals,
    dilution_min, dilution_max, liquid_min, liquid_max, preharvest_days, times_max, total_max
  )
  select
    reg_no, use_type, kind, name, holder, crop, place, target, purpose, dilution_text, liquid_text, timing_text,
    times_text, method, fumigation_time, fumigation_temp, soil, region, applied_name, mix_count, totals,
    dilution_min, dilution_max, liquid_min, liquid_max, preharvest_days, times_max, total_max
  from field.famic_uses_next;
  insert into field.famic_imports (files, products, uses) values (files, products, uses);
  truncate field.famic_products_next, field.famic_uses_next;
end;
$$;

-- ---- 気象 ----

-- 圃場の気象の設定。{ temp_station, rain_station（アメダスの観測所の番号）, office（府県予報区）, area（一次細分区域）,
--   point（予報の気温の地点）, twoweek（2 週間気温予報の地点）}
alter table field.fields add column if not exists weather jsonb not null default '{}';

-- 日ごとの気象。アメダスの観測所ごと。画面が気象庁から直近の日を取って入れる。古い日は気象庁の CSV から入れる
create table if not exists field.weather_daily (
  station text not null,               -- アメダスの観測所の番号
  date date not null,
  temp_mean numeric,                   -- 日平均気温（℃）。毎正時の 24 回の平均。欠けが多い日は空
  temp_max numeric,
  temp_min numeric,
  precip numeric,                      -- 日降水量（mm）
  source text not null default '',     -- amedas（画面が取った値）、csv（CSV から入れた値）
  fetched_at timestamptz not null default now(),
  primary key (station, date)
);

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
    'crops', 'fertilizers', 'work_types', 'work_logs', 'work_log_targets', 'work_log_inputs'
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
revoke all on function field.save_work_log(jsonb, jsonb, jsonb) from public, anon;
grant execute on function field.save_work_log(jsonb, jsonb, jsonb) to authenticated;
revoke all on field.importers from authenticated;
alter table field.importers enable row level security;
revoke all on function field.is_importer() from public, anon;
grant execute on function field.is_importer() to authenticated;
revoke all on function field.weather_stations() from public, anon;
grant execute on function field.weather_stations() to authenticated;
revoke all on function field.famic_begin() from public, anon;
grant execute on function field.famic_begin() to authenticated;
revoke all on function field.famic_finish(text[], int, int) from public, anon;
grant execute on function field.famic_finish(text[], int, int) to authenticated;

alter table field.owners enable row level security;
alter table field.mcp_access_log enable row level security;
alter table field.audit_log enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'fields', 'backdrops', 'plans', 'zones', 'blocks', 'work_types',
    'fertilizers', 'crops', 'beds', 'plantings', 'works', 'changes', 'dev_notes',
    'work_logs', 'work_log_targets', 'work_log_inputs', 'weather_daily'
  ] loop
    execute format('alter table field.%I enable row level security', t);
    execute format('drop policy if exists owner_all on field.%I', t);
    execute format(
      'create policy owner_all on field.%I for all to authenticated '
      'using (field.is_owner()) with check (field.is_owner())', t);
  end loop;
end $$;

-- FAMIC の表は、画面からは読むだけ。入れ替えは DB に直接つないで行う（scripts/import_famic.py）
do $$
declare
  t text;
begin
  foreach t in array array['famic_imports', 'famic_products', 'famic_uses'] loop
    execute format('alter table field.%I enable row level security', t);
    execute format('drop policy if exists owner_read on field.%I', t);
    execute format('create policy owner_read on field.%I for select to authenticated using (field.is_owner())', t);
    execute format('revoke insert, update, delete on field.%I from authenticated', t);
  end loop;
end $$;

-- 取り込み係の許可。FAMIC は、版を読むことと、途中の表に入れることだけ（本番の表は field.famic_finish() が入れ替える）。
-- 気象の値は読み書きできる
drop policy if exists importer_read on field.famic_imports;
create policy importer_read on field.famic_imports for select to authenticated using (field.is_importer());

do $$
declare
  t text;
begin
  foreach t in array array['famic_products_next', 'famic_uses_next'] loop
    execute format('alter table field.%I enable row level security', t);
    execute format('drop policy if exists importer_insert on field.%I', t);
    execute format('create policy importer_insert on field.%I for insert to authenticated with check (field.is_importer())', t);
    execute format('revoke select, update, delete on field.%I from authenticated', t);
  end loop;
end $$;

drop policy if exists importer_all on field.weather_daily;
create policy importer_all on field.weather_daily for all to authenticated
  using (field.is_importer()) with check (field.is_importer());

-- 下絵の画像の置き場。地番や氏名が写っていることがあるので、非公開にする
insert into storage.buckets (id, name, public) values ('field-plan', 'field-plan', false)
on conflict (id) do nothing;

drop policy if exists field_plan_owner_all on storage.objects;
create policy field_plan_owner_all on storage.objects for all to authenticated
  using (bucket_id = 'field-plan' and field.is_owner())
  with check (bucket_id = 'field-plan' and field.is_owner());

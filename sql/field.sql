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
  outline jsonb not null default '[]',   -- 外形。多角形の並び（離れた部分をいくつも持てる）。[[[x, y], …], …]
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

-- コピーの途中の印（copying）は、2026-11-13 に 1 日だけ使った。画面から 1 表ずつ送ってコピーしていたころ、途中で失敗して残った
-- プランを隠すための列。コピーを field.copy_plan() にして、要らなくなったので消す（列を使う画面は、下の min_version = 3 で止める）
alter table field.plans drop column if exists copying;

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

-- 作業の種類のうち、工程の作業（「作業の計画」の表で計画を入れ、順番の確認と並べ直しの対象）か。
-- false は管理作業（防除、追肥、除草、灌水、株の手入れ、その他）。管理作業の計画と実績は、入力の窓で入れる
alter table field.work_types add column if not exists plannable boolean not null default true;

insert into field.work_types (code, label, sort, default_days, min_gap_days, scope, plannable) values
  ('nursery_sow', '育苗の播種',   85, 1, 0, 'bed', true),
  ('spray',       '防除',        200, 1, 0, 'bed', false),
  ('topdress',    '追肥',        210, 1, 0, 'bed', false),
  ('weed',        '除草',        220, 1, 0, 'bed', false),
  ('water',       '灌水',        230, 1, 0, 'bed', false),
  ('care',        '株の手入れ',  240, 1, 0, 'bed', false),
  ('other',       'その他',      250, 1, 0, 'bed', false)
on conflict (code) do update set sort = excluded.sort;

-- 管理作業の計画の、予定の中身（仕様、株の手入れ・その他の中身、予定の農薬や肥料）。入力の窓の内容をそのまま持つ
alter table field.works add column if not exists detail jsonb not null default '{}';
-- 入力の窓で一緒に入力した管理作業の計画のまとまり（直すとき、消すときに「一緒に入力した全部」を選べるように）
alter table field.works add column if not exists batch_id uuid;

-- 実際に使うプラン。作業の記録は、このプランの畝・作付・作業につなぐ。空なら記録を入れられない
alter table field.fields add column if not exists active_plan_id uuid references field.plans (id) on delete set null;

-- 作業の記録。1 日の 1 作業で 1 行。プランではなく圃場に付けるので、プランを消しても残る
create table if not exists field.work_logs (
  id uuid primary key default gen_random_uuid(),
  field_id uuid not null references field.fields (id) on delete cascade,
  date date not null,                  -- 作業をした日（何日かかかった作業は、始めた日）
  work_type text not null references field.work_types (code),
  finishes boolean not null default false,  -- この記録で、つながる計画の作業を終えたか
  spec jsonb not null default '{}',    -- 実際の仕様（株間、条間など）。作業の種類ごとに項目が違う
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists work_logs_field_date_idx on field.work_logs (field_id, date);

-- 何日かかかった作業の、終えた日（作業中なら、進んだ日）。1 日の作業は空。作業 1 回を記録 1 件にするため
alter table field.work_logs add column if not exists end_date date;
alter table field.work_logs drop constraint if exists work_logs_end_after_start;
alter table field.work_logs add constraint work_logs_end_after_start check (end_date is null or end_date > date);

-- 発芽確認と資材の設置は、その他の中身にした。これまでの実績を移し替えてから、種類を消す（実績の表を作ったあとで行う）
update field.work_logs set work_type = 'other', spec = spec || '{"items": ["発芽確認"]}'::jsonb where work_type = 'check';
update field.work_logs set work_type = 'other', spec = spec || '{"items": ["資材の設置"]}'::jsonb where work_type = 'install';
delete from field.work_types where code in ('check', 'install');

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

-- 1 穴あたりの量。unit が kg なら g、L なら mL、ほかは unit の単位。入れたときは、amount は対象の畝の穴の数（苗数）を掛けた合計
alter table field.work_log_inputs add column if not exists per_hole numeric;

-- 収量と売上の見込み（2026-11-24）。空の値は計算に使わない。作付の値は、入っていれば品目の値より優先する。金額は税抜き。
-- 収量は、1 株あたり（苗数が分かるとき）を 10 a あたりより先に使う。計算は app/revenue.js
alter table field.crops add column if not exists yield_kg_per_10a numeric;   -- 10 a あたりの収量（kg）
alter table field.crops add column if not exists yield_g_per_plant numeric;  -- 1 株あたりの収量（g）
alter table field.crops add column if not exists shippable_pct numeric;      -- 出荷率（%）。空なら 100 %
alter table field.crops add column if not exists price_yen_per_kg numeric;   -- 想定単価（円/kg）。空なら市況から推す
alter table field.crops add column if not exists market_item_name text not null default '';  -- 市況での品目名（public.market_daily_item_stats の item_name）
-- 作付の 4 列は、初めに作付の値を 1 つだけ持つ形で足した。いまは使わない（作付の値は、下の field.planting_forecasts の履歴で持つ）。
-- どの公開の画面も使っていない（2026-11-24 に、本番の DB で 105 件すべて空）。版 4 を公開したあとで消す
alter table field.plantings add column if not exists yield_kg_per_10a numeric;
alter table field.plantings add column if not exists yield_g_per_plant numeric;
alter table field.plantings add column if not exists shippable_pct numeric;
alter table field.plantings add column if not exists price_yen_per_kg numeric;

-- 作付の収量と単価の見込みの履歴（2026-11-24）。見直すたびに 1 件足す（出荷率を発芽の具合で見直す、など）。
-- 4 つの値は、変えるものだけを入れる（空は「この記録では変えていない」）。計算に使うのは、項目ごとに、
-- いちばん新しい記録（set_on、同じ日なら created_at）のうち、その項目が入っているもの。どの記録にもなければ品目の値（app/revenue.js）。
-- 作付と同じくプランに付け、プランをコピーすると一緒にコピーする（copy_plan）。作付を消すと一緒に消える
create table if not exists field.planting_forecasts (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references field.plans (id) on delete cascade,
  planting_id uuid not null references field.plantings (id) on delete cascade,
  set_on date not null,                -- 見込みを決めた日
  yield_kg_per_10a numeric,            -- 10 a あたりの収量（kg）
  yield_g_per_plant numeric,           -- 1 株あたりの収量（g）
  shippable_pct numeric,               -- 出荷率（%）
  price_yen_per_kg numeric,            -- 単価（円/kg、税抜き）
  note text not null default '',       -- なぜ見直したか
  created_at timestamptz not null default now()
);

create index if not exists planting_forecasts_planting_idx on field.planting_forecasts (planting_id);
create index if not exists planting_forecasts_plan_idx on field.planting_forecasts (plan_id);
-- 収穫で、この畝だけ量った収穫量（kg）。空の畝には、記録の収穫量（spec.harvest_kg）の残りを面積の比で分ける
alter table field.work_log_targets add column if not exists harvest_kg numeric;

create index if not exists work_log_inputs_log_idx on field.work_log_inputs (log_id);

-- 作業時間の計測。「始める」から「止める」（または次の作業の「始める」）までの 1 回で 1 行。
-- 作業の記録と同じく、プランではなく圃場に付ける。止めても作業は終えたことにしない（終えたかは作業の記録で持つ）。
-- kind: work（作業）、observe（観察）、prep（準備・片付け）、move（移動）。observe、prep、move は、どの作付にも付かない共通の時間。
-- work_ids は、始めたときの計画の作業（今週やることの 1 行に、同じ日の同じ作業が何か所かまとまるので、複数）。
-- 計画の作業が消えても、計測は label の名前で読める。log_id は、計画にない作業を、あとから記録につないだとき。
-- stopped_at が空なら計測中。source: measured（押して測った）、edited（あとで時刻を直した、入れた）
create table if not exists field.work_sessions (
  id uuid primary key default gen_random_uuid(),
  field_id uuid not null references field.fields (id) on delete cascade,
  kind text not null default 'work' check (kind in ('work', 'observe', 'prep', 'move')),
  work_type text,
  work_ids uuid[] not null default '{}',
  log_id uuid references field.work_logs (id) on delete set null,
  label text not null default '',
  started_at timestamptz not null,
  stopped_at timestamptz,
  source text not null default 'measured' check (source in ('measured', 'edited')),
  created_at timestamptz not null default now(),
  constraint work_sessions_stop_after_start check (stopped_at is null or stopped_at >= started_at)
);

-- 観察（observe）を足す前に作った表の制約を、作り直す
alter table field.work_sessions drop constraint if exists work_sessions_kind_check;
alter table field.work_sessions add constraint work_sessions_kind_check check (kind in ('work', 'observe', 'prep', 'move'));

create index if not exists work_sessions_field_idx on field.work_sessions (field_id, started_at);

-- 記録を 1 件、対象と資材ごと保存する。対象と資材は、渡したもので置き換える。
-- 画面から呼ぶ。呼んだ利用者の権限で動くので、RLS がそのまま効く
-- プランをコピーする。プランを作り、区域・区画・畝・作付・作業を、新しい ID を振って写す。作ったプランを返す。
-- 関数 1 回の呼び出しは 1 つのトランザクションなので、途中で失敗したら、何も残らない
-- （画面から 1 表ずつ送っていたころは、途中で回線が切れると、区域だけ、区画までだけ、といったプランが残った）。
-- 呼んだ利用者の権限で動くので、RLS はそのまま効く。行は、列を 1 つずつ書かずに丸ごと写すので、表に列を足しても直さなくてよい。
-- 親を指す列（zone_id、block_id、bed_id、planting_id）だけ、新しい ID に付け替える
create or replace function field.copy_plan(p_source uuid, p_name text) returns field.plans
language plpgsql set search_path = ''
as $$
declare
  source field.plans;
  copy field.plans;
  zone_ids jsonb;
  block_ids jsonb;
  bed_ids jsonb;
  planting_ids jsonb;
begin
  select * into source from field.plans where id = p_source;
  if not found then
    raise exception 'コピーするプランが見つかりません';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'プランの名前がありません';
  end if;
  insert into field.plans (field_id, name) values (source.field_id, p_name) returning * into copy;

  -- 行ごとの新しい ID。{ 元の ID: 新しい ID }
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into zone_ids from field.zones where plan_id = p_source;
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into block_ids from field.blocks where plan_id = p_source;
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into bed_ids from field.beds where plan_id = p_source;
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into planting_ids from field.plantings where plan_id = p_source;

  -- 親から子の順に入れる
  insert into field.zones
  select (jsonb_populate_record(null::field.zones, to_jsonb(r) || jsonb_build_object(
    'id', zone_ids ->> r.id::text, 'plan_id', copy.id))).*
  from field.zones r where r.plan_id = p_source;

  insert into field.blocks
  select (jsonb_populate_record(null::field.blocks, to_jsonb(r) || jsonb_build_object(
    'id', block_ids ->> r.id::text, 'plan_id', copy.id, 'zone_id', zone_ids ->> r.zone_id::text))).*
  from field.blocks r where r.plan_id = p_source;

  insert into field.beds
  select (jsonb_populate_record(null::field.beds, to_jsonb(r) || jsonb_build_object(
    'id', bed_ids ->> r.id::text, 'plan_id', copy.id, 'block_id', block_ids ->> r.block_id::text))).*
  from field.beds r where r.plan_id = p_source;

  insert into field.plantings
  select (jsonb_populate_record(null::field.plantings, to_jsonb(r) || jsonb_build_object(
    'id', planting_ids ->> r.id::text, 'plan_id', copy.id, 'bed_id', bed_ids ->> r.bed_id::text))).*
  from field.plantings r where r.plan_id = p_source;

  insert into field.works
  select (jsonb_populate_record(null::field.works, to_jsonb(r) || jsonb_build_object(
    'id', gen_random_uuid(), 'plan_id', copy.id,
    'block_id', block_ids ->> r.block_id::text, 'planting_id', planting_ids ->> r.planting_id::text))).*
  from field.works r where r.plan_id = p_source;

  insert into field.planting_forecasts
  select (jsonb_populate_record(null::field.planting_forecasts, to_jsonb(r) || jsonb_build_object(
    'id', gen_random_uuid(), 'plan_id', copy.id, 'planting_id', planting_ids ->> r.planting_id::text))).*
  from field.planting_forecasts r where r.plan_id = p_source;

  return copy;
end;
$$;

-- 記録を 1 件、対象と資材ごと置き換え、保存した記録を返す。返す形は、画面が記録を読むとき（app/store.js の loadLogs）の
-- 1 件と同じ（列の順、対象と資材の並び）。画面は、保存のあとに全件を読み直さず、この 1 件を差し替える。
-- 前は ID だけを返していた。戻り値の型は create or replace では変えられないので、古い形のときだけ消して作り直す
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'field' and p.proname = 'save_work_log' and p.prorettype = 'uuid'::regtype
  ) then
    drop function field.save_work_log(jsonb, jsonb, jsonb);
  end if;
end $$;

create or replace function field.save_work_log(log jsonb, targets jsonb, inputs jsonb) returns json
language plpgsql set search_path = ''
as $$
declare
  new_id uuid := coalesce((log ->> 'id')::uuid, gen_random_uuid());
begin
  insert into field.work_logs (id, field_id, date, end_date, work_type, finishes, spec, note)
  values (
    new_id, (log ->> 'field_id')::uuid, (log ->> 'date')::date, nullif(log ->> 'end_date', '')::date, log ->> 'work_type',
    coalesce((log ->> 'finishes')::boolean, false), coalesce(log -> 'spec', '{}'::jsonb), coalesce(log ->> 'note', '')
  )
  on conflict (id) do update set
    date = excluded.date, end_date = excluded.end_date, work_type = excluded.work_type, finishes = excluded.finishes,
    spec = excluded.spec, note = excluded.note;

  delete from field.work_log_targets where log_id = new_id;
  insert into field.work_log_targets (id, log_id, planting_id, bed_id, block_id, work_id, label, crop_name, area_m2, spray_l, harvest_kg)
  select
    coalesce((t ->> 'id')::uuid, gen_random_uuid()), new_id,
    (t ->> 'planting_id')::uuid, (t ->> 'bed_id')::uuid, (t ->> 'block_id')::uuid, (t ->> 'work_id')::uuid,
    coalesce(t ->> 'label', ''), coalesce(t ->> 'crop_name', ''), (t ->> 'area_m2')::numeric, (t ->> 'spray_l')::numeric,
    (t ->> 'harvest_kg')::numeric
  from jsonb_array_elements(coalesce(targets, '[]'::jsonb)) as t;

  delete from field.work_log_inputs where log_id = new_id;
  insert into field.work_log_inputs (id, log_id, seq, kind, reg_no, standard, fertilizer_id, name, method, dilution, amount, unit, per_hole)
  select
    coalesce((i ->> 'id')::uuid, gen_random_uuid()), new_id, coalesce((i ->> 'seq')::int, 0), i ->> 'kind',
    i ->> 'reg_no', i -> 'standard', (i ->> 'fertilizer_id')::uuid, coalesce(i ->> 'name', ''),
    coalesce(i ->> 'method', ''), (i ->> 'dilution')::numeric, (i ->> 'amount')::numeric, coalesce(i ->> 'unit', ''),
    (i ->> 'per_hole')::numeric
  from jsonb_array_elements(coalesce(inputs, '[]'::jsonb)) as i;

  -- 読むときと同じく、対象と資材は並べ替えずに集める（資材は画面が seq で並べる）
  return (
    select row_to_json(saved) from (
      select l.*,
        coalesce((select json_agg(t) from field.work_log_targets t where t.log_id = l.id), '[]'::json) as targets,
        coalesce((select json_agg(i) from field.work_log_inputs i where i.log_id = l.id), '[]'::json) as inputs
      from field.work_logs l where l.id = new_id
    ) saved
  );
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

-- プランごとの、最後の変更の時刻。画面は起動のとき最近の記録しか読まないので、「圃場とプラン」の窓の「最後の変更」はここから出す
create or replace function field.plan_last_changes() returns table (plan_id uuid, last_at timestamptz)
language sql stable set search_path = ''
as $$
  select c.plan_id, max(c.last_at) from field.changes c where c.plan_id is not null group by c.plan_id;
$$;

-- 開発日誌のメモ。日ごとに 1 つ、なぜそうしたかを手で書く。アプリの開発日誌なので、すべての圃場で共通
create table if not exists field.dev_notes (
  day date primary key,
  body text not null default '',
  updated_at timestamptz not null default now()
);

-- この DB を使ってよい画面の版。画面は起動のとき、自分の版（app/store.js の APP_VERSION）がこれより古ければ、
-- データを出す前に新しい版を読み込み直す。古い画面では正しく書けない形に DB を変えるときは、
-- 新しい画面を公開してから、同じ SQL の中でここを APP_VERSION と同じ値に上げる。行は 1 つだけ。画面からは読むだけ
create table if not exists field.app_compat (
  id boolean primary key default true check (id),
  min_version int not null default 1
);
insert into field.app_compat (id) values (true) on conflict (id) do nothing;

-- 2026-11-10: 圃場の外形を、多角形 1 つ（[[x, y], …]）から、多角形の並び（[[[x, y], …], …]）に変えた。
-- 版 1 の画面は並びを読めないので、版 2 の画面を公開してから流す（版 2 の画面は、どちらの形も読める）
update field.fields set outline = jsonb_build_array(outline)
where jsonb_typeof(outline) = 'array' and jsonb_array_length(outline) > 0 and jsonb_typeof(outline -> 0 -> 0) = 'number';
update field.app_compat set min_version = 2 where min_version < 2;
-- 版 3: プランのコピーを field.copy_plan() で行い、plans.copying の列に触らない。版 2 の画面は、この列を読み書きする
update field.app_compat set min_version = 3 where min_version < 3;
-- 版 4: 収穫の記録の対象に、畝ごとの収穫量（work_log_targets.harvest_kg）を持つ。版 3 の画面は、収穫の記録を直すと畝ごとの量を消す。
-- 上の列を足してから版 4 の画面を公開し、そのあとで流す
update field.app_compat set min_version = 4 where min_version < 4;

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

-- 毎日 3:40（日本時間）に、90 日より古い呼び出しの記録を消す。合言葉が違う呼び出しも 1 件ずつ残るので、
-- 消さないと、関数の URL を叩かれ続けたぶんだけ増える。同じ名前で登録し直すと、置き換わる
select cron.schedule(
  'field-mcp-access-log-purge', '40 18 * * *',
  $$delete from field.mcp_access_log where at < now() - interval '90 days'$$
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

-- 品目と FAMIC の作物名の対応は、前もって決めない。防除を記録するときに、農薬に登録されている作物名から
-- 品目ごとに選び、記録の写し（work_log_inputs.standard）に残す。以前の対応の列と、その候補の一覧は消す
drop view if exists field.famic_crop_names;
alter table field.crops drop column if exists famic_crops;

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

-- FAMIC の入れ替えを終える。途中の表の行数が、取り込み係の数えた行数と合えば、本番の表と入れ替えて版を残す。
-- 適用部の約 10 万行を入れ直すので、authenticated の上限（8 秒）を超えることがある（2026-11-23 に 1.9〜10 秒）。
-- この関数だけ上限を 60 秒にする（API は、関数に付けた statement_timeout を、呼ぶときに当てる）
create or replace function field.famic_finish(files text[], products int, uses int) returns void
language plpgsql security definer set search_path = '' set statement_timeout = '60s'
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

-- ---- 農薬の作用機構分類（RAC コード） ----
-- 有効成分ごとの IRAC（殺虫剤）、FRAC（殺菌剤）、HRAC（除草剤）のコード。農薬名の後ろのアイコンに使う。
-- クロップライフジャパンの「RACコード検索表」から、scripts/import_rac.py が丸ごと入れ替える。
-- 有効成分の名前は famic_products.ingredient と同じ形（NFKC）で、名前で結ぶ。FAMIC の部分（4.7）と一緒に切り離す

-- 取り込んだ版
create table if not exists field.rac_imports (
  id bigint generated always as identity primary key,
  edition text not null,               -- 表の版（例: 2025年6月版）
  sha256 text not null,                -- 取ってきたファイルと、手で足した分のハッシュ。同じなら取り込み直さない
  imported_at timestamptz not null default now(),
  codes int not null
);

-- 有効成分ごとのコード。1 つの成分が、殺虫と殺菌のように複数の委員会のコードを持つことがある。
-- committee が空なのは、どの委員会の分類か決まらない成分（植物成長調整剤など。code は '-'）
create table if not exists field.rac_codes (
  ingredient text not null,
  committee text not null check (committee in ('IRAC', 'FRAC', 'HRAC', '')),
  code text not null,                  -- '4A'、'M5' など。'-' は分類の対象外（天敵、展着剤など）
  source text not null check (source in ('jcpa', 'manual')),  -- manual は、表にない成分を IRAC などの原表で確かめて足したもの
  primary key (ingredient, committee)
);

-- コードの表を入れ替える（取り込み係）。codes は [{ ingredient, committee, code, source }]
create or replace function field.rac_replace(edition text, sha256 text, codes jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not field.is_importer() then
    raise exception '取り込み係だけが呼べます';
  end if;
  truncate field.rac_codes;
  insert into field.rac_codes (ingredient, committee, code, source)
  select x.ingredient, x.committee, x.code, x.source
  from jsonb_to_recordset(codes) as x (ingredient text, committee text, code text, source text);
  insert into field.rac_imports (edition, sha256, codes) values (edition, sha256, jsonb_array_length(codes));
end;
$$;

-- FAMIC の有効成分のうち、コードの表にないもの。取り込みのたびに知らせ、原表で確かめて足す。
-- 用途が「その他」の製品にしか入っていない成分（展着剤、フェロモン剤など）は、表が対象にしていないので除く
create or replace function field.rac_unmatched() returns table (ingredient text, use_types text, products int)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (field.is_importer() or field.is_owner()) then
    raise exception '読めません';
  end if;
  return query
  select p.ingredient, string_agg(distinct p.use_type, '・'), count(distinct p.reg_no)::int
  from field.famic_products p
  where not exists (select 1 from field.rac_codes r where r.ingredient = p.ingredient)
  group by p.ingredient
  having bool_or(p.use_type <> 'その他')
  order by p.ingredient;
end;
$$;

-- ---- 市況 ----

-- agri_db が取り込む沖縄協同青果の市況（public.market_daily_item_stats。日ごと、品目ごとの中値。円/kg、卸値）を、
-- 品目の想定単価の推定に使う（app/revenue.js の marketEstimate）。ビューは agri_db が作るので、ない DB では空を返す
create or replace function field.market_items() returns table (item_name text, days int)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select field.is_owner()) then
    raise exception '読めません';
  end if;
  if to_regclass('public.market_daily_item_stats') is null then
    return;
  end if;
  return query
  select s.item_name, count(*)::int
  from public.market_daily_item_stats s
  where s.avg_price is not null
  group by s.item_name
  order by s.item_name;
end;
$$;

-- 初めに作った、品目ごとの日々の中値を 1 日 1 行で返す関数。いまの画面は、下の field.market_series を使う。
-- これを使う画面（版 4 の前の、ブランチの画面）のために残す。版 4 を公開して、その画面が残っていないのを確かめてから消す
-- （drop function field.market_prices(text[])）
create or replace function field.market_prices(p_names text[]) returns table (item_name text, sale_date date, avg_price numeric)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select field.is_owner()) then
    raise exception '読めません';
  end if;
  if to_regclass('public.market_daily_item_stats') is null then
    return;
  end if;
  return query
  select s.item_name, s.sale_date, s.avg_price
  from public.market_daily_item_stats s
  where s.item_name = any (p_names) and s.avg_price is not null
  order by s.item_name, s.sale_date;
end;
$$;

-- 品目ごとの日々の中値。品目 1 つで 1 行（日付と値の並び）にして返す（1 日 1 行で返すと、品目が 25 で 3,500 行を超え、
-- API の 1 回 1,000 行で切れる。並びにすれば行は品目の数だけで、量も 3 分の 1 ほどになる。2026-11-24）
create or replace function field.market_series(p_names text[]) returns table (item_name text, dates date[], prices numeric[])
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select field.is_owner()) then
    raise exception '読めません';
  end if;
  if to_regclass('public.market_daily_item_stats') is null then
    return;
  end if;
  return query
  select s.item_name, array_agg(s.sale_date order by s.sale_date), array_agg(s.avg_price order by s.sale_date)
  from public.market_daily_item_stats s
  where s.item_name = any (p_names) and s.avg_price is not null
  group by s.item_name
  order by s.item_name;
end;
$$;

-- ---- 気象 ----

-- 圃場の気象の設定。{ temp_station, rain_station（アメダスの観測所の番号）, office（府県予報区）, area（一次細分区域）,
--   point（予報の気温の地点）, twoweek（2 週間気温予報の地点）}
alter table field.fields add column if not exists weather jsonb not null default '{}';

-- 気象の値を取る観測所の番号（どの圃場かは返さない）
create or replace function field.weather_stations() returns setof text
language sql stable security definer set search_path = ''
as $$
  select distinct station
  from field.fields f, lateral (values (f.weather ->> 'temp_station'), (f.weather ->> 'rain_station')) as v (station)
  where station is not null and station <> '' and (field.is_importer() or field.is_owner());
$$;

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

-- ---- ニュース ----

-- 県のページ（病害虫防除技術センターの「新着更新情報」、農業研究センターの「お知らせ」）に載った記事。
-- 取り込み係が 1 日 2 回読んで、新しい記事を足す（scripts/fetch-news.mjs）。画面は「確認」で read_at を入れる
create table if not exists field.news (
  key text primary key,                -- 記事を見分ける文字列。新着更新情報は出典・日付・リンク、お知らせは出典・見出し
  source text not null,                -- nogyo（新着更新情報）、kenkyu（お知らせ）
  title text not null,                 -- リンクの文（お知らせは見出し）
  url text not null,
  posted date,                         -- ページに書かれた日付。読めなければ空
  label text not null default '',      -- 新着、更新など
  first_seen timestamptz not null default now(),
  read_at timestamptz                  -- 確認した日時。空なら未読
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
alter table field.audit_log add column if not exists op_id uuid;  -- 画面の 1 回の操作の ID。ヘッダー x-op-id から。DB に直接つないだ変更などは空

create index if not exists audit_log_at_idx on field.audit_log (at);
create index if not exists audit_log_row_idx on field.audit_log (table_name, row_id);
create index if not exists audit_log_op_idx on field.audit_log (op_id) where op_id is not null;

create or replace function field.write_audit_log() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  old_row jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_row jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  op_id uuid;
begin
  -- 中身の変わらない上書き（画面が同じ行を保存し直したとき）は残さない
  if tg_op = 'UPDATE' and old_row = new_row then
    return null;
  end if;
  -- 操作の ID が読めなくても、保存は止めない
  begin
    op_id := (nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-op-id')::uuid;
  exception when others then
    op_id := null;
  end;
  insert into field.audit_log (user_id, db_role, table_name, op, row_id, old_row, new_row, op_id)
  values (
    -- この関数は持ち主の権限で動くので、current_user では見分けられない。画面からは auth.role() が入る
    auth.uid(), coalesce(auth.role(), session_user), tg_table_name, lower(tg_op),
    coalesce(new_row ->> 'id', old_row ->> 'id', new_row ->> 'code', old_row ->> 'code'),
    old_row, new_row, op_id
  );
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'fields', 'backdrops', 'plans', 'zones', 'blocks', 'beds', 'plantings', 'works', 'planting_forecasts',
    'crops', 'fertilizers', 'work_types', 'work_logs', 'work_log_targets', 'work_log_inputs', 'work_sessions'
  ] loop
    execute format('drop trigger if exists write_audit_log on field.%I', t);
    execute format(
      'create trigger write_audit_log after insert or update or delete on field.%I '
      'for each row execute function field.write_audit_log()', t);
  end loop;
end $$;

-- 操作の記録の最後の番号。画面は、戻ってきたときにまずこれを読み、前に DB と比べたときと同じなら、読み直さない。
-- audit_log は画面から読めないので、持ち主かを確かめてから、持ち主の権限で番号だけを返す
create or replace function field.audit_last() returns bigint
language sql stable security definer set search_path = ''
as $$
  select case when field.is_owner() then coalesce((select max(id) from field.audit_log), 0) end;
$$;

-- 画面の 1 回の操作（audit_log の op_id）で変わった行を、操作の前の中身に戻す（Issue #2）。1 つのトランザクションで行い、失敗したら何も変えない。
-- 行ごとに、その操作の最初の記録の old_row が操作の前の中身（足した行は空なので、消す）。同じ行を何度変えた操作も、1 回で戻る。
-- 戻す処理の変更も、操作の ID 付きで記録する。ID は画面が送る x-op-id、なければ新しく作る。その ID を戻すと、やり直しになる。
-- 返すのは次のどれか。
--   { status: 'done', op_id: 戻す処理の ID, rows: 戻した行の数, changes: [{ table, id, row }], logs: [{ id, row }] }
--     changes は、戻した行の今の中身（消えた行は row が null）。作業の記録の表は changes に入れず、logs に、記録・対象・資材の形
--     （load_field の logs の 1 件と同じ）で返す。画面は、これを当てれば DB とそろう（読み直さなくてよい）
--   { status: 'empty' }（記録がない）
--   { status: 'confirm', removed: { 表: 行の数 } }（p_limits を渡し、消える行がそれ以上の表があった。戻さない）。
--     p_limits は { zones: 1, beds: 2, logs: 2, ... }。作業の記録は logs で数える。確かめたら、p_limits なしで呼び直す
--   { status: 'conflict', rows: [{ table, row_id }] }（戻さない）。conflict になるのは、次の 2 つ。
--   1. 戻す行の今の中身が、その操作のあとの中身と違う（ほかの画面や端末で変わった）。
--      あとの操作を先に戻して、操作のあとの中身に戻っていれば、ぶつからない
--   2. 戻すと、操作に入っていない行まで変わる（操作で足した行を、あとから別の行が指していて、連鎖で消える、など）
-- 監査の対象でない表（changes など）と Storage のファイルは戻さない。
drop function if exists field.undo_op(uuid);
create or replace function field.undo_op(p_op uuid, p_limits jsonb default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  -- 親から子の順。fields.active_plan_id は plans を指すので、入れる順で断られた行は、あとでもう一度試す
  v_order constant text[] := array[
    'fields', 'backdrops', 'plans', 'work_types', 'fertilizers', 'crops', 'zones', 'blocks', 'beds', 'plantings', 'works',
    'planting_forecasts', 'work_logs', 'work_log_targets', 'work_log_inputs', 'work_sessions'];
  v_rows jsonb;      -- [{ t: 表, id: 行の ID, before: 操作の前の中身か null, after: 操作のあとの中身か null }]
  v_conflicts jsonb;
  v_headers jsonb;
  v_new uuid;
  v_mark bigint;
  v_pending jsonb;
  v_next jsonb;
  v_item jsonb;
  v_now jsonb;
  v_pk text;
  v_set text;
  v_progress boolean;
  v_removed jsonb;
  v_changes jsonb := '[]'::jsonb;
  v_log_ids uuid[] := '{}';
  v_logs jsonb;
begin
  if not field.is_owner() then
    raise exception '元に戻せるのは、持ち主だけです' using errcode = '42501';
  end if;
  if p_op is null then
    raise exception '操作の ID がありません';
  end if;
  -- 戻す処理を 1 つずつ行う（同じ操作を 2 回続けて戻さない）
  perform pg_advisory_xact_lock(hashtext('field.undo_op'));

  select jsonb_agg(jsonb_build_object('t', table_name, 'id', row_id, 'before', before, 'after', after)
                   order by array_position(v_order, table_name), row_id)
  into v_rows
  from (
    select table_name, row_id, (array_agg(old_row order by id))[1] as before, (array_agg(new_row order by id desc))[1] as after
    from field.audit_log
    where op_id = p_op
    group by table_name, row_id
  ) g;
  if v_rows is null then
    return jsonb_build_object('status', 'empty');
  end if;
  if exists (select 1 from jsonb_array_elements(v_rows) r where not (r ->> 't') = any (v_order)) then
    raise exception '戻し方を決めていない表の変更があります: %',
      (select string_agg(distinct r ->> 't', ', ') from jsonb_array_elements(v_rows) r where not (r ->> 't') = any (v_order));
  end if;

  -- 1. 今の中身が、その操作のあとの中身と違う行があれば、戻さない
  for v_item in select x from jsonb_array_elements(v_rows) e(x) loop
    select a.attname into v_pk
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = format('field.%I', v_item ->> 't')::regclass and i.indisprimary;
    execute format('select to_jsonb(t) from field.%I t where %I::text = $1', v_item ->> 't', v_pk) into v_now using v_item ->> 'id';
    if v_now is distinct from (case when jsonb_typeof(v_item -> 'after') = 'object' then v_item -> 'after' end) then
      v_conflicts := coalesce(v_conflicts, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('table', v_item ->> 't', 'row_id', v_item ->> 'id'));
    end if;
  end loop;
  if v_conflicts is not null then
    return jsonb_build_object('status', 'conflict', 'rows', v_conflicts);
  end if;

  -- 消える行（操作の前になかった行）が多ければ、戻さずに数を返す
  if p_limits is not null then
    select jsonb_object_agg(t, n) into v_removed
    from (
      select case r ->> 't' when 'work_logs' then 'logs' else r ->> 't' end as t, count(*) as n
      from jsonb_array_elements(v_rows) r
      where jsonb_typeof(r -> 'before') <> 'object' and r ->> 't' not in ('work_log_targets', 'work_log_inputs')
      group by 1
    ) c;
    if exists (select 1 from jsonb_each_text(coalesce(v_removed, '{}'::jsonb)) e(t, n) where p_limits ? e.t and e.n::int >= (p_limits ->> e.t)::int) then
      return jsonb_build_object('status', 'confirm', 'removed', v_removed);
    end if;
  end if;

  -- 戻す処理の ID。write_audit_log は request.headers の x-op-id を読むので、このトランザクションの中だけ置き換える
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
    v_new := (v_headers ->> 'x-op-id')::uuid;
  exception when others then
    v_new := null;
  end;
  if v_new is null or v_new = p_op then
    v_new := gen_random_uuid();
  end if;
  perform set_config('request.headers', (coalesce(v_headers, '{}'::jsonb) || jsonb_build_object('x-op-id', v_new))::text, true);
  v_mark := coalesce((select max(id) from field.audit_log), 0);

  begin
    -- 2. 操作の前にあった行を、親から順に、操作の前の中身にする。外部キーか一意の制約で断られた行は、あとでもう一度試す
    select jsonb_agg(x order by n) into v_pending
    from jsonb_array_elements(v_rows) with ordinality e(x, n)
    where jsonb_typeof(x -> 'before') = 'object';
    while v_pending is not null loop
      v_next := null;
      v_progress := false;
      for v_item in select x from jsonb_array_elements(v_pending) e(x) loop
        select string_agg(format('%I = excluded.%I', a.attname, a.attname), ', ' order by a.attnum)
        into v_set
        from pg_attribute a
        where a.attrelid = format('field.%I', v_item ->> 't')::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
        select a.attname into v_pk
        from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
        where i.indrelid = format('field.%I', v_item ->> 't')::regclass and i.indisprimary;
        begin
          execute format(
            'insert into field.%1$I select * from jsonb_populate_record(null::field.%1$I, $1) on conflict (%2$I) do update set %3$s',
            v_item ->> 't', v_pk, v_set)
          using v_item -> 'before';
          v_progress := true;
        exception when foreign_key_violation or unique_violation then
          v_next := coalesce(v_next, '[]'::jsonb) || jsonb_build_array(v_item);
        end;
      end loop;
      if v_next is not null and not v_progress then
        -- どの行も入れられない。最初の行をもう一度入れて、その誤りをそのまま返す
        v_item := v_next -> 0;
        execute format('insert into field.%1$I select * from jsonb_populate_record(null::field.%1$I, $1)', v_item ->> 't')
        using v_item -> 'before';
      end if;
      v_pending := v_next;
    end loop;

    -- 3. 操作で足した行（操作の前になかった行）を、子から順に消す
    for v_item in
      select x from jsonb_array_elements(v_rows) with ordinality e(x, n)
      where jsonb_typeof(x -> 'before') <> 'object'
      order by n desc
    loop
      select a.attname into v_pk
      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = format('field.%I', v_item ->> 't')::regclass and i.indisprimary;
      begin
        execute format('delete from field.%I where %I::text = $1', v_item ->> 't', v_pk) using v_item ->> 'id';
      exception when foreign_key_violation then
        -- 操作に入っていない行が、消す行を指している
        v_conflicts := jsonb_build_array(jsonb_build_object('table', v_item ->> 't', 'row_id', v_item ->> 'id'));
        raise exception using errcode = 'FP001';
      end;
    end loop;

    -- 4. 操作に入っていない行まで変わったら（連鎖の削除、SET NULL など）、すべて取り消す
    select jsonb_agg(distinct jsonb_build_object('table', a.table_name, 'row_id', a.row_id))
    into v_conflicts
    from field.audit_log a
    where a.id > v_mark and a.op_id = v_new
      and not exists (select 1 from jsonb_array_elements(v_rows) r where r ->> 't' = a.table_name and r ->> 'id' = a.row_id);
    if v_conflicts is not null then
      raise exception using errcode = 'FP001';
    end if;

    -- 5. どの行も、操作の前の中身になったかを確かめる。違えば、すべて取り消す
    for v_item in select x from jsonb_array_elements(v_rows) e(x) loop
      select a.attname into v_pk
      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = format('field.%I', v_item ->> 't')::regclass and i.indisprimary;
      execute format('select to_jsonb(t) from field.%I t where %I::text = $1', v_item ->> 't', v_pk) into v_now using v_item ->> 'id';
      if v_now is distinct from (case when jsonb_typeof(v_item -> 'before') = 'object' then v_item -> 'before' end) then
        raise exception '戻したあとの中身が、操作の前と違います: % %', v_item ->> 't', v_item ->> 'id';
      end if;
      -- 画面に返す中身。作業の記録の表は、記録ごとにまとめて返す
      if v_item ->> 't' = 'work_logs' then
        v_log_ids := v_log_ids || (v_item ->> 'id')::uuid;
      elsif v_item ->> 't' in ('work_log_targets', 'work_log_inputs') then
        v_log_ids := v_log_ids || coalesce(v_now ->> 'log_id', v_item -> 'before' ->> 'log_id', v_item ->> 'log_id')::uuid;
      else
        v_changes := v_changes || jsonb_build_array(jsonb_build_object('table', v_item ->> 't', 'id', v_item ->> 'id', 'row', v_now));
      end if;
    end loop;
    select coalesce(jsonb_agg(jsonb_build_object('id', ids.id, 'row', (
      select to_jsonb(x) from (
        select l.*,
          coalesce((select jsonb_agg(t) from field.work_log_targets t where t.log_id = l.id), '[]'::jsonb) as targets,
          coalesce((select jsonb_agg(i) from field.work_log_inputs i where i.log_id = l.id), '[]'::jsonb) as inputs
        from field.work_logs l where l.id = ids.id
      ) x))), '[]'::jsonb)
    into v_logs
    from (select distinct unnest(v_log_ids) as id) ids
    where ids.id is not null;
  exception when sqlstate 'FP001' then
    -- この begin の中の変更（戻す処理の記録も含む）は、取り消されている
    return jsonb_build_object('status', 'conflict', 'rows', v_conflicts);
  end;

  return jsonb_build_object('status', 'done', 'op_id', v_new, 'rows', jsonb_array_length(v_rows), 'changes', v_changes, 'logs', v_logs);
end;
$$;

-- 起動、戻ってきたときの読み直し、圃場の切り替えで読む中身を、1 回でまとめて返す（要求を 1 つにし、すべてを同じ時点の DB から読む）。
-- 返す形は、画面の表ごとの読み込み（app/store.js の composeLoadField）と同じ。表は行ごと返すので、列を足しても直さなくてよい。
-- 表を足す、読む行の絞り方や並び順を変えるときは、ここと composeLoadField の両方を直す（tests/load-field.test.mjs が表の食い違いを確かめる）。
-- p_field_id、p_plan_id がないか消えていれば、先頭の圃場・プランを開く。
-- p_since が操作の記録の最後の番号（field.audit_last）と同じなら、どこも変わっていないので、番号と版だけを返す。
-- stable なので、中の問い合わせはすべて、呼んだ時点の同じ DB を読む（番号と中身がずれない）
create or replace function field.load_field(p_field_id uuid default null, p_plan_id uuid default null, p_since bigint default null)
returns json
language plpgsql stable set search_path = ''
as $$
declare
  v_mark bigint := field.audit_last();
  v_min int := coalesce((select min_version from field.app_compat limit 1), 0);
  v_field uuid;
  v_plan uuid;
begin
  if p_since is not null and v_mark = p_since then
    return json_build_object('unchanged', true, 'mark', v_mark, 'min_version', v_min);
  end if;
  select f.id into v_field from field.fields f where f.id = p_field_id;
  if v_field is null then
    select f.id into v_field from field.fields f order by f.created_at, f.id limit 1;
  end if;
  select p.id into v_plan from field.plans p where p.id = p_plan_id and p.field_id = v_field;
  if v_plan is null then
    select p.id into v_plan from field.plans p where p.field_id = v_field order by p.created_at, p.id limit 1;
  end if;
  return json_build_object(
    'unchanged', false,
    'mark', v_mark,
    'min_version', v_min,
    'field_id', v_field,
    'plan_id', v_plan,
    'fields', coalesce((select json_agg(t order by t.created_at, t.id) from field.fields t), '[]'),
    'work_types', coalesce((select json_agg(t order by t.sort, t.code) from field.work_types t), '[]'),
    'crops', coalesce((select json_agg(t order by t.name, t.id) from field.crops t), '[]'),
    'fertilizers', coalesce((select json_agg(t order by t.name, t.id) from field.fertilizers t), '[]'),
    'backdrop', (select row_to_json(t) from field.backdrops t where t.field_id = v_field order by t.created_at desc limit 1),
    'plans', coalesce((select json_agg(t order by t.created_at, t.id) from field.plans t where t.field_id = v_field), '[]'),
    'tables', case when v_plan is null then null else json_build_object(
      'zones', coalesce((select json_agg(t order by t.created_at, t.id) from field.zones t where t.plan_id = v_plan), '[]'),
      'blocks', coalesce((select json_agg(t order by t.created_at, t.id) from field.blocks t where t.plan_id = v_plan), '[]'),
      'beds', coalesce((select json_agg(t order by t.seq, t.id) from field.beds t where t.plan_id = v_plan), '[]'),
      'plantings', coalesce((select json_agg(t order by t.seq, t.id) from field.plantings t where t.plan_id = v_plan), '[]'),
      'works', coalesce((select json_agg(t order by t.seq, t.id) from field.works t where t.plan_id = v_plan), '[]'),
      'planting_forecasts', coalesce((select json_agg(t order by t.set_on, t.id) from field.planting_forecasts t where t.plan_id = v_plan), '[]')
    ) end,
    -- 記録は、対象と資材ごと。形は save_work_log が返す 1 件と同じ
    'logs', coalesce((
      select json_agg(x order by x.date desc, x.created_at desc, x.id)
      from (
        select l.*,
          coalesce((select json_agg(t) from field.work_log_targets t where t.log_id = l.id), '[]'::json) as targets,
          coalesce((select json_agg(i) from field.work_log_inputs i where i.log_id = l.id), '[]'::json) as inputs
        from field.work_logs l where l.field_id = v_field
      ) x
    ), '[]'),
    -- 作業時間の計測。開く圃場の分と、ほかの圃場で計測中の分（1 人で作業するので、計測中はどの圃場でも 1 つだけ）
    'sessions', coalesce((
      select json_agg(t order by t.started_at, t.id) from field.work_sessions t
      where t.field_id = v_field or t.stopped_at is null
    ), '[]')
  );
end;
$$;

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

-- 上の許可は、すべての表に付く。表を足して、下の方針（policy）の一覧に足し忘れても開いたままにならないよう、
-- ここで、すべての表に RLS を付ける。方針のない表は、だれも読み書きできない（ファイルの最後で確かめる）
do $$
declare
  t text;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'field' and c.relkind in ('r', 'p')
  loop
    execute format('alter table field.%I enable row level security', t);
  end loop;
end $$;
revoke all on field.owners from authenticated;
revoke all on field.mcp_access_log from authenticated;
revoke all on field.audit_log from authenticated;
revoke all on function field.write_audit_log() from public, anon, authenticated;
revoke all on function field.is_owner() from public, anon;
grant execute on function field.is_owner() to authenticated;
revoke all on function field.copy_plan(uuid, text) from public, anon;
grant execute on function field.copy_plan(uuid, text) to authenticated;
revoke all on function field.save_work_log(jsonb, jsonb, jsonb) from public, anon;
grant execute on function field.save_work_log(jsonb, jsonb, jsonb) to authenticated;
revoke all on function field.plan_last_changes() from public, anon;
revoke all on function field.audit_last() from public, anon;
revoke all on function field.load_field(uuid, uuid, bigint) from public, anon;
grant execute on function field.load_field(uuid, uuid, bigint) to authenticated;
grant execute on function field.audit_last() to authenticated;
revoke all on function field.undo_op(uuid, jsonb) from public, anon;
grant execute on function field.undo_op(uuid, jsonb) to authenticated;
grant execute on function field.plan_last_changes() to authenticated;
revoke all on field.importers from authenticated;
alter table field.importers enable row level security;
revoke all on function field.is_importer() from public, anon;
grant execute on function field.is_importer() to authenticated;
revoke all on function field.weather_stations() from public, anon;
grant execute on function field.weather_stations() to authenticated;
revoke all on function field.market_items() from public, anon;
grant execute on function field.market_items() to authenticated;
revoke all on function field.market_prices(text[]) from public, anon;
grant execute on function field.market_prices(text[]) to authenticated;
revoke all on function field.market_series(text[]) from public, anon;
grant execute on function field.market_series(text[]) to authenticated;
revoke all on function field.famic_begin() from public, anon;
grant execute on function field.famic_begin() to authenticated;
revoke all on function field.famic_finish(text[], int, int) from public, anon;
grant execute on function field.famic_finish(text[], int, int) to authenticated;
revoke all on function field.rac_replace(text, text, jsonb) from public, anon;
grant execute on function field.rac_replace(text, text, jsonb) to authenticated;
revoke all on function field.rac_unmatched() from public, anon;
grant execute on function field.rac_unmatched() to authenticated;

alter table field.owners enable row level security;
alter table field.mcp_access_log enable row level security;
alter table field.audit_log enable row level security;

-- 方針の条件の関数は (select …) で囲む。囲まないと、読む行ごとに関数を呼ぶ。囲むと、問い合わせ 1 回につき 1 度だけ評価する
-- （2026-11-15 の測定で、起動の読み込み field.load_field の DB の中の時間が 24 ms から 11 ms に、作業 450 行の読み込みが 6.7 ms から 0.4 ms になった）
do $$
declare
  t text;
begin
  foreach t in array array[
    'fields', 'backdrops', 'plans', 'zones', 'blocks', 'work_types',
    'fertilizers', 'crops', 'beds', 'plantings', 'works', 'planting_forecasts', 'changes', 'dev_notes',
    'work_logs', 'work_log_targets', 'work_log_inputs', 'work_sessions', 'weather_daily', 'news'
  ] loop
    execute format('alter table field.%I enable row level security', t);
    execute format('drop policy if exists owner_all on field.%I', t);
    execute format(
      'create policy owner_all on field.%I for all to authenticated '
      'using ((select field.is_owner())) with check ((select field.is_owner()))', t);
  end loop;
end $$;

-- FAMIC の表と、画面の版（app_compat）は、画面からは読むだけ。FAMIC の入れ替えは、取り込み係が famic_begin() と famic_finish() で行う（scripts/import_famic.py）
do $$
declare
  t text;
begin
  foreach t in array array['famic_imports', 'famic_products', 'famic_uses', 'rac_imports', 'rac_codes', 'app_compat'] loop
    execute format('alter table field.%I enable row level security', t);
    execute format('drop policy if exists owner_read on field.%I', t);
    execute format('create policy owner_read on field.%I for select to authenticated using ((select field.is_owner()))', t);
    execute format('revoke insert, update, delete on field.%I from authenticated', t);
  end loop;
end $$;

-- 取り込み係の許可。FAMIC は、版を読むことと、途中の表に入れることだけ（本番の表は field.famic_finish() が入れ替える）。
-- 気象の値は読み書きできる
drop policy if exists importer_read on field.famic_imports;
create policy importer_read on field.famic_imports for select to authenticated using ((select field.is_importer()));
drop policy if exists importer_read on field.rac_imports;
create policy importer_read on field.rac_imports for select to authenticated using ((select field.is_importer()));

do $$
declare
  t text;
begin
  foreach t in array array['famic_products_next', 'famic_uses_next'] loop
    execute format('alter table field.%I enable row level security', t);
    execute format('drop policy if exists importer_insert on field.%I', t);
    execute format('create policy importer_insert on field.%I for insert to authenticated with check ((select field.is_importer()))', t);
    execute format('revoke select, update, delete on field.%I from authenticated', t);
  end loop;
end $$;

drop policy if exists importer_all on field.weather_daily;
create policy importer_all on field.weather_daily for all to authenticated
  using ((select field.is_importer())) with check ((select field.is_importer()));

-- ニュースは、読むことと足すことだけ（確認した印は変えない）
drop policy if exists importer_read on field.news;
create policy importer_read on field.news for select to authenticated using ((select field.is_importer()));
drop policy if exists importer_insert on field.news;
create policy importer_insert on field.news for insert to authenticated with check ((select field.is_importer()));

-- 下絵の画像の置き場。地番や氏名が写っていることがあるので、非公開にする
insert into storage.buckets (id, name, public) values ('field-plan', 'field-plan', false)
on conflict (id) do nothing;

drop policy if exists field_plan_owner_all on storage.objects;
create policy field_plan_owner_all on storage.objects for all to authenticated
  using (bucket_id = 'field-plan' and (select field.is_owner()))
  with check (bucket_id = 'field-plan' and (select field.is_owner()));

-- 確かめ。RLS のない表と、方針の一覧に足し忘れた表（RLS はあるが方針がない表）、
-- 操作の記録（audit_log）の対象かを決めていない表、行ごとに持ち主かを確かめる方針があれば、失敗させる。
-- 方針がなくてよいのは、画面から読み書きしない 4 つの表だけ
do $$
declare
  missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'field' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if missing is not null then
    raise exception 'RLS のない表があります: %', missing;
  end if;
  select string_agg(c.relname, ', ' order by c.relname) into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'field' and c.relkind in ('r', 'p')
    and c.relname not in ('owners', 'importers', 'mcp_access_log', 'audit_log')
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if missing is not null then
    raise exception '方針（policy）のない表があります。方針の一覧に足してください: %', missing;
  end if;
  -- 操作の記録（audit_log）のトリガーのない表。画面は、戻ってきたときに audit_log の最後の番号（field.audit_last）が
  -- 前と同じなら読み直さないので、トリガーのない表の変更は、ほかの端末で変えても拾えない。
  -- 表を足したら、トリガーの一覧（write_audit_log を付ける do の配列）か、下の「対象にしない表」のどちらかに足す。
  -- 対象にしない表: 管理用（app_compat、audit_log、importers、mcp_access_log、owners）、
  -- 履歴の画面が別に読むもの（changes、dev_notes）、外から取り込むもの（famic_*、rac_*、news、weather_daily）
  select string_agg(c.relname, ', ' order by c.relname) into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'field' and c.relkind in ('r', 'p')
    and c.relname not in (
      'app_compat', 'audit_log', 'importers', 'mcp_access_log', 'owners',
      'changes', 'dev_notes',
      'famic_imports', 'famic_products', 'famic_products_next', 'famic_uses', 'famic_uses_next',
      'rac_codes', 'rac_imports', 'news', 'weather_daily'
    )
    and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'write_audit_log');
  if missing is not null then
    raise exception '操作の記録（audit_log）のトリガーのない表があります。トリガーの一覧か、対象にしない表の一覧に足してください: %', missing;
  end if;
  -- 方針の条件で、持ち主・取り込み係かを確かめる関数を、(select …) で囲まずに呼んでいる方針（読む行ごとに関数を呼ぶ）
  select string_agg(p.schemaname || '.' || p.tablename || ' の ' || p.policyname, ', ' order by p.schemaname, p.tablename, p.policyname) into missing
  from pg_policies p
  where p.schemaname in ('field', 'storage')
    and regexp_replace(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''), 'SELECT field\.is_(owner|importer)\(\)', '', 'g') ~ 'field\.is_(owner|importer)\(\)';
  if missing is not null then
    raise exception '方針の条件の field.is_owner() / field.is_importer() は (select …) で囲んでください（囲まないと行ごとに呼ぶ）: %', missing;
  end if;
end $$;

-- 農作業日記を、この画面で読み書きする関数（docs/actuals-plan.md の 11.1）。
-- 日記のテーブルは inoo_farm の diary スキーマにある（inoo_farm/sql/diary.sql）。先にそちらを実行してから、これを実行する。
-- 日記には、ほかの方の氏名や連絡先が入るので、diary スキーマは API に出さない。画面からは、ここにある関数だけを通す。
-- どの関数も security definer で、最初に field.is_owner() を確かめ、本人でなければ止める。
-- 何度実行してもよい。

-- その日の日記を保存する。
--   p_sections: 本文を見出しごとに分けた節 [{path: [...], body, images: [...]}]（画面の app/diary.js の splitSections が作る）
--   p_tags: 画面で直した作物と作業の種類。{"見出し > 小見出し": {crops, work}}。いまの節にない見出しの分は捨てる
--   p_expected: 画面が読んだときの updated_at。新しい日は null。DB の値と違えば、ほかの画面で書き換えられているので止める
-- 前の版を diary.day_history に残し、diary.days を書き、その日の diary.sections を作り直す。
-- 題も本文も空なら、その日を消す。どこからも使われなくなった写真の行を消し、その名前を返す（置き場のファイルは画面が消す）
create or replace function field.diary_save_day(p_date date, p_title text, p_body text, p_tags jsonb, p_sections jsonb, p_expected timestamptz)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  old diary.days;
  had boolean;
  v_tags jsonb;
  saved timestamptz := clock_timestamp();
  removed text[];
begin
  if not field.is_owner() then
    raise exception 'この利用者は日記を書けません。' using errcode = '42501';
  end if;
  select * into old from diary.days where entry_date = p_date for update;
  had := found;
  if (had and p_expected is distinct from old.updated_at) or (not had and p_expected is not null) then
    raise exception 'この日の日記は、ほかの画面で書き換えられています。読み込み直してから書いてください。' using errcode = '40001';
  end if;

  select coalesce(jsonb_object_agg(t.key, t.value), '{}') into v_tags
  from jsonb_each(coalesce(p_tags, '{}')) t
  where t.key in (
    select array_to_string(array(select jsonb_array_elements_text(s->'path')), ' > ')
    from jsonb_array_elements(p_sections) s
  );

  if had and (old.title, old.body, old.tags) is distinct from (p_title, p_body, v_tags) then
    insert into diary.day_history (entry_date, title, body, tags) values (p_date, old.title, old.body, old.tags);
  end if;

  delete from diary.sections where entry_date = p_date;
  if btrim(p_title) = '' and btrim(p_body) = '' then
    delete from diary.days where entry_date = p_date;
    saved := null;
  else
    insert into diary.days (entry_date, title, body, tags, updated_at)
    values (p_date, p_title, p_body, v_tags, saved)
    on conflict (entry_date) do update
      set title = excluded.title, body = excluded.body, tags = excluded.tags, updated_at = excluded.updated_at;

    insert into diary.sections (id, entry_date, day_title, path, crops, work, body, images)
    select
      to_char(p_date, 'YYYY-MM-DD') || '-' || lpad(n::text, 2, '0'),
      p_date,
      p_title,
      path,
      array(select jsonb_array_elements_text(chosen->'crops')),
      array(select jsonb_array_elements_text(chosen->'work')),
      body,
      images
    from (
      select
        n, path, body, images,
        coalesce(v_tags->array_to_string(path, ' > '), diary.section_tags(path, body)) as chosen
      from (
        select
          n,
          array(select jsonb_array_elements_text(s->'path')) as path,
          coalesce(s->>'body', '') as body,
          array(select jsonb_array_elements_text(coalesce(s->'images', '[]'))) as images
        from jsonb_array_elements(p_sections) with ordinality as e(s, n)
      ) raw
    ) tagged;
  end if;

  -- その日の写真で、どの日の本文にも、前の版にも出てこないもの
  with gone as (
    delete from diary.photos p
    where p.entry_date = p_date
      and not exists (select 1 from diary.days d where strpos(d.body, 'images/' || p.name) > 0)
      and not exists (select 1 from diary.day_history h where strpos(h.body, 'images/' || p.name) > 0)
    returning p.name
  )
  select coalesce(array_agg(name), '{}') into removed from gone;

  return jsonb_build_object('updated_at', saved, 'removed', to_jsonb(removed));
end;
$$;

-- 期間内の日記を、日付の順に返す。節ごとの作物と作業の種類と、写真の撮影日時・元のファイル名も付ける
create or replace function field.diary_get_days(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not field.is_owner() then
    raise exception 'この利用者は日記を読めません。' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'date', d.entry_date,
      'title', d.title,
      'body', d.body,
      'tags', d.tags,
      'updated_at', d.updated_at,
      'sections', (
        select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'path', to_jsonb(s.path), 'crops', to_jsonb(s.crops), 'work', to_jsonb(s.work)) order by s.id), '[]')
        from diary.sections s where s.entry_date = d.entry_date
      ),
      'photos', (
        select coalesce(jsonb_object_agg(p.name, jsonb_build_object('taken_at', p.taken_at, 'original_name', p.original_name, 'width', p.width, 'height', p.height)), '{}')
        from diary.photos p where p.entry_date = d.entry_date
      )
    ) order by d.entry_date), '[]')
    from diary.days d
    where d.entry_date between p_from and p_to
  );
end;
$$;

-- その日の写真の名前（本文で使っていないものも）。新しい写真の通し番号を決めるのに使う
create or replace function field.diary_photo_names(p_date date)
returns text[]
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not field.is_owner() then
    raise exception 'この利用者は日記を読めません。' using errcode = '42501';
  end if;
  return (select coalesce(array_agg(name order by name), '{}') from diary.photos where entry_date = p_date);
end;
$$;

-- 日記のある日と、その日の題、写真の枚数（カレンダーの印に使う）
create or replace function field.diary_calendar(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not field.is_owner() then
    raise exception 'この利用者は日記を読めません。' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'date', entry_date,
      'title', title,
      'photos', (length(body) - length(replace(body, '](images/', ''))) / length('](images/')
    ) order by entry_date), '[]')
    from diary.days
    where entry_date between p_from and p_to
  );
end;
$$;

-- 語をすべて含む日を、新しい日から返す（多くて 200 日）。全角・半角と大文字・小文字の違いは見ない。
-- 日本語は通常の全文検索では語に分けられないので、部分一致で探す。前後の文は画面が切り出す
create or replace function field.diary_search(p_words text[])
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not field.is_owner() then
    raise exception 'この利用者は日記を読めません。' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('date', entry_date, 'title', title, 'body', body) order by entry_date desc), '[]')
    from (
      select d.entry_date, d.title, d.body
      from diary.days d
      where not exists (
        select 1 from unnest(p_words) w
        where btrim(w) <> ''
          and strpos(lower(normalize(d.title || E'\n' || d.body, NFKC)), lower(normalize(btrim(w), NFKC))) = 0
      )
      order by d.entry_date desc
      limit 200
    ) hits
  );
end;
$$;

-- いちばん古い日記の日。日記がなければ null（カレンダーの年月のリストを、ここから始める）
create or replace function field.diary_first_date()
returns date
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not field.is_owner() then
    raise exception 'この利用者は日記を読めません。' using errcode = '42501';
  end if;
  return (select min(entry_date) from diary.days);
end;
$$;

-- 作物と作業の種類の名前の一覧（画面で種類を直すときの選択肢）
create or replace function field.diary_tag_names()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not field.is_owner() then
    raise exception 'この利用者は日記を読めません。' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'crops', (select coalesce(jsonb_agg(name order by sort), '[]') from diary.tag_words where kind = 'crops'),
    'work', (select coalesce(jsonb_agg(name order by sort), '[]') from diary.tag_words where kind = 'work')
  );
end;
$$;

-- 置き場に上げた写真を 1 枚記録する。撮影日時と元のファイル名は、取れなければ null
create or replace function field.diary_add_photo(p_name text, p_date date, p_taken_at timestamp, p_original_name text, p_width int, p_height int)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not field.is_owner() then
    raise exception 'この利用者は日記を書けません。' using errcode = '42501';
  end if;
  insert into diary.photos (name, entry_date, taken_at, original_name, width, height)
  values (p_name, p_date, p_taken_at, nullif(p_original_name, ''), p_width, p_height)
  on conflict (name) do update
    set entry_date = excluded.entry_date, taken_at = excluded.taken_at, original_name = excluded.original_name,
        width = excluded.width, height = excluded.height, uploaded_at = now();
end;
$$;

revoke all on function field.diary_save_day(date, text, text, jsonb, jsonb, timestamptz) from public, anon;
revoke all on function field.diary_get_days(date, date) from public, anon;
revoke all on function field.diary_photo_names(date) from public, anon;
revoke all on function field.diary_calendar(date, date) from public, anon;
revoke all on function field.diary_search(text[]) from public, anon;
revoke all on function field.diary_tag_names() from public, anon;
revoke all on function field.diary_first_date() from public, anon;
revoke all on function field.diary_add_photo(text, date, timestamp, text, int, int) from public, anon;
grant execute on function field.diary_save_day(date, text, text, jsonb, jsonb, timestamptz) to authenticated;
grant execute on function field.diary_get_days(date, date) to authenticated;
grant execute on function field.diary_photo_names(date) to authenticated;
grant execute on function field.diary_calendar(date, date) to authenticated;
grant execute on function field.diary_search(text[]) to authenticated;
grant execute on function field.diary_tag_names() to authenticated;
grant execute on function field.diary_first_date() to authenticated;
grant execute on function field.diary_add_photo(text, date, timestamp, text, int, int) to authenticated;

-- 日記の写真の置き場。非公開のまま、本人だけが上げて読めるようにする（公開キーでは一覧も取り出しもできない）
drop policy if exists diary_photos_owner_all on storage.objects;
create policy diary_photos_owner_all on storage.objects for all to authenticated
  using (bucket_id = 'diary-photos' and field.is_owner())
  with check (bucket_id = 'diary-photos' and field.is_owner());

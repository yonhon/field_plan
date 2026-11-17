// データの読み書き。通常は Supabase の field スキーマ。
// URL に ?local=1 を付けると、DB を使わずにこのブラウザーの中だけに保存する（動作確認用）。
// さらに &strict=1 を付けると、保存の遅れと外部キーを DB に近づける。
import { DEFAULT_WORK_TYPES } from "./schedule.js";
import { isBlockTarget } from "./logs.js";
import { uploadWithProgress } from "./upload.js";
import { pathKey, photoNames, pickLabels, renameTagKeys, renamedHeadings } from "./diary.js";

const BUCKET = "field-plan";
// 農作業日記の写真の置き場（inoo_farm と共用。非公開）
const DIARY_BUCKET = "diary-photos";
// DB を使わないモードの、タグの言葉の一覧（動作確認用の見本）。Claude のタグは、テストが diary.days の ai_tags に入れる
const LOCAL_TAG_NAMES = {
  crops: ["オクラ", "トマト", "大根"],
  work: ["定植・播種", "収穫", "防除"],
  place: ["露地", "ハウス"],
  issues: ["アブラムシ", "うどんこ病"],
  stage: ["発芽", "収穫期"],
  topic: ["講義・研修"],
};
// この画面の版。DB の field.app_compat の min_version より古ければ、起動のときに新しい版を読み込み直す。
// 古い画面では正しく書けない形に DB を変えるときに 1 つ上げ、DB の min_version も同じ値にする（sql/field.sql）
export const APP_VERSION = 3;
const LOCAL_KEY = "field_plan_local";

// 下絵の署名付き URL。発行のたびに URL が変わると、ブラウザーのキャッシュが効かず、起動のたびに画像全体を読み直す。
// そこで長めの期限で発行してブラウザーに覚え、残りが少なくなるまで使い回す。ログアウトで忘れる
const IMAGE_URLS_KEY = "field_plan_image_urls";
const IMAGE_URL_SECONDS = 7 * 24 * 60 * 60;
const IMAGE_URL_MARGIN_MS = 24 * 60 * 60 * 1000; // 開いたままでも期限が切れないよう、これより残りが少なければ発行し直す

function savedImageUrls() {
  try {
    return JSON.parse(localStorage.getItem(IMAGE_URLS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function forgetImageUrls() {
  try {
    localStorage.removeItem(IMAGE_URLS_KEY);
  } catch {
    // 消せなくても、URL は期限で切れる
  }
}

// プランの下にあるテーブル。どれも plan_id を持ち、list / upsert / remove で読み書きする。
// children は、親の行を消したときに一緒に消える行（DB では外部キーが消す。ローカルではここを見て消す）
const PLAN_TABLES = {
  zones: { order: "created_at", children: [["blocks", "zone_id"]] },
  blocks: { order: "created_at", children: [["beds", "block_id"], ["works", "block_id"]] },
  beds: { order: "seq", children: [["plantings", "bed_id"]] },
  plantings: { order: "seq", children: [["works", "planting_id"]] },
  works: { order: "seq", children: [] },
};

// strict のローカルの保存。ふつうのローカルの保存はすぐ終わり、行のつながりも確かめないので、保存の順序の誤りが出ない。
// 親の表ほど保存を遅くし（delay × STRICT_DELAY_MS）、親の保存を待たない書き方が必ず失敗するようにする。
// parents は [親の表, 親を指す列]。親のない行は、DB と同じ 23503 で断る
const STRICT_DELAY_MS = 100;
const STRICT_TABLES = {
  zones: { delay: 4, parents: [] },
  blocks: { delay: 3, parents: [["zones", "zone_id"]] },
  beds: { delay: 2, parents: [["blocks", "block_id"]] },
  plantings: { delay: 1, parents: [["beds", "bed_id"]] },
  works: { delay: 0, parents: [["blocks", "block_id"], ["plantings", "planting_id"]] },
};

// 起動、戻ってきたときの読み直し、圃場の切り替えで読む中身を、表ごとの読み込みを組み合わせて返す。
// DB の関数 field.load_field（sql/field.sql）と同じ形を返す。?local=1 の店と、DB の関数がないときに使う。
// 読む表、読む行の絞り方、並び順を変えるときは、load_field と両方を直す（tests/load-field.test.mjs が表の食い違いを確かめる）。
// 返すのは { unchanged, mark, minVersion, fieldId, planId, fields, workTypes, crops, fertilizers, plans, tables, logs, backdrop }。
// since が DB の変更の印（changeMark）と同じなら、{ unchanged: true, mark, minVersion } だけを返す
export function composeLoadField(store) {
  return async ({ fieldId = null, planId = null, since = null } = {}) => {
    // 印は中身より先に読む（読んでいるあいだに入った変更は、印が変わるので次に拾える）
    const mark = store.changeMark ? await store.changeMark().catch(() => null) : null;
    const minVersion = await store.minAppVersion();
    if (since !== null && mark !== null && mark === since) {
      return { unchanged: true, mark, minVersion };
    }
    const [fields, workTypes, crops, fertilizers] = await Promise.all([
      store.loadFields(),
      store.loadWorkTypes(),
      store.listAll("crops"),
      store.listAll("fertilizers"),
    ]);
    const field = fields.find((item) => item.id === fieldId) || fields[0] || null;
    const plans = field ? await store.loadPlans(field.id) : [];
    const plan = plans.find((item) => item.id === planId) || plans[0] || null;
    const names = Object.keys(PLAN_TABLES);
    const [tables, logs, backdrop] = await Promise.all([
      plan ? Promise.all(names.map((table) => store.list(table, plan.id))).then((rows) => Object.fromEntries(names.map((table, index) => [table, rows[index]]))) : null,
      field ? store.loadLogs(field.id) : [],
      field ? store.loadBackdrop(field.id) : null,
    ]);
    return { unchanged: false, mark, minVersion, fieldId: field?.id ?? null, planId: plan?.id ?? null, fields, workTypes, crops, fertilizers, plans, tables, logs, backdrop };
  };
}

// options: { url, anonKey }。画像を、進み具合を知らせながら上げるのに使う
export function createSupabaseStore(client, options) {
  const check = ({ data, error }) => {
    if (error) {
      throw error;
    }
    return data;
  };
  // Supabase は 1 回に 1,000 行までしか返さないので、それより多くなりうる表は分けて読む。
  // build は、毎回新しい問い合わせを作る関数（並びは、行が一意に決まるようにしておく）
  const PAGE = 1000;
  // 作業の記録を、読んだときも保存したときも同じ形にそろえる（キーは名前の順、資材は seq の順）。
  // 保存したときは DB の関数が返した 1 件を画面の記録と差し替えるので、読み直した記録と形が違うと、
  // 「元に戻す」や戻ってきたときの読み直しが、変わっていない記録を変わったとみなす
  const sortKeys = (row) => Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]]));
  const logShape = (row) =>
    sortKeys({ ...row, targets: row.targets.map(sortKeys), inputs: [...row.inputs].sort((a, b) => a.seq - b.seq).map(sortKeys) });
  const allRows = async (build) => {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const page = check(await build().range(from, from + PAGE - 1));
      rows.push(...page);
      if (page.length < PAGE) {
        return rows;
      }
    }
  };

  const store = {
    async loadFields() {
      return check(await client.from("fields").select("*").order("created_at"));
    },
    async createField(field) {
      return check(await client.from("fields").insert(field).select().single());
    },
    async saveField(field) {
      const { id, name, outline, note } = field;
      check(await client.from("fields").update({ name, outline, note, view_dirs: field.view_dirs ?? null }).eq("id", id));
    },
    async loadBackdrop(fieldId) {
      const rows = check(
        await client.from("backdrops").select("*").eq("field_id", fieldId).order("created_at", { ascending: false }).limit(1)
      );
      return rows[0] || null;
    },
    async saveBackdrop(backdrop) {
      check(await client.from("backdrops").upsert(backdrop));
    },
    // onProgress(送った量, 全体の量) で、進み具合を知らせる
    async uploadImage(fieldId, file, onProgress) {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${fieldId}/${crypto.randomUUID()}.${ext}`;
      const { data } = await client.auth.getSession();
      await uploadWithProgress({
        url: `${options.url}/storage/v1/object/${BUCKET}/${path}`,
        headers: {
          apikey: options.anonKey,
          authorization: `Bearer ${data.session?.access_token ?? options.anonKey}`,
          "content-type": file.type || "application/octet-stream",
          "x-upsert": "false",
        },
        body: file,
        onProgress,
      });
      return path;
    },
    // 圃場を消す。下絵・プランと、その中の区域・区画・畝・日程は DB の側で一緒に消える。
    // 開発日誌の記録は残る。下絵の画像は、消せなかったものの数を返す（圃場の削除は取り消さない）
    async deleteField(id) {
      const paths = check(await client.from("backdrops").select("storage_path").eq("field_id", id)).map((row) => row.storage_path);
      check(await client.from("fields").delete().eq("id", id));
      if (!paths.length) {
        return 0;
      }
      const { data, error } = await client.storage.from(BUCKET).remove(paths);
      return error ? paths.length : paths.length - (data?.length ?? 0);
    },
    async imageUrl(path) {
      const saved = savedImageUrls();
      const now = Date.now();
      if (saved[path]?.expires - now > IMAGE_URL_MARGIN_MS) {
        return saved[path].url;
      }
      const url = check(await client.storage.from(BUCKET).createSignedUrl(path, IMAGE_URL_SECONDS)).signedUrl;
      const live = Object.entries(saved).filter(([, item]) => item.expires > now);
      try {
        localStorage.setItem(IMAGE_URLS_KEY, JSON.stringify({ ...Object.fromEntries(live), [path]: { url, expires: now + IMAGE_URL_SECONDS * 1000 } }));
      } catch {
        // 覚えられなくても、次の起動で発行し直すだけ
      }
      return url;
    },
    async loadPlans(fieldId) {
      return check(await client.from("plans").select("*").eq("field_id", fieldId).order("created_at"));
    },
    async createPlan(plan) {
      return check(await client.from("plans").insert(plan).select().single());
    },
    // プランを、中身ごとコピーする。DB の関数が、プランを作り、区域・区画・畝・作付・作業を新しい ID で写す。作ったプランを返す。
    // 1 つのトランザクションなので、途中で失敗しても、作りかけのプランは残らない
    async copyPlan(id, name) {
      return check(await client.rpc("copy_plan", { p_source: id, p_name: name }));
    },
    async renamePlan(id, name) {
      check(await client.from("plans").update({ name }).eq("id", id));
    },
    // プランの下の行は DB の側で一緒に消える
    async deletePlan(id) {
      check(await client.from("plans").delete().eq("id", id));
    },
    async list(table, planId) {
      return allRows(() => client.from(table).select("*").eq("plan_id", planId).order(PLAN_TABLES[table].order).order("id"));
    },
    // 品目と肥料は、すべてのプランで共通
    async listAll(table) {
      return allRows(() => client.from(table).select("*").order("name").order("id"));
    },
    async upsert(table, rows) {
      if (rows.length) {
        check(await client.from(table).upsert(rows));
      }
    },
    async remove(table, ids) {
      if (ids.length) {
        check(await client.from(table).delete().in("id", ids));
      }
    },
    async loadWorkTypes() {
      return check(await client.from("work_types").select("*").order("sort"));
    },
    // この DB を使ってよい画面の版
    async minAppVersion() {
      return check(await client.from("app_compat").select("min_version").maybeSingle())?.min_version ?? 0;
    },
    // 変更の記録。開発日誌なので、すべての圃場の分を、新しい順に最近の 1,000 件
    // 変更の記録を、新しい順に。fromDay 以降、beforeDay より前に絞れる（どちらも YYYY-MM-DD）。
    // limit を渡すと、その件数まで（日の新しい順）。渡さなければ、当てはまるものをすべて
    async listChanges({ fromDay = null, beforeDay = null, limit = null } = {}) {
      const build = () => {
        let query = client.from("changes").select("*");
        if (fromDay) {
          query = query.gte("day", fromDay);
        }
        if (beforeDay) {
          query = query.lt("day", beforeDay);
        }
        return query.order("day", { ascending: false }).order("no", { ascending: false });
      };
      return limit ? check(await build().limit(limit)) : allRows(build);
    },
    // 番号の記録の日。なければ null
    async changeDay(no) {
      return check(await client.from("changes").select("day").eq("no", no).maybeSingle())?.day ?? null;
    },
    // プランごとの最後の変更の時刻 [{ plan_id, last_at }]
    async planLastChanges() {
      return check(await client.rpc("plan_last_changes"));
    },
    // DB の変更の印（操作の記録 field.audit_log の最後の番号）。戻ってきたときの読み直しの前に、変わったかを確かめる。
    // 同じ印なら、そのあいだに、読み直す表はどれも変わっていない
    async changeMark() {
      return check(await client.rpc("audit_last"));
    },
    // 記録を足す。番号は DB が振るので、それを返す
    async addChange(entry) {
      const { no, ...row } = entry;
      return check(await client.from("changes").insert(row).select("no").single()).no;
    },
    async saveChange(entry) {
      check(await client.from("changes").upsert(entry));
    },
    // 開発日誌のメモ。すべての圃場で共通
    async listNotes() {
      return check(await client.from("dev_notes").select("day, body"));
    },
    async saveNote({ day, body }) {
      check(await client.from("dev_notes").upsert({ day, body, updated_at: new Date().toISOString() }));
    },
    async saveWorkType(type) {
      check(await client.from("work_types").upsert(type));
    },
    // 実際に使うプラン。空（null）にもできる
    async setActivePlan(fieldId, planId) {
      check(await client.from("fields").update({ active_plan_id: planId }).eq("id", fieldId));
    },
    // 作業の記録。圃場ごとに、対象と資材を付けて、新しい順に
    async loadLogs(fieldId) {
      const rows = await allRows(() =>
        client
          .from("work_logs")
          .select("*, targets:work_log_targets(*), inputs:work_log_inputs(*)")
          .eq("field_id", fieldId)
          .order("date", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id")
      );
      return rows.map(logShape);
    },
    // 記録を 1 件、対象と資材ごと保存する（DB の関数が 1 つのトランザクションで置き換える）。
    // 保存した記録を、loadLogs の 1 件と同じ形で返す（DB の関数が古く、ID だけを返したときは ID）
    async saveLog({ targets, inputs, ...log }) {
      const saved = check(await client.rpc("save_work_log", { log, targets, inputs }));
      return saved && typeof saved === "object" ? logShape(saved) : saved;
    },
    async deleteLog(id) {
      check(await client.from("work_logs").delete().eq("id", id));
    },
    // 1 回の操作（DB の変更の記録の op_id）で変わった行を、操作の前に戻す（DB の関数 field.undo_op）。
    // 返すのは { status: "done", op_id, rows } か { status: "empty" } か { status: "conflict", rows }
    async undoOp(opId) {
      return check(await client.rpc("undo_op", { p_op: opId }));
    },
    // ---- 農薬の使用基準（FAMIC）。DB を使わないモードでは使えない ----
    famic: true,
    // 農薬を名前（カタカナにそろえた文字の一部）か登録番号で探す。有効成分ごとの行を返す
    async searchPesticides(query) {
      const base = client.from("famic_products").select("reg_no, ord, name, kind, holder, use_type, formulation, ingredient, count_ingredient");
      const rows = /^\d+$/.test(query)
        ? check(await base.eq("reg_no", Number(query)))
        : check(await base.ilike("name_search", `%${query.replace(/[%_]/g, "")}%`).order("reg_no").limit(300));
      return rows;
    },
    async loadProducts(regNos) {
      return regNos.length ? check(await client.from("famic_products").select("*").in("reg_no", regNos.map(Number)).order("ord")) : [];
    },
    // 農薬 1 つの使用基準を、すべての作物名の分読む（多いもので 700 行ほど。1 回に 1,000 行までなので、分けて読む）
    async loadUses(regNo) {
      return allRows(() => client.from("famic_uses").select("*").eq("reg_no", Number(regNo)).order("id"));
    },
    async famicVersion() {
      const rows = check(await client.from("famic_imports").select("*").order("id", { ascending: false }).limit(1));
      return rows[0] || null;
    },
    // 農薬の作用機構分類（RAC コード）。有効成分ごとの行（500 行あまり）
    async loadRacCodes() {
      return allRows(() => client.from("rac_codes").select("ingredient, committee, code").order("ingredient").order("committee"));
    },
    // ---- 気象 ----
    async saveFieldWeather(fieldId, { base_lat, base_lng, weather }) {
      check(await client.from("fields").update({ base_lat, base_lng, weather }).eq("id", fieldId));
    },
    async loadWeather(stations, from, to) {
      return stations.length
        ? allRows(() => client.from("weather_daily").select("*").in("station", stations).gte("date", from).lte("date", to).order("date").order("station"))
        : [];
    },
    async saveWeather(rows) {
      if (rows.length) {
        check(await client.from("weather_daily").upsert(rows));
      }
    },
    // ---- ニュース（県のページの記事。scripts/fetch-news.mjs が足す） ----
    async loadNews() {
      return allRows(() => client.from("news").select("*").order("first_seen", { ascending: false }).order("key"));
    },
    async markNews(keys, readAt) {
      if (keys.length) {
        check(await client.from("news").update({ read_at: readAt }).in("key", keys));
      }
    },
    // 2 週間気温予報。ブラウザーから気象庁を読めないので、Supabase の関数を通す
    async twoWeek(station) {
      const { data, error } = await client.functions.invoke("field-weather", { body: { station } });
      if (error) {
        throw error;
      }
      return data;
    },
    async twoWeekStations() {
      const { data, error } = await client.functions.invoke("field-weather", { body: { list: true } });
      if (error) {
        throw error;
      }
      return data.stations || [];
    },
    // Google フォトで選んだ写真。ブラウザーから直接読めないときに、Supabase の関数を通して読む（app/google-photos.js）
    async googlePhoto(url, token) {
      const { data, error } = await client.functions.invoke("field-photos", { body: { url, token } });
      if (error) {
        throw error;
      }
      if (!(data instanceof Blob)) {
        throw new Error("写真の中身を受け取れませんでした");
      }
      return data;
    },
    // ---- 農作業日記。diary スキーマは API に出していないので、field の関数（sql/diary.sql）を通す ----
    async diaryDays(from, to) {
      return check(await client.rpc("diary_get_days", { p_from: from, p_to: to }));
    },
    async diaryCalendar(from, to) {
      return check(await client.rpc("diary_calendar", { p_from: from, p_to: to }));
    },
    async diarySearch(words) {
      return check(await client.rpc("diary_search", { p_words: words }));
    },
    async diaryTagNames() {
      return check(await client.rpc("diary_tag_names"));
    },
    // 対象（作付か区画）に付いた日記の節。ids は作付か区画の ID の並び
    async diaryTargetSections(ids) {
      return check(await client.rpc("diary_target_sections", { p_ids: ids }));
    },
    // 対象（作付か区画）の作業の記録と、まだ終わっていない計画。返り値は { logs, works }（sql/diary.sql の diary_target_works）
    async diaryTargetWorks(kind, id) {
      return check(await client.rpc("diary_target_works", { p_kind: kind, p_id: id }));
    },
    // タグの条件（filters: [{kind, name}] か [{kind: "targets", id}]）にすべて合う節。返り値は { total, sections, photos }
    async diaryTagSections({ filters, oldest, limit, offset }) {
      return check(await client.rpc("diary_tag_sections", { p_filters: filters, p_oldest: oldest, p_limit: limit, p_offset: offset }));
    },
    // いちばん古い日記の日（YYYY-MM-DD）。日記がなければ null
    async diaryFirstDate() {
      return check(await client.rpc("diary_first_date"));
    },
    async diaryPhotoNames(date) {
      return check(await client.rpc("diary_photo_names", { p_date: date }));
    },
    // その日を保存する。返り値は { updated_at, removed }。removed は、どこからも使われなくなった写真の名前
    async diarySaveDay({ date, title, body, tags, sections, expected }) {
      return check(
        await client.rpc("diary_save_day", { p_date: date, p_title: title, p_body: body, p_tags: tags, p_sections: sections, p_expected: expected ?? null })
      );
    },
    // 同じ名前の写真がもうあれば、code: "exists" の誤りにする（呼ぶ側が次の番号で上げ直す）
    async diaryUploadPhoto(path, blob) {
      const { error } = await client.storage.from(DIARY_BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (error) {
        throw /exist|duplicate/i.test(error.message) || String(error.statusCode) === "409" ? Object.assign(new Error(error.message), { code: "exists" }) : error;
      }
    },
    async diaryAddPhoto({ name, date, takenAt, originalName, width, height }) {
      check(
        await client.rpc("diary_add_photo", {
          p_name: name,
          p_date: date,
          p_taken_at: takenAt,
          p_original_name: originalName,
          p_width: width,
          p_height: height,
        })
      );
    },
    async diaryRemovePhotos(paths) {
      if (paths.length) {
        const { error } = await client.storage.from(DIARY_BUCKET).remove(paths);
        if (error) {
          throw error;
        }
      }
    },
    // 写真の署名付き URL を { 置き場の中の場所: URL } で返す。下絵と同じく、長めの期限で発行してブラウザーに覚える
    async diaryPhotoUrls(paths) {
      const saved = savedImageUrls();
      const now = Date.now();
      const key = (path) => `${DIARY_BUCKET}/${path}`;
      const urls = {};
      const missing = [];
      for (const path of paths) {
        if (saved[key(path)]?.expires - now > IMAGE_URL_MARGIN_MS) {
          urls[path] = saved[key(path)].url;
        } else {
          missing.push(path);
        }
      }
      if (!missing.length) {
        return urls;
      }
      const signed = check(await client.storage.from(DIARY_BUCKET).createSignedUrls(missing, IMAGE_URL_SECONDS));
      const fresh = {};
      for (const item of signed) {
        if (item.signedUrl && !item.error) {
          urls[item.path] = item.signedUrl;
          fresh[key(item.path)] = { url: item.signedUrl, expires: now + IMAGE_URL_SECONDS * 1000 };
        }
      }
      const live = Object.entries(saved).filter(([, item]) => item.expires > now);
      try {
        localStorage.setItem(IMAGE_URLS_KEY, JSON.stringify({ ...Object.fromEntries(live), ...fresh }));
      } catch {
        // 覚えられなくても、次に開いたときに発行し直すだけ
      }
      return urls;
    },
  };
  // 起動、戻ってきたときの読み直し、圃場の切り替えで読む中身を、1 回の要求で読む（DB の関数 field.load_field）。
  // 形は composeLoadField と同じ。DB の関数がないとき（古い DB）は、表ごとに読む
  const composed = composeLoadField(store);
  store.loadField = async ({ fieldId = null, planId = null, since = null } = {}) => {
    const { data, error } = await client.rpc("load_field", { p_field_id: fieldId, p_plan_id: planId, p_since: since });
    if (error) {
      if (error.code === "PGRST202" || error.code === "42883") {
        return composed({ fieldId, planId, since });
      }
      throw error;
    }
    if (data.unchanged) {
      return { unchanged: true, mark: data.mark, minVersion: data.min_version };
    }
    return {
      unchanged: false,
      mark: data.mark,
      minVersion: data.min_version,
      fieldId: data.field_id,
      planId: data.plan_id,
      fields: data.fields,
      workTypes: data.work_types,
      crops: data.crops,
      fertilizers: data.fertilizers,
      plans: data.plans,
      tables: data.tables,
      logs: data.logs.map(logShape),
      backdrop: data.backdrop,
    };
  };
  return store;
}

// 利用者の 1 回の操作の ID。書き込みに付けて送り、DB の変更の記録（field.audit_log の op_id）に残す。
// 押す、キーを打つ、の始まりで新しくする
let operation = crypto.randomUUID();
let sending = null; // いま送っている書き込みの操作の ID

export const currentOperation = () => operation;

export function startOperation() {
  operation = crypto.randomUUID();
}

// call の中で呼んだ書き込みを、id の操作のものとして送る。あとから送る保存（queueSave）に使う
export function duringOperation(id, call) {
  const now = operation;
  operation = id;
  try {
    return call();
  } finally {
    operation = now;
  }
}

// Supabase の fetch。書き込みに操作の ID を付ける。読み取りと認証には付けない
export function fetchWithOperation(url, options = {}) {
  if (!sending || !String(url).includes("/rest/v1/") || (options.method || "GET") === "GET") {
    return fetch(url, options);
  }
  const headers = new Headers(options.headers);
  headers.set("x-op-id", sending);
  return fetch(url, { ...options, headers });
}

const QUEUED_WRITES = [
  "upsert", "remove", "saveField", "saveBackdrop", "saveLog", "deleteLog", "saveWorkType", "saveFieldWeather", "markNews",
  "createField", "deleteField", "createPlan", "copyPlan", "renamePlan", "deletePlan", "setActivePlan",
  "diarySaveDay", "diaryAddPhoto", "undoOp",
];

// 書き込みを列に入れたときに知らせる相手。(書き込みの名前, 操作の ID) で呼ぶ。
// 元に戻すの履歴（history.js）が、どの操作で何を書いたかを覚えるのに使う
const writeListeners = new Set();
export function onQueuedWrite(listener) {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

// 書き込みを、呼んだ順に 1 つずつ送る。同時に送ると、親の行より先に子の行が届いて断られることがある。
// 前の書き込みが失敗しても、次の書き込みは送る。writing は、送り終えていない書き込みがあるあいだ true。
// 操作の ID は、呼んだ時点のものを使う。1 つずつ送るので、送っているあいだ sending で分かる
export function inOrder(store) {
  let last = Promise.resolve();
  let active = 0;
  let failures = 0; // 失敗した書き込みの数。戻ってきたときの読み直しが、失敗のあとは必ず DB と比べるのに使う
  const queued = (write, name) => (...args) => {
    const id = operation;
    writeListeners.forEach((listener) => listener(name, id));
    active += 1;
    const result = last
      .then(() => {
        sending = id;
        return write(...args);
      })
      .finally(() => {
        sending = null;
        active -= 1;
      });
    last = result.catch(() => {
      failures += 1;
    });
    return result;
  };
  const writes = QUEUED_WRITES.filter((name) => store[name]).map((name) => [name, queued(store[name], name)]);
  return { ...store, ...Object.fromEntries(writes), writing: () => active > 0, failures: () => failures };
}

export function createLocalStore({ strict = false } = {}) {
  const store = createLocalTables({ strict });
  store.loadField = composeLoadField(store);
  return store;
}

function createLocalTables({ strict = false } = {}) {
  const read = () => JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
  const write = (data) => localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
  const update = (change) => {
    const data = read();
    change(data);
    write(data);
  };
  const strictWrite = async (table, rows) => {
    const rules = STRICT_TABLES[table];
    if (!strict || !rules || !rows.length) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, rules.delay * STRICT_DELAY_MS));
    const data = read();
    for (const [parent, column] of rules.parents) {
      const known = new Set((data[parent] || []).map((row) => row.id));
      if (rows.some((row) => row[column] && !known.has(row[column]))) {
        throw Object.assign(new Error(`${table} の ${column} が指す行が ${parent} にありません（外部キー違反）`), { code: "23503" });
      }
    }
  };
  // 圃場を 1 つしか持てなかったころの形を、圃場ごとの形に直す
  update((data) => {
    if (data.field) {
      data.fields = [data.field];
      if (data.backdrop) {
        data.backdrops = { [data.field.id]: { ...data.backdrop, storage_path: `local:${data.field.id}` } };
      }
      if (data.image) {
        data.images = { [data.field.id]: data.image };
      }
      delete data.field;
      delete data.backdrop;
      delete data.image;
    }
  });
  // 変更の記録。DB の field.audit_log の代わりに、変える前の行を、操作の ID と一緒に残す（undoOp が使う）
  const audit = (data, table, id, before, op = sending) => {
    data.audit = data.audit || [];
    const seq = (data.audit.at(-1)?.seq || 0) + 1;
    data.audit.push({ seq, op, table, id, before: before ? structuredClone(before) : null });
  };
  const removeRows = (data, table, ids) => {
    if (!ids.length) {
      return;
    }
    data[table] = (data[table] || []).filter((row) => !ids.includes(row.id));
    for (const [child, key] of PLAN_TABLES[table]?.children || []) {
      removeRows(data, child, (data[child] || []).filter((row) => ids.includes(row[key])).map((row) => row.id));
    }
  };

  return withTestControl({
    async loadFields() {
      return read().fields || [];
    },
    async createField(field) {
      const created = { id: crypto.randomUUID(), outline: [], note: "", created_at: new Date().toISOString(), ...field };
      update((data) => {
        data.fields = [...(data.fields || []), created];
      });
      return created;
    },
    async saveField(field) {
      update((data) => {
        data.fields = data.fields.map((item) => (item.id === field.id ? field : item));
      });
    },
    async loadBackdrop(fieldId) {
      return read().backdrops?.[fieldId] || null;
    },
    async deleteField(id) {
      update((data) => {
        const plans = (data.plans || []).filter((plan) => plan.field_id === id).map((plan) => plan.id);
        data.fields = data.fields.filter((field) => field.id !== id);
        data.plans = (data.plans || []).filter((plan) => plan.field_id !== id);
        data.workLogs = (data.workLogs || []).filter((log) => log.field_id !== id);
        for (const table of Object.keys(PLAN_TABLES)) {
          data[table] = (data[table] || []).filter((row) => !plans.includes(row.plan_id));
        }
        delete data.backdrops?.[id];
        delete data.images?.[id];
      });
      return 0;
    },
    async saveBackdrop(backdrop) {
      update((data) => {
        data.backdrops = { ...data.backdrops, [backdrop.field_id]: backdrop };
      });
    },
    async uploadImage(fieldId, file) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      update((data) => {
        data.images = { ...data.images, [fieldId]: dataUrl };
      });
      return `local:${fieldId}`;
    },
    async imageUrl(path) {
      return read().images?.[path.slice("local:".length)] || "";
    },
    async loadPlans(fieldId) {
      return (read().plans || []).filter((plan) => plan.field_id === fieldId);
    },
    // DB の関数（field.copy_plan）と同じに、1 回の書き込みで写す（途中で失敗したら、何も残らない）
    async copyPlan(id, name) {
      const data = read();
      const source = data.plans.find((plan) => plan.id === id);
      if (!source) {
        throw new Error("コピーするプランが見つかりません");
      }
      const copy = { id: crypto.randomUUID(), field_id: source.field_id, name };
      // 行ごとに新しい ID を振り、親を指す列は新しい ID に付け替える
      const ids = new Map();
      const fresh = (old) => ids.get(old) ?? ids.set(old, crypto.randomUUID()).get(old);
      const parents = { zones: [], blocks: ["zone_id"], beds: ["block_id"], plantings: ["bed_id"], works: ["block_id", "planting_id"] };
      data.plans = [...data.plans, copy];
      for (const [table, keys] of Object.entries(parents)) {
        const rows = (data[table] || []).filter((row) => row.plan_id === id).map((row) => {
          const item = { ...row, id: fresh(row.id), plan_id: copy.id };
          keys.forEach((key) => {
            item[key] = row[key] ? fresh(row[key]) : null;
          });
          return item;
        });
        data[table] = [...(data[table] || []), ...rows];
      }
      write(data);
      return copy;
    },
    async createPlan(plan) {
      const created = { id: crypto.randomUUID(), ...plan };
      update((data) => {
        data.plans = [...(data.plans || []), created];
      });
      return created;
    },
    async renamePlan(id, name) {
      update((data) => {
        data.plans.find((plan) => plan.id === id).name = name;
      });
    },
    async deletePlan(id) {
      update((data) => {
        data.plans = data.plans.filter((plan) => plan.id !== id);
        for (const table of Object.keys(PLAN_TABLES)) {
          data[table] = (data[table] || []).filter((row) => row.plan_id !== id);
        }
      });
    },
    async list(table, planId) {
      const order = PLAN_TABLES[table].order;
      return (read()[table] || [])
        .filter((row) => row.plan_id === planId)
        .sort((a, b) => (a[order] < b[order] ? -1 : a[order] > b[order] ? 1 : 0));
    },
    async upsert(table, rows) {
      await strictWrite(table, rows);
      const ids = rows.map((row) => row.id);
      update((data) => {
        const kept = (data[table] || []).map((row) => (ids.includes(row.id) ? rows.find((item) => item.id === row.id) : row));
        const known = kept.map((row) => row.id);
        data[table] = [...kept, ...rows.filter((row) => !known.includes(row.id))];
      });
    },
    async listAll(table) {
      return (read()[table] || []).sort((a, b) => a.name.localeCompare(b.name, "ja"));
    },
    async remove(table, ids) {
      update((data) => removeRows(data, table, ids));
    },
    async minAppVersion() {
      return read().app_compat?.min_version ?? 0;
    },
    async loadWorkTypes() {
      // 前に保存した種類に、あとから増えた種類（記録だけに使う種類など）を足す
      const saved = read().workTypes || [];
      const known = new Set(saved.map((type) => type.code));
      return [...saved, ...DEFAULT_WORK_TYPES.filter((type) => !known.has(type.code)).map((type) => ({ ...type }))].sort(
        (a, b) => a.sort - b.sort
      );
    },
    async listChanges({ fromDay = null, beforeDay = null, limit = null } = {}) {
      const rows = (read().changes || [])
        .filter((item) => (!fromDay || item.day >= fromDay) && (!beforeDay || item.day < beforeDay))
        .sort((a, b) => b.day.localeCompare(a.day) || b.no - a.no);
      return limit ? rows.slice(0, limit) : rows;
    },
    async changeDay(no) {
      return (read().changes || []).find((item) => item.no === no)?.day ?? null;
    },
    // DB の変更の印の代わり。ブラウザーの保存のうち、DB で操作の記録（audit_log）の対象になる表の中身から作る
    // （中身が変われば、印も変わる。変更の履歴やニュースなど、対象でない表の書き込みでは変わらない。本番と同じ）
    async changeMark() {
      const data = read();
      const text = JSON.stringify(AUDITED_LOCAL.map((key) => data[key] ?? null));
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
      }
      return `${text.length}:${hash >>> 0}`;
    },
    async planLastChanges() {
      const last = new Map();
      for (const item of read().changes || []) {
        if (item.plan_id && (!last.has(item.plan_id) || item.last_at > last.get(item.plan_id))) {
          last.set(item.plan_id, item.last_at);
        }
      }
      return [...last].map(([plan_id, last_at]) => ({ plan_id, last_at }));
    },
    async addChange(entry) {
      let no = 0;
      update((data) => {
        no = Math.max(0, ...(data.changes || []).map((item) => item.no)) + 1;
        data.changes = [...(data.changes || []), { ...entry, no }];
      });
      return no;
    },
    async saveChange(entry) {
      update((data) => {
        data.changes = (data.changes || []).map((item) => (item.id === entry.id ? entry : item));
      });
    },
    async listNotes() {
      return read().notes || [];
    },
    async saveNote(note) {
      update((data) => {
        data.notes = [...(data.notes || []).filter((item) => item.day !== note.day), note];
      });
    },
    async saveWorkType(type) {
      update((data) => {
        const types = data.workTypes || DEFAULT_WORK_TYPES.map((item) => ({ ...item }));
        data.workTypes = types.some((item) => item.code === type.code)
          ? types.map((item) => (item.code === type.code ? type : item))
          : [...types, type];
      });
    },
    async setActivePlan(fieldId, planId) {
      update((data) => {
        data.fields.find((field) => field.id === fieldId).active_plan_id = planId;
      });
    },
    async loadLogs(fieldId) {
      return (read().workLogs || [])
        .filter((log) => log.field_id === fieldId)
        .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
    },
    // 保存した記録を、loadLogs の 1 件と同じ形で返す
    async saveLog({ targets, inputs, ...log }) {
      const id = log.id || crypto.randomUUID();
      let result;
      update((data) => {
        const old = (data.workLogs || []).find((item) => item.id === id);
        audit(data, "workLogs", id, old);
        const saved = {
          created_at: old?.created_at || new Date().toISOString(),
          ...log,
          id,
          targets: targets.map((target) => ({ ...target, id: target.id || crypto.randomUUID(), log_id: id })),
          inputs: inputs.map((input) => ({ ...input, id: input.id || crypto.randomUUID(), log_id: id })),
        };
        data.workLogs = [...(data.workLogs || []).filter((item) => item.id !== id), saved];
        result = structuredClone(saved);
      });
      return result;
    },
    async deleteLog(id) {
      update((data) => {
        audit(data, "workLogs", id, (data.workLogs || []).find((log) => log.id === id));
        data.workLogs = (data.workLogs || []).filter((log) => log.id !== id);
      });
    },
    // DB の field.undo_op と同じ戻し方を、このブラウザーの保存の、変更の記録（data.audit）で行う。
    // 記録を付けているのは、作業の記録（対象と資材ごと 1 件）だけ
    async undoOp(opId) {
      let result;
      update((data) => {
        const log = data.audit || [];
        const rows = new Map();
        for (const entry of log.filter((item) => item.op === opId)) {
          const key = `${entry.table}:${entry.id}`;
          rows.set(key, { ...entry, before: rows.has(key) ? rows.get(key).before : entry.before, last: entry.seq });
        }
        if (!rows.size) {
          result = { status: "empty" };
          return;
        }
        const conflicts = [...rows.values()].filter((row) => log.some((item) => item.table === row.table && item.id === row.id && item.seq > row.last));
        if (conflicts.length) {
          result = { status: "conflict", rows: conflicts.map((row) => ({ table: row.table, row_id: row.id })) };
          return;
        }
        const undoId = sending && sending !== opId ? sending : crypto.randomUUID();
        for (const row of rows.values()) {
          const list = data[row.table] || [];
          audit(data, row.table, row.id, list.find((item) => item.id === row.id), undoId);
          data[row.table] = [...list.filter((item) => item.id !== row.id), ...(row.before ? [structuredClone(row.before)] : [])];
        }
        result = { status: "done", op_id: undoId, rows: rows.size };
      });
      return result;
    },
    // 農薬の使用基準は DB にある。動作確認のため、このブラウザーの保存に famic: { products, uses } を入れたときだけ、それを使う
    get famic() {
      return Boolean(read().famic);
    },
    async searchPesticides(query) {
      const { products = [] } = read().famic || {};
      return /^\d+$/.test(query) ? products.filter((row) => row.reg_no === Number(query)) : products.filter((row) => row.name_search.includes(query));
    },
    async loadProducts(regNos) {
      const { products = [] } = read().famic || {};
      return products.filter((row) => regNos.map(Number).includes(row.reg_no));
    },
    async loadUses(regNo) {
      const { uses = [] } = read().famic || {};
      return uses.filter((row) => row.reg_no === Number(regNo));
    },
    async loadRacCodes() {
      const { rac = [] } = read().famic || {};
      return rac;
    },
    async saveFieldWeather(fieldId, { base_lat, base_lng, weather }) {
      update((data) => {
        Object.assign(data.fields.find((field) => field.id === fieldId), { base_lat, base_lng, weather });
      });
    },
    async loadWeather(stations, from, to) {
      return (read().weather || []).filter((row) => stations.includes(row.station) && row.date >= from && row.date <= to).sort((a, b) => a.date.localeCompare(b.date));
    },
    async saveWeather(rows) {
      update((data) => {
        const key = (row) => `${row.station}|${row.date}`;
        const fresh = new Set(rows.map(key));
        data.weather = [...(data.weather || []).filter((row) => !fresh.has(key(row))), ...rows];
      });
    },
    async loadNews() {
      return (read().news || []).map((item) => ({ ...item }));
    },
    async markNews(keys, readAt) {
      update((data) => {
        for (const item of data.news || []) {
          if (keys.includes(item.key)) {
            item.read_at = readAt;
          }
        }
      });
    },
    async twoWeek() {
      return { days: [] };
    },
    async twoWeekStations() {
      return [];
    },
    // 動作確認では、関数を通さずに読む（テストは、読み先を手元に差し替える）
    async googlePhoto(url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`写真を読めませんでした（${response.status}）`);
      }
      return response.blob();
    },
    // ---- 農作業日記。DB の関数（sql/diary.sql）と同じ動きを、このブラウザーの保存で行う ----
    // data.diary = { days: { 日付: 日 }, photos: { 名前: 写真 }, files: { 場所: data URL }, history: [...], sections: { 日付: [...] } }
    async diaryDays(from, to) {
      const diary = read().diary || {};
      return Object.values(diary.days || {})
        .filter((day) => day.date >= from && day.date <= to)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((day) => ({
          ...day,
          sections: diary.sections?.[day.date] || [],
          photos: Object.fromEntries(Object.values(diary.photos || {}).filter((photo) => photo.date === day.date).map((photo) => [photo.name, photo])),
        }));
    },
    async diaryCalendar(from, to) {
      return Object.values(read().diary?.days || {})
        .filter((day) => day.date >= from && day.date <= to)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((day) => ({ date: day.date, title: day.title, photos: photoNames(day.body).length }));
    },
    async diarySearch(words) {
      const fold = (text) => text.normalize("NFKC").toLowerCase();
      return Object.values(read().diary?.days || {})
        .filter((day) => words.every((word) => fold(`${day.title}\n${day.body}`).includes(fold(word.trim()))))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 200)
        .map(({ date, title, body }) => ({ date, title, body }));
    },
    async diaryTagNames() {
      return structuredClone(LOCAL_TAG_NAMES);
    },
    async diaryTargetWorks(kind, id) {
      const data = read();
      const blockOf = new Map((data.beds || []).map((bed) => [bed.id, bed.block_id]));
      const plantings = kind === "block" ? (data.plantings || []).filter((planting) => blockOf.get(planting.bed_id) === id).map((planting) => planting.id) : [id];
      const blocks = kind === "block" ? [id] : (data.plantings || []).filter((planting) => planting.id === id).map((planting) => blockOf.get(planting.bed_id));
      const hits = (target) => plantings.includes(target.planting_id) || (isBlockTarget(target) && blocks.includes(target.block_id));
      const allLogs = data.workLogs || [];
      const done = new Set(allLogs.filter((log) => log.finishes).flatMap((log) => (log.targets || []).map((target) => target.work_id)).filter(Boolean));
      const logs = allLogs
        .filter((log) => (log.targets || []).some(hits))
        .sort((a, b) => a.date.localeCompare(b.date) || String(a.created_at).localeCompare(String(b.created_at)))
        .map(({ id: logId, field_id, date, end_date, work_type, finishes, spec, note, targets, inputs }) => ({
          id: logId, field_id, date, end_date, work_type, finishes, spec, note,
          block_work: !(targets || []).some((target) => plantings.includes(target.planting_id)),
          inputs: inputs || [],
        }));
      const works = (data.works || [])
        .filter((work) => !work.cancelled_on && !done.has(work.id) && (plantings.includes(work.planting_id) || (!work.planting_id && blocks.includes(work.block_id))))
        .sort((a, b) => String(a.plan_start || "9").localeCompare(String(b.plan_start || "9")) || a.seq - b.seq)
        .map(({ id: workId, work_type, plan_start, plan_end, note, detail, planting_id }) => ({ id: workId, work_type, plan_start, plan_end, note, detail, block_work: !planting_id }));
      return { logs, works };
    },
    async diaryTagSections({ filters, oldest, limit, offset }) {
      const diary = read().diary || {};
      const data = read();
      // 区画を指す対象で絞ったときは、区画の中の作付に付いた節も含める（DB の diary_tag_sections と同じ）
      const blockOf = new Map((data.plantings || []).map((planting) => [planting.id, (data.beds || []).find((bed) => bed.id === planting.bed_id)?.block_id]));
      const fits = (section) =>
        filters.every((filter) =>
          filter.kind === "targets"
            ? (section.labels?.targets || []).some((item) => item.id === filter.id || (filter.target_kind === "block" && blockOf.get(item.id) === filter.id))
            : (section.labels?.[filter.kind] || []).includes(filter.name)
        );
      const hits = Object.entries(diary.sections || {})
        .flatMap(([date, sections]) => sections.filter(fits).map((section) => ({ ...section, date, title: diary.days?.[date]?.title || "" })))
        .sort((a, b) => (oldest ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)) || a.id.localeCompare(b.id));
      const page = hits
        .slice(offset, offset + limit)
        .map(({ id, date, title, path, labels, tag_source }) => {
          const day = diary.days?.[date] || {};
          return { id, date, title, path, day_body: day.body || "", day_tags: day.tags || {}, updated_at: day.updated_at, labels, tag_source };
        });
      const names = new Set(page.flatMap((section) => photoNames(section.day_body)));
      const photos = Object.fromEntries(Object.values(diary.photos || {}).filter((photo) => names.has(photo.name)).map((photo) => [photo.name, photo]));
      return { total: hits.length, sections: page, photos };
    },
    async diaryTargetSections(ids) {
      const diary = read().diary || {};
      return Object.entries(diary.sections || {})
        .flatMap(([date, sections]) =>
          sections
            .filter((section) => (section.labels?.targets || []).some((item) => ids.includes(item.id)))
            .map((section) => ({ id: section.id, date, title: diary.days?.[date]?.title || "", heading: section.path.join(" > "), body: section.body || "" }))
        )
        .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    },
    async diaryFirstDate() {
      return Object.keys(read().diary?.days || {}).sort()[0] || null;
    },
    async diaryPhotoNames(date) {
      return Object.values(read().diary?.photos || {}).filter((photo) => photo.date === date).map((photo) => photo.name).sort();
    },
    async diarySaveDay({ date, title, body, tags, sections, expected }) {
      let result = null;
      update((data) => {
        const diary = (data.diary ||= {});
        diary.days ||= {};
        diary.sections ||= {};
        diary.history ||= [];
        diary.photos ||= {};
        const old = diary.days[date];
        if ((old && expected !== old.updated_at) || (!old && expected)) {
          throw Object.assign(new Error("この日の日記は、ほかの画面で書き換えられています。読み込み直してから書いてください。"), { code: "40001" });
        }
        const keys = new Set(sections.map((section) => pathKey(section.path)));
        // 見出しの名前を変えた節は、手で直したタグも Claude のタグも、新しい見出しに引き継ぐ
        const renamed = renamedHeadings(
          (diary.sections[date] || []).map((section) => pathKey(section.path)),
          sections.map((section) => pathKey(section.path))
        );
        const kept = Object.fromEntries(Object.entries(renameTagKeys(tags, renamed)).filter(([key]) => keys.has(key)));
        if (old && JSON.stringify([old.title, old.body, old.tags]) !== JSON.stringify([title, body, kept])) {
          diary.history.push({ date, title: old.title, body: old.body, tags: old.tags, saved_at: new Date().toISOString() });
        }
        const saved = title.trim() || body.trim() ? new Date().toISOString() : null;
        if (saved) {
          // Claude のタグ（ai_tags）は保存では変えない。節のタグは、手直し → Claude の順で選ぶ（DB の diary.apply_labels と同じ）
          const ai = renameTagKeys(old?.ai_tags, renamed);
          diary.days[date] = { date, title, body, tags: kept, ai_tags: ai, updated_at: saved };
          diary.sections[date] = sections.map((section, i) => {
            const key = pathKey(section.path);
            const { labels, tag_source } = pickLabels(kept[key], ai[key]);
            return {
              id: `${date}-${String(i + 1).padStart(2, "0")}`,
              path: section.path,
              body: section.body,
              crops: labels.crops || [],
              work: labels.work || [],
              labels,
              tag_source,
            };
          });
        } else {
          delete diary.days[date];
          delete diary.sections[date];
        }
        const used = new Set([...Object.values(diary.days), ...diary.history].flatMap((day) => photoNames(day.body)));
        const removed = Object.values(diary.photos).filter((photo) => photo.date === date && !used.has(photo.name)).map((photo) => photo.name);
        removed.forEach((name) => delete diary.photos[name]);
        result = { updated_at: saved, removed };
      });
      return result;
    },
    async diaryUploadPhoto(path, blob) {
      // strict では、写真を送るのに時間がかかる（スマホの回線に近づける）
      if (strict) {
        await new Promise((resolve) => setTimeout(resolve, 10 * STRICT_DELAY_MS));
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const dataUrl = `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
      update((data) => {
        const diary = (data.diary ||= {});
        diary.files ||= {};
        if (diary.files[path]) {
          throw Object.assign(new Error("同じ名前の写真があります"), { code: "exists" });
        }
        diary.files[path] = dataUrl;
      });
    },
    async diaryAddPhoto({ name, date, takenAt, originalName, width, height }) {
      update((data) => {
        const diary = (data.diary ||= {});
        diary.photos = { ...diary.photos, [name]: { name, date, taken_at: takenAt, original_name: originalName || null, width, height } };
      });
    },
    async diaryRemovePhotos(paths) {
      update((data) => {
        paths.forEach((path) => delete data.diary?.files?.[path]);
      });
    },
    async diaryPhotoUrls(paths) {
      const files = read().diary?.files || {};
      return Object.fromEntries(paths.filter((path) => files[path]).map((path) => [path, files[path]]));
    },
  });
}

// ローカルの保存のうち、DB で操作の記録（audit_log）の対象になる表に当たるもの（changeMark が見る）
const AUDITED_LOCAL = ["fields", "backdrops", "plans", "zones", "blocks", "beds", "plantings", "works", "crops", "fertilizers", "workTypes", "workLogs"];

// 通しテストで、ローカルの保存の書き込みを遅らせたり、失敗させたりする（回線の遅さや、保存の失敗を確かめる）。
// ブラウザーの保存の LOCAL_TEST_KEY に { "delay": ミリ秒, "fail": true } を入れる。書き込みのたびに読むので、起動のあとで切り替えられる。
// "readDelay": ミリ秒 は、変更の履歴の読み込み（SLOW_READS）を遅らせる（起動がそれを待たないことを確かめる）。
// 圃場の読み込み（loadFields。起動と、戻ってきたときの読み直しで読む）の回数を、LOCAL_READS_KEY に数える
const LOCAL_TEST_KEY = "field_plan_local_test";
const LOCAL_READS_KEY = "field_plan_local_reads";
const SLOW_READS = ["listChanges", "listNotes", "planLastChanges"];

function withTestControl(store) {
  const control = () => {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_TEST_KEY) || "{}");
    } catch {
      return {};
    }
  };
  // 元の書き込みを先に取っておく（下で、同じ名前を包んだものに置き換える。famic の getter はそのまま残す）
  const writes = QUEUED_WRITES.filter((name) => store[name]).map((name) => [name, store[name]]).map(([name, write]) => [
    name,
    async (...args) => {
      const { delay = 0, fail = false } = control();
      if (delay) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (fail) {
        throw new Error("試験のための保存の失敗");
      }
      return write(...args);
    },
  ]);
  const reads = SLOW_READS.filter((name) => store[name]).map((name) => [name, store[name]]).map(([name, read]) => [
    name,
    async (...args) => {
      const { readDelay = 0 } = control();
      if (readDelay) {
        await new Promise((resolve) => setTimeout(resolve, readDelay));
      }
      return read(...args);
    },
  ]);
  const loadFields = store.loadFields;
  const counted = [
    "loadFields",
    async (...args) => {
      localStorage.setItem(LOCAL_READS_KEY, String(Number(localStorage.getItem(LOCAL_READS_KEY) || 0) + 1));
      return loadFields(...args);
    },
  ];
  return Object.defineProperties(store, Object.fromEntries([...writes, ...reads, counted].map(([name, wrapped]) => [name, { value: wrapped, enumerable: true }])));
}

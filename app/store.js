// データの読み書き。通常は Supabase の field スキーマ。
// URL に ?local=1 を付けると、DB を使わずにこのブラウザーの中だけに保存する（動作確認用）。
// さらに &strict=1 を付けると、保存の遅れと外部キーを DB に近づける。
import { DEFAULT_WORK_TYPES } from "./schedule.js";
import { uploadWithProgress } from "./upload.js";
import { pathKey, photoNames, pickLabels } from "./diary.js";

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
export const APP_VERSION = 1;
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

  return {
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
    async listChanges() {
      return check(await client.from("changes").select("*").order("no", { ascending: false }).limit(1000));
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
      rows.forEach((row) => row.inputs.sort((a, b) => a.seq - b.seq));
      return rows;
    },
    // 記録を 1 件、対象と資材ごと保存する（DB の関数が 1 つのトランザクションで置き換える）
    async saveLog({ targets, inputs, ...log }) {
      return check(await client.rpc("save_work_log", { log, targets, inputs }));
    },
    async deleteLog(id) {
      check(await client.from("work_logs").delete().eq("id", id));
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
  "upsert", "remove", "saveField", "saveBackdrop", "saveLog", "deleteLog", "saveWorkType", "saveFieldWeather",
  "createField", "deleteField", "createPlan", "renamePlan", "deletePlan", "setActivePlan",
  "diarySaveDay", "diaryAddPhoto",
];

// 書き込みを、呼んだ順に 1 つずつ送る。同時に送ると、親の行より先に子の行が届いて断られることがある。
// 前の書き込みが失敗しても、次の書き込みは送る。writing は、送り終えていない書き込みがあるあいだ true。
// 操作の ID は、呼んだ時点のものを使う。1 つずつ送るので、送っているあいだ sending で分かる
export function inOrder(store) {
  let last = Promise.resolve();
  let active = 0;
  const queued = (write) => (...args) => {
    const id = operation;
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
    last = result.catch(() => {});
    return result;
  };
  const writes = QUEUED_WRITES.filter((name) => store[name]).map((name) => [name, queued(store[name])]);
  return { ...store, ...Object.fromEntries(writes), writing: () => active > 0 };
}

export function createLocalStore({ strict = false } = {}) {
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
  const removeRows = (data, table, ids) => {
    if (!ids.length) {
      return;
    }
    data[table] = (data[table] || []).filter((row) => !ids.includes(row.id));
    for (const [child, key] of PLAN_TABLES[table]?.children || []) {
      removeRows(data, child, (data[child] || []).filter((row) => ids.includes(row[key])).map((row) => row.id));
    }
  };

  return {
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
    async listChanges() {
      return (read().changes || []).sort((a, b) => b.no - a.no);
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
    async saveLog({ targets, inputs, ...log }) {
      const id = log.id || crypto.randomUUID();
      update((data) => {
        const old = (data.workLogs || []).find((item) => item.id === id);
        const saved = {
          created_at: old?.created_at || new Date().toISOString(),
          ...log,
          id,
          targets: targets.map((target) => ({ ...target, id: target.id || crypto.randomUUID(), log_id: id })),
          inputs: inputs.map((input) => ({ ...input, id: input.id || crypto.randomUUID(), log_id: id })),
        };
        data.workLogs = [...(data.workLogs || []).filter((item) => item.id !== id), saved];
      });
      return id;
    },
    async deleteLog(id) {
      update((data) => {
        data.workLogs = (data.workLogs || []).filter((log) => log.id !== id);
      });
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
    async twoWeek() {
      return { days: [] };
    },
    async twoWeekStations() {
      return [];
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
    async diaryTagSections({ filters, oldest, limit, offset }) {
      const diary = read().diary || {};
      const fits = (section) =>
        filters.every((filter) =>
          filter.kind === "targets"
            ? (section.labels?.targets || []).some((item) => item.id === filter.id)
            : (section.labels?.[filter.kind] || []).includes(filter.name)
        );
      const hits = Object.entries(diary.sections || {})
        .flatMap(([date, sections]) => sections.filter(fits).map((section) => ({ ...section, date, title: diary.days?.[date]?.title || "" })))
        .sort((a, b) => (oldest ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)) || a.id.localeCompare(b.id));
      const page = hits
        .slice(offset, offset + limit)
        .map(({ id, date, title, path, labels, tag_source }) => ({ id, date, title, path, day_body: diary.days?.[date]?.body || "", labels, tag_source }));
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
        const kept = Object.fromEntries(Object.entries(tags || {}).filter(([key]) => keys.has(key)));
        if (old && JSON.stringify([old.title, old.body, old.tags]) !== JSON.stringify([title, body, kept])) {
          diary.history.push({ date, title: old.title, body: old.body, tags: old.tags, saved_at: new Date().toISOString() });
        }
        const saved = title.trim() || body.trim() ? new Date().toISOString() : null;
        if (saved) {
          // Claude のタグ（ai_tags）は保存では変えない。節のタグは、手直し → Claude の順で選ぶ（DB の diary.apply_labels と同じ）
          const ai = old?.ai_tags || {};
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
  };
}

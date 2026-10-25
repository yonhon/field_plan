// データの読み書き。通常は Supabase の field スキーマ。
// URL に ?local=1 を付けると、DB を使わずにこのブラウザーの中だけに保存する（動作確認用）。
import { DEFAULT_WORK_TYPES } from "./schedule.js";
import { uploadWithProgress } from "./upload.js";

const BUCKET = "field-plan";
const LOCAL_KEY = "field_plan_local";

// プランの下にあるテーブル。どれも plan_id を持ち、list / upsert / remove で読み書きする。
// children は、親の行を消したときに一緒に消える行（DB では外部キーが消す。ローカルではここを見て消す）
const PLAN_TABLES = {
  zones: { order: "created_at", children: [["blocks", "zone_id"]] },
  blocks: { order: "created_at", children: [["beds", "block_id"], ["works", "block_id"]] },
  beds: { order: "seq", children: [["plantings", "bed_id"]] },
  plantings: { order: "seq", children: [["works", "planting_id"]] },
  works: { order: "seq", children: [] },
};

// options: { url, anonKey }。画像を、進み具合を知らせながら上げるのに使う
export function createSupabaseStore(client, options) {
  const check = ({ data, error }) => {
    if (error) {
      throw error;
    }
    return data;
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
      return check(await client.storage.from(BUCKET).createSignedUrl(path, 3600)).signedUrl;
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
      return check(await client.from(table).select("*").eq("plan_id", planId).order(PLAN_TABLES[table].order));
    },
    // 品目と肥料は、すべてのプランで共通
    async listAll(table) {
      return check(await client.from(table).select("*").order("name"));
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
      const rows = check(
        await client
          .from("work_logs")
          .select("*, targets:work_log_targets(*), inputs:work_log_inputs(*)")
          .eq("field_id", fieldId)
          .order("date", { ascending: false })
          .order("created_at", { ascending: false })
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
  };
}

export function createLocalStore() {
  const read = () => JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
  const write = (data) => localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
  const update = (change) => {
    const data = read();
    change(data);
    write(data);
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
  };
}

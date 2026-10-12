// データの読み書き。通常は Supabase の field スキーマ。
// URL に ?local=1 を付けると、DB を使わずにこのブラウザーの中だけに保存する（動作確認用）。
import { DEFAULT_WORK_TYPES } from "./schedule.js";

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

export function createSupabaseStore(client) {
  const check = ({ data, error }) => {
    if (error) {
      throw error;
    }
    return data;
  };

  return {
    async loadField() {
      const rows = check(await client.from("fields").select("*").order("created_at").limit(1));
      return rows[0] || null;
    },
    async createField(field) {
      return check(await client.from("fields").insert(field).select().single());
    },
    async saveField(field) {
      const { id, name, outline, note } = field;
      check(await client.from("fields").update({ name, outline, note }).eq("id", id));
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
    async uploadImage(fieldId, file) {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${fieldId}/${crypto.randomUUID()}.${ext}`;
      check(await client.storage.from(BUCKET).upload(path, file, { contentType: file.type }));
      return path;
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
    // 変更の記録。新しい順に、最近の 1,000 件
    async listChanges(fieldId) {
      return check(await client.from("changes").select("*").eq("field_id", fieldId).order("no", { ascending: false }).limit(1000));
    },
    // 記録を足す。番号は DB が振るので、それを返す
    async addChange(entry) {
      const { no, ...row } = entry;
      return check(await client.from("changes").insert(row).select("no").single()).no;
    },
    async saveChange(entry) {
      check(await client.from("changes").upsert(entry));
    },
    async listNotes(fieldId) {
      return check(await client.from("day_notes").select("*").eq("field_id", fieldId));
    },
    async saveNote(note) {
      check(await client.from("day_notes").upsert(note));
    },
    async saveWorkType(type) {
      check(await client.from("work_types").upsert(type));
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
    async loadField() {
      return read().field || null;
    },
    async createField(field) {
      const created = { id: crypto.randomUUID(), outline: [], note: "", ...field };
      update((data) => {
        data.field = created;
      });
      return created;
    },
    async saveField(field) {
      update((data) => {
        data.field = field;
      });
    },
    async loadBackdrop() {
      return read().backdrop || null;
    },
    async saveBackdrop(backdrop) {
      update((data) => {
        data.backdrop = backdrop;
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
        data.image = dataUrl;
      });
      return "local";
    },
    async imageUrl() {
      return read().image || "";
    },
    async loadPlans() {
      return read().plans || [];
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
      return read().workTypes || DEFAULT_WORK_TYPES.map((type) => ({ ...type }));
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
        data.workTypes = types.map((item) => (item.code === type.code ? type : item));
      });
    },
  };
}

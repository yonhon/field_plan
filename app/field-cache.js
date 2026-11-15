// 前回 DB から読んだ圃場の中身を、端末（IndexedDB）に取っておく。
// 起動のときは、ログインを確かめ、取っておいたときの DB の変更の印を渡して DB の関数 field.load_field を呼ぶ。
// 「変わっていない」と返ってきたら、取っておいた中身で画面を出す（中身を読み直さない。app.js の startApp）。
// 取っておくのは、DB から読んだそのままの中身と、そのときの印だけ。画面で変えた中身は取っておかない
// （保存できなかった変更を、DB の中身として出さないため）。日記は取っておかない。ログアウトで消す。
// 読み書きできないとき（プライベートブラウズ、端末の空きがない、など）は、取っておかないだけ（いままでどおり読む）
const DB_NAME = "field_plan";
const STORE = "cache";
const KEY = "field";
const FORMAT = 1; // 取っておく形の版。形を変えたら上げる（前の形の中身は使わない）
const OPEN_WAIT_MS = 1500; // IndexedDB が開かないまま止まることがあるので、これを過ぎたら使わない（起動を止めない）

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB を開けません"));
  });
}

async function run(mode, action) {
  const db = await Promise.race([open(), new Promise((_, reject) => setTimeout(() => reject(new Error("IndexedDB が開きません")), OPEN_WAIT_MS))]);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

// 取っておいた中身（store.loadField の返事の形）。利用者かアプリの版が違えば、使わない（null）
export async function readFieldCache({ user, version }) {
  try {
    const entry = await run("readonly", (store) => store.get(KEY));
    return entry && entry.format === FORMAT && entry.user === user && entry.version === version ? entry.loaded : null;
  } catch {
    return null;
  }
}

// DB から読んだ中身を取っておく。loaded は store.loadField の返事（中身のあるもの）。
// 呼んだ時点の写しを取る（このあと画面が中身を書き換えても、取っておく中身は変わらない）
export function writeFieldCache({ user, version, loaded }) {
  if (loaded.unchanged || loaded.mark === null || loaded.mark === undefined || !loaded.fieldId || !loaded.planId) {
    return Promise.resolve();
  }
  let copy;
  try {
    copy = structuredClone(loaded);
  } catch {
    return Promise.resolve();
  }
  return run("readwrite", (store) => store.put({ format: FORMAT, user, version, savedAt: new Date().toISOString(), loaded: copy }, KEY)).catch(() => {});
}

// 取っておいた中身を消す（ログアウト）
export function clearFieldCache() {
  return run("readwrite", (store) => store.delete(KEY)).catch(() => {});
}

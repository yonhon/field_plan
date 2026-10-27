// ブラウザーが覚える表示の設定。次に開いたときに引き継ぐ。圃場ごとに覚える（表示日、開いていたプラン、工程表の表示と表示期間）。
// 開いていた圃場だけは、圃場をまたぐので 1 つ（app.js の CURRENT_FIELD_KEY）。
// 覚えられない（プライベートブラウズなど）ときは、覚えないだけで、表示は変わらない
const KEY = "field_plan_prefs";

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

// 圃場ごとに覚えた値。覚えていなければ、圃場ごとにする前に 1 つだけ覚えていた値（legacyKey）を使う
export function loadPref(fieldId, name, legacyKey = null) {
  const saved = read()[fieldId]?.[name];
  if (saved !== undefined) {
    return saved;
  }
  try {
    return legacyKey ? localStorage.getItem(legacyKey) : null;
  } catch {
    return null;
  }
}

export function savePref(fieldId, name, value) {
  try {
    const prefs = read();
    prefs[fieldId] = { ...prefs[fieldId], [name]: value };
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // 覚えられなくても、いまの表示は変わらない
  }
}

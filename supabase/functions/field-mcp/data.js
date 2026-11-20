// 計画のデータを DB から読む。量が少ないので全件を読み、短時間だけ覚えておく。
const CACHE_MS = 30_000;

// アプリの更新の一覧は、公開しているアプリのものを読む。配備し直さなくても、アプリを公開すれば新しい一覧が届く。
// 写しは持たない。読めないとき、中身がおかしいときは null を返す（get_changes が「読めなかった」と添える）
export async function loadUpdates({ url, fetch = globalThis.fetch, timeoutMs = 5000 }) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const list = await response.json();
    if (!Array.isArray(list) || !list.every((item) => Number.isInteger(item.no) && item.date && item.title)) {
      throw new Error("一覧の形が違う");
    }
    return list;
  } catch (error) {
    console.error("updates.json を読めなかった", error);
    return null;
  }
}

export function createDataSource({ query, now = () => Date.now() }) {
  let cache = null;
  return {
    async getData() {
      if (cache && now() - cache.at < CACHE_MS) {
        return cache.data;
      }
      const data = await query();
      cache = { at: now(), data };
      return data;
    },
  };
}

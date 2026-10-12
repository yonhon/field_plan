// 計画のデータを DB から読む。量が少ないので全件を読み、短時間だけ覚えておく。
const CACHE_MS = 30_000;

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

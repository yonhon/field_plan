// 計算のテストが使う test と beforeEach の入口。node --test で動かすときは node:test、
// Mutation testing（mutation/ の mizchi/mutator）が Vitest で動かすときは vitest のものを渡す。
// Vitest は、動かしているあいだ環境変数 VITEST を入れる。テストは node:test を直接読まず、ここから読む
const api = process.env.VITEST ? await import("vitest") : await import("node:test");

export const test = api.test;
export const beforeEach = api.beforeEach;

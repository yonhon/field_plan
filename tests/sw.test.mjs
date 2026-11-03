// Service Worker（app/sw.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "app");
const SOURCE = readFileSync(join(APP, "sw.js"), "utf8");
const SCOPE = "https://example.test/field_plan/";
const FILES = JSON.parse(SOURCE.match(/const FILES = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]/, "]"));

// app.js から import でたどれる部品をすべて集める
function modules(file = "app.js", found = new Set()) {
  found.add(file);
  const text = readFileSync(join(APP, file), "utf8");
  for (const [, name] of text.matchAll(/^import [^;]*? from "\.\/([^"]+)";/gm)) {
    if (!found.has(name)) {
      modules(name, found);
    }
  }
  return found;
}

test("一式に、app.js からたどれる部品と、index.html が読むファイルがすべて入っている", () => {
  const html = readFileSync(join(APP, "index.html"), "utf8");
  const parts = JSON.parse(html.match(/const parts = (\[[^\]]*\]);/)[1]);
  const used = modules();
  assert.deepEqual([...parts].sort(), [...used].sort(), "index.html の parts");
  const linked = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map(([, path]) => path).filter((path) => path !== "sw.js");
  for (const file of [...used, ...linked]) {
    assert.ok(FILES.includes(file), `sw.js の FILES に ${file} がない`);
  }
});

// Cache API をまねる
function fakeCaches() {
  const stores = new Map();
  const open = (name) => {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        entries,
        put: async (url, response) => void entries.set(url, response),
        match: async (url) => entries.get(url)?.clone(),
      });
    }
    return stores.get(name);
  };
  return {
    stores,
    open: async (name) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
}

// sw.js を、まねた Service Worker の中で動かす。server は { URL: 中身 }、中身が null なら取れない
function startWorker(server) {
  const listeners = {};
  const messages = []; // すべての画面に知らせたこと
  const replies = []; // 確かめるよう頼んだ画面への返事
  const caches = fakeCaches();
  const self = {
    registration: { scope: SCOPE },
    clients: { matchAll: async () => [{ postMessage: (data) => messages.push(data) }], claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (type, listener) => (listeners[type] = listener),
  };
  const fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    const body = server[url];
    if (body === undefined) {
      return new Response("", { status: 404 });
    }
    if (body === null) {
      throw new TypeError("Failed to fetch");
    }
    return new Response(body);
  };
  vm.runInNewContext(SOURCE, { self, caches, fetch, Response, URL, Promise, String, Uint8Array, Error, TypeError });
  const dispatch = async (type, extra = {}) => {
    let waiting = Promise.resolve();
    let responded = null;
    listeners[type]({ ...extra, waitUntil: (promise) => (waiting = promise), respondWith: (promise) => (responded = promise) });
    await waiting;
    return responded;
  };
  return {
    caches,
    messages,
    install: () => dispatch("install"),
    replies,
    check: () => dispatch("message", { data: "check", source: { postMessage: (data) => replies.push(data) } }),
    request: async (url, mode = "no-cors") => {
      const responded = await dispatch("fetch", { request: { method: "GET", url, mode } });
      return responded ? (await responded).text() : null;
    },
  };
}

const serverWith = (version) => Object.fromEntries(FILES.map((file) => [new URL(file, SCOPE).href, `${file} ${version}`]));

test("入れたあとは、一式を手元から出す。一式にないものと、ほかのサイトには触らない", async () => {
  const server = serverWith("v1");
  const worker = startWorker(server);
  await worker.install();
  server[`${SCOPE}app.js`] = "app.js v2";
  assert.equal(await worker.request(`${SCOPE}app.js`), "app.js v1");
  assert.equal(await worker.request(`${SCOPE}?local=1`, "navigate"), "./ v1");
  assert.equal(await worker.request(`${SCOPE}index.html`, "navigate"), "./ v1");
  assert.equal(await worker.request(`${SCOPE}updates.json`), null);
  assert.equal(await worker.request(`${SCOPE}styles.css?v=1`), null);
  assert.equal(await worker.request("https://db.example.test/rest/v1/plans"), null);
});

test("サーバーの一式が変わっていれば、一式を取り直してから知らせる", async () => {
  const server = serverWith("v1");
  const worker = startWorker(server);
  await worker.install();
  await worker.check();
  assert.deepEqual(worker.messages, [], "変わっていなければ知らせない");
  assert.deepEqual(worker.replies, ["up-to-date"], "頼んだ画面には、変わっていないと返す");
  Object.assign(server, serverWith("v2"));
  await worker.check();
  assert.deepEqual(worker.messages, ["update-ready"]);
  assert.deepEqual(worker.replies, ["up-to-date"], "取り直したことは、すべての画面への知らせだけで伝える");
  assert.equal(await worker.request(`${SCOPE}app.js`), "app.js v2");
  assert.equal(await worker.request(`${SCOPE}store.js`), "store.js v2");
  assert.equal(worker.caches.stores.size, 1, "古い一式は消す");
});

test("1 つでも取れなければ、取り直さずに、手元の一式を使い続ける", async () => {
  const server = serverWith("v1");
  const worker = startWorker(server);
  await worker.install();
  Object.assign(server, serverWith("v2"));
  server[`${SCOPE}store.js`] = null;
  await worker.check();
  assert.deepEqual(worker.messages, []);
  assert.deepEqual(worker.replies, ["check-failed"]);
  assert.equal(await worker.request(`${SCOPE}app.js`), "app.js v1");
});

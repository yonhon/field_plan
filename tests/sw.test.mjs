// Service Worker（app/sw.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "./test-api.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildVersion } from "../scripts/build-version.mjs";

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

test("index.html は、HTML の中に書いたスクリプトを持たず、Content-Security-Policy でこのサイトのスクリプトだけを許す", () => {
  const html = readFileSync(join(APP, "index.html"), "utf8");
  const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] ?? "";
  assert.match(policy, /(^|;)\s*script-src 'self'\s*(;|$)/);
  for (const [, tag, inside] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(tag, /\bsrc=/, "src のない script がある");
    assert.equal(inside.trim(), "", "script の中にコードがある");
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, "onclick などの属性がある");
});

test("書体の CSS は index.html では読まず、boot.js が表示を止めない形で読む。使っていない書体は読まない", () => {
  const html = readFileSync(join(APP, "index.html"), "utf8");
  // head の <link rel="stylesheet"> で外の CSS を読むと、読み終えるまで画面も JS も止まる
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/rel="stylesheet"/.test(tag)) {
      assert.doesNotMatch(tag, /href="https?:/, `外の CSS を読んでいる: ${tag}`);
    }
  }
  const boot = readFileSync(join(APP, "boot.js"), "utf8");
  const url = boot.match(/const FONTS_URL =\s*"([^"]+)"/)?.[1] ?? "";
  assert.match(url, /^https:\/\/fonts\.googleapis\.com\/css2\?/);
  assert.match(url, /display=swap/);
  assert.match(boot, /fetchPriority = "low"/);
  // styles.css が名前を出している書体だけを読む
  const css = readFileSync(join(APP, "styles.css"), "utf8");
  for (const [, name] of url.matchAll(/family=([^:&]+)/g)) {
    const family = decodeURIComponent(name.replace(/\+/g, " "));
    assert.ok(css.includes(`"${family}"`), `styles.css が使っていない書体を読んでいる: ${family}`);
  }
});

test("一式に、app.js からたどれる部品と、index.html が読むファイルがすべて入っている", () => {
  const html = readFileSync(join(APP, "index.html"), "utf8");
  const parts = JSON.parse(readFileSync(join(APP, "boot.js"), "utf8").match(/const parts = (\[[^\]]*\]);/)[1]);
  const used = modules();
  assert.deepEqual([...parts].sort(), [...used].sort(), "boot.js の parts");
  const linked = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map(([, path]) => path).filter((path) => path !== "sw.js");
  for (const file of [...used, ...linked]) {
    assert.ok(FILES.includes(file), `sw.js の FILES に ${file} がない`);
  }
});

test("manifest のアイコンは一式に入っていて、起動の URL は画面と同じ", () => {
  const manifest = JSON.parse(readFileSync(join(APP, "manifest.webmanifest"), "utf8"));
  for (const icon of manifest.icons) {
    assert.ok(FILES.includes(icon.src), `sw.js の FILES に ${icon.src} がない`);
  }
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"), "Android で切り抜かれても欠けないアイコンがない");
  // ログインと Google フォトの戻り先を変えないため、起動の URL に印（?source=pwa など）を付けない
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
});

test("index.html は、外のサーバーからスクリプトを読まない", () => {
  const html = readFileSync(join(APP, "index.html"), "utf8");
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)].map(([, src]) => src);
  assert.ok(sources.length > 0, "src のある script が見つからない");
  for (const src of sources) {
    assert.match(src, /^\.\//, `${src} は、app/ の中のファイルではない`);
  }
  // 手元に置いたライブラリーは、決めた版のファイルが 1 つだけ
  const vendored = sources.filter((src) => src.startsWith("./vendor/"));
  assert.equal(vendored.length, 1);
  assert.match(vendored[0], /^\.\/vendor\/supabase-js-\d+\.\d+\.\d+\.js$/);
  assert.ok(readFileSync(join(APP, vendored[0])).length > 0);
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
// windows は、開いている画面（{ url }）。通知を押したときに使う
function startWorker(server, { windows = null } = {}) {
  const listeners = {};
  const opened = []; // 新しく開いた画面の URL
  const focused = []; // 前に出した画面の URL
  const posted = []; // 開いている画面に送ったこと（URL と中身）
  const windowClients = (windows || []).map((client) => ({
    ...client,
    focus: async () => void focused.push(client.url),
    postMessage: (data) => posted.push({ url: client.url, data: JSON.parse(JSON.stringify(data)) }), // sw.js の中で作った値を、こちらの値に直す
  }));
  const messages = []; // すべての画面に知らせたこと
  const replies = []; // 確かめるよう頼んだ画面への返事
  const caches = fakeCaches();
  const self = {
    registration: { scope: SCOPE },
    clients: {
      matchAll: async () => (windows ? windowClients : [{ postMessage: (data) => messages.push(data) }]),
      openWindow: async (url) => void opened.push(url),
      claim: async () => {},
    },
    skipWaiting: async () => {},
    addEventListener: (type, listener) => (listeners[type] = listener),
  };
  const fetched = []; // サーバーから取った URL
  const fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    fetched.push(url);
    const body = server[url];
    if (body === undefined) {
      return new Response("", { status: 404 });
    }
    if (body === null) {
      throw new TypeError("Failed to fetch");
    }
    return new Response(body);
  };
  vm.runInNewContext(SOURCE, { self, caches, fetch, Response, URL, Promise, String, Uint8Array, Error, TypeError, crypto: globalThis.crypto, TextDecoder });
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
    fetched,
    install: () => dispatch("install"),
    replies,
    opened,
    focused,
    posted,
    click: (data) => dispatch("notificationclick", { notification: { data } }),
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

// 版の印を、サーバーの中身から、公開の手順と同じスクリプト（scripts/build-version.mjs）で作る。
// 端末の照らし合わせ（sw.js）と、公開の手順の計算が食い違えば、下のテストが失敗する
function withVersion(server) {
  const dir = mkdtempSync(join(tmpdir(), "field-plan-sw-"));
  for (const file of FILES) {
    const path = join(dir, file === "./" ? "index.html" : file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, server[new URL(file, SCOPE).href]);
  }
  server[`${SCOPE}version.json`] = JSON.stringify(buildVersion({ appDir: dir, files: FILES }));
  return server;
}

test("版の印: 手元と同じ版なら、版の印だけを取って終わる", async () => {
  const server = withVersion(serverWith("v1"));
  const worker = startWorker(server);
  await worker.install();
  worker.fetched.length = 0;
  await worker.check();
  assert.deepEqual(worker.fetched, [`${SCOPE}version.json`]);
  assert.deepEqual(worker.replies, ["up-to-date"]);
  assert.deepEqual(worker.messages, []);
});

test("版の印: 版が変われば、変わったファイルだけを取り、ほかは手元から写して入れ替える", async () => {
  const server = withVersion(serverWith("v1"));
  const worker = startWorker(server);
  await worker.install();
  server[`${SCOPE}app.js`] = "app.js v2";
  server[`${SCOPE}store.js`] = "store.js v2";
  withVersion(server);
  worker.fetched.length = 0;
  await worker.check();
  assert.deepEqual(worker.fetched.sort(), [`${SCOPE}app.js`, `${SCOPE}store.js`, `${SCOPE}version.json`].sort());
  assert.deepEqual(worker.messages, ["update-ready"]);
  assert.equal(await worker.request(`${SCOPE}app.js`), "app.js v2");
  assert.equal(await worker.request(`${SCOPE}schedule.js`), "schedule.js v1");
  assert.equal(JSON.parse(await worker.request(`${SCOPE}version.json`)).version, JSON.parse(server[`${SCOPE}version.json`]).version);
  assert.equal(worker.caches.stores.size, 1, "古い一式は消す");
});

test("版の印: 取ったファイルが版の印と合わなければ（新旧が混ざって届いた）、入れ替えずに、手元の一式を使い続ける", async () => {
  const server = withVersion(serverWith("v1"));
  const worker = startWorker(server);
  await worker.install();
  server[`${SCOPE}app.js`] = "app.js v2";
  withVersion(server);
  server[`${SCOPE}app.js`] = "app.js v1 (配信の途中のキャッシュ)";
  await worker.check();
  assert.deepEqual(worker.messages, []);
  assert.deepEqual(worker.replies, ["check-failed"]);
  assert.equal(await worker.request(`${SCOPE}app.js`), "app.js v1");
});

test("版の印: 版の印のない一式を入れたあとでも、中身が同じなら、知らせずに印だけを足す", async () => {
  const server = serverWith("v1");
  const worker = startWorker(server);
  await worker.install();
  withVersion(server);
  await worker.check();
  assert.deepEqual(worker.messages, [], "中身は同じなので知らせない");
  assert.deepEqual(worker.replies, ["up-to-date"]);
  assert.equal(JSON.parse(await worker.request(`${SCOPE}version.json`)).version, JSON.parse(server[`${SCOPE}version.json`]).version, "印を手元に足した");
  worker.fetched.length = 0;
  await worker.check();
  assert.deepEqual(worker.fetched, [`${SCOPE}version.json`], "次からは、版の印だけを取る");
});

test("版の印: 画面には、手元の一式の版の印を出す（サーバーの版が変わっても、入れ替えるまでは手元のもの）", async () => {
  const server = withVersion(serverWith("v1"));
  const worker = startWorker(server);
  await worker.install();
  const kept = server[`${SCOPE}version.json`];
  server[`${SCOPE}app.js`] = "app.js v2";
  withVersion(server);
  assert.equal(await worker.request(`${SCOPE}version.json`), kept);
});

test("計測中の通知を押すと、開いている画面を前に出して「今日」のタブにさせる。読み込み直さない", async () => {
  const worker = startWorker(serverWith("v1"), { windows: [{ url: "https://example.test/other/" }, { url: `${SCOPE}#diary` }] });
  await worker.click({ view: "today" });
  assert.deepEqual(worker.focused, [`${SCOPE}#diary`]);
  assert.deepEqual(worker.posted, [{ url: `${SCOPE}#diary`, data: { type: "show-view", view: "today" } }]);
  assert.deepEqual(worker.opened, []);
});

test("計測中の通知を押したとき、開いている画面がなければ「今日」のタブで開く。ほかの通知には触らない", async () => {
  const worker = startWorker(serverWith("v1"), { windows: [] });
  await worker.click({ view: "today" });
  assert.deepEqual(worker.opened, [`${SCOPE}#today`]);
  await worker.click(null);
  assert.deepEqual(worker.opened, [`${SCOPE}#today`]);
});

// 起動を速くするための Service Worker。
// アプリのファイルを一式、手元に取っておき、起動のときはサーバーを待たずにそこから出す。
// GitHub Pages はファイルを 10 分しかキャッシュさせないので、これがないと、10 分ぶりに開くたびに
// ファイルごとに更新を確かめる往復が要る。回線が悪いと、その往復だけで何秒も待つ。
// 更新は、画面が出たあとで確かめる（画面から "check" が届く）。変わっていれば一式まとめて取り直し、
// 取り終えてから入れ替えて、画面に知らせる。一式を同時に取るので、古い版と新しい版の部品は混ざらない。
// JS の部品を足したら、FILES と index.html の parts の両方に足す（tests/sw.test.mjs が確かめる）
const FILES = [
  "./",
  "styles.css",
  "config.js",
  "app.js",
  "geometry.js",
  "schedule.js",
  "schedule-view.js",
  "strip-view.js",
  "store.js",
  "crops.js",
  "crops-view.js",
  "dialog.js",
  "draw.js",
  "journal.js",
  "history.js",
  "print.js",
  "logs.js",
  "log-view.js",
  "planting-view.js",
  "pesticide.js",
  "rac.js",
  "weather.js",
  "weather-view.js",
  "prefs.js",
  "upload.js",
  "diary.js",
  "diary-view.js",
  "user-menu.js",
  "icons/A_mark_color.svg",
  "icons/favicon-32.png",
  "icons/apple-touch-icon.png",
];
// 一式ごとに、取った時刻を名前に付けたキャッシュに入れる。いちばん新しく、取り終えた印のあるものを使う
const PREFIX = "field-plan-app-";
const DONE = "__done__";

const scope = () => new URL(self.registration.scope);
const urls = () => FILES.map((file) => new URL(file, scope()).href);

// 一式をサーバーから取る。1 つでも取れなければ、全体を失敗にする（欠けた一式は使わない）
async function download() {
  return Promise.all(
    urls().map(async (url) => {
      const response = await fetch(url, { cache: "no-cache" });
      if (!response.ok) {
        throw new Error(`${url}: ${response.status}`);
      }
      return { url, response, body: await response.arrayBuffer() };
    })
  );
}

// 取った一式を新しいキャッシュに入れ、入れ終えてから古い一式を消す
async function store(files) {
  const name = PREFIX + String(Date.now()).padStart(15, "0");
  const cache = await caches.open(name);
  await Promise.all(
    files.map(({ url, response, body }) =>
      cache.put(url, new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }))
    )
  );
  await cache.put(new URL(DONE, scope()).href, new Response(""));
  const old = (await caches.keys()).filter((key) => key.startsWith(PREFIX) && key !== name);
  await Promise.all(old.map((key) => caches.delete(key)));
}

// いま使う一式。なければ null（そのときはサーバーから出す）
async function current() {
  const names = (await caches.keys()).filter((key) => key.startsWith(PREFIX)).sort().reverse();
  for (const name of names) {
    const cache = await caches.open(name);
    if (await cache.match(new URL(DONE, scope()).href)) {
      return cache;
    }
  }
  return null;
}

function same(a, b) {
  const [x, y] = [new Uint8Array(a), new Uint8Array(b)];
  return x.length === y.length && x.every((byte, index) => byte === y[index]);
}

// サーバーの一式が手元と違えば取り直して、開いている画面すべてに "update-ready" を知らせる。
// 確かめた結果（"update-ready"、変わっていなければ "up-to-date"、取れなければ "check-failed"）を返す。
// 取れなければ（圏外など）、手元の一式を使い続ける
let checking = null;
async function check() {
  const files = await download();
  const cache = await current();
  const differs = async ({ url, body }) => {
    const kept = cache && (await cache.match(url));
    return !kept || !same(await kept.arrayBuffer(), body);
  };
  const changed = (await Promise.all(files.map(differs))).some(Boolean);
  if (!changed) {
    return "up-to-date";
  }
  await store(files);
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  clients.forEach((client) => client.postMessage("update-ready"));
  return "update-ready";
}

self.addEventListener("install", (event) => {
  event.waitUntil(download().then(store).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// 確かめている途中に頼まれたら、同じ確認の結果を返す。"update-ready" は check がすべての画面に知らせるので、
// 頼んだ画面には、それ以外の結果だけを返す（版が古くて止まった画面は、この返事を待っている）
self.addEventListener("message", (event) => {
  if (event.data !== "check") {
    return;
  }
  if (!checking) {
    checking = check()
      .catch(() => "check-failed")
      .finally(() => (checking = null));
  }
  event.waitUntil(
    checking.then((result) => {
      if (result !== "update-ready") {
        event.source?.postMessage(result);
      }
    })
  );
});

// 手元の一式にあるファイルだけを、手元から出す。ほかの要求（DB、フォント、updates.json など）には触らない
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  const base = scope();
  if (url.origin !== base.origin) {
    return;
  }
  // 画面そのもの（index.html）は、?local=1 などが付いていても同じものを出す
  const page = request.mode === "navigate" && (url.pathname === base.pathname || url.pathname === `${base.pathname}index.html`);
  const key = page ? base.href : `${url.origin}${url.pathname}`;
  if (!page && (url.search || !urls().includes(key))) {
    return;
  }
  event.respondWith(
    current()
      .then((cache) => cache && cache.match(key))
      .then((kept) => kept || fetch(request))
  );
});

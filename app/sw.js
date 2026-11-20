// 起動を速くするための Service Worker。
// アプリのファイルを一式、手元に取っておき、起動のときはサーバーを待たずにそこから出す。
// GitHub Pages はファイルを 10 分しかキャッシュさせないので、これがないと、10 分ぶりに開くたびに
// ファイルごとに更新を確かめる往復が要る。回線が悪いと、その往復だけで何秒も待つ。
// 更新は、画面が出たあとで確かめる（画面から "check" が届く）。まず版の印（version.json。公開の手順が
// scripts/build-version.mjs で作る）だけを取り、手元の一式の印と同じなら終わり。違えば、変わったファイルだけを取り直し、
// 変わっていないファイルは手元の一式から写す。どのファイルも、版の印のハッシュと照らし合わせ、1 つでも合わなければ
// 入れ替えない（公開の直後に、配信の途中のキャッシュが新旧のファイルを混ぜて返しても、混ざった一式で動かない）。
// 取り終えてから入れ替えて、画面に知らせる。版の印が取れないとき（古い公開、手元の開発）は、一式すべてを取って比べる。
// JS の部品を足したら、FILES と boot.js の parts の両方に足す（tests/sw.test.mjs が確かめる）
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
  "field-cache.js",
  "history.js",
  "print.js",
  "logs.js",
  "log-view.js",
  "process-editor.js",
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
  "work-time.js",
  "today-view.js",
  "revenue-view.js",
  "field-plans.js",
  "news-view.js",
  "toast.js",
  "undo-pad.js",
  "icons.js",
  "html.js",
  "google-photos.js",
  "google-photos.html",
  "google-photos-callback.js",
  "boot.js",
  "vendor/supabase-js-2.119.0.js",
  "icons/A_mark_color.svg",
  "icons/favicon-32.png",
  "icons/apple-touch-icon.png",
];
// 一式ごとに、取った時刻を名前に付けたキャッシュに入れる。いちばん新しく、取り終えた印のあるものを使う
const PREFIX = "field-plan-app-";
const DONE = "__done__";

const VERSION = "version.json"; // 版の印。一式と一緒に手元に取っておく（画面は、いま動いている版をここから読む）

const scope = () => new URL(self.registration.scope);
const urls = () => FILES.map((file) => new URL(file, scope()).href);
const versionUrl = () => new URL(VERSION, scope()).href;

async function sha256(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// サーバーの版の印。取れない、形がおかしい、一式の一覧と合わないときは null（一式すべてを比べる形に戻る）
async function fetchVersion() {
  try {
    const response = await fetch(versionUrl(), { cache: "no-cache" });
    if (!response.ok) {
      return null;
    }
    const body = await response.arrayBuffer();
    const info = JSON.parse(new TextDecoder().decode(body));
    if (typeof info?.version !== "string" || !info.files || FILES.some((file) => typeof info.files[file] !== "string")) {
      return null;
    }
    return { info, response, body };
  } catch {
    return null;
  }
}

// 手元の一式の版の印。なければ null
async function keptVersion(cache) {
  try {
    const kept = cache && (await cache.match(versionUrl()));
    return kept ? await kept.json() : null;
  } catch {
    return null;
  }
}

// 版の印に合わせて一式をそろえる。ハッシュが手元の印と同じファイルは手元の一式から写し、ほかはサーバーから取る。
// どのファイルも、版の印のハッシュと照らし合わせる。1 つでも合わなければ、全体を失敗にする（混ざった一式は使わない）
async function collect(server, cache, kept) {
  return Promise.all(
    FILES.map(async (file) => {
      const url = new URL(file, scope()).href;
      let source = null;
      if (cache && kept?.files?.[file] === server.info.files[file]) {
        const hit = await cache.match(url);
        if (hit) {
          source = { response: hit, body: await hit.arrayBuffer() };
        }
      }
      if (!source) {
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) {
          throw new Error(`${url}: ${response.status}`);
        }
        source = { response, body: await response.arrayBuffer() };
      }
      if ((await sha256(source.body)) !== server.info.files[file]) {
        throw new Error(`${url}: 版の印と中身が合いません`);
      }
      return { url, ...source };
    })
  );
}

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
  const cache = await current();
  const server = await fetchVersion();
  let files;
  if (server) {
    const kept = await keptVersion(cache);
    if (cache && kept?.version === server.info.version) {
      // 一式の中身は同じでも、画面に出す版の番号（label。更新の一覧の最後の番号）だけ変わることがある
      // （updates.json は一式に入れないので、更新の一覧を足しただけでは version は変わらない）。そのときは印だけを差し替える
      if (kept.label !== server.info.label) {
        const { status, statusText, headers } = server.response;
        await cache.put(versionUrl(), new Response(server.body, { status, statusText, headers }));
      }
      return "up-to-date";
    }
    files = await collect(server, cache, kept);
    files.push({ url: versionUrl(), response: server.response, body: server.body });
    // 手元の一式に版の印がなかった（版の印を使う前に入れた一式）ときは、中身が同じなら、印を足すだけで知らせない
    if (cache && !kept && !(await changedFrom(cache, files))) {
      await store(files);
      return "up-to-date";
    }
  } else {
    files = await download();
    if (!(await changedFrom(cache, files))) {
      return "up-to-date";
    }
  }
  await store(files);
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  clients.forEach((client) => client.postMessage("update-ready"));
  return "update-ready";
}

// 取った一式（files）が、手元の一式（cache）と違うか。版の印のファイルは比べない
async function changedFrom(cache, files) {
  const differs = async ({ url, body }) => {
    if (url === versionUrl()) {
      return false;
    }
    const kept = cache && (await cache.match(url));
    return !kept || !same(await kept.arrayBuffer(), body);
  };
  return (await Promise.all(files.map(differs))).some(Boolean);
}

// 入れるとき。版の印があれば、それに合わせてそろえる（手元の一式があれば、変わっていないファイルは写す）
async function install() {
  const server = await fetchVersion();
  if (!server) {
    await store(await download());
    return;
  }
  const cache = await current();
  const files = await collect(server, cache, await keptVersion(cache));
  await store([...files, { url: versionUrl(), response: server.response, body: server.body }]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(install().then(() => self.skipWaiting()));
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

// 手元の一式にあるファイル（と版の印）だけを、手元から出す。ほかの要求（DB、フォント、updates.json など）には触らない
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
  if (!page && (url.search || !(urls().includes(key) || key === versionUrl()))) {
    return;
  }
  event.respondWith(
    current()
      .then((cache) => cache && cache.match(key))
      .then((kept) => kept || fetch(request))
  );
});

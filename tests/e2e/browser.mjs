// 通しテストの土台。app/ を配り、Chrome を画面なしで動かして、Chrome DevTools Protocol で操作する。
// 依存を増やさないため、Node の標準の部品だけで書く
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const LOCAL_KEY = "field_plan_local";
const WAIT_MS = 5000;
const SEND_MS = 20000;
const POLL_MS = 25;
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChrome() {
  return [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((path) => path && existsSync(path));
}

function serveApp() {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://localhost").pathname)).replace(/^[\\/]+/, "") || "index.html";
    try {
      const body = readFileSync(join(APP, path));
      response.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Chrome が書くファイルから、DevTools の口を読む
async function devtoolsPort(profile) {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < WAIT_MS / POLL_MS; i += 1) {
    if (existsSync(file)) {
      // Chrome が書いている途中は、Windows では開けない（EBUSY）。少し待って読み直す
      let port = "";
      try {
        port = readFileSync(file, "utf8").split("\n")[0].trim();
      } catch (error) {
        if (error.code !== "EBUSY" && error.code !== "EPERM") {
          throw error;
        }
      }
      if (port) {
        return port;
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error("Chrome が起動しませんでした");
}

function connect(url) {
  const socket = new WebSocket(url);
  const waiting = new Map();
  const errors = [];
  let nextId = 1;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    } else if (message.method === "Page.javascriptDialogOpening") {
      // 保存中に閉じるときの確認。次のテストへ進めるよう、閉じる
      send("Page.handleJavaScriptDialog", { accept: true });
    } else if (message.method === "Runtime.exceptionThrown") {
      const { exception, text } = message.params.exceptionDetails;
      errors.push(exception?.description?.split("\n")[0] || text);
    }
  };
  // 返事を待つのは SEND_MS まで。返事が来ないと、テストがいつまでも止まったままになる
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method}: ${SEND_MS / 1000} 秒待っても、Chrome から返事がありませんでした`));
      }, SEND_MS);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome につながりませんでした")), WAIT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve({ send, errors, close: () => socket.close() });
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Chrome につながりませんでした"));
    };
  });
}

// 開いた Chrome の、操作する画面（page）の一覧を取る。起動の直後は、画面がまだ一覧にないことがある
async function pageTarget(port) {
  for (let i = 0; i < WAIT_MS / POLL_MS; i += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(WAIT_MS) }).then((response) => response.json());
    const found = targets.find((target) => target.type === "page");
    if (found) {
      return found;
    }
    await sleep(POLL_MS);
  }
  throw new Error("Chrome の画面が見つかりませんでした");
}

// Chrome を開き、テストで使う操作を返す。終わったら close を呼ぶ。
// 起動に失敗したら（Windows で、まれに起動の途中で止まる）、1 回だけ開き直す
export async function openBrowser() {
  try {
    return await launch();
  } catch (error) {
    console.error(`Chrome の起動に失敗したので、開き直します: ${error.message}`);
    return launch();
  }
}

async function launch() {
  const server = await serveApp();
  const profile = mkdtempSync(join(tmpdir(), "field-plan-e2e-"));
  const chrome = spawn(
    findChrome(),
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1500,1100", "about:blank"],
    { stdio: "ignore" }
  );
  // つなぐ前に失敗したら、Chrome とサーバーを止める。残ると、テストのプロセスが終わらない
  let page;
  try {
    const port = await devtoolsPort(profile);
    page = await connect((await pageTarget(port)).webSocketDebuggerUrl);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    // 外のサーバーが遅いと、スクリプトが待たされて起動が遅れる。?local=1 では要らないので読まない
    await page.send("Network.enable");
    await page.send("Network.setBlockedURLs", { urls: ["*cdn.jsdelivr.net*", "*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  } catch (error) {
    page?.close();
    chrome.kill();
    server.close();
    throw error;
  }

  const run = async (expression) => {
    const { result, exceptionDetails } = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    }
    return result.value;
  };

  const waitFor = async (expression, label = expression) => {
    for (let i = 0; i < WAIT_MS / POLL_MS; i += 1) {
      if (await run(expression)) {
        return;
      }
      await sleep(POLL_MS);
    }
    const screen = await run(`JSON.stringify({
      url: location.pathname + location.search + location.hash,
      tab: document.querySelector(".tab-btn.is-active")?.dataset.view,
      status: document.getElementById("saveStatus")?.textContent,
      dialog: document.querySelector("dialog[open]")?.textContent.slice(0, 100),
      strip: document.getElementById("strip")?.innerHTML.length,
    })`);
    throw new Error(`待っても変わりませんでした: ${label}\n${screen}\n例外: ${page.errors.join(" / ") || "なし"}`);
  };

  // 本物のマウスの操作で押す（確認の窓は、スクリプトの click を受け付けない）
  const click = async (selector) => {
    const target = JSON.stringify(selector);
    await waitFor(`Boolean(document.querySelector(${target}))`, selector);
    await run(`document.querySelector(${target}).scrollIntoView({ block: "center" })`);
    // 測ってから押すまでに配置が変わると、別の要素を押してしまう。次の描画でも同じ位置で、その要素が押せることを確かめる
    await waitFor(
      `new Promise((resolve) => {
        const element = document.querySelector(${target});
        const box = element?.getBoundingClientRect();
        requestAnimationFrame(() => {
          const now = element?.getBoundingClientRect();
          const same = box && now && box.x === now.x && box.y === now.y && now.width > 0;
          resolve(Boolean(same && element.contains(document.elementFromPoint(now.x + now.width / 2, now.y + now.height / 2))));
        });
      })`,
      `${selector} を押せる`
    );
    const point = await run(`(() => {
      const box = document.querySelector(${target}).getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    }
  };

  // 要素を、右へ dx ピクセル、本物のマウスの操作でドラッグする
  const drag = async (selector, dx) => {
    const target = JSON.stringify(selector);
    await waitFor(`Boolean(document.querySelector(${target}))`, selector);
    const point = await run(`(() => {
      const element = document.querySelector(${target});
      element.scrollIntoView({ block: "center" });
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 5; step += 1) {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + (dx * step) / 5, y: point.y, button: "left", buttons: 1 });
    }
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + dx, y: point.y, button: "left", clickCount: 1 });
  };

  // 圃場図の上の点（圃場の座標。m。x は東、y は北）を、本物のマウスの操作でクリックする
  const clickMap = async (world) => {
    const point = await run(`(() => {
      const map = document.getElementById("map");
      // 図が画面の外にあれば、図まで送る（人が押すときと同じ）
      map.closest(".map-frame").scrollIntoView({ block: "nearest" });
      const p = new DOMPoint(${world[0]}, ${-world[1]}).matrixTransform(map.getScreenCTM());
      return { x: p.x, y: p.y };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, ...point, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
  };

  // 圃場図の上の点（圃場の座標）から、右へ dx ピクセル、本物のマウスの操作でなぞる
  const dragMap = async (world, dx) => {
    const point = await run(`(() => {
      const map = document.getElementById("map");
      // 図が画面の外にあれば、図まで送る（人が押すときと同じ）
      map.closest(".map-frame").scrollIntoView({ block: "nearest" });
      const p = new DOMPoint(${world[0]}, ${-world[1]}).matrixTransform(map.getScreenCTM());
      return { x: p.x, y: p.y };
    })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 5; step += 1) {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + (dx * step) / 5, y: point.y, button: "left", buttons: 1 });
    }
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + dx, y: point.y, button: "left", clickCount: 1 });
  };

  // 画面の幅を変える（スマホの幅を試す）。width を省くと元の大きさに戻す
  const viewport = (width, height = 844) =>
    width
      ? page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
      : page.send("Emulation.clearDeviceMetricsOverride");

  // キーを押して離す（Tab など）。文字を入れるときは type を使う
  const press = async (key, code = key, keyCode = { Tab: 9, Enter: 13 }[key]) => {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  };
  // カーソルのある欄に、文字を打ち込む
  const type = (text) => page.send("Input.insertText", { text });

  const setValue = (selector, value) =>
    run(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);

  // data は DB の中身。stored は、ほかにブラウザーが覚えている値（{ キー: 文字列 }。開いていた圃場など）。
  // until に "fatalError" を渡すと、画面ではなく、起動を止めた知らせが出るまで待つ
  const loadApp = async (data, stored = {}, until = "app") => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    // 前のテストの画面に残った保存が、入れるデータを上書きしないよう、先にアプリではない画面へ移る
    await page.send("Page.navigate", { url: `${origin}/config.js` });
    await waitFor(`location.pathname === "/config.js" && document.readyState === "complete"`, "アプリから離れる");
    const items = { ...stored, [LOCAL_KEY]: JSON.stringify(data) };
    await run(`localStorage.clear(); Object.entries(${JSON.stringify(items)}).forEach(([key, value]) => localStorage.setItem(key, value))`);
    await page.send("Page.navigate", { url: `${origin}/index.html?local=1&strict=1` });
    if (until === "fatalError") {
      await waitFor(`document.getElementById("fatalError")?.hidden === false`, "起動を止めた知らせ");
      page.errors.length = 0;
      return;
    }
    await waitFor(`document.getElementById("viewTabs")?.hidden === false`, "アプリの起動");
    // 起動の途中で styles.css を読み直すので、読み終わるのを待つ（読むあいだは配置が変わる）
    await waitFor(`Boolean(document.querySelector('link[href^="./styles.css"]')?.sheet)`, "見た目の読み込み");
    page.errors.length = 0;
  };

  const close = async () => {
    await page.send("Browser.close").catch(() => {});
    page.close();
    // Chrome が終わるまで待ってから、一時のフォルダーを消す（Windows では、終わる前はファイルをつかんでいて消せない）
    const exited = chrome.exitCode !== null ? Promise.resolve() : new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await new Promise((resolve) => server.close(resolve));
    // 待つのは 5 秒まで。Chrome が先に終わったら、タイマーを止める（残ると、テストのプロセスが終わるのを 5 秒止める）
    let timer;
    await Promise.race([exited, new Promise((resolve) => (timer = setTimeout(resolve, 5000)))]);
    clearTimeout(timer);
    // Chrome の子のプロセスが、終わったあともしばらくファイルをつかんでいることがある。消せなければ残す（OS の一時フォルダーの中）
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EBUSY") {
        throw error;
      }
    }
  };

  return {
    run,
    waitFor,
    click,
    clickMap,
    dragMap,
    viewport,
    drag,
    press,
    type,
    setValue,
    loadApp,
    close,
    errors: page.errors,
    saved: () => run(`JSON.parse(localStorage.getItem(${JSON.stringify(LOCAL_KEY)}))`),
  };
}

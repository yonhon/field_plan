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
      const port = readFileSync(file, "utf8").split("\n")[0].trim();
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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
      socket.send(JSON.stringify({ id, method, params }));
    });
  return new Promise((resolve) => {
    socket.onopen = () => resolve({ send, errors, close: () => socket.close() });
  });
}

// Chrome を開き、テストで使う操作を返す。終わったら close を呼ぶ
export async function openBrowser() {
  const server = await serveApp();
  const profile = mkdtempSync(join(tmpdir(), "field-plan-e2e-"));
  const chrome = spawn(
    findChrome(),
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1500,1100", "about:blank"],
    { stdio: "ignore" }
  );
  const port = await devtoolsPort(profile);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = await connect(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");

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
    throw new Error(`待っても変わりませんでした: ${label}`);
  };

  // 本物のマウスの操作で押す（確認の窓は、スクリプトの click を受け付けない）
  const click = async (selector) => {
    const target = JSON.stringify(selector);
    await waitFor(`Boolean(document.querySelector(${target}))`, selector);
    const point = await run(`(() => {
      const element = document.querySelector(${target});
      element.scrollIntoView({ block: "center" });
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    }
  };

  const setValue = (selector, value) =>
    run(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);

  const loadApp = async (data) => {
    const url = `http://127.0.0.1:${server.address().port}/index.html?local=1&strict=1`;
    await page.send("Page.navigate", { url });
    await waitFor(`document.readyState !== "loading"`);
    await run(`localStorage.clear(); localStorage.setItem(${JSON.stringify(LOCAL_KEY)}, ${JSON.stringify(JSON.stringify(data))})`);
    await page.send("Page.reload");
    await sleep(100);
    await waitFor(`!document.getElementById("viewTabs")?.hidden`, "アプリの起動");
    page.errors.length = 0;
  };

  const close = async () => {
    await page.send("Browser.close").catch(() => {});
    page.close();
    chrome.kill();
    await new Promise((resolve) => server.close(resolve));
    await sleep(200);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };

  return {
    run,
    waitFor,
    click,
    setValue,
    loadApp,
    close,
    errors: page.errors,
    saved: () => run(`JSON.parse(localStorage.getItem(${JSON.stringify(LOCAL_KEY)}))`),
  };
}

// 画像の読み込み（app/upload.js）のテスト。実行: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadWithProgress } from "../app/upload.js";

// 送る側をまねる。script は [待つミリ秒, "progress" | "load" | "error", 値] の並び
function fakeRequest(script, status = 200, responseText = "") {
  return class {
    constructor() {
      this.upload = {};
      this.headers = {};
      this.aborted = false;
      this.status = 0;
      this.responseText = "";
    }
    open(method, url) {
      Object.assign(this, { method, url });
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    abort() {
      this.aborted = true;
    }
    send() {
      let at = 0;
      for (const [wait, kind, value] of script) {
        at += wait;
        setTimeout(() => {
          if (this.aborted) {
            return;
          }
          if (kind === "progress") {
            this.upload.onprogress({ loaded: value, total: 100 });
          } else if (kind === "load") {
            Object.assign(this, { status, responseText });
            this.onload();
          } else {
            this.onerror();
          }
        }, at);
      }
    }
  };
}

const base = { url: "https://example/storage", headers: { authorization: "Bearer t" }, body: { size: 100 } };

test("進み具合を知らせて、終わったら成功", async () => {
  const seen = [];
  await uploadWithProgress({ ...base, Request: fakeRequest([[5, "progress", 40], [5, "progress", 100], [5, "load"]]), onProgress: (loaded, total) => seen.push(`${loaded}/${total}`) });
  assert.deepEqual(seen, ["40/100", "100/100"]);
});

test("遅くても進んでいれば待つ。進まなくなったら止める", async () => {
  // 30 ミリ秒ごとに進む送り方は、40 ミリ秒の見張りでは止めない
  await uploadWithProgress({ ...base, stallMs: 40, Request: fakeRequest([[30, "progress", 30], [30, "progress", 60], [30, "progress", 90], [30, "load"]]) });
  // 途中で止まると、見張りの時間のあとに失敗する
  await assert.rejects(
    uploadWithProgress({ ...base, stallMs: 40, Request: fakeRequest([[10, "progress", 30], [500, "load"]]) }),
    /通信が進まなかったので、止めました/
  );
});

test("断られたときと、通信できないとき", async () => {
  await assert.rejects(uploadWithProgress({ ...base, Request: fakeRequest([[5, "load"]], 403, '{"message":"new row violates row-level security policy"}') }), /row-level security/);
  await assert.rejects(uploadWithProgress({ ...base, Request: fakeRequest([[5, "load"]], 500, "oops") }), /HTTP 500/);
  await assert.rejects(uploadWithProgress({ ...base, Request: fakeRequest([[5, "error"]]) }), /通信できませんでした/);
});

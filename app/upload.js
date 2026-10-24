// 画像を、進み具合を知らせながら上げる。
// 回線が遅くても進んでいれば待つ。stallMs のあいだ少しも進まなければ、止めて知らせる。
export const STALL_MS = 60_000;

export function uploadWithProgress({ url, headers, body, onProgress = () => {}, stallMs = STALL_MS, Request = globalThis.XMLHttpRequest }) {
  return new Promise((resolve, reject) => {
    const xhr = new Request();
    let timer = null;
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        xhr.abort();
        finish(new Error(`${Math.round(stallMs / 1000)} 秒のあいだ通信が進まなかったので、止めました。回線を確かめるか、画像を小さくしてから、もう一度読み込んでください`));
      }, stallMs);
    };
    xhr.open("POST", url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      watch();
      onProgress(event.loaded, event.total || body.size || 0);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish();
        return;
      }
      let message = `HTTP ${xhr.status}`;
      try {
        message = JSON.parse(xhr.responseText).message || message;
      } catch {
        // 本文が JSON でなければ、状態の番号だけを出す
      }
      finish(new Error(message));
    };
    xhr.onerror = () => finish(new Error("通信できませんでした"));
    watch();
    xhr.send(body);
  });
}

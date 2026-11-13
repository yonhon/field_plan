// 起動。index.html が読む。Content-Security-Policy で、HTML の中に書いたスクリプトは動かさないので、ファイルに分けている
// JS の部品は互いに呼び合うので、ブラウザーに残った古い版と新しい版が混ざると、画面が出なくなる。
// Service Worker（sw.js）が一式をそろえて出しているときは、そのまま読む。
// そうでないとき（初めて開いたとき、?local=1）は、読み込む前に、部品ごとにサーバーへ更新を確かめて、手元の控えを新しくしておく
const parts = ["app.js", "geometry.js", "schedule.js", "schedule-view.js", "strip-view.js", "store.js", "crops.js", "crops-view.js", "dialog.js", "draw.js", "journal.js", "history.js", "print.js", "logs.js", "log-view.js", "process-editor.js", "planting-view.js", "pesticide.js", "rac.js", "weather.js", "weather-view.js", "prefs.js", "upload.js", "diary.js", "diary-view.js", "user-menu.js", "field-plans.js", "news-view.js", "toast.js", "html.js"];
// 新しい版のお知らせの「読み込み直す」。保存を送り終えてから読み込み直す（app.js の finishSaves）。
// 送れなかったものが残れば、読み込み直さない
document.getElementById("updateBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "保存を送っています…";
  const request = new CustomEvent("app-before-reload", { detail: { waits: [] } });
  document.dispatchEvent(request);
  const done = (await Promise.all(request.detail.waits).catch(() => [false])).every(Boolean);
  if (done) {
    location.reload();
  } else {
    button.disabled = false;
    button.textContent = label;
  }
});
// ?local=1 は動作確認用なので、Service Worker を登録しない（手元のファイルを直したら、すぐ反映させたい）
if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("local")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
  const checkUpdate = () => navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage("check"));
  const fatal = document.getElementById("fatalError");
  // DB が、この版より新しい画面を求めている（app.js の startApp が知らせる）。画面は出ていない
  let outdated = false;
  // 新しい版を取り終えたら、ふだんは読み込み直すボタンを出す。版が古くて止まっているときは、すぐ読み込み直す
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data === "update-ready") {
      if (outdated) {
        location.reload();
      } else {
        document.getElementById("updateToast").hidden = false;
      }
    } else if (outdated && event.data === "up-to-date") {
      fatal.textContent = "この DB を使うには、アプリの新しい版が要ります。新しい版はまだ公開されていません。数分たってから読み込み直してください。";
    } else if (outdated && event.data === "check-failed") {
      fatal.textContent = "この DB を使うには、アプリの新しい版が要りますが、読み込めませんでした。回線を確かめて、読み込み直してください。";
    }
  });
  // 更新の確認は、画面が出てから行う。起動の読み込みと回線を取り合わないように
  document.addEventListener("app-ready", checkUpdate, { once: true });
  document.addEventListener("app-outdated", () => {
    outdated = true;
    fatal.textContent = "この DB を使うには、アプリの新しい版が要ります。新しい版を読み込んでいます。";
    checkUpdate();
  });
}
// 見た目（styles.css）も、古い版が残っていると新しい部品と合わなくなる。更新を確かめ、版の印（更新日時）を付けて読み直す
async function refreshStyles() {
  const response = await fetch("./styles.css", { cache: "no-cache" });
  const stamp = response.headers.get("last-modified") || response.headers.get("etag");
  const link = document.querySelector('link[href^="./styles.css"]');
  if (stamp && link) {
    link.href = `./styles.css?v=${encodeURIComponent(stamp)}`;
  }
}
try {
  if (!navigator.serviceWorker?.controller) {
    await Promise.all([...parts.map((part) => fetch(`./${part}`, { cache: "no-cache" })), refreshStyles().catch(() => {})]);
  }
  await import("./app.js");
} catch (error) {
  const box = document.getElementById("fatalError");
  box.textContent =
    "画面の部品を読み込めませんでした。Ctrl + Shift + R（Mac は Command + Shift + R）で読み込み直してください。\n" +
    `直らないときは、次の内容を伝えてください: ${error.message}`;
  box.hidden = false;
}

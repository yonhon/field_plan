// Google のログインから戻ったときに動く（google-photos.html）。URL の # の後ろにあるアクセストークンを、開いた画面（同じサイト）へ送る。
// トークンは URL から消し、履歴にも残さない
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const message = document.getElementById("message");
if (window.opener) {
  window.opener.postMessage(
    {
      type: "google-photos-auth",
      state: params.get("state"),
      access_token: params.get("access_token"),
      expires_in: params.get("expires_in"),
      error: params.get("error"),
    },
    location.origin
  );
  if (params.get("error")) {
    message.textContent = "Google フォトの写真の選択が許可されませんでした。この窓は閉じてかまいません。";
  }
} else {
  message.textContent = "開いた画面が見つかりません。この窓を閉じて、日記の「Google フォト」から、もう一度選んでください。";
}

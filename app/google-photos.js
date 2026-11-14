// Google フォトから写真を選ぶ（Google Photos Picker API）。PC では、ファイルを選ぶ窓に Google フォトが出ないため。
// 流れ: 押したその場で窓を開く（あとから開くと、ポップアップとして止められる）→ その窓で Google にログインし、写真の選択を許可する
// （google-photos.html が、受け取ったアクセストークンをこの画面へ送る）→ 同じ窓で Google フォトの選ぶ画面を開く →
// 選び終えたかを Picker API に尋ねて待つ → 選んだ写真を読む。
// ログインの印（アクセストークン）は、この画面を開いているあいだだけ覚える（1 時間ほどで切れる。保存しない）。
// Google の設定（OAuth のクライアント）は、config.js の googleClientId。ログインするアカウントは、クライアントを作ったアカウントと別でよい。
// Google フォトの選ぶ画面は、開いた側との窓のつながりを切る（COOP）ので、窓が閉じたかは分からない。選び終えたかは、API で知る

const SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://photospicker.googleapis.com/v1";
const WINDOW = "field-plan-google-photos";
// 読む写真の大きさ。日記には短い辺 1080 px に縮めて入れる（diary-view.js の shrink）ので、それより大きければよい
const SIZE = "=w2048-h2048";

let token = null; // { value, expires }
let current = null; // 選んでいる途中の { cancelled }

export const googlePhotosEnabled = () => Boolean(window.FIELD_PLAN_CONFIG?.googleClientId);
export const googlePhotosBusy = () => Boolean(current);

// 選んでいる途中でやめる。待っているのをやめるだけで、Google フォトの窓は閉じない（つながりが切れていて閉じられない）
export function cancelGooglePhotos() {
  if (current) {
    current.cancelled = true;
    current.wake?.();
  }
}

const callbackUrl = () => new URL("google-photos.html", document.baseURI).href;

function wait(ms, job) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    job.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// 「5s」「1.5s」の形の時間を、ミリ秒にする
function duration(text, fallback) {
  const seconds = Number.parseFloat(String(text ?? ""));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
}

// Picker API を呼ぶ。ログインの印が切れていたら（401）、印を捨てて知らせる
async function api(method, path) {
  const response = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token.value}` } });
  if (response.status === 401) {
    token = null;
    throw new Error("Google のログインが切れました。もう一度「Google フォト」を押してください。");
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(`Google フォトに問い合わせられませんでした（${response.status}${detail?.error?.message ? `: ${detail.error.message}` : ""}）`);
  }
  return method === "DELETE" ? null : response.json();
}

// 開いた窓で Google にログインし、写真の選択を許可してもらう。google-photos.html が、結果をこの画面へ送る
function authorize(win, job) {
  const state = crypto.randomUUID();
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: window.FIELD_PLAN_CONFIG.googleClientId,
    redirect_uri: callbackUrl(),
    response_type: "token",
    scope: SCOPE,
    include_granted_scopes: "true",
    state,
  }).toString();
  win.location.href = url.href;
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
      error ? reject(error) : resolve(value);
    };
    const onMessage = (event) => {
      const data = event.data;
      if (event.origin !== location.origin || data?.type !== "google-photos-auth" || data.state !== state) {
        return;
      }
      if (data.error || !data.access_token) {
        finish(new Error(data.error === "access_denied" ? "Google フォトの写真の選択が許可されませんでした。" : `Google にログインできませんでした（${data.error || "印がありません"}）`));
        return;
      }
      finish(null, { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60 * 1000 });
    };
    window.addEventListener("message", onMessage);
    // ログインの途中で窓を閉じたとき（ログインの画面は、窓のつながりを切らない）と、やめたとき
    const timer = setInterval(() => {
      if (job.cancelled || win.closed) {
        finish(new Error(job.cancelled ? "" : "Google のログインの窓が閉じられました。"));
      }
    }, 500);
  });
}

// 選んだ写真の一覧（写真だけ。動画は除く）
async function pickedItems(sessionId) {
  const items = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ sessionId, pageSize: "100", ...(pageToken ? { pageToken } : {}) });
    const page = await api("GET", `/mediaItems?${query}`);
    items.push(...(page.mediaItems || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return items.filter((item) => item.type !== "VIDEO" && item.mediaFile?.baseUrl);
}

// 撮影日時（createTime は UTC）を、この端末の時刻で "YYYY-MM-DD HH:MM:SS" にする（写真の EXIF から読む撮影日時と同じ形）
export function localDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 写真を読む。まずブラウザーから直接読み、読めなければ（CORS で止められたら）Supabase の関数を通す
async function download(item, store) {
  const url = `${item.mediaFile.baseUrl}${SIZE}`;
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token.value}` } });
    if (response.ok) {
      return await response.blob();
    }
  } catch {
    // CORS で止められたときは、下で関数を通す
  }
  return store.googlePhoto(url, token.value);
}

// Google フォトで写真を選んでもらい、選んだ写真を [{ blob, name, takenAt }] で返す。やめたときは空。
// onStatus に、いまの段階を文で渡す。ボタンを押したその場で呼ぶ（窓を開くため。await の前に開く）
export async function pickGooglePhotos({ store, onStatus = () => {} }) {
  if (current) {
    return [];
  }
  const win = window.open("", WINDOW, "popup,width=1000,height=760");
  if (!win) {
    throw new Error("Google フォトの窓を開けませんでした。このサイトのポップアップを許可してください。");
  }
  const job = { cancelled: false };
  current = job;
  try {
    if (!token || token.expires <= Date.now()) {
      onStatus("Google にログインしています…");
      try {
        token = await authorize(win, job);
      } catch (error) {
        if (job.cancelled) {
          win.close();
          return [];
        }
        throw error;
      }
    }
    if (job.cancelled) {
      win.close();
      return [];
    }
    onStatus("Google フォトで写真を選んでいます…");
    const session = await api("POST", "/sessions");
    // 選び終えたら、Google フォトの画面が自分で窓を閉じる（autoclose）
    win.location.href = `${session.pickerUri.replace(/\/$/, "")}/autoclose`;
    const interval = Math.max(1000, duration(session.pollingConfig?.pollInterval, 3000));
    const until = Date.now() + duration(session.pollingConfig?.timeoutIn, 30 * 60 * 1000);
    let picked = session.mediaItemsSet;
    while (!picked && !job.cancelled && Date.now() < until) {
      await wait(interval, job);
      if (!job.cancelled) {
        picked = (await api("GET", `/sessions/${session.id}`)).mediaItemsSet;
      }
    }
    if (!picked) {
      api("DELETE", `/sessions/${session.id}`).catch(() => {});
      return [];
    }
    const items = await pickedItems(session.id);
    const photos = [];
    for (const [i, item] of items.entries()) {
      onStatus(`Google フォトから読んでいます ${i + 1}/${items.length}…`);
      photos.push({ blob: await download(item, store), name: item.mediaFile.filename || null, takenAt: item.createTime ? localDateTime(item.createTime) : null });
    }
    // 選んだ一覧は、読み終えたら Google に消してもらう（残しても 1 日ほどで消える）
    api("DELETE", `/sessions/${session.id}`).catch(() => {});
    return photos;
  } finally {
    current = null;
    onStatus("");
  }
}

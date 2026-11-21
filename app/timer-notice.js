// 計測中の作業を、端末の通知欄に出す（「圃場計画　作業中：〇〇　9:12 から」）。文面は today-view.js の計測中の帯から作る。
// 通知を押すと「今日」のタブを出す（sw.js の notificationclick）。
// 許しは、ホーム画面に入れたアプリ（standalone）で、初めて計測を始めたときに 1 度だけ尋ねる。
// 尋ねられるのは本人の操作の続きだけなので、「始める」を押した処理の頭（保存を待つ前）で呼ぶ。
// 許されていなければ、何もしない（計測はいままでどおり）。PC のタブでは尋ねない
const TAG = "field-plan-timer";
const ASKED_KEY = "field_plan_notice_asked";

let shown; // いま出している文面。null は出していない。undefined はまだ分からない（起動のあと、残った通知を消すため）

const supported = () => typeof Notification !== "undefined" && "serviceWorker" in navigator;
const installed = () => window.matchMedia?.("(display-mode: standalone)").matches === true;

// 初めて計測を始めたときに、通知の許しを尋ねる。答えが出たら decided を呼ぶ（許されたら、すぐ通知を出すため）
export function askNoticePermission(decided) {
  if (!supported() || !installed() || Notification.permission !== "default") {
    return;
  }
  try {
    if (localStorage.getItem(ASKED_KEY)) {
      return;
    }
    localStorage.setItem(ASKED_KEY, "1");
  } catch {
    return; // 尋ねたことを覚えられないなら、毎回尋ねることになるので尋ねない
  }
  Notification.requestPermission()
    .then(() => decided?.())
    .catch(() => {});
}

// 通知を text の文面にする。text が null なら消す。同じ文面なら出し直さない
export async function syncTimerNotice(text) {
  if (!supported() || Notification.permission !== "granted" || text === shown) {
    return;
  }
  shown = text;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      return;
    }
    if (text) {
      await registration.showNotification("圃場計画", { body: text, tag: TAG, silent: true, icon: "./icons/icon-192.png", data: { view: "today" } });
    } else {
      for (const notice of await registration.getNotifications({ tag: TAG })) {
        notice.close();
      }
    }
  } catch {
    shown = undefined; // 出せなかったら、次に描くときにもう一度試す
  }
}

// 計測中の通知の文面
export const timerNoticeText = (name, clock) => `作業中：${name}　${clock} から`;

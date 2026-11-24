// 決まった時間のあとに動かす処理（自動保存の 600 ms、お知らせの 2 秒など）を置く。setTimeout の代わりに使う。
// ?local=1（動作確認と通しテスト）のときだけ、window.fieldClock.advance(ms) で、今から ms のうちに来る処理を、
// 時間を待たずに今動かせる。通しテストが、決まった時間を実際に待たずに済むようにするため（2026-11-24）。
// 時間を進めるのはこの部品で置いた処理だけで、Date.now() やほかの setTimeout は進まない。
// fn が Promise を返すと、advance はそれが終わるまで待つ。利用者の答えを待つ処理（確かめの窓など）は返さない
// （返すと、テストの advance が窓の答えを待ったまま止まる）

const timers = new Map(); // id → { fn, due, handle }
let nextId = 1;
let skew = 0; // advance で進めたぶん。この部品の「今」は performance.now() + skew

const now = () => performance.now() + skew;

function arm(id, timer) {
  timer.handle = setTimeout(() => {
    timers.delete(id);
    timer.fn();
  }, Math.max(0, timer.due - now()));
}

// ms のあとに fn を動かす。返す id を cancel に渡すと取りやめる
export function later(fn, ms) {
  const id = nextId++;
  const timer = { fn, due: now() + ms, handle: null };
  timers.set(id, timer);
  arm(id, timer);
  return id;
}

export function cancel(id) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer.handle);
    timers.delete(id);
  }
}

// 今から ms のうちに来る処理を、来る順に今動かす。動かした処理が置いた処理も、ms のうちに来るなら続けて動かす
export async function advance(ms) {
  const until = now() + ms;
  for (;;) {
    const [id, timer] = [...timers].filter(([, item]) => item.due <= until).sort(([, a], [, b]) => a.due - b.due)[0] || [];
    if (!timer) {
      break;
    }
    clearTimeout(timer.handle);
    timers.delete(id);
    // その処理の時刻まで進めてから動かす（その中で置いた処理は、その時刻から数える）
    skew += Math.max(0, timer.due - now());
    await timer.fn();
  }
  skew += Math.max(0, until - now());
  // 残った処理は、進めた時間のぶん早く来るよう、置き直す
  for (const [id, timer] of timers) {
    clearTimeout(timer.handle);
    arm(id, timer);
  }
}

if (new URLSearchParams(location.search).get("local") === "1") {
  window.fieldClock = { advance };
}

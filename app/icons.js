// 元に戻す・やり直す・押しピン・閉じるの印（絵）。パソコン、iPad、スマホのどれでも同じ形にするため、文字（↶ ↷）ではなく
// SVG で描く。文字の ↶ ↷ は書体（Zen Kaku Gothic New）に入っておらず、端末ごとに別の書体で描かれて、形が変わっていた。
// 形は、いのーファームのロゴ（円と波。線の端は四角い）と書体の線の細さに合わせる（2026-11-18 に本人と決めた）。
//   矢印: ロゴのいちばん上の波と同じ曲線の山（2 次の曲線）に、「く」の字の矢じり。やり直すは、元に戻すの左右の裏返し
//   押しピン: 45 度傾けた押しピン。頭の上の辺を矢印と同じ波の山の曲線にし、8 割に縮めて矢印と大きさをそろえる
// どれも 24 × 24 の枠、線の太さ 1.7、端は四角。大きさは CSS で決める（ヘッダーの文字の横は 16px、スマホの印は 24px）
const STROKE = 1.7;
const PIN_SCALE = 0.8;

const icon = (paths) =>
  `<svg xmlns="http://www.w3.org/2000/svg" class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="butt" stroke-linejoin="miter">${paths}</svg>`;

export const UNDO_ICON = icon('<path d="M20 15.5Q14 4 6.2 13.6"/><path d="M5.6 8.6v5.6h5.6"/>');
export const REDO_ICON = icon('<path d="M4 15.5Q10 4 17.8 13.6"/><path d="M18.4 8.6v5.6h-5.6"/>');
// 縮めると線も細くなるので、縮めた割合で割った太さを指定して、矢印と同じ太さに見せる
const PIN_STROKE = Math.round((STROKE / PIN_SCALE) * 1000) / 1000;
export const PIN_ICON = icon(
  `<g transform="translate(12 12.3) rotate(45) scale(${PIN_SCALE}) translate(-12 -12)" stroke-width="${PIN_STROKE}">` +
    '<path d="M8.5 5Q12 1.6 15.5 5"/><path d="M10 4.3v4.7l-3.2 4h10.4l-3.2-4V4.3"/><path d="M12 13v7.5"/></g>'
);
export const CLOSE_ICON = icon('<path d="M7 7l10 10M17 7L7 17"/>');

// 「今日」のタブの、作業を始めるボタンの絵（2026-11-25 に本人と決めた）。観察は目、準備・片付けは箱。
// 移動は、出発の点から目的地の印までの点線の山（ロゴの波に近い形）。矢印はブラウザーの操作でよく見るので使わない。
// 計画にない作業はスコップ。＋ は「＋ 入力する」で使っているので使わない
export const OBSERVE_ICON = icon('<path d="M2 12Q12 2.5 22 12Q12 21.5 2 12Z"/><circle cx="12" cy="12" r="3.2"/>');
export const PREP_ICON = icon('<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5"/><path d="M12 12v9"/>');
export const MOVE_ICON = icon(
  '<circle cx="5" cy="18" r="2.2"/><path d="M7 16.8Q12 8 16.5 12.5" stroke-dasharray="2.2 2"/>' +
    '<path d="M18.5 12.2c-2.6-2.9-3.9-4.9-3.9-6.5a3.9 3.9 0 0 1 7.8 0c0 1.6-1.3 3.6-3.9 6.5z"/><circle cx="18.5" cy="5.7" r="1.2"/>'
);
export const SHOVEL_ICON = icon('<path d="M9 3h6"/><path d="M12 3v10"/><path d="M8 13h8v3.5a4 4 0 0 1-8 0z"/>');
// 計測の印。始める（三角）と止める（四角）は塗り、完了はチェックの線（太め）
const solid = (paths) =>
  `<svg xmlns="http://www.w3.org/2000/svg" class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" stroke="none">${paths}</svg>`;
export const PLAY_ICON = solid('<path d="M7 4.5v15L19.5 12z"/>');
export const STOP_ICON = solid('<rect x="6" y="6" width="12" height="12" rx="1.5"/>');
export const CHECK_ICON = icon('<path d="M4.5 12.5l5 5L19.5 7" stroke-width="2.4"/>');

const ICONS = { undo: UNDO_ICON, redo: REDO_ICON, pin: PIN_ICON, close: CLOSE_ICON };

// data-icon="undo" などの印のあるボタンの、文字の前に絵を入れる（index.html のボタン。起動のときに 1 度呼ぶ）。
// 中身を描き直さず（draw を使わず）、絵の要素だけを先頭に足す。文字はそのまま残る
export function decorateIcons(root = document) {
  for (const button of root.querySelectorAll("[data-icon]")) {
    const markup = ICONS[button.dataset.icon];
    if (markup && !button.querySelector("svg.icon")) {
      const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
      button.prepend(document.importNode(svg, true));
    }
  }
}

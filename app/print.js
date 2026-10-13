// PDF 出力。ブラウザーの印刷を開き、出力先で「PDF に保存」を選んでもらう。
// 画面とは別の、印刷だけに出る枠（printArea）に中身を入れて、ほかを隠す

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// A4 の、余白 10 mm を除いた印刷できる範囲（CSS の px。1 mm は 96 / 25.4 px）。見出しのぶん、高さを 12 mm 引く
export const PAGE_PX = { landscape: [1047, 672], portrait: [718, 1031] };
export const pxToMm = (px) => (px * 25.4) / 96;

let pageTitle = null; // 印刷のあいだだけ変える、画面の題名の元の値

function clear() {
  if (pageTitle !== null) {
    document.title = pageTitle;
    pageTitle = null;
  }
  document.body.classList.remove("is-printing");
  document.getElementById("printArea").innerHTML = "";
}

// name は保存するときのファイル名（拡張子なし）、title は紙の上に出す見出し、
// body は中身の HTML、landscape は紙を横に使うかどうか
export function printPage({ name, title, body, landscape }) {
  let area = document.getElementById("printArea");
  if (!area) {
    area = document.createElement("div");
    area.id = "printArea";
    document.body.append(area);
    const style = document.createElement("style");
    style.id = "printPageStyle";
    document.head.append(style);
  }
  document.getElementById("printPageStyle").textContent = `@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 10mm; }`;
  area.innerHTML = `<h1 class="print-title">${escapeHtml(title)}</h1>${body}`;
  document.body.classList.add("is-printing");
  // ブラウザーは、画面の題名を、保存するファイル名の初めの値にする
  pageTitle ??= document.title;
  document.title = name;
  // 印刷の画面を閉じたあと、次に画面を触ったときに片づける
  // （閉じる前に片づけると、機種によっては、画面全体が印刷されてしまう）
  window.addEventListener(
    "afterprint",
    () => {
      for (const type of ["pointerdown", "keydown"]) {
        window.addEventListener(type, clear, { once: true, capture: true });
      }
    },
    { once: true }
  );
  window.print();
}

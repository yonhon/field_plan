// 画面の一部を描き直す共通の関数。画面は、入れ物の中身を HTML の文字列で丸ごと作り直して描く。
// そのままでは、スクロールの位置と入力欄のカーソルが失われる（窓の中がいちばん上へ戻る、Tab で移った先の欄が消える）。
// draw は、作り直す前に、触っていた所の画面の上での高さ、スクロールの位置、カーソルのある欄を覚えておき、
// 作り直したあと、同じ所を同じ高さに戻し、カーソルも戻す。
// 中身を入れ替えるときは、innerHTML を直接書かず、いつも draw を通す（tests/draw.test.mjs が確かめる）。
// 将来、違う所だけを書き換える仕組みに替えるときは、この関数の中身だけを替える（docs/implementation-rules.md）

let touched = null; // 最後に押した、または入った要素
// Tab で欄を移っている途中なら、元の欄と向き。値を変えて Tab を押すと、元の欄を離れたときの保存がすぐ終わり、
// 移る先の欄が決まったあと、カーソルが入る前に作り直すことがある。そのときは移る先の欄が消え、カーソルはどこにも入らない
let tabbing = null;

// 押したときと、入力欄に入ったとき（Tab で移ったときも）に覚える。どの入れ物の中かは、描くときに確かめる
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (event) => (touched = event.target), true);
  document.addEventListener("focusin", (event) => (touched = event.target), true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Tab") {
        tabbing = { from: document.activeElement, back: event.shiftKey };
        setTimeout(() => (tabbing = null));
      }
    },
    true
  );
}

// Tab で移る先の欄。from の次（back なら前）の、押せる要素。窓が開いていれば、窓の中だけで探す
function nextFocusable(from, back) {
  const scope = from.closest("dialog[open]") || document;
  const all = [...scope.querySelectorAll("input, select, textarea, button, a[href], [tabindex]")].filter(
    (el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0
  );
  const i = all.indexOf(from);
  return i < 0 ? null : all[i + (back ? -1 : 1)] || null;
}

const attrsOf = (el) => [...el.attributes].filter((attr) => attr.name === "id" || attr.name.startsWith("data-"));

// 同じ要素を、作り直したあとに探すための鍵。入れ物から要素までの道筋で、
// id か data-* の属性を持つ要素は、その属性で探す（間に入れ物が増えても見つかる）。
// 属性を持たない要素は、それより下に属性を持つ要素がなければ、同じ種類の何番目の子かで探す。
// 同じ属性の要素がいくつもあるときは、何番目かも持つ
function keyOf(el, root) {
  const chain = [];
  for (let node = el; node && node !== root; node = node.parentElement) {
    chain.unshift(node);
  }
  if (chain[0]?.parentElement !== root) {
    return null; // 入れ物の中ではない
  }
  const lastWithAttrs = chain.findLastIndex((node) => attrsOf(node).length);
  const steps = [];
  let base = root;
  chain.forEach((node, i) => {
    const attrs = attrsOf(node);
    if (attrs.length) {
      const selector = node.localName + attrs.map((attr) => `[${attr.name}="${CSS.escape(attr.value)}"]`).join("");
      steps.push({ selector, index: [...base.querySelectorAll(selector)].indexOf(node) });
      base = node;
    } else if (i > lastWithAttrs) {
      steps.push({ child: node.localName, index: [...node.parentElement.children].filter((item) => item.localName === node.localName).indexOf(node) });
      base = node;
    }
  });
  return steps;
}

function findByKey(root, steps) {
  let node = root;
  for (const step of steps) {
    const found = step.selector ? node.querySelectorAll(step.selector) : [...node.children].filter((item) => item.localName === step.child);
    node = found[step.index];
    if (!node) {
      return null;
    }
  }
  return node;
}

// 要素を縦にスクロールしている入れ物。なければ画面全体
function scrollerOf(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return document.scrollingElement;
}

// 作り直す前の様子を覚える。返り値は、作り直したあとに呼ぶと元に戻す関数
function keep(root) {
  // 中でスクロールしている要素の位置（窓の中など。作り直すと 0 に戻る）
  const scrolls = [];
  if (!(root instanceof SVGElement)) {
    for (const el of root.querySelectorAll("*")) {
      if (el.scrollTop || el.scrollLeft) {
        scrolls.push({ key: keyOf(el, root), top: el.scrollTop, left: el.scrollLeft });
      }
    }
  }
  // 触った要素から外へたどり、作り直したあとにも残っていそうな要素を目印にする（選んだ検索結果は消えるので、その行など）。
  // 図（SVG）の要素は、ドラッグで動くものなので目印にしない（動かした図形に合わせて画面が動いてしまう）
  const anchors = [];
  for (let el = touched?.isConnected && root.contains(touched) ? touched : null; el && el !== root; el = el.parentElement) {
    if (!(el instanceof SVGElement) && attrsOf(el).length) {
      anchors.push({ key: keyOf(el, root), top: el.getBoundingClientRect().top });
    }
  }
  const active = document.activeElement;
  const focusKey = active && active !== root && root.contains(active) ? keyOf(active, root) : null;
  const selection = focusKey && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  // カーソルが入れ物の中の欄から Tab で離れ、まだどこにも入っていない
  const tabFrom = !focusKey && tabbing?.from && tabbing.from !== root && root.contains(tabbing.from) ? { key: keyOf(tabbing.from, root), back: tabbing.back } : null;
  return () => {
    for (const scroll of scrolls) {
      const el = scroll.key && findByKey(root, scroll.key);
      if (el) {
        el.scrollTop = scroll.top;
        el.scrollLeft = scroll.left;
      }
    }
    for (const anchor of anchors) {
      const el = anchor.key && findByKey(root, anchor.key);
      if (el) {
        const moved = el.getBoundingClientRect().top - anchor.top;
        if (Math.abs(moved) >= 1) {
          scrollerOf(el).scrollTop += moved;
        }
        break;
      }
    }
    const focused = focusKey && findByKey(root, focusKey);
    if (focused) {
      focused.focus({ preventScroll: true });
      if (selection && typeof focused.selectionStart === "number") {
        focused.setSelectionRange(...selection);
      }
    }
    const from = tabFrom?.key && findByKey(root, tabFrom.key);
    if (from) {
      nextFocusable(from, tabFrom.back)?.focus({ preventScroll: true });
    }
  };
}

// 入れ物の中身を、html で丸ごと作り直す。スクロールの位置とカーソルは、作り直す前と同じ所に戻す
export function draw(root, html) {
  if (!root) {
    return;
  }
  const restore = root.isConnected && root.firstChild ? keep(root) : null;
  root.innerHTML = html;
  restore?.();
}

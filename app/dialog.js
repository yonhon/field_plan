// お知らせの窓。ブラウザー標準の alert は文を選んでコピーできないので、ページの中の窓で出す。
// 文はマウスで選べて、「文をコピー」でもコピーできる。確認（はい・いいえ）と入力は、標準の窓のまま。

let box = null;

function build() {
  box = document.createElement("dialog");
  box.className = "notice";
  box.innerHTML =
    '<p class="notice-text"></p>' +
    '<div class="row"><button class="primary-btn" data-action="close">OK</button>' +
    '<button class="text-btn" data-action="copy">文をコピー</button></div>';
  box.addEventListener("click", async (event) => {
    const action = event.target.dataset.action;
    if (action === "close") {
      box.close();
    } else if (action === "copy") {
      const text = box.querySelector(".notice-text").textContent;
      try {
        await navigator.clipboard.writeText(text);
        event.target.textContent = "コピーしました";
      } catch {
        // 上の方法を許していないブラウザーでは、文を選んで、古い方法でコピーする。
        // それも通らなければ、文を選んだ状態のままにして、手でコピーできるようにする
        getSelection().selectAllChildren(box.querySelector(".notice-text"));
        if (document.execCommand("copy")) {
          event.target.textContent = "コピーしました";
        }
      }
    }
  });
  document.body.append(box);
}

export function notify(message) {
  if (!box) {
    build();
  }
  // 続けて呼ばれたら、前の文の下に足す
  const text = box.querySelector(".notice-text");
  text.textContent = box.open ? `${text.textContent}\n\n${message}` : message;
  box.querySelector('[data-action="copy"]').textContent = "文をコピー";
  if (!box.open) {
    box.showModal();
  }
}

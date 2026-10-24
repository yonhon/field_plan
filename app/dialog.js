// お知らせの窓。ブラウザー標準の alert は文を選んでコピーできないので、ページの中の窓で出す。
// 文はマウスで選べて、「文をコピー」でもコピーできる。入力は、標準の窓のまま。
// 消す操作の確認も、ページの中の窓で出す（confirmDelete）。

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

// 消す操作の確認。ブラウザー標準の confirm は OK が初めから選ばれていて、Enter やスペースを押すと
// 見えないうちに OK になるので使わない。初めは「キャンセル」を選んでおき、「削除する」は
// マウスか指で押したときだけ受け付ける。消すものの名前は太字で出す。返り値は、消してよいとき true
export function confirmDelete(message, name) {
  const dialog = document.createElement("dialog");
  dialog.className = "notice";
  dialog.innerHTML =
    '<p class="notice-text"></p><p class="notice-target"></p>' +
    '<div class="row"><button class="text-btn" data-action="cancel">キャンセル</button>' +
    '<button class="danger-btn" data-action="delete">削除する</button></div>';
  dialog.querySelector(".notice-text").textContent = message;
  dialog.querySelector(".notice-target").textContent = name;
  dialog.querySelector(".notice-target").hidden = !name;
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("click", (event) => {
      const action = event.target.dataset.action;
      // キーボードで押されたボタンの click は detail が 0 になる
      if (action === "cancel" || (action === "delete" && event.detail > 0)) {
        dialog.returnValue = action;
        dialog.close();
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "delete");
    });
    dialog.showModal();
    dialog.querySelector('[data-action="cancel"]').focus();
  });
}

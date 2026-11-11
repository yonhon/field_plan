# field_plan

- 処理を書くとき、直すときは `docs/implementation-rules.md` を守る。
- 画面を作るとき、直すときは `docs/design-rules.md` を守る。
- テストは `node --test "tests/*.test.mjs"`。画面の操作の流れを変えたら、`node --test "tests/e2e/*.test.mjs"` も動かす。
- 通しテストを動かしたら、かかった時間と、失敗したことや終わらなかったことと、その原因を `docs/e2e-runs.md` に足す。切り上げる時間もそこに書いてある（全体 60 秒）。超えたら止めてやり直し、全体が通るまで続ける。

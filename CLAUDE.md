# field_plan

- 処理を書くとき、直すときは、直す前に `AGENTS.md`（実装のきまり。英語）を読んで守る。jev-lint が読むので、`AGENTS.md` は英語で書く。
- 画面を作るとき、直すときは `docs/design-rules.md` を守る。
- コードを直したら、コミットしないときも、終える前に必ず `node --test "tests/*.test.mjs"` を流す。通しテストは `node --test "tests/e2e/*.test.mjs"`。
- 計算のファイル（`mutation/mutator.config.json` の `include`）を直したら、コミットの前に `node mutation/run.mjs --since HEAD` も動かす。結果の扱いは `AGENTS.md` の「Checks」にある。
- コミットの前に、`AGENTS.md` の「Checks」の手順（通しテスト、mutator など）を済ませる。
- コミットの前に、変更を `git add` してから `npx -y jev-lint@0.10.0 commits --staged` で、変更を `AGENTS.md` に照らす（環境変数 `TYPESAFE_API_KEY` が要る。README の 12 章）。指摘が出たら確かめ、当たっていれば直す。
- 通しテストを動かしたら、かかった時間と、失敗したことや終わらなかったことと、その原因を `docs/e2e-runs.md` に足す。切り上げる時間と、それを見直すときもそこに書いてある（全体 120 秒）。超えたら止めてやり直し、全体が通るまで続ける。

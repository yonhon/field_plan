半年に 1 度の、画面の速さと、計算のテストの効き目の確かめです。

画面の速さの確かめです（`docs/performance.md`）。

- [ ] main を最新にし、ほかの重い処理を止める
- [ ] `node scripts/perf/run.mjs --record` で測る（いまの量と 1 年後の量）。前回と大きく違えば測り直す
- [ ] `docs/perf-runs.md` の前回の記録と比べ、「レビューに進む目安」（`docs/performance.md`）に当たるかを確かめ、気づいたことを最後の欄に書く
- [ ] iPhone（Safari）で、起動とタブの切り替え（日程、圃場図、台帳、履歴）を試し、もたつきを感じるかを、この Issue に書く
- [ ] Android の Chrome で、しばらく使っていなかったあとの起動のネットワークの記録を取り、`docs/perf-runs.md` の「実機の起動」の表に足す（取り方は `docs/performance.md` の「実機の起動のログ」）
- [ ] 本番のデータの件数が、前のレビューのときの 2 倍ほどになっていないかを確かめる（件数は、この Issue に書かない）
- [ ] 目安に当たったら、本物のデータでレビューし、直す候補を `performance` のラベルの Issue にする

計算のテストの効き目の確かめです（Mutation testing。docs/development.md の「Mutation testing」）。

- [ ] `node mutation/run.mjs` で全体を回し（7 分ほど）、`node mutation/summary.mjs` の表を `docs/mutation-runs.md` に足す
- [ ] `docs/mutation-runs.md` の前の記録より点数が下がったファイルは、`mutation/report/index.html` で Survived と NoCoverage を見て、直した所に当たるものにテストを足す
- [ ] StrykerJS で検算する: `node scripts/mutation.mjs app/geometry.js app/logs.js` と `node mutation/run.mjs app/geometry.js app/logs.js` を回し、`node mutation/summary.mjs --compare` の表を `docs/mutation-runs.md` の「StrykerJS との検算」に足す。どちらかだけで気づかない行が多ければ、どちらかの不具合を疑う
- [ ] 前回から増えた計算のファイルで、テストが行の 9 割以上を通るものは、`mutation/mutator.config.json` の `include` に足す

- [ ] 記録をコミットし、この Issue を閉じる

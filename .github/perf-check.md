半年に 1 度の、画面の速さの確かめです（`docs/performance.md`）。

- [ ] main を最新にし、ほかの重い処理を止める
- [ ] `node scripts/perf/run.mjs --record` で測る（いまの量と 1 年後の量）。前回と大きく違えば測り直す
- [ ] `docs/perf-runs.md` の前回の記録と比べ、「レビューに進む目安」（`docs/performance.md`）に当たるかを確かめ、気づいたことを最後の欄に書く
- [ ] iPhone（Safari）で、起動とタブの切り替え（日程、圃場図、台帳、履歴）を試し、もたつきを感じるかを、この Issue に書く
- [ ] Android の Chrome で、しばらく使っていなかったあとの起動のネットワークの記録を取り、`docs/perf-runs.md` の「実機の起動」の表に足す（取り方は `docs/performance.md` の「実機の起動のログ」）
- [ ] 本番のデータの件数が、前のレビューのときの 2 倍ほどになっていないかを確かめる（件数は、この Issue に書かない）
- [ ] 目安に当たったら、本物のデータでレビューし、直す候補を `performance` のラベルの Issue にする
- [ ] 記録をコミットし、この Issue を閉じる

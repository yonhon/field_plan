# Mutation testing の記録

計算のテストが計算の誤りに気づくかを確かめる Mutation testing（mizchi/mutator。README の 12 章）の結果を残します。
次のときに足します。前の記録と比べ、大きく変わったら理由を調べます。

- mutator の版を上げたとき（`mutation/package.json`）。上げる前と同じ形で全体を回し、点数が大きく変わらないかを確かめる。変わったら、下の「StrykerJS との検算」でも確かめ、mutator の不具合らしければ版を戻す。
- 1 月と 7 月の定期の確かめ（`.github/perf-check.md`）。

表は `node mutation/run.mjs`（全体）のあとに `node mutation/summary.mjs` で出します。点数は、気づいた変異（Killed、Timeout）の割合で、気づかない変異は Survived（テストは通るが気づかない）と NoCoverage（どのテストも通らない）です。`app/pesticide.js` は、テストのない画面の部分の NoCoverage で点数が下がるので、点数ではなく、計算の関数（289 行目から 547 行目あたり）の Survived を見ます。

## 全体の結果

### 2026-11-19、mutator 0.4.5、Vitest 5.1.1、Windows 11、Node 24.16.0、単体テスト 234 件

全体で 7 分 23 秒（変異 6,984 件）。

| ファイル | 点数 | 変異 | Killed | Timeout | Survived | NoCoverage |
|---|---|---|---|---|---|---|
| app/crops.js | 76.5% | 213 | 163 | 0 | 38 | 12 |
| app/diary.js | 70.7% | 1028 | 677 | 50 | 241 | 60 |
| app/geometry.js | 91.4% | 699 | 632 | 7 | 55 | 5 |
| app/logs.js | 82.2% | 1507 | 1225 | 14 | 224 | 44 |
| app/pesticide.js | 42.4% | 964 | 409 | 0 | 26 | 529 |
| app/rac.js | 37.5% | 1137 | 422 | 1 | 688 | 23 |
| app/schedule.js | 77.3% | 736 | 569 | 0 | 161 | 6 |
| app/upload.js | 75.5% | 53 | 40 | 0 | 12 | 1 |
| app/weather.js | 65.8% | 647 | 426 | 0 | 170 | 51 |

rac.js の Survived の多くは、アイコンの色の値（文字列）。

### 2026-11-21、mutator 0.5.0（0.4.5 から上げた）、Vitest 5.1.1、Windows 11、Node 24.16.0、単体テスト 257 件

上げる前に、同じコードで 0.4.5 の全体も回して比べた。全体で 7 分 22 秒（変異 7,189 件）。上げたあとの最初の 1 回は、前回の結果（`.mutator/`）を作り直すので、すべて回し直す。

| ファイル | 点数 | 変異 | Killed | Timeout | Survived | NoCoverage |
|---|---|---|---|---|---|---|
| app/crops.js | 76.5% | 213 | 163 | 0 | 38 | 12 |
| app/diary.js | 70.7% | 1028 | 677 | 50 | 241 | 60 |
| app/geometry.js | 91.4% | 699 | 632 | 7 | 55 | 5 |
| app/logs.js | 86.6% | 1507 | 1261 | 14 | 172 | 26 |
| app/pesticide.js | 43.7% | 964 | 418 | 0 | 13 | 525 |
| app/rac.js | 37.6% | 1137 | 422 | 1 | 686 | 23 |
| app/schedule.js | 77.3% | 736 | 569 | 0 | 161 | 6 |
| app/upload.js | 75.5% | 53 | 40 | 0 | 12 | 1 |
| app/weather.js | 65.8% | 647 | 426 | 0 | 170 | 51 |
| app/work-time.js | 100.0% | 205 | 204 | 0 | 0 | 0 |

0.4.5 との違い:

- 7,189 件のうち 7,183 件が同じ結果。違ったのは rac.js のアイコンの絵を描く所（117〜136 行）の 6 件で、Survived と RuntimeError が入れ替わった。この 6 件だけを 0.5.0 で回し直すと 6 件とも Survived で、同じ版でも実行のたびに揺れる。版の違いではない。critical の関数ではない。
- 記録した等価な変異（`mutator.accepted.json` の 43 件）は、そのまま使えた。critical の関数は 941 件に気づき、気づかない 0 件、記録 42 件で、変わらない。
- `--reporter agent`（Claude 向けの JSON）に、テストの出力が混ざらなくなった（mizchi/mutator#39）。
- 一部のファイルだけを回すと、回さなかったファイルの記録が、`acceptance.stale`（もうない変異）として挙がる。記録のある logs.js、pesticide.js、work-time.js を含めて回すと 0 件。stale を見て記録を消すのは、全体を回したときだけにする。

ほぼ同じ結果なので、StrykerJS での検算はしなかった。

## StrykerJS との検算

mutator の結果が正しいかを、仕組みの違う StrykerJS（`node scripts/mutation.mjs`）と比べて確かめます。両方を同じファイルで回し、`node mutation/summary.mjs --compare` で、どちらかだけで「気づかない」になった行を出します。差が数行なら、どちらも正しく動いています。大きくずれたら、どちらかの不具合を疑います（mutator 0.3.0 では、前の実行の計装していないモジュールを使い回して、テストがあるのに NoCoverage になる不具合があった。mizchi/mutator#22）。

### 2026-11-19、mutator 0.4.5 と StrykerJS 10.1.1

| ファイル | 時間（mutator / Stryker） | 気づかない（mutator / Stryker） | mutator だけで気づかない行 | Stryker だけで気づかない行 |
|---|---|---|---|---|
| app/geometry.js | 37 秒 / 190 秒 | 60 / 59 | 153 | なし |
| app/schedule.js | 96 秒 / 169 秒 | 167 / 167 | なし | なし |
| app/logs.js | 87 秒 / 298 秒 | 268 / 264 | 591 | なし |

## critical の関数

農薬の使用回数、使用基準、量、指摘にかかわる関数（`app/logs.js` の 14、`app/pesticide.js` の 11）に `// mutator-critical` を付けている（README の 12 章）。

| 日 | mutator | 気づいた | 気づかない | 記録した等価な変異 | メモ |
|---|---|---|---|---|---|
| 2026-11-19 | 0.4.5 | 941 | 0 | 42 | 付けたときは 87 件が気づかなかった。テストを 8 件足して 45 件を Kill し、残りの 42 件は等価として `mutator.accepted.json` に理由を付けて記録した。今のコードの誤りは見つからなかった |

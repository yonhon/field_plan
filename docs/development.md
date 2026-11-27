# 開発の手順

処理を書くとき、直すときは [AGENTS.md](../AGENTS.md)（実装のきまり。英語）を、画面を作るとき、直すときは [design-rules.md](design-rules.md) を守ります。
それぞれのファイルが何をするかは、ファイルの先頭のコメントに書いています（`head -3 app/*.js` で一覧できる）。

## 画面の部分とファイル

ファイルの名前から場所が分かりにくいものです。ここにないものは、画面の名前のファイル（日程なら `schedule-view.js`、計算は `schedule.js`）にあります。
2 列目の `…` は、`app/` のファイル名か、リポジトリの直下からのパスで書きます。「`ファイル` の `名前`」と書いた名前は、そのファイルの中にあることを、`tests/head-comment.test.mjs` が確かめます。

| 画面の部分 | ファイル |
|---|---|
| 圃場図（描く、作図、区画と畝の編集、下絵、図形の保存と送り直し）、タブの切り替えと URL、ログイン | `app.js` |
| 台帳の「工程作業日数」のサブタブ | `schedule-view.js` の `renderTypes`（台帳の枠は `crops-view.js`） |
| 日程の画面の「区画と畝」の図 | `strip-view.js` |
| 「作業を入力する」の窓、最近の実績、管理作業の計画、完了と取りやめ | `log-view.js` |
| 「作業を入力する」の窓の「工程の計画」のタブ | `process-editor.js` |
| 「作業を入力する」の窓の「収量と単価」のタブ | `forecast-editor.js` |
| 作付の詳細（区画の詳細を含む） | `planting-view.js` |
| 圃場の設定の窓の「気象」のタブ | `weather-view.js` |
| 圃場図の上のタブの「ニュース」 | `news-view.js` |
| 計測中の作業の、端末の通知欄 | `timer-notice.js`（帯は `today-view.js`） |
| ヘッダーの左上のロゴとメニュー | `user-menu.js` |
| 「圃場とプラン」の窓 | `field-plans.js` |
| 変更の履歴の画面 | `journal.js`（アプリの更新の一覧は `updates.json`） |
| スマホの元に戻す・やり直すの小さな窓 | `undo-pad.js`（印は `icons.js`、戻す仕組みは `history.js`） |
| ヘッダーの下に出るお知らせ | `toast.js` |
| お知らせの窓（文をコピーできる） | `dialog.js` |
| 日記の「Google フォト」 | `google-photos.js`、`google-photos.html`、`google-photos-callback.js`（中継は `supabase/functions/field-photos/`） |
| 農薬の使用基準と、農薬名の後ろの RAC コードのアイコン | `pesticide.js`、`rac.js`（`config.js` の `famic` で外せる） |
| 2 週間気温予報 | `weather.js`（読むのは `supabase/functions/field-weather/`） |

## テーブル

```
fields（圃場。active_plan_id で実際に使うプランを指す）
├─ backdrops（下絵の位置合わせ）
├─ work_logs（作業の記録。プランではなく圃場に付ける）
│  ├─ work_log_targets（対象の畝・区画と、つながる計画の作業）
│  └─ work_log_inputs（使った資材）
├─ work_sessions（作業時間の計測。始めた時刻と止めた時刻、計画の作業の ID か、つないだ記録）
└─ plans（プラン）
   └─ zones（区域。有効圃場、物置、井戸、通路など）
      └─ blocks（耕起対象区画。始まる日となくなる日を持つ）
         ├─ works（畝立ての前までの作業）
         └─ beds（畝。なくなる日を持つ）
            └─ plantings（作付）
               └─ works（畝立てから後の作業）

work_types（作業の種類と目安の日数。plannable が false の種類は記録だけに使う）、crops（品目の設定値）、fertilizers（肥料）、
dev_notes（開発日誌のメモ）は、すべての圃場で共通

weather_daily（アメダスの観測所ごとの日ごとの気温と降水量）、
famic_imports・famic_products・famic_uses（FAMIC の農薬登録情報。画面からは読むだけ）、
rac_imports・rac_codes（有効成分ごとの RAC コード。画面からは読むだけ）、
app_compat（この DB を使ってよい画面の版。画面からは読むだけ）も共通
```

圃場はいくつも持てます。外形、下絵、プランは圃場ごとです。
図形は、圃場の基準点を原点としたメートル座標の多角形で持ちます。
区画、畝、作付、作業はどれもプランの ID を持ち、プランごとにまとめて読み込みます。

## アプリの更新の一覧

アプリそのものに加えた変更は、`app/updates.json` に書きます。変更の履歴の画面に、「アプリ」の札と A の付いた番号で出ます（[使い方](manual.md)の「アプリの更新」）。

| 項目 | 内容 |
|---|---|
| `no` | 通し番号。足すたびに 1 ずつ増やす |
| `date` | 公開した日 |
| `title` | 何ができるようになったか |
| `body` | 使う人に向けた説明 |
| `reason` | なぜ変えたか。きっかけになった困りごと |

push のたびに、できるようになったことごとに 1 件ずつ足します。
このファイルは公開されるので、圃場の場所、面積、実際の品目や時期は書きません。

## 手元で動かす

```
python -m http.server 8765 --directory app
```

`http://localhost:8765/` を開きます。`http://localhost:8765/?local=1` にすると、ログインも DB も使わず、そのブラウザーの中だけに保存します。`http://localhost:8765/?local=1&strict=1` にすると、さらに保存を遅らせ、親のない行を DB と同じように断ります。保存の順序の誤りを見つけるのに使います。

## テスト

テストは次のとおりです。

```
node --test "tests/*.test.mjs"
```

このテストは、`main` に push したときにも GitHub の上で動きます（`.github/workflows/deploy_app.yml`）。通らなければ、アプリは公開されません。

`tests/head-comment.test.mjs` は、Git にあるコードのファイル（`.js`、`.mjs`、`.ts`、`.py`、`.sql`。`app/vendor/` は除く）が、1 行目に何をするファイルかのコメントを持つことを確かめます。ファイルやフォルダーを足しても、自動で対象に入ります。ファイルごとの役目は、この文書や README に表で書かず、ファイルの先頭に書きます。あわせて、上の「画面の部分とファイル」の表が、あるファイルと名前を指していることも確かめます。

主な操作を Chrome で通して動かすテストは、次のとおりです。`?local=1&strict=1` で動かすので、ログインも DB も使いません。Chrome は、いつもの場所か、環境変数 `CHROME_PATH` の場所から探します。見つからなければ、テストを飛ばします。

```
node --test "tests/e2e/*.test.mjs"
```

## Mutation testing

計算のテストが、計算の誤りに本当に気づくかは、Mutation testing（[mizchi/mutator](https://github.com/mizchi/mutator)）で確かめます。計算のコードを 1 か所ずつ書き換え（`<` を `<=` に、`+` を `-` にする、など）、そのたびに、その所を通るテストだけを Vitest で動かして、テストが失敗するかを見ます。失敗しなかった書き換えは、テストが確かめていない所です。Survived はテストが通るが気づかないもの、NoCoverage はどのテストも通らないものです。

mutator と Vitest は `mutation/` にだけ入れます（リポジトリの直下には package.json と node_modules を置かない）。計算のテストは `tests/test-api.mjs` から `test` を読むので、`node --test` でも Vitest でも動きます。初めに一度、入れます。

```
npm --prefix mutation ci
```

回し方は次のとおりです。対象は `mutation/mutator.config.json` の `include`（計算のテストが行の 9 割以上を通るファイル）です。結果は `mutation/report/index.html` を開いて見ます（Survived は `mutation/report/mutation.json` にもある）。`push` のたびには動かしません。

```
node mutation/run.mjs --since HEAD
node mutation/run.mjs app/geometry.js
node mutation/run.mjs
node mutation/run.mjs accept <key> --reason "理由"
```

- ふだんは `--since HEAD` で、コミットしていない変更の所だけを回します。数秒から数十秒です。計算のファイルを直したら、コミットの前に回します。
- ファイルを指定すれば、そのファイルの全体を回します（geometry.js は 40 秒ほど）。何も指定しなければ全体で、7 分ほどです（2026-11-19）。
- 前回の結果は `.mutator/` に残り、変えていない関数は回し直しません（Git の対象外）。
- どう書き換えても結果が変わらない変異（Kill できないもの）は、`accept` で理由を付けて `mutator.accepted.json`（リポジトリの直下）に記録し、コミットします。次から Survived に出なくなります。記録した変異がなくなった（コードを変えた）ときは、mutator が `stale` として挙げ、「remove from mutator.accepted.json」と出すので、記録から消します。mutator 0.5.1 までは、ファイルを指定して回すと、指定しなかったファイルの記録も誤って `stale` に挙がっていました（mizchi/mutator#48。0.5.2 で直った）。版を 0.5.1 以前に戻したときは、全体か `--since` で回したときに挙がったものだけを消します。
- 農薬の使用回数、使用基準、量、指摘にかかわる関数（`app/logs.js` と `app/pesticide.js`）には、前の行に `// mutator-critical` を付けています。この関数の中に、気づかない変異（Survived、NoCoverage）が 1 つでもあると、`accept` で記録したもの以外は、mutator が終了コード 2 で終わります。テストを足すか、等価なら理由を付けて記録するまで、コミットしません。農薬にかかわる関数を足したら、`// mutator-critical` も付けます。
- 結果は `docs/mutation-runs.md` に残します。`node mutation/summary.mjs` で、ファイルごとの表を出せます。

mutator の版は `mutation/package.json` で決めています。版を上げたら、全体を回し、`docs/mutation-runs.md` の前の記録と比べます。大きく変わったら、StrykerJS でも確かめ、mutator の不具合らしければ版を戻します（package.json と package-lock.json を戻す）。

StrykerJS（`stryker.config.json`、`scripts/mutation.mjs`）は、mutator の結果が正しいかを確かめる検算のために残しています。ふだんは使いません。`npx` で動かすので、入れる必要はありません。

```
node scripts/mutation.mjs app/geometry.js app/logs.js
node mutation/run.mjs app/geometry.js app/logs.js
node mutation/summary.mjs --compare
```

StrykerJS は、書き換え 1 つにつき、そのファイルを直接・間接に読み込むテストファイルを全部動かすので、mutator より 2〜5 倍遅くなります。`lib/ の写しは、app/ の部品と同じ内容` のテストは飛ばします（Stryker は `app/` のファイルそのものを書き換えるため）。比べ方と前回の結果は `docs/mutation-runs.md` にあります。

## jev-lint

コミットの前に、変更が実装のきまり（`AGENTS.md`）に沿っているかを、[jev-lint](https://github.com/mizchi/jev-lint) で確かめます。jev-lint は、差分と `AGENTS.md` を TypeSafe の判定用のモデル（Jev）に送り、きまりを破っていないか、コミットのメッセージが差分と合っているかを判定します。差分で判定できるきまり（「JS の部品を足したら `FILES` と `parts` に足す」「HTML に入れる文字は `escapeHtml` を通す」など）が対象で、「テストを動かす」のような作業の手順は判定しません。`AGENTS.md` を英語で書いているのは、このためです。使う決まりは `.jev-lint.yaml` で選んでいます。

```
git add <変えたファイル>
npx -y jev-lint@0.10.0 commits --staged
```

TypeSafe の API キーを、環境変数 `TYPESAFE_API_KEY` に入れておきます（設定ファイルには書かない）。1 回の判定は数秒、0.001 ドル前後です（2026-11-22）。判定の結果は `.jev-lint/` に残ります（Git の対象外）。指摘が出たら確かめ、当たっていれば直します。外れることもあるので、指摘だけを理由に直さなくてよい。

## 外のライブラリーの版を上げる

supabase-js（DB とログインのライブラリー）は、版を決めたファイルを `app/vendor/` に置いています。版を上げるときは、npm のパッケージ `@supabase/supabase-js` のその版から `dist/umd/supabase.js` を取り、`app/vendor/supabase-js-<版>.js` として置き、古いファイルを消して、`app/index.html` と `app/sw.js` の `FILES` のファイル名を直します。`LICENSE` が変わっていれば、`app/vendor/supabase-js.LICENSE.txt` も置き換えます。そのあと、ログインして、読み込みと保存ができることを確かめます。

## field.sql を空の DB で確かめる

`sql/field.sql` を直したら、手元の空の DB で、最後まで流れることを確かめます。Docker と psycopg が要ります。Supabase が持っているもの（`auth`、`cron`、`storage`、役割）は、スクリプトが代わりを作ります。

```
docker run -d --rm --name fp-empty -e POSTGRES_PASSWORD=local -p 127.0.0.1:55432:5432 postgres:17-alpine
python scripts/check_field_sql.py sql/field.sql --times 2 --whole
docker stop fp-empty
```

文ごとに 2 回流して失敗した文を出し、そのあと、SQL Editor と同じようにファイル全体を 1 回で流します。どれも失敗が 0 なら通っています。`--dump <ファイル>` を付けると、できた定義（列、制約、索引、方針、関数、許可）を書き出すので、直す前と後を比べられます。流したあとに、`field.copy_plan()` も試します（中身が ID を除いて元と同じになる、途中で失敗したら何も残らない、他人はコピーできない、など）。続けて、操作を戻す `field.undo_op()` も試します。親子の行の追加と削除、外部キーの連鎖（CASCADE、SET NULL）、同じ行の複数回の変更、戻す・やり直すの繰り返し、あとで変わった行や操作に入っていない行まで変わるときに戻さないこと、途中で失敗したら何も変わらないこと、などです。

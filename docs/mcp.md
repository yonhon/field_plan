# MCP サーバー（Claude.ai から計画と実績を読む）

計画と作業の実績を、Claude.ai のコネクタから読むためのサーバーです。読むだけで、書き換えはできません。

| 機能 | 内容 |
|---|---|
| `list_fields` | 圃場の一覧と、それぞれの面積、プラン、実際に使うプラン、最後に変更のあった日、記録の数 |
| `list_plans` | 1 つの圃場のプランの一覧と、それぞれの規模、最後に変更のあった日 |
| `get_plan` | 1 つのプランの全体。区域、耕起対象区画、畝、作付（品目、苗数、肥料の量、作業の日付）、集計、日程の無理の指摘 |
| `get_schedule` | 期間を決めた作業の一覧。同じ日の同じ作業は、場所をまとめる |
| `get_changes` | 日ごとの、計画の変更（# の番号）、メモ、アプリの更新（A の番号） |
| `get_crops` | 品目の設定値と、肥料の銘柄 |
| `get_records` | 作業の実績（作業をした日と、何日かかかった作業の終えた日、対象の畝、仕様、資材、メモ、つながる計画の作業）と、取りやめた計画の作業。期間、品目、作業、場所で絞れる |
| `get_pesticide_usage` | 実際に使うプランの作付ごとの、農薬の使用回数（本剤ごと、有効成分ごと）と上限、使用時期の基準を満たす最初の収穫日、作用機構分類（`rac`）。農薬の使用基準（FAMIC）を使う部分で、Supabase の秘密の値 `FIELD_FAMIC` を `false` にすると外れる。`get_records` の農薬に付く `rac` も、このとき外れる |

`list_fields` と `get_crops` のほかは、毎回 `field` で圃場を選びます（名前の一部でもよい）。
品目と肥料、日ごとのメモ、アプリの更新は、すべての圃場で共通です。

サーバーは、DB にある内容をすべて返します。区域の名前、面積、時期も含みます。
記事にするときに出さない情報は、Claude.ai の側で指定します。

## コネクタ URL の作り方

コネクタの URL は、関数の URL の末尾に「合言葉」を付けたものです。合言葉が違う呼び出しには、サーバーは何も返しません。

```
https://byhthaiwbutqstrqbwwc.supabase.co/functions/v1/field-mcp/<合言葉>
```

合言葉を作って Supabase に登録し、URL を表示します。PowerShell で、このリポジトリのフォルダーから実行します。

```powershell
$t = python -c "import secrets; print(secrets.token_urlsafe(32))"
bun x supabase secrets set "FIELD_MCP_TOKEN=$t" --remote=byhthaiwbutqstrqbwwc
"https://byhthaiwbutqstrqbwwc.supabase.co/functions/v1/field-mcp/$t"
```

3 行目が表示した URL を控えます。合言葉はあとから取り出せないので、控え忘れたら作り直してください。

## Claude.ai に登録する

1. Claude.ai の「設定 > コネクタ」で、カスタムコネクタを追加します。
2. 上で表示された URL を入力します。
3. 認証は「No sign-in」を選びます。

## URL の扱い

**URL そのものが鍵です。** 人に見せたり、公開の場所や会話に貼ったりしないでください。
漏れた疑いがあるときは、「コネクタ URL の作り方」をもう一度実行します。合言葉が入れ替わり、古い URL は使えなくなります。

呼び出しは `field.mcp_access_log` に残ります。合言葉が違う呼び出し（`authorized` が false）が続いていないかを、ここで確かめられます。90 日より古い行は、毎日 3:40 に pg_cron が消します。

## サーバーを配備する

ふだんは手で配備しません。サーバーが使う `app/` の計算の部品か、`supabase/functions/field-mcp/` が変わった push のときに、GitHub Actions（`.github/workflows/deploy_mcp.yml`）がテストしてから配備します。合言葉は変わらないので、コネクタの登録はそのまま使えます。

- 画面と同じ計算をするために、`app/` の部品（`geometry.js`、`schedule.js`、`crops.js`、`logs.js`、`rac.js`、`html.js`）の写しを、サーバーのフォルダーの `lib/` に置きます。Edge Function は自分のフォルダーの中のファイルしか読み込めないためです。
- 写しは Git に入れません（`.gitignore`）。`scripts/sync-mcp-lib.mjs` が写し、テスト（`tests/field-mcp.test.mjs` が、サーバーのコードを読み込む前に写す）と、配備の手順の中で自動で呼ばれます。手で写す必要はありません。
- 配備には、リポジトリのシークレット `SUPABASE_ACCESS_TOKEN`（Supabase のアクセストークン）を使います。配備したあと、違う合言葉で呼んで、サーバーが起動して断ることを確かめます。
- 部品を足したり外したりしたときは、`scripts/sync-mcp-lib.mjs` の `SHARED` と、ワークフローの `paths` の両方を直します。

手元から配備するときは、先に写します。

```powershell
node scripts/sync-mcp-lib.mjs
bun x supabase functions deploy field-mcp --remote=byhthaiwbutqstrqbwwc --no-verify-jwt
```

配備の前に、本番のプロジェクトに配備してよいかを確かめられます（Supabase CLI 3.0 から）。`agri_db (byhthaiwbutqstrqbwwc)` と出ていれば、Yes を選びます。

アプリの更新の一覧（`updates.json`）は、写しを持たず、サーバーが呼ばれるたびに、公開しているアプリ（`https://yonhon.github.io/field_plan/updates.json`）から読みます。そのため、一覧を足したときは、アプリを公開するだけで Claude.ai にも届きます（GitHub Pages が最大 10 分ためておくので、少し遅れることがあります）。読めないときは、`get_changes` が、アプリの更新を読めなかったことを添えて返します。

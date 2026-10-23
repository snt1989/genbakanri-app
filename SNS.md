# SNS投稿（Instagram）

管理者だけが使える「SNS投稿」タブです。

- 案件が「施工完了」になり写真がそろうと、投稿文と写真の下書きができます（管理者がこのタブを開いたとき）。
- 管理者が内容を確認し、「承認して今すぐ投稿」または「承認して予約」を選びます。投稿は必ず承認後です。
- データは Firestore の `snsPosts` コレクション、ルールは `settings/sns` に保存します。
  Firestore のセキュリティルールで、この2つの読み書きを許可しておいてください。

## 予約投稿

- 管理者がアプリを開いている間は、画面が予約の時刻に投稿します。
- アプリを閉じている間は、`vercel.json` の定期実行（毎日 JST 12:00 ごろ。UTC 3:00）が
  `/api/config?snscron=1` を呼び、予約時刻から10分以上たった投稿を最大3件まで投稿します。
- 必要な環境変数：`CRON_SECRET`、`IG_USER_ID`、`IG_ACCESS_TOKEN`（既存の投稿機能と同じ）。
  写真のURLは `APP_HOST`（なければ `VERCEL_PROJECT_PRODUCTION_URL`）のドメインで作ります。
- Vercel の Hobby プランは定期実行が1日1回までです。もっと細かくしたい場合は Pro プランにして
  `vercel.json` のスケジュールを増やしてください（例：`*/15 * * * *`）。

## Instagramログイン方式（Facebookページ不要）
環境変数 `IG_API_HOST=graph.instagram.com` を追加すると、Instagram API with Instagram Login で動作します。
`IG_USER_ID`＝Instagramアカウントのユーザー ID、`IG_ACCESS_TOKEN`＝Metaアプリ画面で生成した長期トークン（60日）。
毎日のcronでトークンを自動延長し、`settings/igToken`（Firestore）に保存します（security rulesでクライアントから読めないようにしてください）。

## 複数のInstagramアカウント（事業部ごと）
SNS投稿タブの「Instagramアカウント」から、アカウントを追加・編集・削除できます（管理者のみ）。
- 登録するもの：表示名、担当の事業部、InstagramのユーザーID、アクセストークン（Instagramログイン方式）。
- トークンは SSO_SECRET から作った鍵で暗号化し、Firestore の `igAccounts` コレクションに保存します（画面には再表示しません）。
- 毎日のcronで、全アカウントのトークンを自動延長します。
- 投稿先は、投稿ごとに指定できます。指定がなければ「案件の事業部が同じアカウント → 事業部の指定がないアカウント → 最初のアカウント」の順で決まり、プレビューの最終チェックで確認します。
- 環境変数の `IG_USER_ID` / `IG_ACCESS_TOKEN` のアカウントは「既定」として残ります（表示名は、任意の環境変数 `IG_ACCOUNT_NAME` / 担当事業部は `IG_ACCOUNT_DIVISION`）。
- Firestoreのセキュリティルールに `igAccounts` の読み書きを、`snsPosts` と同じ条件で許可してください。

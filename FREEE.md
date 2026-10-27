# freee会計 連携のセットアップ

アプリの「設定 → freee連携」（管理者のみ）から、顧客の取引先登録・案件の売上取引登録・入金状況の取得ができます。

freeeに登録済みの取引先は、「設定 → freee連携 → freeeの取引先を顧客として取り込む」でこのアプリの顧客に取り込めます（同名の顧客があれば紐づけのみ）。
Vercel で公開しているアプリ（Firebase接続）でのみ動きます。

予算管理との連携（管理者のみ）:
- 「設定 → マスタ管理 → 予算管理画面」の勘定科目に、「freeeから勘定科目を取り込む」で費用の勘定科目を追加できます。
- 「予算管理」の案件を開き、「freeeから実績を取り込む」で、freeeの経費（支出）の取引を実績として取り込めます（期間を指定。取引のタグ・内容に案件名があるものは最初からチェック。同じ明細は二重に取り込みません）。freeeの帳簿は書き換えません（読み取りのみ）。

## 1回だけ必要な準備
1. freeeアプリストア（開発者ページ）で「アプリ」を作成する。
   - コールバックURL: `https://<アプリのドメイン>/api/freee-callback`
   - 権限: 会計（取引・取引先・勘定科目・税区分の読み書き）
2. Vercel の Settings → Environment Variables に登録して再デプロイする。
   - `FREEE_CLIENT_ID` … アプリの Client ID
   - `FREEE_CLIENT_SECRET` … アプリの Client Secret
   - `FREEE_TOKEN_KEY` … 自分で決めた長いランダム文字列（アクセストークンの暗号化に使用。変更すると再連携が必要）
   - （既存）`FIREBASE_PROJECT_ID` / `FIREBASE_API_KEY`
   - 任意 `FREEE_REDIRECT_URI` … 既定は `https://<ホスト>/api/freee-callback`
3. アプリの「設定 → freee連携」→「freeeと連携する」。

## 安全面
- Firestoreのルールが公開設定のため、freeeのトークンは `FREEE_TOKEN_KEY` でAES-256-GCM暗号化して保存します。
- `/api/freee` は毎回、管理者の氏名＋ログインパスワードをサーバー側で照合します。
- freeeの帳簿に書き込む操作は、画面で必ず確認が出ます。

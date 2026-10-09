# 法人番号から顧客情報を呼び出す

顧客登録の「法人番号」欄に13桁の番号を入れ、「法人情報を呼び出す」を押すと、国税庁 法人番号公表サイトの Web-API から名称・所在地を取得して入力します。

## 準備（管理者・最初の1回だけ）
1. 国税庁「適格請求書発行事業者公表サイト」（https://www.invoice-kohyo.nta.go.jp/）の Web-API のページから「アプリケーションID発行届出仮登録」に進み、メールアドレスを送信します。
   届いたメールのURLから届出フォーム（法人名または氏名・メールアドレス・電話番号など）を入力して送信すると、後日メールで**アプリケーションID**が届きます。
   無料・添付書類不要・個人でも申請可能。同じメールアドレスで複数のIDは取れません。手続きの詳細: https://www.houjin-bangou.nta.go.jp/documents/k-web-api-tetuduki.pdf
2. Vercel の Project → Settings → Environment Variables に `HOUJIN_APP_ID` = 届いたID を登録し、Redeploy します。
   ※IDはチャットやGitHubに書かず、Vercelの環境変数にだけ登録してください。

## 仕様
- サーバー: `api/houjin.js`（ログイン中メンバーのみ）。13桁のチェックデジットも確認します。
- 入力されるのは空欄の項目のみ（既存の入力は上書きしません）。
- Artifactプレビューでは使えません（Vercel版のみ）。

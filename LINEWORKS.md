# LINE WORKS 連携の設定手順

できること
- 案件の登録・進捗変更、報告書の提出、タスクの追加を、グループトークルームへ自動通知
- 毎朝8時(日本時間)に、期限が近いタスクと工期終了が近い案件をまとめて通知
- 案件画面の「LINE WORKSで共有」ボタンで、任意のメッセージを送信
- LINE WORKSのBotに話しかけて、案件・タスクの確認と日報の登録(`ヘルプ` `案件` `案件 名前` `タスク` `報告 案件名 内容`)

## 1. LINE WORKS Developer Console
1. https://developers.worksmobile.com/ で「API 2.0」のアプリを作成(Client ID / Client Secret を控える)
2. OAuth Scopes に `bot` を追加
3. 「Service Account」を発行し、Private Key(.keyファイル)をダウンロード
4. 「Bot」を作成し、Bot ID と Signing Secret を控える
   - Callback URL: `https://<公開URL>/api/works-callback`(アプリの 設定 > LINE WORKS に表示)
   - Botのトーク参加を許可(グループトークルームに追加できる設定)にする
   - 受信するCallback Event は **Message Event(テキストにチェック)** と **Join Event** を On にする(他は Off のままで可)
5. Botを、通知先にしたいグループトークルームに追加する
   → 追加した時点で、そのルームが通知先に自動設定されます(設定画面でチャンネルIDの手入力も可)

## 2. Vercel の環境変数(Settings > Environment Variables)
| 名前 | 内容 |
|---|---|
| `WORKS_CLIENT_ID` | アプリの Client ID |
| `WORKS_CLIENT_SECRET` | アプリの Client Secret |
| `WORKS_SERVICE_ACCOUNT` | Service Account(例 `xxxx.serviceaccount@ドメイン`) |
| `WORKS_PRIVATE_KEY` | Private Key の中身(`-----BEGIN PRIVATE KEY-----` から末尾まで。改行は `\n` でも可) |
| `WORKS_BOT_ID` | Bot ID |
| `WORKS_BOT_SECRET` | Bot の Signing Secret(Botへの話しかけに必要) |
| `CRON_SECRET` | 自分で決めた長いランダム文字列(毎朝の通知に必要) |

登録後に再デプロイしてください。値はチャットや画面に貼らず、Vercelにだけ登録します。

## 3. アプリ側
1. 設定 > LINE WORKS を開く(管理者)
2. 通知する内容を選び「設定を保存する」→「テスト送信」でトークルームに届くか確認
3. 各メンバーは 設定 > LINE WORKS で「連携コードを発行」し、Botに `連携 123456` と送ると本人確認が済みます(10分以内)

## 仕組みと注意
- アプリのAPI(`/api/works`)は、毎回「ログイン中メンバーの氏名＋パスワード」をサーバーで照合します。設定変更とテスト送信は管理者のみ。
- Botへの話しかけは `X-WORKS-Signature`(HMAC-SHA256)を検証し、署名が合わないものは無視します。
- Botは、本人確認が済んだメンバーにだけ応答し、見られる案件はアプリと同じ(管理者は全件、他は担当案件のみ)です。
- グループトークルームで話しかけた場合、返信はそのルームの全員に見えます。金額は通知・返信に含めません。
- 通知は、アプリの画面から操作したときに送られます。CSV取り込みなどの一括操作では送られません。

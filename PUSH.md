# スマホ通知（チャット）の設定

1. アプリの 設定 → 個人情報 →「スマホ通知」→（管理者）「通知用のキーを作成する」
2. 表示された `VAPID_PUBLIC_KEY` と `VAPID_PRIVATE_KEY` を Vercel の Environment Variables に登録（前後に空白を入れない）→ Redeploy
3. 各メンバーが、スマホで「この端末で通知を受け取る」をオン
   - iPhone: Safari で開き「共有 → ホーム画面に追加」したアプリから設定（iOS 16.4以降）
   - Android: Chrome で設定

自分が参加しているチャット（案件チャットは担当者、グループは参加者）に、他の人が投稿すると通知されます。

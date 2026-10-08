# スマホアプリ（iOS / Android）化の手順

## 1. すぐ使える：ホーム画面に追加（PWA）
https://genbakanri-app.vercel.app を開き、
- **iPhone（Safari）**：共有ボタン →「ホーム画面に追加」
- **Android（Chrome）**：メニュー →「アプリをインストール」/「ホーム画面に追加」

アイコン付きで全画面のアプリとして起動します（ストア申請は不要）。

## 2. ストア配布用のネイティブアプリ（Capacitor）
このフォルダに Capacitor の設定を用意済みです。お手元のPCで実行してください。

```
npm install
APP_API_BASE=https://genbakanri-app.vercel.app npm run cap:add:android   # 初回のみ
APP_API_BASE=https://genbakanri-app.vercel.app npm run cap:add:ios       # 初回のみ（Macのみ）
npm run cap:android   # Android Studio が開く → ▶ で実機/エミュレータ起動、Build > Generate Signed Bundle でストア用ファイル
npm run cap:ios       # Xcode が開く → 実機起動、Product > Archive でApp Store Connectへ
```
- iOS は Mac + Xcode + Apple Developer Program（年額）が必要、Android は Android Studio + Google Play Console（初回のみ登録料）が必要です。
- `appId`（jp.ltd.sanoh.genba）は `capacitor.config.json` で変更できます（ストア公開後は変更不可）。
- ネイティブ版は Firebase の設定を Vercel の `/api/config` から取得するため、`APP_API_BASE` の指定が必要です。
- アプリ本体（index.html）を更新したら `npm run cap:sync` で再同期します。

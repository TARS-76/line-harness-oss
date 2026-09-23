# 店舗追加チェックリスト（Store Template v0.1）

> 既存デプロイ（1デプロイ N 店舗 / `line_accounts` モデル）に店舗を1つ足す手順。
> 自動化したのは §2 の登録と検証（`scripts/store-bootstrap.ts`）だけ。LINE 側の作業は人手のまま残す。
> 店舗A・Bでの実機検証（2026-09-20〜23）で確かめた手順を元にしている。

**v0.1 はローカル worker での検証モード。** 本番公開の手順（§5）は別ゲートとして分けている。
§1〜§4 を終えただけで一般公開してはいけない。

---

## 0. 不要な手順（やらない）

以下は店舗A・Bの実測で**不要**と確認済み。

| やらないこと | 理由 |
|---|---|
| `.dev.vars` を書き換える | 2店舗目以降の webhook は DB 照合（slow path）で正しい店舗に振り分けられる |
| 店舗ごとに別の Webhook URL を用意する | 全店舗で共通の `/webhook` を使う |
| 店舗ごとに LIFF を build / deploy する | LIFF の bundle は全店舗共通。`?liffId=` で店舗を切り替える |
| Messaging channel と Login channel の bot link | 無くても動く |
| Callback URL（`/auth/callback`）を設定する | `apps/liff` は `/auth/*` を使わない |
| 管理画面の「登録すべき URL」（`AccountSetupUrls`）を参照する | 今の Pages 構成と合わない（既知のクリーンアップ候補）。**§2 のスクリプトが出す値が正** |

---

## 1. LINE 側の準備（人手・登録前）

- [ ] **1-1 Provider を店舗専用に作る**
  - 店舗ごとに Provider を分ける。`friends.line_user_id` が全体で UNIQUE なので、同じ Provider に複数店舗を置くと2店舗目の follow が失敗しうる（T-9）
- [ ] **1-2 Messaging API channel を作る**
  - Channel ID を控える
  - Channel secret は §1-5 のファイルに直接保存する
  - long-lived token は発行しない。token はスクリプトが client_credentials で発行する
- [ ] **1-3 LINE Login channel を作る**
  - 同じ Provider に作る
  - Channel ID を控える
  - Channel secret は §1-5 のファイルに直接保存する
  - 状態は**「開発中」のまま**にする（公開は §5）
- [ ] **1-4 LIFF アプリを作る**（Login channel の LIFF タブ）
  - 作成時の Endpoint URL には仮に LIFF の配信 URL（`?liffId=` なし）を入れる。正しい URL は §3-3 で差し替える
  - 発行された LIFF ID を控える。`<Login channel ID>-<英数字>` の形になる
- [ ] **1-5 secret ファイルを作る**
  - repo の外に置き、`chmod 600` にする
  - 中身は値1行だけ
  - エディタで直接書き込む。`echo 値 > file` はシェル履歴に残るので**使わない**
  ```
  ~/.line-harness-poc/stores/<slug>/secrets/messaging-channel-secret
  ~/.line-harness-poc/stores/<slug>/secrets/login-channel-secret
  <管理 API キー（env API_KEY）のファイル。repo の外。全店舗で1つを共有してよい>
  ```
- [ ] **1-6 manifest を作る**: `~/.line-harness-poc/stores/<slug>/store.json`
  - secret の本文は書かない。書くのはファイルのパスだけ
  - 未知のキーがあるとスクリプトが拒否する
  ```json
  {
    "slug": "<slug>",
    "name": "<管理画面に出る店舗名>",
    "line": {
      "providerName": "<1-1>",
      "messagingChannelId": "<1-2 の Channel ID>",
      "loginChannelId": "<1-3 の Channel ID>",
      "liffId": "<1-4 の LIFF ID>"
    },
    "deployment": {
      "adminApiUrl": "http://127.0.0.1:8787",
      "webhookBaseUrl": "https://<worker の公開ホスト>",
      "liffBaseUrl": "https://<LIFF の Pages ホスト>/"
    },
    "secretFiles": {
      "messagingChannelSecret": "~/.line-harness-poc/stores/<slug>/secrets/messaging-channel-secret",
      "loginChannelSecret": "~/.line-harness-poc/stores/<slug>/secrets/login-channel-secret",
      "adminApiKey": "<1-5 の管理 API キーファイル>"
    }
  }
  ```
- [ ] **1-7 まだ友だち追加しない**
  - 登録前に follow されると、その follow は DB に残らない
  - 追加してしまった場合の復旧は「ブロック → 解除」

---

## 2. 登録（スクリプト）

Node 22 以上（`node:sqlite` を使う）が必要。worker をローカルで起動しておく（`--execute` の時だけ必要）。

```bash
PATH=~/.nvm/versions/node/v22.23.2/bin:$PATH npx tsx scripts/store-bootstrap.ts --store <slug>
```

```bash
PATH=~/.nvm/versions/node/v22.23.2/bin:$PATH npx tsx scripts/store-bootstrap.ts --store <slug> --execute
```

- [ ] **2-1 dry-run（既定）で通ることを確認する**
  - 検査する項目: manifest の構造、`liffId` の prefix が Login channel ID と一致するか、secret ファイル（0600・repo の外・形式）、既存店舗と ID が重複しないか
  - D1 は読むだけで、ネットワーク通信もしない
- [ ] **2-2 `--execute` で登録する**。固定順で進み、どこかで失敗したらその場で止まる（fail closed）
  1. worker が見ている D1 と、スクリプトが読む D1 が同じか照合する
  2. D1 をバックアップする（`~/.line-harness-poc/d1-backups/store-bootstrap-*`。全店舗の secret を含むので 0600）
  3. LINE から access token を発行する
  4. `POST /api/line-accounts` で登録する（main pool への登録も API が行う）
  5. 検証する: 新店舗の行が manifest と一致するか、main pool に入ったか。そのうえで DB 差分を**既知の差分（allowlist）だけ**に限る
     - 期待する差分（登録前の状態から決める）: `line_accounts` は新店舗の1行ちょうど
       - main pool があった場合: `traffic_pools` +0 / `pool_accounts` は（既存 main, 新店舗）の1行ちょうど
       - main pool が無かった場合: `traffic_pools` は `slug='main'`・active=新店舗の1行ちょうど / `pool_accounts` は（その pool, 新店舗）の1行ちょうど
       - `account_settings` は（新店舗, `follower_import_v1`）の0〜1行（upstream の登録処理が書く。現行 fork では発生しない）
     - それ以外はすべて不変でなければ失敗: 既存店舗の行・既存の設定・既存の pool membership・無関係なテーブル。新店舗に紐づく未知の追加も失敗にする
- [ ] **2-3 出力された値を控える**: Webhook URL、LIFF Endpoint URL、`line_accounts.id`
- 終了コード: `0` 成功 / `1` 書き込み前に停止 / `2` 書き込み後に停止
  - `2` の場合は `~/.line-harness-poc/stores/<slug>/runs/<時刻>/journal.json` で、どこまで完了したかを確認する
  - 同じ channel はもう登録済みなので、再実行しても preflight で止まる
- scheduled（cron）は**スクリプトからは呼ばない**
  - scheduled は全店舗の配信・リマインド送信・health 記録を一緒に動かすため
  - 新店舗の `token_expires_at` は、次の通常 tick で既存の refresh が正常化するまで NULL のままでよい（発行した token は30日有効）

---

## 3. LINE 側の仕上げ（人手・登録後）

- [ ] **3-1 Messaging API 設定**
  - Webhook URL に §2-3 の値を貼る
  - 「Webhook の利用」を ON にする
  - 「検証」が Success になることを確認する（公開 ingress が必要）
- [ ] **3-2 LINE Official Account Manager の応答設定**
  - 応答メッセージを **OFF**
  - Webhook を ON
- [ ] **3-3 LIFF の Endpoint URL を §2-3 の値に差し替える**
  - URL に `?liffId=` が付いていることを確認する
  - 付いていないと、LIFF は既定の店舗の LIFF にフォールバックし、別店舗の予約になる
- [ ] **3-4 検証モードの権限**
  - Login channel が「開発中」の間は、**実機で使う LINE アカウント自身**を Login channel の Admin か Tester に追加する
  - コンソールを操作する人のアカウントと実機のアカウントが別だと、LIFF の起動が 400（`User need to have developer role`）になる

---

## 4. 実機 E2E（人手）

- [ ] **4-1 友だち追加**
  - 実機で公式アカウントを友だち追加する
  - `friends` に新しい行ができ、`line_account_id` が新店舗になっていること
- [ ] **4-2 予約マスタを管理画面から投入する**
  - メニュー、スタッフ、担当、シフト。v0.1 では自動化しない
  - 管理画面の店舗切替で、他店舗のデータが見えないこと
- [ ] **4-3 LIFF から予約リクエストを1件出す**
  - 201 が返ること
  - 「受付」通知が実機に届くこと
  - 予約の行が新店舗に帰属していること
- [ ] **4-4 管理画面から承認する**
  - 「確定」通知が実機に届くこと
  - reminder が生成されること
- [ ] **4-5 既存店舗が変化していないことを確認する**（B-8 と同じ方法）
- 詰まったときの切り分け:
  - LIFF が 400 → §3-4
  - 401 `IdToken expired.` → T-13。LINE 設定 → 連携アプリで連携を解除し、再同意する

---

## 5. 本番公開ゲート（別判断・v0.1 の範囲外）

§1〜§4 は検証モード。一般のお客様に公開する前に、**別の判断として**以下を決めて実施する。

- [ ] LINE Login channel を「公開済み」にする（Tester の制限が外れ、誰でも LIFF を開ける）
- [ ] 本番の worker・D1・公開ホストを用意する（`wrangler.toml` の `env.production` は未構築）
  - スクリプトの `adminApiUrl` は現在ローカル専用。本番用の state reader が別途必要
- [ ] 管理認証が店舗単位でないこと（D-1 / T-4：API キー1本で全店舗の owner になる）を受け入れるか、先に決着させる

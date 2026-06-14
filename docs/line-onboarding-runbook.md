# LINE 導入 Runbook（クライアント・オンボーディング）

> 2026-06-14 検証。ローカル開発環境（wrangler dev + ngrok + local D1）で確認した手順。
> ✅ = 実機検証済み / ⚠️ = 未検証（本番投入前に要テスト）

## 0. 前提インフラ
- Worker: `apps/worker`、`npx wrangler dev --ip 0.0.0.0 --port 8787`
- 公開: ngrok（dev）。`https://<ngrok>/webhook` を LINE に登録
- D1 は `--local`（SQLite）。クエリ:
  `cd apps/worker && npx wrangler d1 execute line-harness --local --command "..."`

## 1. LINE 側設定チェックリスト ✅（最頻の障壁）
**LINE Developers Console（developers.line.biz → Messaging API設定）**
- Webhook URL = `https://<現ngrok>/webhook`（末尾 `/webhook` 必須）
- **「Webhookの利用」が ON** ← OFFだとイベントは一切届かない（#1原因）
- 「検証」ボタンで Success

**LINE Official Account Manager（manager.line.biz → 設定 → 応答設定）**
- 応答モード: チャット or Bot
- Webhook: ON
- 応答メッセージ: OFF 推奨（ONだとLINE定型応答とbotが競合）
- あいさつメッセージ: 任意（※これはWebhookを通らずLINE側から送られる。DBには残らない）

**シークレット整合**
- `.dev.vars` の `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` が、対象の公式アカウントと一致。ズレると署名検証で弾かれ「200は返るがDB無記録」になる。

## 2. 「200 OK だけ来る」症状の診断 ✅
`POST /webhook 200 OK` は**処理成功の証拠にならない**（webhook.ts は署名NGでも200を返す設計）。
- worker ログに `Invalid LINE signature` が出る → シークレット不一致
- ログに何も出ない → Webほっくが届いていない（§1のLINE側設定）
- `[follow]` 等が出てDBに入る → 成功

### ⚠️ 罠: friend 未登録だとメッセージが握り潰される
`webhook.ts` のメッセージ処理は `getFriendByLineUserId` → `if (!friend) return`。
**follow（友だち登録）がDBに無いと、受信メッセージはログも返信もされず捨てられる。**
friends=0 のまま「200だけ来る」典型パターン。

### 復旧: follow の焼き直し ✅
友だち追加時にWebhook未整備だと follow が登録されない。
→ **LINEで公式アカを「ブロック → ブロック解除」すると follow が再発火**し friends に登録される。
（Webhookが正しく設定済みなら、通常の新規友だち追加で follow は直接発火する）

## 3. 自動返信の設定 ✅
auto_replies テーブルに直挿しで即有効（worker 再起動不要・毎リクエストでDB読込）。
```sql
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, line_account_id, is_active)
VALUES ('<uuid>', 'テスト', 'contains', 'text', '自動返信テストOK！', NULL, 1);
```
- `line_account_id = NULL` で全アカウント共通（グローバルルール）
- 検証済み: 受信「テスト」→ 送信「自動返信テストOK！」が messages_log に往復記録（約260ms）

## 4. 常駐化（tmux）✅
```bash
tmux new-session -d -s worker -c <repo>/apps/worker
tmux send-keys -t worker 'npx wrangler dev --ip 0.0.0.0 --port 8787 2>&1 | tee /tmp/worker-dev.log' Enter
```
- 再アタッチ: `tmux attach -t worker`
- ログ: `tail -f /tmp/worker-dev.log`
- 停止: `tmux kill-session -t worker`
- ⚠️ `pkill -f "wrangler dev"` は自分のシェルも巻き込んで落とす（コマンド文字列が自己マッチ）。停止は **PID直指定** で。

## 5. ⚠️ 本番投入前に要テスト（未検証ギャップ）
1. **マルチアカウント（line_accounts）経路**: 今回は env シークレット1本（line_accounts=0件）で検証。複数公式アカウント（別チャンネル）の場合、webhook の slow-path（口座ごとの channel_secret 照合）と `line_account_id` の friends/scenario 伝播が未検証。
2. **シナリオ（ステップ配信）＋ cron**: friend_add シナリオの即時配信・時間差ステップが未検証。**ローカル dev は cron が自動発火しない** → 手動発火は `curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"`。
3. **ダッシュボードUI（apps/web）**: 友だち数等はDB直クエリで確認しただけ。管理画面の実表示は未確認。
4. **本番デプロイ**: 全て dev + ngrok。本番は deploy 済みWorker + remote D1 + 固定ドメインが必要（ngrok前提の手順は本番にそのまま使えない）。

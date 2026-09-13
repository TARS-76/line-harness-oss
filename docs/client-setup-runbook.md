# クライアント環境 構築 Runbook

> 1 クライアント分の環境をゼロから立てる手順。
> 2026-09-13 にローカル（`wrangler dev --local` + ローカル D1 + ダミー LINE トークン）で実測した内容。
> ✅ = このマシンで実際に再現した / ⚠️ = 未実測（構造上の帰結、または本番でのみ起きる）
>
> LINE 側（Webhook・応答設定・シークレット整合）の手順は
> [line-onboarding-runbook.md](line-onboarding-runbook.md) にある。本書は重複させない。

---

## 0. 用語

| 語 | 意味 |
|---|---|
| **env API_KEY** | Worker の環境変数 `API_KEY`。管理 API 全体の共通鍵 |
| **staff キー** | D1 の `staff_members.api_key`。スタッフ個人に発行する鍵。`lh_` 始まり |
| **fork** | クライアントに渡すリポジトリ。upstream = `Shudesu/line-harness-oss` |

管理 API の認証ヘッダは **`Authorization: Bearer <key>`**。
`X-API-Key` ではない ✅（誤ると 401 が返り、鍵が違うのかヘッダが違うのか区別できず時間を溶かす）。

---

## 1. DB 初期化 — `bootstrap.sql` を使う ✅

```bash
cd apps/worker
npx wrangler d1 execute <DB名> --local --file=../../packages/db/bootstrap.sql
```

### 罠: `schema.sql` は 51 マイグレーション前の姿

`packages/db/` には 2 つの SQL がある。**新規構築に使うのは `bootstrap.sql` だけ。**

| ファイル | 中身 | 用途 |
|---|---|---|
| `schema.sql` (838行) | マイグレーション適用**前**の初期スキーマ | 履歴の起点。単体では現行と一致しない |
| `bootstrap.sql` (963行) | `schema.sql` + **51本**のマイグレーションを畳んだ現行スキーマ | ✅ 新規構築はこちら |

`bootstrap.sql` は `scripts/generate-bootstrap.mjs` の生成物で、手編集禁止。
畳み込み済みのマイグレーション一覧は `packages/db/bootstrap-meta.json`（`migrationCount: 51`）にある。
スキーマを変えたときは `pnpm --dir packages/db generate:bootstrap` で再生成する。

> ⚠️ **未決**: `package.json` の `db:migrate` / `db:migrate:local` は現在 **`schema.sql` を指している**。
> このスクリプトを踏むと 51 本ぶん古い DB ができる。
> 直すか、スクリプトごと廃止するかは未決。→ [pre-distribution-checklist.md](pre-distribution-checklist.md)

---

## 2. ビルド順 — `sdk` → `mcp-server` ✅

```bash
pnpm --filter @line-harness/sdk build
pnpm --filter @line-harness/mcp-server build
```

`@line-harness/mcp-server` は `dependencies` に `"@line-harness/sdk": "workspace:*"` を持ち、
sdk の `main` は `./dist/index.cjs` ＝ **ビルド生成物**を参照する。
sdk を先に build しないと mcp-server の build が解決に失敗する。

`pnpm -r build`（ルートの `build`）を使えば依存順は pnpm が解決するので、迷ったらこちらでよい。

> `dist/` は `.gitignore:2` で除外＝**git 追跡されていない**。
> clone 直後は必ず build が要る。配布時の扱いは未決 → [pre-distribution-checklist.md](pre-distribution-checklist.md)

---

## 3. Worker 起動 — `--var` は `.dev.vars` に勝つ ✅

```bash
tmux new -d -s worker "cd <repo> && npx wrangler dev \
  --config apps/worker/wrangler.toml --local \
  --persist-to ~/lh-mcp-local/wstate --port 8788 \
  --var API_KEY:<key> \
  --var LINE_CHANNEL_ACCESS_TOKEN:dummy-local-no-line-reach \
  --var LINE_CHANNEL_SECRET:dummy-local-no-line-reach \
  --var WORKER_URL:http://127.0.0.1:8788 \
  --var LIFF_URL:http://127.0.0.1:8788/liff"
```

### 罠: `.dev.vars` に本番寄りの値が残っていても黙って無視される

`apps/worker/.dev.vars` と `--var` の両方に `API_KEY` がある状態で実測した結果：

| 投げた鍵 | `GET /api/line-accounts` |
|---|---|
| `--var` で渡した値 | **200** ✅ |
| `.dev.vars` の値 | **401** ✅ |
| D1 の staff キー | 200 ✅ |
| デタラメ | 401 ✅ |

→ **`--var` が勝ち、`.dev.vars` の同名キーは完全に無効化される。** 警告は出ない。

これは実害のある方向にも働く。`.dev.vars` に本番の `LINE_CHANNEL_ACCESS_TOKEN` が残っていても、
`--var` でダミーを渡していれば LINE には到達しない（今回の検証はこれに依存している）。
逆に **`--var` を付け忘れると `.dev.vars` の本番トークンで起動し、実際に LINE へ送信されうる。**
ローカル検証では `--var` でダミーを明示するのを手順に含めること。

`.dev.vars` は `apps/worker/.gitignore:9` で除外済み ✅（秘密が commit に載らないことは確認済み）。

---

## 4. staff キーの発行 — 平文はレスポンスでしか取れない ✅

```bash
curl -X POST http://127.0.0.1:8788/api/staff \
  -H "Authorization: Bearer <env API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"...","email":"...","role":"..."}'
```

| エンドポイント | apiKey の見え方 | 実装 |
|---|---|---|
| `POST /api/staff`（発行） | **平文** | [staff.ts:119](../apps/worker/src/routes/staff.ts#L119) `serializeStaff(member, false)` |
| `POST /api/staff/:id/regenerate-key` | **平文** | [staff.ts:216](../apps/worker/src/routes/staff.ts#L216) |
| `GET /api/staff`（一覧） | `lh_****xxxx` にマスク | [staff.ts:76](../apps/worker/src/routes/staff.ts#L76) |
| `GET /api/staff/:id` | マスク | [staff.ts:91](../apps/worker/src/routes/staff.ts#L91) |
| `PATCH /api/staff/:id` | マスク | [staff.ts:170](../apps/worker/src/routes/staff.ts#L170) |

**発行レスポンスを取り逃すと、API 経由では二度と平文を取得できない。**
取り逃した場合の回復手段は regenerate（＝旧キーは失効）のみ。
発行時に必ず控える。

### ただし「ハッシュ保存」ではない ⚠️

D1 には**平文のまま**保存されている（`serializeStaff` が `row.api_key` をそのまま返せている以上、
DB 側は平文）。マスクは API 表層の措置であって、**D1 への読み取り権があれば平文が読める**。
バックアップファイルや `wrangler d1 execute` の結果にも平文で出る。取り扱いを誤らないこと。

> ⚠️ **未決**: ハッシュ保存へ移すかどうか。移すなら既存キーの移行が要る。コード変更のため本書では判断しない。

---

## 5. MCP クライアント設定 — 差し替えるのは 3 点だけ ✅

`.mcp.json`（`.gitignore:10` で除外済み ✅）。テンプレートは `.mcp.json.example`。

```json
{
  "mcpServers": {
    "line-harness": {                                   // ← ③ サーバー名
      "command": "node",
      "args": ["./packages/mcp-server/dist/index.js"],
      "env": {
        "LINE_HARNESS_API_URL": "http://127.0.0.1:8788", // ← ① URL
        "LINE_HARNESS_API_KEY": "lh_..."                 // ← ② キー
      }
    }
  }
}
```

クライアントごとに変えるのは **① URL ／ ② キー ／ ③ サーバー名** の 3 点だけ。
`command` と `args` は共通。

`LINE_HARNESS_API_KEY` には **staff キー**を入れる運用で疎通確認済み ✅
（env API_KEY でも通るが、誰の操作かを D1 側で追えるので staff キーを推奨）。

---

## 6. MCP ツールの権限 — `.claude/settings.json`

`.claude/settings.json` の `permissions.allow` / `deny` で、Claude Code から呼べる MCP ツールを絞る。
現行は **読み取り 9 本を allow、書き込み 20 本を deny、計 29 本＝登録ツール全数**。

### deny の効き方 ✅（実測）

deny 指定されたツールは **ツール一覧そのものから除去される**。
`broadcast` を実際に呼び出して確認した結果：

```
Error: No such tool available: mcp__line-harness__broadcast
```

「呼べるが拒否される」ではなく「そもそも列挙されない」。
エージェントが誤って呼ぶことが構造的に起きない。

### 罠: サーバー名がずれると deny が静かに無効化される ⚠️

permission のキーは `mcp__<サーバー名>__<ツール名>` という形で**サーバー名を埋め込んでいる**。

```
.mcp.json の "line-harness"  →  mcp__line-harness__broadcast
```

§5 ③ でサーバー名を `line-harness-miki` のようにクライアント別に変えた場合、
`.claude/settings.json` 側も**同じ名前に揃えないと deny が 1 本も一致しない**。
一致しない deny はエラーにならず、**黙って無視される**＝書き込みツールが全部開く。

> ⚠️ これは permission キーの構造からの帰結で、**改名しての再現実測はしていない**。
> サーバー名を変えるときは、変更後に読み取り専用のはずの環境で
> 書き込みツール（例: `broadcast`）が一覧に出ていないか目視すること。

**推奨: サーバー名は `line-harness` のまま固定し、クライアント差分は URL とキーの 2 点に閉じる。**
そうすれば `.claude/settings.json` を全クライアント共通で使い回せる。

### ツール名の照合 ✅

登録ツールと allow+deny は機械照合すること（2026-09-13 時点で 29 = 9 + 20、未記載 0・余剰 0）。
`packages/mcp-server/src/tools/index.ts` の `registerAllTools` に 1 本足すと
allow/deny のどちらにも載らない「未記載ツール」が生まれ、deny されない。
照合スクリプトの常設は未決 → [pre-distribution-checklist.md](pre-distribution-checklist.md)

### 罠: MCP resources は allow/deny の対象外 ⚠️

MCP サーバーは **tools とは別に resources を 3 本公開している**
（`packages/mcp-server/src/resources/index.ts` の `server.resource()` × 3）。

`permissions` の `mcp__*__*` は **tools のみ**を対象とする。
resources はこの allow/deny を通らない。
「書き込みツールを全部 deny した」＝「MCP 経由で何も漏れない」ではない。

> ⚠️ resources が何を露出しているかは今回**未調査**。読み取り専用環境を謳う前に中身を確認すること。

---

## 7. 防護範囲の境界（誤解しやすい点）

今回整えた `.claude/settings.json` の deny は **Claude Code 側の防護**であって、
**Worker API を止めるものではない**。

```
Claude Code ──deny──✗── MCP server ──→ Worker API ──→ LINE
     　　　                                  ↑
curl / 他クライアント ───────────────────────┘  ここは通る
```

`POST /api/broadcasts` は稼働しており、**キーさえあれば curl で直接叩ける**。
ローカル検証で LINE に届かない最終的な理由は deny ではなく、
**§3 の `--var` でダミートークンを渡していること**。この 2 つを混同しないこと。

---

## 8. 起動確認 ✅

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8788/
```

- `/` が 200 なら Worker は生きている
- **`/health` は存在しない**。404 が返るのは正常。ヘルスチェックに使わない ✅
- cron（Scheduled Worker）はローカルで自動発火しない。手動は
  `curl "http://localhost:8788/cdn-cgi/handler/scheduled"`

停止は tmux セッション指定で：

```bash
tmux kill-session -t worker
```

`pkill -f "wrangler dev"` は自分のシェルを巻き込むため使わない。

---

## 関連

- LINE 側の設定と Webhook 疎通 → [line-onboarding-runbook.md](line-onboarding-runbook.md)
- 配布前に決める必要がある項目 → [pre-distribution-checklist.md](pre-distribution-checklist.md)
- 時刻の扱い（SQL に `now` を書かない条件）→ [AGENTS.md](../AGENTS.md) と
  [line-accounts.ts の `jstMonthStart`](../apps/worker/src/routes/line-accounts.ts#L62)

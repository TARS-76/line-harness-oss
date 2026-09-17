# 配布前チェックリスト

> fork をクライアントに渡す前に決着させる項目。**列挙のみ。本書の作成時点では 1 件も実行していない。**
> 2026-09-13 起票。判断が要るものは「未決」として残してある — 勝手に決めない。
>
> 手順そのものは [client-setup-runbook.md](client-setup-runbook.md) にある。本書は「まだ決まっていないこと」だけを扱う。

---

## 1. LICENSE — **対応中: `chore/license`**

- 決着: upstream (`Shudesu/line-harness-oss`) は **MIT**（upstream 93a2335 `Add MIT LICENSE file`）。fork も同じ `LICENSE` を置く
- 対応: ブランチ `chore/license` で upstream の LICENSE を cherry-pick（b4cf365）。upstream 93a2335 の `LICENSE` と diff 0 行
- 残: ルート `package.json` の `license` フィールドは未追加（`private: true` のため要否は別途）/
  クライアント納品物の扱い（MIT は著作権表示と許諾表示の同梱を条件に再配布・改変可）は運用で決める

## 2. MANIFEST_URL の向き先 — **未決**

- 現状: `DEFAULT_MANIFEST_URL` が **upstream を指している**
  ```
  https://github.com/Shudesu/line-harness-oss/releases/latest/download/release-manifest.json
  ```
  （`packages/create-line-harness/src/lib/installed-wrangler.ts:4` と `src/commands/update.ts:49` の **2 箇所**）
- このまま配ると、クライアント環境の `update` が **upstream のリリースを取りに行く**
- 決めること: fork の releases に向けるか / 自動更新を無効にするか / upstream 追従を意図的に残すか
- 2 箇所に重複定義されている点も併せて整理するか決める

## 3. `wrangler.toml` の `account_id` — **未決**

- 現状: git 上の `apps/worker/wrangler.toml` は e791f2c で **プレースホルダ化済み**
  （16行目 `YOUR_DEV_ACCOUNT_ID` / 56行目 `YOUR_ACCOUNT_ID`、`[vars]` の `CF_ACCOUNT_ID` も同様）。
  実値が入っているのは**ローカル作業コピーのみ**（`git update-index --skip-worktree` 指定。`git ls-files -v` で `S`）
- fork の clone にはプレースホルダしか渡らない。ただし skip-worktree は clone に引き継がれないため、
  クライアント側で改めて実値を入れる手順が要る
- 決めること: env 化するか / クライアントごとに書き換える手順にするか / skip-worktree 運用を続けるか

## 4. `database_id` — **未決**

- 現状: git 上は §3 と同じく e791f2c でプレースホルダ化済み（24-25行目 `YOUR_DEV_D1_DATABASE_ID` /
  64-65行目 `YOUR_D1_DATABASE_ID`、`[vars]` / `[env.production.vars]` の `D1_DATABASE_ID` も同様）。
  実値 `<D1_DATABASE_ID>` が入っているのはローカル作業コピー（skip-worktree）のみ
- ローカル作業コピーでは**開発側と本番側が同じ検証用 D1 を指している**。
  最初のクライアント用 D1 を作るときの分離手順は
  [client-setup-runbook.md §1「最初のクライアント用 D1 を作るとき」](client-setup-runbook.md) を参照
- 決めること: クライアントごとの払い出し手順 / テンプレート化の方法（§3 と同じ線引き）

## 5. `dist/` の扱い — **未決**

- 現状: `.gitignore:2` の `dist/` で**全 dist が git 追跡外**。clone 直後は必ず build が必要
- MCP サーバーは `.mcp.json` から `./packages/mcp-server/dist/index.js` を直接叩くため、
  **build を忘れると MCP がまったく起動しない**（クライアント側で最初に詰まる箇所）
- 決めること: 配布物に dist を同梱するか / セットアップスクリプトで build を強制するか /
  postinstall で自動 build するか

## 6. 案D（82カラム DEFAULT）— **未決**

- 前回セッションで検討した案。**本書の作成時点で内容を再確認していない**ため、ここでは要約しない
- 着手時は、何を解決する案だったのかの確認から始めること
- 決めること: 採用可否、および採用する場合のマイグレーション方針

## 7. ツール名照合スクリプトの常設 — **対応中: `chore/mcp-permission-check`**

- 対応: `scripts/check-mcp-permissions.ts`（`pnpm check:mcp`）。登録ツールと allow+deny の照合
  （未記載 / 余剰 / 重複を fail）に加えて
  - **キー検査**: `mcpServers` に `line-harness` キーが存在すること。`packages/mcp-server` を指す
    別名キー（例: `line-harness-miki`）があれば fail（→ [client-setup-runbook.md §5 ③](client-setup-runbook.md)）
  - **2 モード**: `--ci` は `.mcp.json.example` のみ検査（CI に `.mcp.json` は無い）。
    既定（ローカル）は `.mcp.json.example` と `.mcp.json` の両方を検査し、`.mcp.json` が無ければ fail
  - prefix が `mcp__line-harness__` でない `mcp__*harness*__` の entry は黙って捨てず fail（exit 1）にする。
    その deny は実行時に何も止めていないため
- 残: CI（`.github/workflows/release.yml`）への `pnpm check:mcp --ci` の組み込みは未

## 8. 「fork にクライアント固有の値を置かない」の明文化 — **未決**

- 上記 3・4 が示すとおり、現状の fork には固有値が**混在している**
- 原則として何をリポジトリに置き、何を環境変数・ローカルファイルへ出すかの線引きが未定義
- 現時点で fork 外に出ている（`.gitignore` 済み）もの:
  `.mcp.json` / `apps/worker/.dev.vars` / `dist/`
- 現時点で fork 内に残っている固有値: `account_id` / `database_id` / `MANIFEST_URL`
- 決めること: 線引きの原則をどこに書くか（`AGENTS.md` か `CONTRIBUTING.md` か本書か）/
  既存の混在分をいつ解消するか

---

## 本書に含めていないが、調査中に出た未決事項

手順書側で「未決」と印を付けたもの。再掲のみで、判断は同じくしていない。

- **`package.json` の `db:migrate` / `db:migrate:local` が `schema.sql` を指している**
  → 51 マイグレーション前の DB ができる。修正するか廃止するか未決
  （[client-setup-runbook.md §1](client-setup-runbook.md)）
- **staff キーが D1 に平文保存されている**
  → ハッシュ保存へ移すか未決。移す場合は既存キーの移行が要る
  （[client-setup-runbook.md §4](client-setup-runbook.md)）
- **MCP resources（3 本）が allow/deny の対象外で、中身が未調査**
  → 読み取り専用環境を謳う前に要確認
  （[client-setup-runbook.md §6](client-setup-runbook.md)）
- **MCP サーバー名を改名した場合に deny が無効化される件が未実測**
  → 構造上の帰結としては確実だが再現確認をしていない
  （[client-setup-runbook.md §6](client-setup-runbook.md)）

---

## 追記: タイムスタンプ表記の規約（2026-09-13 起票・2026-09-17 改訂）

- **形式は列ごとに 1 つ。1 列に複数の形式を書き込まない**
  - **既定: `+09:00` 付き**（`jstNow()` / `toJstString()`）— `broadcasts.sent_at` など TS 側が書く列
  - **予約・イベント系の出来事時刻は UTC `Z`** — `starts_at` / `ends_at` / `requested_at` / `scheduled_at` /
    `sent_at`（`booking_reminders` / `event_booking_reminders`）など。
    根拠: [`036_booking.sql:4-8`](../packages/db/migrations/036_booking.sql#L4) /
    [`037_event_booking.sql:4-8`](../packages/db/migrations/037_event_booking.sql#L4)
  - **naive JST（offset なし）は例外列を列挙する**: `batch_lock_at`
    （[`031_batch_lock_at.sql:14`](../packages/db/migrations/031_batch_lock_at.sql#L14)）ほか、
    SQL の `DEFAULT (strftime(..., 'now', '+9 hours'))` で書かれる列（`bootstrap.sql` に 82 列。§6 案D の対象）
- **既知の混在**（規約違反・別 PR で扱う）
  - `created_at` 系: TS は `jstNow()` で `+09:00` を書く一方、SQL の DEFAULT は naive JST（上記 82 列）。
    INSERT が列を省略した行だけ形式が変わり、**同じ列に 2 形式が混在しうる**
  - `DEFAULT (datetime('now'))` の列が `bootstrap.sql` に 14 列あり、これは naive **UTC**（第 3 の形式）
  - `packages/db/src/broadcasts.ts:298` — `new Date(Date.now() + 9h).toISOString()` で
    JST の壁時計時刻に `Z` が付く（`broadcast_insights.fetched_at`）。値は JST なのに UTC を示す suffix
- SQL で経過時間を比較するときは、列の形式に `now` 側を合わせる。`+09:00` 付きの列は
  `julianday('now') - julianday(col)`（SQLite が offset を UTC 正規化する）、naive JST の列は
  `julianday('now', '+9 hours') - julianday(col)`。混ぜると 9 時間ズレる
  - 実例: `packages/db/src/broadcasts.ts:250` の `sent_at`（`+09:00`）比較が `'+9 hours'` を使っており
    9 時間早く拾っていた → `fix/insight-sent-at-offset` で修正。`batch_lock_at`（naive JST）の比較（:374 / :395）は正しい

# 配布前チェックリスト

> fork をクライアントに渡す前に決着させる項目。**列挙のみ。本書の作成時点では 1 件も実行していない。**
> 2026-09-13 起票。判断が要るものは「未決」として残してある — 勝手に決めない。
>
> 手順そのものは [client-setup-runbook.md](client-setup-runbook.md) にある。本書は「まだ決まっていないこと」だけを扱う。

---

## 1. LICENSE — **未決**

- 現状: リポジトリ直下に `LICENSE` ファイルが**存在しない**。`package.json` にも `license` フィールドなし
- upstream (`Shudesu/line-harness-oss`) のライセンスを確認し、fork 側の表記をどうするか決める
- クライアントへの再配布可否・改変可否がここで決まるため、**他の項目より先に決着が要る**
- 決めること: upstream のライセンスは何か / fork に LICENSE を置くか / クライアント納品物の扱い

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

- 現状: Cloudflare の `account_id` が**リポジトリにハードコード**されている（`apps/worker/wrangler.toml` の 16行目・56行目）
- fork をそのまま渡すと自分のアカウント ID がクライアントに渡る
- 決めること: env 化するか / クライアントごとに書き換える手順にするか / `.gitignore` 対象にするか

## 4. `database_id` — **未決**

- 現状: `database_id = "0f04675b-2cbe-4a90-8561-8561b1684206"` がハードコード（24-25行目・64-65行目）
- **2 つの環境ブロックで `database_name` が違うのに `database_id` が同一**
  （`line-harness` と `line-crm` が同じ ID を指している）。意図的かどうかの確認が要る
- 決めること: 上記が意図的か（先に確認）/ クライアントごとの払い出し手順 / テンプレート化の方法

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

## 7. ツール名照合スクリプトの常設 — **未決**

- 現状: MCP 登録ツールと `.claude/settings.json` の allow+deny の照合を**手作業で実施**
  （2026-09-13 時点 29 = 9 + 20、未記載 0・余剰 0。→ [client-setup-runbook.md §6](client-setup-runbook.md)）
- `registerAllTools` にツールを 1 本足すと、allow/deny のどちらにも載らない「未記載ツール」が生まれ、
  **deny されないまま露出する**。手作業では追随漏れが起きる
- 決めること: スクリプト化するか / `scripts/` に置くか CI に組むか / 未記載検出時に fail させるか

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

## 追記: タイムスタンプ表記の層またぎ不一致（2026-09-13）

- **タイムスタンプ表記は SQL 側の naive JST が正**（根拠: `packages/db/migrations/031_batch_lock_at.sql:14` の設計注記）
  → TS 側の一部が `+09:00` 付きで書いており、層をまたいだ不一致が残る。統一は専用 PR で扱う
- **`packages/db/src/broadcasts.ts:298` — `new Date(Date.now() + 9h).toISOString()` で JST 値に `Z` が付く**
  → 値は JST の壁時計時刻なのに UTC を示す suffix が付く。要調査

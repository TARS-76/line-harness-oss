# Project Instructions

- ゴールから外れる提案をしないでください。
- ゴールに進む提案を必ずしてください。
- 回答には必ず「次のタスクはこれ」「今の進捗を全体像から整理するとこれ」を含めてください。
- 私が大学生だと思って、言語化してください。

## 技術方針

- **カレンダー境界（月初・日初など）を SQL の `now` で作らない。JS 側で JST の境界を組み、バインドパラメータで渡す。** SQLite の `date('now', ...)` は UTC 基準で、JST の 00:00-09:00 の 9 時間だけ前日/前月の値を返すため（実測: `date('2026-09-01T02:00:00.000+09:00','start of month')` → `2026-08-01`）。`step-delivery.ts` / `booking-reminders.ts` はこの慣習に従っており、破れていた `line-accounts.ts` は修正済み。理由の詳細は [`jstMonthStart` の docstring](apps/worker/src/routes/line-accounts.ts#L62) に 1 箇所だけ書いてあるのでそちらを見ること。なお `conversations.ts` の `strftime('%s','now')` は**経過時間の差分**計算で、両辺が同じ epoch に解決されるため安全（実測で確認済み）＝ 差分は可・境界は不可。
- **タイムスタンプの形式は列ごとに 1 つ。** 既定は `+09:00` 付き（`jstNow()`）。予約・イベント系の出来事時刻（`starts_at` / `sent_at` など）は UTC `Z`（`036_booking.sql` / `037_event_booking.sql` 冒頭の規約）。naive JST（offset なし）は `batch_lock_at`（`031_batch_lock_at.sql:14`）など例外列のみ。1 列に複数の形式を書き込まない。経過時間を SQL で比較するときは列の形式に `now` 側を合わせる（`+09:00` の列は `julianday('now')`、naive JST の列は `julianday('now', '+9 hours')`）。列ごとの一覧は [pre-distribution-checklist.md の追記](docs/pre-distribution-checklist.md)。

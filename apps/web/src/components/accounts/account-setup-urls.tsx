'use client'

import { useState } from 'react'

interface Props {
  liffId: string | null
  // Heading shown above the URL list. Defaults to a registration-friendly
  // wording ("以下を LINE Developers Console に貼ってください") but the edit
  // modal can override it to "現在の設定値".
  heading?: string
}

// Worker base URL for webhook / OAuth / LIFF endpoint registration.
// In production this is something like https://your-worker.your-subdomain.workers.dev.
// We derive it from NEXT_PUBLIC_API_URL because the admin UI already requires
// that env var (build fails without it — see apps/web/src/lib/api.ts).
function workerBase(): string {
  const url = process.env.NEXT_PUBLIC_API_URL
  if (!url) return ''
  return url.replace(/\/$/, '')
}

export default function AccountSetupUrls({ liffId, heading }: Props) {
  const base = workerBase()
  const webhookUrl = base ? `${base}/webhook` : ''
  const callbackUrl = base ? `${base}/auth/callback` : ''
  // For multi-account, every LIFF endpoint URL must include `?liffId=` so the
  // LIFF page knows which account to init for. Without it, the LIFF page
  // falls back to VITE_LIFF_ID (account ①) and non-default accounts hit an
  // auth loop. See memory: liff-endpoint-url-rule.md.
  const liffEndpointUrl = base && liffId ? `${base}?liffId=${encodeURIComponent(liffId)}` : ''

  return (
    <div className="space-y-3 mt-4 pt-4 border-t border-gray-100">
      <p className="text-xs font-medium text-gray-700">
        {heading ?? 'LINE Developers Console に登録すべき URL'}
      </p>
      <div className="space-y-2">
        <UrlRow label="Webhook URL" hint="Messaging API channel に貼る" url={webhookUrl} />
        <UrlRow
          label="Callback URL"
          hint="LINE Login channel の Callback URL に貼る"
          url={callbackUrl}
        />
        <UrlRow
          label="LIFF Endpoint URL"
          hint={
            liffId
              ? '?liffId= 付き — LIFF 設定画面に貼る'
              : 'LIFF ID 入力後に表示されます'
          }
          url={liffEndpointUrl}
        />
      </div>
    </div>
  )
}

function UrlRow({ label, hint, url }: { label: string; hint: string; url: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // navigator.clipboard requires HTTPS / secure context. If it ever fails
      // the user can still select-copy from the visible text.
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-600">{label}</span>
        <span className="text-[10px] text-gray-400">{hint}</span>
      </div>
      <div className="flex items-stretch gap-1">
        <input
          readOnly
          value={url}
          placeholder="—"
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-xs font-mono bg-gray-50 text-gray-700 truncate"
        />
        <button
          type="button"
          onClick={onCopy}
          disabled={!url}
          className="px-2 rounded text-xs font-medium border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copied ? '✓' : 'コピー'}
        </button>
      </div>
    </div>
  )
}

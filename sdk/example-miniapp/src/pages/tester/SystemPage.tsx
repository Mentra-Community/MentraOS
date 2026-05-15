// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useSession} from "@mentra/miniapp/react"

import {Button} from "../../ui/button"
import {Input} from "../../ui/input"
import {Label} from "../../ui/label"
import {Textarea} from "../../ui/textarea"
import {Shell} from "../Shell"

export default function SystemPage() {
  const session = useSession()
  const navigate = useNavigate()

  const [url, setUrl] = useState("https://mentraglass.com")
  const [clipText, setClipText] = useState("Copied from Mentra mini app!")
  const [shareText, setShareText] = useState("Try MentraOS — smart glasses for developers.\nhttps://mentraglass.com")
  const [log, setLog] = useState<string[]>([])

  const appendLog = (msg: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, 10))

  const handleOpenUrl = () => {
    session.system.openUrl(url)
    appendLog(`openUrl("${url}")`)
  }

  const handleCopy = async () => {
    try {
      await session.system.copyToClipboard(clipText)
      appendLog(`copyToClipboard(${clipText.length} chars) ✓ — paste somewhere to verify`)
    } catch (err) {
      appendLog(`copyToClipboard error: ${String(err)}`)
    }
  }

  const handleShare = async () => {
    try {
      const res = await session.system.share({text: shareText, title: "From MentraOS"})
      appendLog(`share() → ${res.cancelled ? "cancelled" : "success=" + res.success}`)
    } catch (err) {
      appendLog(`share error: ${String(err)}`)
    }
  }

  return (
    <Shell>
      <MiniappHeader title="session.system" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <Section emoji="🔗" title="Open URL" subtitle="Opens in the phone's default browser.">
          <Label htmlFor="url">URL</Label>
          <Input id="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button className="mt-2" onClick={handleOpenUrl}>Open</Button>
        </Section>

        <Section emoji="📋" title="Clipboard" subtitle="Writes to the system pasteboard.">
          <Label htmlFor="clip">Text</Label>
          <Input id="clip" value={clipText} onChange={(e) => setClipText(e.target.value)} />
          <Button className="mt-2" onClick={handleCopy}>Copy</Button>
        </Section>

        <Section emoji="🔖" title="Share Sheet" subtitle="Opens the native iOS/Android share sheet.">
          <Label htmlFor="share">Text</Label>
          <Textarea id="share" rows={3} value={shareText} onChange={(e) => setShareText(e.target.value)} />
          <Button className="mt-2" onClick={handleShare}>Share</Button>
        </Section>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Log
          </div>
          {log.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            log.map((entry, i) => (
              <div key={i} className="font-mono text-[11px] text-foreground/80">{entry}</div>
            ))
          )}
        </div>
      </div>
    </Shell>
  )
}

function Section({emoji, title, subtitle, children}: {emoji: string; title: string; subtitle?: string; children: React.ReactNode}) {
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-lg">{emoji}</span>
        <span className="font-semibold">{title}</span>
      </div>
      {subtitle && <p className="mb-3 text-[12px] text-muted-foreground">{subtitle}</p>}
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  )
}

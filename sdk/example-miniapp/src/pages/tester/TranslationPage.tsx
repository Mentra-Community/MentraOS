// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useRef, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useSession} from "@mentra/miniapp/react"

import {Button} from "../../ui/button"
import {Input} from "../../ui/input"
import {Label} from "../../ui/label"
import {Shell} from "../Shell"

export default function TranslationPage() {
  const session = useSession()
  const navigate = useNavigate()

  const [fromLang, setFromLang] = useState("en-US")
  const [toLang, setToLang] = useState("es-ES")
  const [active, setActive] = useState(false)
  const [last, setLast] = useState("—")
  const [log, setLog] = useState<string[]>([])
  const unsubRef = useRef<(() => void) | null>(null)

  const append = (msg: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, 12))

  const toggle = () => {
    if (active) {
      unsubRef.current?.()
      unsubRef.current = null
      setActive(false)
      append(`stopped (${fromLang} → ${toLang})`)
      return
    }
    unsubRef.current = session.translation.forLanguagePair(fromLang.trim(), toLang.trim(), (d) =>
      setLast(`${d.sourceLanguage} → ${d.targetLanguage}: ${d.text}`),
    )
    setActive(true)
    append(`forLanguagePair("${fromLang.trim()}", "${toLang.trim()}") started`)
  }

  const handleStopAll = () => {
    session.translation.stop()
    unsubRef.current = null
    setActive(false)
    append("translation.stop() — all subscriptions torn down")
  }

  return (
    <Shell>
      <MiniappHeader title="session.translation" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Hoisted out of <code className="font-mono">session.mic</code> in v3 alignment. Requires
          {" "}
          <code className="font-mono">MICROPHONE</code> in miniapp.json.
        </p>

        <Section emoji="🌐" title=".forLanguagePair(from, to, handler)" subtitle="Each call is independent — multiple language pairs can run at once.">
          <Label htmlFor="from">From (BCP-47)</Label>
          <Input id="from" value={fromLang} onChange={(e) => setFromLang(e.target.value)} />
          <Label className="mt-2" htmlFor="to">To (BCP-47)</Label>
          <Input id="to" value={toLang} onChange={(e) => setToLang(e.target.value)} />
          <Button className="mt-2" onClick={toggle}>{active ? "Stop" : "Start"}</Button>
          <div className="mt-2 truncate text-sm">
            <span className="text-muted-foreground">last:</span> <span className="font-mono">{last}</span>
          </div>
        </Section>

        <Section emoji="🛑" title=".stop()" subtitle="Tears down every translation subscription this module owns.">
          <Button variant="destructive" onClick={handleStopAll}>session.translation.stop()</Button>
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

function Section({
  emoji,
  title,
  subtitle,
  children,
}: {
  emoji: string
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-lg">{emoji}</span>
        <span className="font-mono text-sm font-semibold">{title}</span>
      </div>
      {subtitle && <p className="mb-3 text-[12px] text-muted-foreground">{subtitle}</p>}
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  )
}

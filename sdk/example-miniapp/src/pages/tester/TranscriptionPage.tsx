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

type Slot = "auto" | "single" | "multi"

export default function TranscriptionPage() {
  const session = useSession()
  const navigate = useNavigate()

  // Each "slot" demonstrates one method in isolation. State for what's
  // active per slot lets us render Start/Stop independently.
  const [activeSlots, setActiveSlots] = useState<Record<Slot, boolean>>({auto: false, single: false, multi: false})
  const [singleLang, setSingleLang] = useState("en-US")
  const [multiLangs, setMultiLangs] = useState("en-US, es-ES, ja-JP")
  const [hints, setHints] = useState("en, ja")
  const [vocab, setVocab] = useState("MentraOS, HIPAA")

  const [lastByLane, setLastByLane] = useState<Record<Slot, string>>({auto: "—", single: "—", multi: "—"})
  const [log, setLog] = useState<string[]>([])

  const unsubsRef = useRef<Partial<Record<Slot, () => void>>>({})

  const append = (msg: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, 12))

  const setLast = (slot: Slot, text: string, lang?: string) =>
    setLastByLane((prev) => ({...prev, [slot]: lang ? `[${lang}] ${text}` : text}))

  const toggleAuto = () => {
    if (activeSlots.auto) {
      unsubsRef.current.auto?.()
      unsubsRef.current.auto = undefined
      setActiveSlots((s) => ({...s, auto: false}))
      append("auto: stopped")
      return
    }
    unsubsRef.current.auto = session.transcription.on((d) => setLast("auto", d.text, d.language))
    setActiveSlots((s) => ({...s, auto: true}))
    append("transcription.on(...) started")
  }

  const toggleSingle = () => {
    if (activeSlots.single) {
      unsubsRef.current.single?.()
      unsubsRef.current.single = undefined
      setActiveSlots((s) => ({...s, single: false}))
      append("single: stopped")
      return
    }
    unsubsRef.current.single = session.transcription.forLanguage(singleLang.trim(), (d) =>
      setLast("single", d.text, d.language ?? singleLang.trim()),
    )
    setActiveSlots((s) => ({...s, single: true}))
    append(`forLanguage("${singleLang.trim()}") started`)
  }

  const toggleMulti = () => {
    if (activeSlots.multi) {
      unsubsRef.current.multi?.()
      unsubsRef.current.multi = undefined
      setActiveSlots((s) => ({...s, multi: false}))
      append("multi: stopped")
      return
    }
    const langs = multiLangs.split(",").map((l) => l.trim()).filter(Boolean)
    unsubsRef.current.multi = session.transcription.forLanguage(langs, (d) =>
      setLast("multi", d.text, d.language),
    )
    setActiveSlots((s) => ({...s, multi: true}))
    append(`forLanguage([${langs.join(", ")}]) started`)
  }

  const handleConfigure = () => {
    const languageHints = hints.split(",").map((s) => s.trim()).filter(Boolean)
    const vocabulary = vocab.split(",").map((s) => s.trim()).filter(Boolean)
    session.transcription.configure({languageHints, vocabulary, diarization: true})
    append(`configure({languageHints: [${languageHints.join(", ")}], vocabulary: [${vocabulary.join(", ")}], diarization: true})`)
  }

  const handleStopAll = () => {
    session.transcription.stop()
    unsubsRef.current = {}
    setActiveSlots({auto: false, single: false, multi: false})
    append("transcription.stop() — all subscriptions torn down")
  }

  return (
    <Shell>
      <MiniappHeader title="session.transcription" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Each section exercises one method in isolation. Requires
          {" "}
          <code className="font-mono">MICROPHONE</code> in miniapp.json.
        </p>

        <Section
          emoji="🌐"
          title=".on(handler)"
          subtitle="Auto-detect language. Detected language is in data.language."
        >
          <Button onClick={toggleAuto}>{activeSlots.auto ? "Stop" : "Start"}</Button>
          <div className="mt-2 truncate text-sm">
            <span className="text-muted-foreground">last:</span> <span className="font-mono">{lastByLane.auto}</span>
          </div>
        </Section>

        <Section
          emoji="🔤"
          title=".forLanguage(lang, handler)"
          subtitle="One language."
        >
          <Label htmlFor="single-lang">Language (BCP-47)</Label>
          <Input id="single-lang" value={singleLang} onChange={(e) => setSingleLang(e.target.value)} />
          <Button className="mt-2" onClick={toggleSingle}>{activeSlots.single ? "Stop" : "Start"}</Button>
          <div className="mt-2 truncate text-sm">
            <span className="text-muted-foreground">last:</span> <span className="font-mono">{lastByLane.single}</span>
          </div>
        </Section>

        <Section
          emoji="🌍"
          title=".forLanguage([lang1, lang2, …], handler)"
          subtitle="Multiple languages, single subscription."
        >
          <Label htmlFor="multi-langs">Languages (comma-separated)</Label>
          <Input id="multi-langs" value={multiLangs} onChange={(e) => setMultiLangs(e.target.value)} />
          <Button className="mt-2" onClick={toggleMulti}>{activeSlots.multi ? "Stop" : "Start"}</Button>
          <div className="mt-2 truncate text-sm">
            <span className="text-muted-foreground">last:</span> <span className="font-mono">{lastByLane.multi}</span>
          </div>
        </Section>

        <Section
          emoji="⚙️"
          title=".configure(config)"
          subtitle="Sends languageHints + vocabulary + diarization to the cloud."
        >
          <Label htmlFor="hints">languageHints</Label>
          <Input id="hints" value={hints} onChange={(e) => setHints(e.target.value)} />
          <Label className="mt-2" htmlFor="vocab">vocabulary</Label>
          <Input id="vocab" value={vocab} onChange={(e) => setVocab(e.target.value)} />
          <Button className="mt-2" onClick={handleConfigure}>Apply config</Button>
        </Section>

        <Section emoji="🛑" title=".stop()" subtitle="Tears down every transcription subscription this module owns.">
          <Button variant="destructive" onClick={handleStopAll}>session.transcription.stop()</Button>
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

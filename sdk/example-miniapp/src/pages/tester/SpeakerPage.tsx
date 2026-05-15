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

// A short public-domain MP3 as a sanity default.
const SAMPLE_URL = "https://file-examples.com/storage/fe52b2c4fa6816aa39f5b99/2017/11/file_example_MP3_700KB.mp3"

export default function SpeakerPage() {
  const session = useSession()
  const navigate = useNavigate()

  const [audioUrl, setAudioUrl] = useState(SAMPLE_URL)
  const [tts, setTts] = useState("Hello from the Mentra miniapp SDK.")
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState<"play" | "speak" | null>(null)

  const appendLog = (msg: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, 15))

  const handlePlay = async () => {
    setBusy("play")
    try {
      await session.speaker.play({audioUrl})
      appendLog(`play() completed`)
    } catch (err) {
      appendLog(`play error: ${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const handleSpeak = async () => {
    setBusy("speak")
    try {
      const res = await session.speaker.speak(tts)
      appendLog(`speak() completed=${res.completed}`)
    } catch (err: unknown) {
      const e = err as {code?: string; message?: string}
      appendLog(`speak error: ${e.code ?? ""} ${e.message ?? String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const handleStop = () => {
    session.speaker.stop()
    appendLog(`stop() sent`)
  }

  return (
    <Shell>
      <MiniappHeader title="session.speaker" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <div className="mb-4 rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-lg">▶️</span>
            <span className="font-semibold">Play URL</span>
          </div>
          <p className="mb-2 text-[12px] text-muted-foreground">Streams the URL through the phone's audio output.</p>
          <Label htmlFor="url">Audio URL</Label>
          <Input id="url" value={audioUrl} onChange={(e) => setAudioUrl(e.target.value)} />
          <div className="mt-2 flex gap-2">
            <Button onClick={handlePlay} disabled={busy !== null}>
              {busy === "play" ? "Playing…" : "Play"}
            </Button>
            <Button variant="destructive" onClick={handleStop}>Stop</Button>
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-lg">🗣️</span>
            <span className="font-semibold">Speak (Cloud TTS)</span>
          </div>
          <p className="mb-2 text-[12px] text-muted-foreground">Uses the cloud TTS endpoint wired into the phone.</p>
          <Label htmlFor="tts">Text</Label>
          <Textarea id="tts" rows={3} value={tts} onChange={(e) => setTts(e.target.value)} />
          <Button className="mt-2" onClick={handleSpeak} disabled={busy !== null}>
            {busy === "speak" ? "Speaking…" : "Speak"}
          </Button>
        </div>

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

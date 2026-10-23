// Tester page — fire-and-forget speaker (TTS + raw audio + live PCM stream).

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useRpc} from "@mentra/miniapp/ui"

import "../../../shared/channels"
import type {Channels} from "../../../shared/channels"
import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {ErrorRow} from "./_TesterRow"

export default function SpeakerPage() {
  const navigate = useNavigate()
  const {invoke, lastError} = useTester("speaker")
  const streamTone = useRpc<Channels, "tester:speaker-stream-tone">("tester:speaker-stream-tone")
  const onsetTest = useRpc<Channels, "tester:speaker-onset-test">("tester:speaker-onset-test")
  const [phrase, setPhrase] = useState("Hello from MentraJS")
  const [audioUrl, setAudioUrl] = useState(
    "https://file-examples.com/storage/fe0e2ffd1867594d0d2b0f2/2017/11/file_example_MP3_700KB.mp3",
  )
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [onsetStatus, setOnsetStatus] = useState<string | null>(null)
  const [onsetRunning, setOnsetRunning] = useState(false)

  const runOnsetTest = async (kind: "clicks" | "speech") => {
    if (onsetRunning) return
    setOnsetRunning(true)
    setOnsetStatus(
      kind === "clicks"
        ? "Glasses stay quiet for 6s, then four beeps, then four beeps again with no gap."
        : "Glasses stay quiet for 6s, then the recorded phrase “Testing. One. Two. Three.” twice, back to back.",
    )
    try {
      const res = await onsetTest({kind, idleMs: 6000})
      setOnsetStatus(
        `done — idle ${res.idleMs}ms, pass 1 ${res.first.durationMs ?? "?"}ms, pass 2 ${res.second.durationMs ?? "?"}ms. ` +
          (kind === "clicks"
            ? "Each pass should be four beeps. A missing first beep on pass 1 is the clip."
            : "Each pass should start with Testing. A missing first syllable on pass 1 is the clip."),
      )
    } catch (err) {
      setOnsetStatus(`failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setOnsetRunning(false)
    }
  }

  // speaker.createStream E2E: the background generates a 440Hz tone and pumps
  // it through the live PCM stream; we only see the summary here.
  const runStreamTone = async () => {
    try {
      setStreamStatus("streaming 5s 440Hz tone via createStream…")
      const res = await streamTone({seconds: 5, freqHz: 440, sampleRate: 16000})
      setStreamStatus(
        `done — ${res.streamId}: played ${res.durationMs ?? "?"}ms in ${res.chunks} chunks ` +
          `(last bufferedMs ${res.lastBufferedMs})`,
      )
    } catch (err) {
      setStreamStatus(`failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <Shell>
      <MiniappHeader title="session.speaker" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <Label htmlFor="speaker-phrase">phrase</Label>
        <Input id="speaker-phrase" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        <div className="mt-3 flex gap-2">
          <Button onClick={() => invoke("speak", [phrase]).catch(() => {})}>speak(phrase)</Button>
          <Button variant="destructive" onClick={() => invoke("stop", []).catch(() => {})}>
            stop()
          </Button>
        </div>

        <div className="mt-5">
          <Label htmlFor="speaker-audio-url">audio URL (MP3/WAV)</Label>
          <Input
            id="speaker-audio-url"
            value={audioUrl}
            onChange={(e) => setAudioUrl(e.target.value)}
            placeholder="https://example.com/clip.mp3"
          />
          <div className="mt-2 flex gap-2">
            <Button onClick={() => invoke("play", [{audioUrl}]).catch(() => {})}>play({"{audioUrl}"})</Button>
          </div>
        </div>

        <div className="mt-5">
          <Label>onset clip test</Label>
          <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
            Leaves the glasses quiet so the speaker can power down, then plays audio that is already loud on the
            first sample. Count pass 1 against pass 2. Pass 2 starts the moment pass 1 ends.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            <Button disabled={onsetRunning} onClick={() => void runOnsetTest("clicks")}>
              Four beeps after idle, then again
            </Button>
            <Button disabled={onsetRunning} variant="secondary" onClick={() => void runOnsetTest("speech")}>
              Play “Testing. One. Two. Three.” after idle, then again
            </Button>
          </div>
          {onsetStatus && (
            <div className="mt-2 break-all font-mono text-[12px] text-muted-foreground">{onsetStatus}</div>
          )}
        </div>

        <div className="mt-5">
          <Label>live PCM stream (createStream)</Label>
          <div className="mt-2 flex gap-2">
            <Button onClick={() => void runStreamTone()}>stream 5s 440Hz tone</Button>
          </div>
          {streamStatus && (
            <div className="mt-2 break-all font-mono text-[12px] text-muted-foreground">{streamStatus}</div>
          )}
        </div>

        <ErrorRow event={lastError} />
      </div>
    </Shell>
  )
}

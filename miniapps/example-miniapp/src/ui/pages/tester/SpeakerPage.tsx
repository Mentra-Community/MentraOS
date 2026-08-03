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
  const [phrase, setPhrase] = useState("Hello from MentraJS")
  const [audioUrl, setAudioUrl] = useState(
    "https://file-examples.com/storage/fe0e2ffd1867594d0d2b0f2/2017/11/file_example_MP3_700KB.mp3",
  )
  const [streamStatus, setStreamStatus] = useState<string | null>(null)

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

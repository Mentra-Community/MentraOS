// Tester page — fire-and-forget speaker (TTS + raw audio).

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {ErrorRow} from "./_TesterRow"

export default function SpeakerPage() {
  const navigate = useNavigate()
  const {fire, lastError} = useTester("speaker")
  const [phrase, setPhrase] = useState("Hello from MentraJS")
  return (
    <Shell>
      <MiniappHeader title="session.speaker" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <Label htmlFor="speaker-phrase">phrase</Label>
        <Input id="speaker-phrase" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        <div className="mt-3 flex gap-2">
          <Button onClick={() => fire("speak", [phrase])}>speak(phrase)</Button>
          <Button variant="destructive" onClick={() => fire("stop", [])}>
            stop()
          </Button>
        </div>
        <ErrorRow event={lastError} />
      </div>
    </Shell>
  )
}

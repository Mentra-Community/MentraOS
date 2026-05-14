// Tester page — fire-and-forget actions go through the
// `tester:fire` channel; background dispatches to session.display.*.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import "../../../shared/channels"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"

export default function DisplayPage() {
  const navigate = useNavigate()
  const [text, setText] = useState("Hello from MentraJS!")
  const fire = (method: string, args: unknown[] = []) =>
    mentra.send("tester:fire", {iface: "display", method, args})
  return (
    <Shell>
      <MiniappHeader title="session.display" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Render text on the glasses display. Tap a button to invoke the
          corresponding `session.display.*` method in background.
        </p>
        <Label htmlFor="display-text">text</Label>
        <Input id="display-text" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button onClick={() => fire("showTextWall", [text])}>showTextWall(text)</Button>
          <Button onClick={() => fire("showReferenceCard", ["Title", text])}>
            showReferenceCard(title, text)
          </Button>
          <Button onClick={() => fire("showDoubleTextWall", ["Top", text])}>
            showDoubleTextWall(top, bottom)
          </Button>
          <Button variant="destructive" onClick={() => fire("clearView", [])}>
            clearView()
          </Button>
        </div>
      </div>
    </Shell>
  )
}

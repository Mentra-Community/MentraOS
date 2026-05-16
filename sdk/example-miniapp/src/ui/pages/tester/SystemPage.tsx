// Tester page — fire-and-forget OS-level utilities.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {ErrorRow, TableRow} from "./_TesterRow"

export default function SystemPage() {
  const navigate = useNavigate()
  // We open a tester subscription so the result/error events from `fire`
  // calls flow back here as `tester:event`s. The system module itself
  // has no streamed event surface.
  const {log, fire, lastError} = useTester("system")
  const lastResult = [...log].reverse().find((e) => e.kind === "result")
  const [url, setUrl] = useState("https://mentra.glass")
  const [clipText, setClipText] = useState("Hello from session.system.copyToClipboard")
  return (
    <Shell>
      <MiniappHeader title="session.system" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          OS-level utilities — open URL, share sheet, clipboard, download.
          All fire-and-forget; this module has no streamed event surface.
        </p>
        <Label htmlFor="sys-url">URL</Label>
        <Input id="sys-url" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={() => fire("openUrl", [url])}>openUrl(url)</Button>
          <Button onClick={() => fire("share", [{url, title: "Shared from Mentra"}])}>
            share({"{"}url, title{"}"})
          </Button>
        </div>
        <Label htmlFor="sys-clip" className="mt-4 block">clipboard text</Label>
        <Input id="sys-clip" value={clipText} onChange={(e) => setClipText(e.target.value)} />
        <div className="mt-2 flex gap-2">
          <Button onClick={() => fire("copyToClipboard", [clipText])}>copyToClipboard(text)</Button>
        </div>
        <TableRow
          emoji="📨"
          label="last fire() result"
          data={lastResult ? ((lastResult.payload as unknown) as Record<string, unknown>) : null}
        />
        <ErrorRow event={lastError} />
      </div>
    </Shell>
  )
}

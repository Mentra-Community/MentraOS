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
  // session.system is imperative-only — every action resolves through the
  // `tester:invoke` RPC reply (the awaited return of invoke()), so capture
  // the latest result in local state rather than off the event stream.
  const {invoke, lastError} = useTester("system")
  const [lastResult, setLastResult] = useState<Record<string, unknown> | null>(null)
  const [url, setUrl] = useState("https://mentra.glass")
  const [clipText, setClipText] = useState("Hello from session.system.copyToClipboard")

  const run = (method: string, args: unknown[]) => {
    invoke(method, args)
      .then((r) =>
        setLastResult(
          r && typeof r === "object"
            ? {method, ...(r as Record<string, unknown>)}
            : {method, result: r ?? "(ok)"},
        ),
      )
      .catch(() => {
        /* error already surfaced via lastError → ErrorRow */
      })
  }
  return (
    <Shell>
      <MiniappHeader title="session.system" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          OS-level utilities — open URL, share sheet, clipboard, download.
          All fire-and-forget; this module has no streamed event surface.
        </p>
        <Label htmlFor="sys-url">URL</Label>
        <Input id="sys-url" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={() => run("openUrl", [url])}>openUrl(url)</Button>
          <Button onClick={() => run("share", [{url, title: "Shared from Mentra"}])}>
            share({"{"}url, title{"}"})
          </Button>
        </div>
        <Label htmlFor="sys-clip" className="mt-4 block">clipboard text</Label>
        <Input id="sys-clip" value={clipText} onChange={(e) => setClipText(e.target.value)} />
        <div className="mt-2 flex gap-2">
          <Button onClick={() => run("copyToClipboard", [clipText])}>copyToClipboard(text)</Button>
        </div>
        <TableRow emoji="📨" label="last invoke() result" data={lastResult} ordered />
        <ErrorRow event={lastError} />
      </div>
    </Shell>
  )
}

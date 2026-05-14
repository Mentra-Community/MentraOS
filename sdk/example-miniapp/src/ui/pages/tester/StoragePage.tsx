// Tester page — diagnostic surface, ephemeral by design.
// session.storage doesn't have an event surface, so background's
// TesterController serves the "tester:fire" requests directly and
// surfaces results via the "tester:event" channel with kind="result".

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {TableRow} from "./_TesterRow"

export default function StoragePage() {
  const navigate = useNavigate()
  const {log, fire} = useTester("storage")
  const [key, setKey] = useState("test-key")
  const [value, setValue] = useState("hello")
  const lastResult = [...log].reverse().find((e) => e.kind === "result" || e.kind === "error")
  return (
    <Shell>
      <MiniappHeader title="session.storage" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Per-miniapp key/value store. Read-then-write tests use the
          `tester:fire` dispatcher; the result envelope comes back on
          `tester:event` with kind="result".
        </p>
        <Label htmlFor="storage-key">key</Label>
        <Input id="storage-key" value={key} onChange={(e) => setKey(e.target.value)} />
        <Label htmlFor="storage-value">value</Label>
        <Input id="storage-value" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="mt-3 flex gap-2">
          <Button onClick={() => fire("set", [key, value])}>set(key, value)</Button>
          <Button onClick={() => fire("get", [key])}>get(key)</Button>
          <Button onClick={() => fire("delete", [key])}>delete(key)</Button>
        </div>
        <div className="mt-4">
          <TableRow
            emoji="🗄️"
            label="last result"
            data={lastResult ? ((lastResult.payload as unknown) as Record<string, unknown>) : null}
          />
        </div>
      </div>
    </Shell>
  )
}

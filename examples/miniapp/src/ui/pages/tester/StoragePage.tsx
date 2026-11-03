// Tester page — diagnostic surface, ephemeral by design.
// session.storage has no event surface; it's an imperative tester. Each
// button issues a "tester:invoke" RPC that background dispatches to
// session.storage.*, and the call's return value (e.g. get → the stored
// string) is the RPC resolution we render below.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {ErrorRow, TableRow} from "./_TesterRow"

export default function StoragePage() {
  const navigate = useNavigate()
  const {invoke, lastError} = useTester("storage")
  const [key, setKey] = useState("test-key")
  const [value, setValue] = useState("hello")
  const [result, setResult] = useState<{method: string; args: unknown[]; value: unknown} | null>(null)

  // invoke() routes errors to lastError (and re-throws), so the catch just
  // keeps the last successful result visible while <ErrorRow> shows the error.
  const run = async (method: "set" | "get" | "delete", args: unknown[]) => {
    try {
      const value = await invoke(method, args)
      setResult({method, args, value})
    } catch {
      /* surfaced via lastError */
    }
  }

  return (
    <Shell>
      <MiniappHeader title="session.storage" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Per-miniapp key/value store. Read-then-write tests use the
          `tester:invoke` dispatcher; the result envelope comes back on
          `tester:event` with kind="result".
        </p>
        <Label htmlFor="storage-key">key</Label>
        <Input id="storage-key" value={key} onChange={(e) => setKey(e.target.value)} />
        <Label htmlFor="storage-value">value</Label>
        <Input id="storage-value" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="mt-3 flex gap-2">
          <Button onClick={() => run("set", [key, value])}>set(key, value)</Button>
          <Button onClick={() => run("get", [key])}>get(key)</Button>
          <Button onClick={() => run("delete", [key])}>delete(key)</Button>
        </div>
        <div className="mt-4">
          <TableRow
            emoji="🗄️"
            label="last result"
            ordered
            data={result ? {method: result.method, args: result.args, value: result.value} : null}
          />
          <ErrorRow event={lastError} />
        </div>
      </div>
    </Shell>
  )
}

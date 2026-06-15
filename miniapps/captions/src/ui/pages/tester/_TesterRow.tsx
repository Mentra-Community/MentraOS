// Tester page — diagnostic surface, ephemeral by design.
// Shared building blocks for tester pages. The leading underscore in the
// filename keeps it out of any future file-pattern routing.

/**
 * Card with emoji + label + a single line of value text.
 * Use for events whose payload is one short value (button press, head pos,
 * VAD boolean, etc.) where a key-value table would be overkill.
 */
export function Row({
  emoji,
  label,
  value,
  mono,
}: {
  emoji: string
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="mb-2 rounded-xl border border-border bg-card p-3">
      <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="text-base">{emoji}</span>
        <span>{label}</span>
      </div>
      <div className={`truncate text-sm ${mono ? "font-mono text-[11px]" : ""}`}>{value}</div>
    </div>
  )
}

/**
 * Card with emoji + label + a key-value table of the event's payload.
 * Use for events with rich payloads (TouchData, ConnectionData,
 * PhoneNotificationData, CalendarEventData, LocationData) so the developer
 * can see every field, not just whatever subset the formatter chose.
 *
 * Pass `data` as a Record<string, unknown> — controllers / page handlers
 * typically spread `{...event}` and tag a `receivedAt` timestamp.
 */
export function TableRow({
  emoji,
  label,
  data,
  ordered,
}: {
  emoji: string
  label: string
  data: Record<string, unknown> | null
  // Keep rows in object insertion order instead of the default
  // value-weighted sort. Use when the field order is meaningful.
  ordered?: boolean
}) {
  const entries = data ? (ordered ? Object.entries(data) : sortedEntries(data)) : []
  return (
    <div className="mb-2 rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="text-base">{emoji}</span>
        <span>{label}</span>
      </div>
      {!data || entries.length === 0 ? (
        <div className="text-sm text-muted-foreground">(none)</div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-[12px]">
            <tbody>
              {entries.map(([key, val], i) => (
                <tr key={key} className={i % 2 === 0 ? "bg-background" : "bg-muted/30"}>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {key}
                  </td>
                  <td className="break-all px-3 py-1.5 font-mono text-[11px]">{renderValue(val)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * Inline banner for the most-recent `tester:event {kind:"error"}` on a
 * page. Pages call `useTester(...)` → render `<ErrorRow event={lastError}/>`
 * so a misnamed iface/method or a bad arg shape surfaces in the UI
 * instead of disappearing into a console log nobody reads.
 */
/**
 * Live invoke status: shows "running…" the instant a button is tapped, then the
 * latency on success, or on failure the code + the exact pipeline stage and
 * transport that broke. Fast-feedback surface — a dev sees where a request is
 * and where it died without digging through logs.
 */
export function StatusRow({status}: {status: import("../../hooks/useTester").InvokeStatus}) {
  if (status.phase === "idle") return null
  if (status.phase === "running") {
    return (
      <div className="mb-2 rounded-xl border border-border bg-card p-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <span className="font-mono text-[12px]">{status.method}() running…</span>
        </div>
      </div>
    )
  }
  if (status.phase === "ok") {
    return (
      <div className="mb-2 rounded-xl border border-green-600 bg-green-600/10 p-3 text-green-700">
        <div className="font-mono text-[12px]">✅ {status.method}() ok · {status.ms}ms</div>
      </div>
    )
  }
  const tags = [status.code, status.stage && `stage:${status.stage}`, status.transport && `via:${status.transport}`]
    .filter(Boolean)
    .join("  ")
  return (
    <div className="mb-2 rounded-xl border border-destructive bg-destructive/10 p-3 text-destructive">
      <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider">
        <span className="text-base">❌</span>
        <span>
          {status.method}() failed · {status.ms}ms
        </span>
      </div>
      {tags && <div className="mb-1 font-mono text-[11px] opacity-80">{tags}</div>}
      <div className="break-all font-mono text-[12px]">{status.message}</div>
    </div>
  )
}

export function ErrorRow({event}: {event: import("../../../shared/types").TesterEventPayload | null}) {
  if (!event) return null
  const payload = event.payload as {method?: string; message?: string} | null
  const method = payload?.method
  const message = payload?.message ?? "(no error message)"
  return (
    <div className="mb-2 rounded-xl border border-destructive bg-destructive/10 p-3 text-destructive">
      <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider">
        <span className="text-base">⚠️</span>
        <span>last invoke() error</span>
      </div>
      <div className="break-all text-[12px] font-mono">
        {method ? `${event.iface}.${method}: ` : `${event.iface}: `}
        {message}
      </div>
    </div>
  )
}

function sortedEntries(obj: Record<string, unknown>): Array<[string, unknown]> {
  // Put primitives (non-empty) first, then empty-ish, then nested — readable
  // scanning order in a table.
  const entries = Object.entries(obj)
  const weight = (v: unknown) => {
    if (v == null || v === "" || v === -1) return 2
    if (typeof v === "object") return 3
    return 1
  }
  return entries.sort((a, b) => {
    const d = weight(a[1]) - weight(b[1])
    if (d !== 0) return d
    return a[0].localeCompare(b[0])
  })
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "null"
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") return v === -1 ? "—" : String(v)
  if (typeof v === "string") return v === "" ? "—" : v
  return JSON.stringify(v)
}

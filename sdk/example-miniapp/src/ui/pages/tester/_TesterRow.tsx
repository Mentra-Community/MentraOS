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
}: {
  emoji: string
  label: string
  data: Record<string, unknown> | null
}) {
  const entries = data ? sortedEntries(data) : []
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

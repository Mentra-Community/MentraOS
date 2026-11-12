// Tester page — phone-side surfaces (notifications, battery, etc.).

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useRpc} from "@mentra/miniapp/ui"

import type {Channels} from "../../../shared/channels"
import type {CalendarSnapshotResult} from "../../../shared/types"
import {Button} from "../../components/button"
import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {ErrorRow, TableRow} from "./_TesterRow"

export default function PhonePage() {
  const navigate = useNavigate()
  const {log, latestByKind, lastError} = useTester("phone")
  const lastNotif = latestByKind("notification")
  const lastBattery = latestByKind("battery")
  const [calendar, setCalendar] = useState<CalendarSnapshotResult | null>(null)
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const calendarList = useRpc<Channels, "tester:calendar-list">("tester:calendar-list")

  const listEvents = async () => {
    setCalendarLoading(true)
    setCalendarError(null)
    const startsAt = new Date()
    const endsAt = new Date(startsAt.getTime() + 7 * 24 * 60 * 60 * 1000)
    try {
      setCalendar(
        await calendarList({
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          limit: 20,
        }),
      )
    } catch (error) {
      setCalendarError(error instanceof Error ? error.message : String(error))
    } finally {
      setCalendarLoading(false)
    }
  }
  return (
    <Shell>
      <MiniappHeader title="session.phone" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Phone-side surfaces — notifications and battery streams, plus calendar snapshots.
          <span className="block mt-2">
            For URL opening / share / clipboard / download see
            <span className="font-mono mx-1">session.system</span>.
          </span>
        </p>
        <TableRow
          emoji="🔔"
          label="last .onNotification()"
          data={lastNotif ? (lastNotif.payload as unknown as Record<string, unknown>) : null}
        />
        <TableRow
          emoji="🔋"
          label="last .onBattery()"
          data={lastBattery ? (lastBattery.payload as unknown as Record<string, unknown>) : null}
        />
        <div className="mb-2 rounded-xl border border-border bg-card p-3">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            📅 calendar.listEvents()
          </div>
          <Button onClick={listEvents} disabled={calendarLoading}>
            {calendarLoading ? "Reading calendar…" : "List next 7 days"}
          </Button>
          {calendarError ? <p className="mt-2 break-all text-[12px] text-destructive">{calendarError}</p> : null}
          {calendar ? (
            <div className="mt-3 space-y-2">
              <p className="text-[12px] text-muted-foreground">
                {calendar.events.length} event(s){calendar.truncated ? " (truncated)" : ""}
              </p>
              {calendar.events.map((event) => (
                <div key={event.id} className="rounded-md border border-border bg-background p-2 text-[12px]">
                  <div className="font-medium">{event.title || "(untitled)"}</div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">{event.startsAt}</div>
                  {event.location ? <div className="mt-1">{event.location}</div> : null}
                  {event.links.map((link) => (
                    <div key={link} className="mt-1 break-all font-mono text-[11px] text-primary">
                      {link}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <ErrorRow event={lastError} />
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}

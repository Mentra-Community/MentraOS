import type {NavManeuver} from "@mentra/miniapp"

import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import type {LogEntry, NavStatus} from "@/frontend/pages/NavigationPage/NavigationPage"
import {useUser} from "@/backend/hooks/useUser"

export function LiveLog({
  log,
  running,
  status,
  maneuver,
}: {
  log: LogEntry[]
  running: boolean
  status: NavStatus
  maneuver: NavManeuver | null
}) {
  const fmt = useUser().navigation.format
  const showStatusBlock = running || maneuver || status !== "idle"
  return (
    <>
      {showStatusBlock ? (
        <>
          <div className="flex items-center gap-2 mt-4 mb-2.5">
            <div
              className={`text-[11px] font-bold tracking-wider px-2 py-1 rounded ${statusPillClasses(status)}`}>
              {statusText(status)}
            </div>
            {maneuver && maneuver.distanceMeters >= 0 ? (
              <div className="text-[12px] font-mono text-neutral-700 bg-neutral-100 px-2 py-1 rounded ml-auto">
                {formatDistance(maneuver.distanceMeters)}
              </div>
            ) : null}
          </div>

          {maneuver ? (
            <ManeuverPill
              glyph={fmt.glyph(maneuver.maneuverType)}
              primary={fmt.headline(maneuver)}
            />
          ) : (
            <div className="text-[13px] text-neutral-500 italic mb-2">
              {status === "rerouting" ? "Rebuilding route…" : "Starting navigation…"}
            </div>
          )}
        </>
      ) : null}

      <h2 className="text-[14px] font-bold tracking-wide text-neutral-800 mt-4 mb-2">
        Live updates {running ? "•" : ""}{" "}
        <span className="font-mono text-[12px] text-neutral-500 font-normal">({log.length})</span>
      </h2>
      <div className="bg-white border border-neutral-200 rounded-xl p-2 max-h-72 overflow-y-auto">
        {log.length === 0 ? (
          <div className="text-[13px] text-neutral-500 italic px-2 py-1">(no events yet)</div>
        ) : (
          log.map((e) => (
            <div
              key={e.id}
              className="flex gap-2 font-mono text-[12px] text-neutral-700 px-1 py-0.5 border-b border-neutral-100 last:border-0">
              <span className="text-neutral-400 shrink-0">{new Date(e.ts).toLocaleTimeString()}</span>
              <span>{e.line}</span>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function ManeuverPill({glyph, primary}: {glyph: string; primary: string}) {
  return (
    <div className="flex items-center gap-3 bg-emerald-700 text-white px-4 py-3 rounded-xl mb-2">
      <div className="text-[28px] font-bold leading-none">{glyph}</div>
      <div className="flex-1 min-w-0">
        <div className="text-base font-semibold leading-tight">{primary}</div>
      </div>
    </div>
  )
}

function statusPillClasses(s: NavStatus): string {
  switch (s) {
    case "navigating":
      return "bg-blue-100 text-blue-800"
    case "rerouting":
      return "bg-amber-100 text-amber-900"
    case "arrived":
      return "bg-emerald-100 text-emerald-900"
    default:
      return "bg-neutral-100 text-neutral-700"
  }
}

function statusText(s: NavStatus): string {
  switch (s) {
    case "idle":
      return "IDLE"
    case "navigating":
      return "NAVIGATING"
    case "rerouting":
      return "REROUTING"
    case "arrived":
      return "ARRIVED"
  }
}

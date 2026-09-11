import type {NavManeuver} from "@mentra/miniapp"

import {ManeuverFormatter} from "@/background/managers/ManeuverFormatter"
import {useNavStore} from "@/ui/store/navStore"
import {formatDistance} from "@/ui/lib/formatDistance"
import type {LogEntry, NavStatus} from "@/shared/types"

const fmt = new ManeuverFormatter()

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
  const unitSystem = useNavStore((s) => s.unitSystem)
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
              <div className="text-[12px] font-mono text-neutral-700 dark:text-zinc-200 bg-neutral-100 dark:bg-zinc-800 px-2 py-1 rounded ml-auto">
                {formatDistance(maneuver.distanceMeters, unitSystem)}
              </div>
            ) : null}
          </div>

          {maneuver ? (
            <ManeuverPill
              glyph={fmt.glyph(maneuver.maneuverType)}
              primary={fmt.headline(maneuver)}
            />
          ) : (
            <div className="text-[13px] text-neutral-500 dark:text-zinc-400 italic mb-2">
              {status === "rerouting" ? "Rebuilding route…" : "Starting navigation…"}
            </div>
          )}
        </>
      ) : null}

      <h2 className="text-[14px] font-bold tracking-wide text-neutral-800 dark:text-zinc-200 mt-4 mb-2">
        Live updates {running ? "•" : ""}{" "}
        <span className="font-mono text-[12px] text-neutral-500 dark:text-zinc-400 font-normal">({log.length})</span>
      </h2>
      <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-2 max-h-72 overflow-y-auto">
        {log.length === 0 ? (
          <div className="text-[13px] text-neutral-500 dark:text-zinc-400 italic px-2 py-1">(no events yet)</div>
        ) : (
          log.map((e) => (
            <div
              key={e.id}
              className="flex gap-2 font-mono text-[12px] text-neutral-700 dark:text-zinc-200 px-1 py-0.5 border-b border-neutral-100 dark:border-zinc-800 last:border-0">
              <span className="text-neutral-400 dark:text-zinc-500 shrink-0">{new Date(e.ts).toLocaleTimeString()}</span>
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
      return "bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-300"
    case "rerouting":
      return "bg-amber-100 dark:bg-amber-500/20 text-amber-900 dark:text-amber-300"
    case "arrived":
      return "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-900 dark:text-emerald-300"
    default:
      return "bg-neutral-100 dark:bg-zinc-800 text-neutral-700 dark:text-zinc-200"
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

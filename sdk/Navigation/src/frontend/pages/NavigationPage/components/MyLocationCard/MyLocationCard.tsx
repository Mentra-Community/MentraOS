import type {Coords} from "@/backend/session/managers/LocationManager"

export function MyLocationCard({coords}: {coords: Coords | null}) {
  return (
    <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3">
      <div className="text-[11px] font-bold tracking-wider text-neutral-500 uppercase">
        📍 My location
      </div>
      {coords ? (
        <>
          <div className="font-mono text-[15px] text-neutral-900 mt-1">
            {coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}
          </div>
          <div className="text-[12px] text-neutral-500 mt-0.5">
            {coords.accuracy != null ? `±${Math.round(coords.accuracy)}m • ` : ""}
            updated {timeAgo(coords.ts)}
          </div>
        </>
      ) : (
        <div className="text-[13px] text-neutral-500 italic mt-1">(waiting for fix…)</div>
      )}
    </div>
  )
}

function timeAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 2) return "just now"
  if (sec < 60) return `${sec}s ago`
  return `${Math.floor(sec / 60)}m ago`
}

type Props = {
  lat: string
  lng: string
  setLat: (v: string) => void
  setLng: (v: string) => void
  simulate: boolean
  setSimulate: (b: boolean) => void
  speedMultiplier: number
  setSpeedMultiplier: (n: number) => void
  running: boolean
  onStart: () => void
  onStop: () => void
}

export function Controls({
  lat,
  lng,
  setLat,
  setLng,
  simulate,
  setSimulate,
  speedMultiplier,
  setSpeedMultiplier,
  running,
  onStart,
  onStop,
}: Props) {
  return (
    <>
      <div className="flex gap-2 mb-2">
        <label className="flex-1 text-[12px] text-neutral-600">
          Lat
          <input
            className="block w-full mt-1 px-3 py-2 rounded-lg border border-neutral-300 font-mono text-[14px] disabled:bg-neutral-100"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            disabled={running}
            inputMode="decimal"
          />
        </label>
        <label className="flex-1 text-[12px] text-neutral-600">
          Lng
          <input
            className="block w-full mt-1 px-3 py-2 rounded-lg border border-neutral-300 font-mono text-[14px] disabled:bg-neutral-100"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            disabled={running}
            inputMode="decimal"
          />
        </label>
      </div>

      <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
        <label className="flex items-center gap-2 text-[14px] text-neutral-800">
          <input
            type="checkbox"
            checked={simulate}
            onChange={(e) => setSimulate(e.target.checked)}
            disabled={running}
          />
          <span>Simulate walking</span>
        </label>
        {simulate ? (
          <label className="flex-1 flex items-center gap-2 text-[12px] text-neutral-600">
            <span className="font-mono w-9 text-right text-neutral-900 font-semibold">
              {speedMultiplier}x
            </span>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={speedMultiplier}
              onChange={(e) => setSpeedMultiplier(Number(e.target.value))}
              disabled={running}
              className="flex-1"
            />
          </label>
        ) : null}
      </div>

      <div className="flex gap-2 mb-2">
        {!running ? (
          <button
            className="flex-1 bg-emerald-600 text-white border-0 px-4 py-3 rounded-xl font-semibold text-base"
            onClick={onStart}>
            Start{simulate ? ` (sim ${speedMultiplier}x)` : ""}
          </button>
        ) : (
          <button
            className="flex-1 bg-red-500 text-white border-0 px-4 py-3 rounded-xl font-semibold text-base"
            onClick={onStop}>
            Stop
          </button>
        )}
      </div>
    </>
  )
}

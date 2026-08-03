type StartStopProps = {
  running: boolean
  canStart: boolean
  simulate: boolean
  speedMultiplier: number
  onStart: () => void
  onStop: () => void
}

export function StartStopButton({
  running,
  canStart,
  simulate,
  speedMultiplier,
  onStart,
  onStop,
}: StartStopProps) {
  return (
    <div className="flex gap-2 mb-2">
      {!running ? (
        <button
          className="flex-1 bg-emerald-600 text-white border-0 px-4 py-3 rounded-xl font-semibold text-base disabled:bg-neutral-300 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed"
          onClick={onStart}
          disabled={!canStart}>
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
  )
}

type SimulationControlsProps = {
  simulate: boolean
  setSimulate: (b: boolean) => void
  speedMultiplier: number
  setSpeedMultiplier: (n: number) => void
  running: boolean
}

export function SimulationControls({
  simulate,
  setSimulate,
  speedMultiplier,
  setSpeedMultiplier,
  running,
}: SimulationControlsProps) {
  return (
    <div className="flex items-center gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-600 rounded-lg px-3 py-2 mb-2">
      <label className="flex items-center gap-2 text-[14px] text-neutral-800 dark:text-zinc-200">
        <input
          type="checkbox"
          checked={simulate}
          onChange={(e) => setSimulate(e.target.checked)}
          disabled={running}
        />
        <span>Simulate walking</span>
      </label>
      {simulate ? (
        <label className="flex-1 flex items-center gap-2 text-[12px] text-neutral-600 dark:text-zinc-300">
          <span className="font-mono w-9 text-right text-neutral-900 dark:text-zinc-50 font-semibold">
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
  )
}

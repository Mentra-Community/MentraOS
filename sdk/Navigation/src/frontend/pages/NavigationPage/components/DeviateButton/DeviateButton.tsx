/**
 * Dev-only: nudge the simulator ~50m off-route to verify the SDK's
 * rerouting pipeline. Only meaningful when a simulated trip is active.
 */
export function DeviateButton({onDeviate}: {onDeviate: () => void}) {
  return (
    <button
      className="w-full mt-2 bg-orange-50 text-orange-900 border border-dashed border-orange-300 px-3 py-2.5 rounded-xl text-sm font-semibold"
      onClick={onDeviate}>
      🚧 Deviate (test reroute)
    </button>
  )
}

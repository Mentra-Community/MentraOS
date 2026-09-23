// Every phone-side glasses-hotspot user reserves it before native preflight.
let owner: symbol | null = null

export function acquireGlassesHotspot(): () => void {
  if (owner) throw new Error("The glasses hotspot is already in use by another operation")
  const token = Symbol("glasses hotspot")
  owner = token
  return () => {
    if (owner === token) owner = null
  }
}

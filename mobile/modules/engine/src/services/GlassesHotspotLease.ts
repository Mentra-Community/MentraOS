// Every hotspot user reserves before BLE AP changes or native association,
// and releases only after its owned cleanup completes.
let owner: symbol | null = null

export function acquireGlassesHotspot(): () => void {
  if (owner) throw new Error("The glasses hotspot is already in use")
  const token = Symbol("glasses hotspot")
  owner = token
  return () => {
    if (owner === token) owner = null
  }
}

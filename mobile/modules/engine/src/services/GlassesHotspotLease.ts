// ACS and managed relay must reserve the hotspot before either starts native preflight.
let owner: symbol | null = null

export function acquireGlassesHotspot(): () => void {
  if (owner) throw new Error("The glasses hotspot is already in use by a call or stream")
  const token = Symbol("glasses hotspot")
  owner = token
  return () => {
    if (owner === token) owner = null
  }
}

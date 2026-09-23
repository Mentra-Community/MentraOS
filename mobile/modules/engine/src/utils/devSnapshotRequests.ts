const generations = new Map<string, number>()

/** Release selection invalidates any earlier asynchronous dev probe/download. */
export function invalidateDevSnapshotRequests(packageName: string): void {
  generations.set(packageName, (generations.get(packageName) ?? 0) + 1)
}

export function createDevSnapshotRequest(packageName: string) {
  const generation = generations.get(packageName) ?? 0
  const isCurrent = () => (generations.get(packageName) ?? 0) === generation
  return {
    isCurrent,
    beforeActivate: () => {
      if (!isCurrent()) throw new Error(`Dev snapshot for ${packageName} was superseded by a release installation`)
    },
  }
}

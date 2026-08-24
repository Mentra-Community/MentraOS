import {createGalleryLoadCoordinator} from "./galleryLoadCoordinator"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return {promise, resolve}
}

describe("createGalleryLoadCoordinator", () => {
  it("coalesces the duplicate mount and focus load", async () => {
    const coordinator = createGalleryLoadCoordinator()
    const pending = deferred()
    const load = jest.fn(() => pending.promise)

    const mountLoad = coordinator.run(load, {refreshAfterCurrent: false})
    const focusLoad = coordinator.run(load, {refreshAfterCurrent: false})
    expect(focusLoad).toBe(mountLoad)
    expect(load).toHaveBeenCalledTimes(1)

    pending.resolve()
    await mountLoad
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("runs a fresh load after an in-flight scan when storage changed", async () => {
    const coordinator = createGalleryLoadCoordinator()
    const initial = deferred()
    const refreshed = deferred()
    const load = jest.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise)

    const initialLoad = coordinator.run(load, {refreshAfterCurrent: false})
    const postSyncLoad = coordinator.run(load)
    expect(postSyncLoad).toBe(initialLoad)

    initial.resolve()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)

    refreshed.resolve()
    await postSyncLoad
  })
})

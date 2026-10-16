const mockTriggers: Array<() => void> = []
let mockInterval: {handler: () => void; intervalMs: number} | null = null
const mockRefresh = jest.fn(async (_session: unknown) => "unchanged")

jest.mock("@mentra/engine", () => ({
  BgTimer: {
    setInterval: (handler: () => void, intervalMs: number) => {
      mockInterval = {handler, intervalMs}
      return 1
    },
    clearInterval: () => {
      mockInterval = null
    },
  },
}))
jest.mock("@/services/miniapps/maintenanceTriggers", () => {
  const subscribe = (handler: () => void) => {
    mockTriggers.push(handler)
    return () => mockTriggers.splice(mockTriggers.indexOf(handler), 1)
  }
  return {subscribeAppForeground: subscribe, subscribeCloudReconnect: subscribe}
})
jest.mock("./refresh", () => ({refreshWorkspaceManifest: (session: unknown) => mockRefresh(session)}))

import {WORKSPACE_MANIFEST_CHECK_INTERVAL_MS, workspaceManifestScheduler} from "./workspaceManifestScheduler"

describe("workspaceManifestScheduler", () => {
  afterEach(() => workspaceManifestScheduler.stop())

  it("re-checks the workspace on foreground, reconnect and every 15 minutes, like Store updates", async () => {
    const session = {isRunning: () => true, reconcile: jest.fn()}
    await workspaceManifestScheduler.start("https://demo.acmeworkspace.com", session)
    // Launch has just checked.
    expect(mockRefresh).not.toHaveBeenCalled()
    expect(mockTriggers).toHaveLength(2)
    expect(mockInterval?.intervalMs).toBe(WORKSPACE_MANIFEST_CHECK_INTERVAL_MS)
    expect(WORKSPACE_MANIFEST_CHECK_INTERVAL_MS).toBe(15 * 60_000)

    mockTriggers[0]()
    await new Promise((done) => setTimeout(done, 0))
    mockInterval!.handler()
    await new Promise((done) => setTimeout(done, 0))
    expect(mockRefresh).toHaveBeenCalledTimes(2)
    expect(mockRefresh).toHaveBeenLastCalledWith(session)

    workspaceManifestScheduler.stop()
    expect(mockTriggers).toHaveLength(0)
    expect(mockInterval).toBeNull()
  })
})

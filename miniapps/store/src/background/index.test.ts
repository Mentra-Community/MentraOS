import {describe, expect, test} from "bun:test"
import type {MiniappSession} from "@mentra/miniapp/background"
import {StoreController} from "./index"
import type {StoreApp, StoreSnapshot} from "../shared/types"

interface TestController {
  install(packageName: string, query?: string, selectedApp?: StoreApp): Promise<StoreSnapshot>
  load(query?: string, clearOperation?: boolean, refreshAutomaticCatalog?: boolean): Promise<StoreSnapshot>
  refresh(query?: string, refreshAutomaticCatalog?: boolean, clearOperation?: boolean): Promise<StoreSnapshot>
  refreshing: Promise<StoreSnapshot> | null
  snapshot: StoreSnapshot
}

describe("StoreController refresh serialization", () => {
  test("queues a post-install reload behind an in-flight background refresh", async () => {
    let finishFirstLoad: (() => void) | undefined
    const firstLoadGate = new Promise<void>((resolve) => {
      finishFirstLoad = resolve
    })
    const loadCalls: Array<{clearOperation: boolean; query?: string}> = []
    const session = {
      miniapps: {
        install: async () => undefined,
      },
      ui: {
        send: () => undefined,
      },
    } as unknown as MiniappSession
    const controller = new StoreController(session) as unknown as TestController
    controller.load = async (query, clearOperation = false) => {
      loadCalls.push({clearOperation, query})
      if (loadCalls.length === 1) await firstLoadGate
      return controller.snapshot
    }

    const backgroundRefresh = controller.refresh("before")
    await Promise.resolve()
    expect(loadCalls).toEqual([{clearOperation: false, query: "before"}])

    const install = controller.install("com.example.app", "after", {
      packageName: "com.example.app",
      release: {
        id: "release-1",
        version: "2.0.0",
        bundleUrl: "https://example.com/bundle.zip",
        bundleSha256: "a".repeat(64),
        hardwareRequirements: [],
      },
    } as unknown as StoreApp)
    await Promise.resolve()
    await Promise.resolve()
    expect(loadCalls).toHaveLength(1)

    finishFirstLoad?.()
    await Promise.all([backgroundRefresh, install])

    expect(loadCalls).toEqual([
      {clearOperation: false, query: "before"},
      {clearOperation: true, query: "after"},
    ])
    expect(controller.refreshing).toBeNull()
  })

  test("does not strand a refresh queued as the drain promise settles", async () => {
    const snapshot = {
      apps: [],
      installed: [],
      loading: false,
      offline: false,
      error: null,
      operation: null,
      refreshedAt: null,
    } satisfies StoreSnapshot
    const session = {
      ui: {
        send: () => undefined,
      },
    } as unknown as MiniappSession
    const controller = new StoreController(session) as unknown as TestController
    const loadCalls: string[] = []
    controller.load = async (query) => {
      loadCalls.push(query ?? "")
      return snapshot
    }

    let completionRefresh: Promise<StoreSnapshot> | undefined
    let queuedCompletionRefresh = false
    Object.defineProperty(controller, "snapshot", {
      configurable: true,
      get: () => {
        if (!queuedCompletionRefresh) {
          queuedCompletionRefresh = true
          queueMicrotask(() => {
            completionRefresh = controller.refresh("completion", false, true)
          })
        }
        return snapshot
      },
    })

    await controller.refresh("initial")
    await Promise.resolve()
    await completionRefresh

    expect(loadCalls).toEqual(["initial", "completion"])
    expect(controller.refreshing).toBeNull()
  })
})

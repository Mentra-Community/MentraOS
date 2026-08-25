import {describe, expect, test} from "bun:test"
import type {MiniappSession} from "@mentra/miniapp/background"
import {StoreController} from "./index"
import type {StoreApp, StoreSnapshot} from "../shared/types"

interface TestController {
  start(): void
  install(packageName: string, query?: string, selectedApp?: StoreApp): Promise<StoreSnapshot>
  load(query?: string, clearOperation?: boolean, refreshAutomaticCatalog?: boolean): Promise<StoreSnapshot>
  refresh(query?: string, refreshAutomaticCatalog?: boolean, clearOperation?: boolean): Promise<StoreSnapshot>
  automaticUpdateCandidates(): StoreApp[]
  scheduleAutomaticUpdates(): Promise<void>
  refreshing: Promise<StoreSnapshot> | null
  snapshot: StoreSnapshot
}

describe("StoreController refresh serialization", () => {
  test("registers host reconciliation as an invocation-scoped action", async () => {
    let actionId = ""
    let actionHandler: (() => Promise<unknown>) | undefined
    const session = {
      miniapps: {onInstallProgress: () => () => undefined},
      actions: {
        handle: (id: string, handler: () => Promise<unknown>) => {
          actionId = id
          actionHandler = handler
          return () => undefined
        },
      },
      ui: {
        send: () => undefined,
        onOpen: () => () => undefined,
        handle: () => () => undefined,
      },
    } as unknown as MiniappSession
    const controller = new StoreController(session) as unknown as TestController
    let scheduled = 0
    controller.refresh = async () => controller.snapshot
    controller.automaticUpdateCandidates = () => [{}, {}] as StoreApp[]
    controller.scheduleAutomaticUpdates = async () => {
      scheduled += 1
    }

    controller.start()
    const result = (await actionHandler?.()) as {checkedAt: number; candidateCount: number}

    expect(actionId).toBe("reconcile_updates")
    expect(result.candidateCount).toBe(2)
    expect(result.checkedAt).toBeGreaterThan(0)
    expect(scheduled).toBe(1)
  })

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

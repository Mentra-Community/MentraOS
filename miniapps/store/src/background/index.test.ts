import {describe, expect, test} from "bun:test"
import type {MiniappSession} from "@mentra/miniapp/background"
import {StoreController} from "./index"
import type {StoreApp, StoreSnapshot} from "../shared/types"

interface TestController {
  start(): void
  install(packageName: string, query?: string, selectedApp?: StoreApp): Promise<StoreSnapshot>
  uninstall(packageName: string, query?: string): Promise<StoreSnapshot>
  setTrack(packageName: string, track: "stable" | "beta", query?: string): Promise<StoreSnapshot>
  load(query?: string, clearOperation?: boolean, refreshAutomaticCatalog?: boolean): Promise<StoreSnapshot>
  refresh(query?: string, refreshAutomaticCatalog?: boolean, clearOperation?: boolean): Promise<StoreSnapshot>
  automaticUpdateCandidates(): StoreApp[]
  scheduleAutomaticUpdates(): Promise<void>
  refreshing: Promise<StoreSnapshot> | null
  lastQuery: string
  snapshot: StoreSnapshot
}

describe("StoreController refresh serialization", () => {
  test("registers host reconciliation as an invocation-scoped action", async () => {
    const actionHandlers = new Map<
      string,
      (params: Record<string, unknown>, context: {callerPackageName: string}) => Promise<unknown>
    >()
    const session = {
      miniapps: {onInstallProgress: () => () => undefined},
      actions: {
        handle: (id: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          actionHandlers.set(id, handler)
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
    const refreshCalls: Array<{query?: string; refreshAutomaticCatalog?: boolean}> = []
    controller.lastQuery = "camera"
    controller.refresh = async (query, refreshAutomaticCatalog) => {
      refreshCalls.push({query, refreshAutomaticCatalog})
      return controller.snapshot
    }
    controller.automaticUpdateCandidates = () => [{}, {}] as StoreApp[]
    controller.scheduleAutomaticUpdates = async () => {
      scheduled += 1
    }

    controller.start()
    const result = (await actionHandlers.get("reconcile_updates")?.({})) as {checkedAt: number; candidateCount: number}

    expect([...actionHandlers.keys()]).toEqual([
      "reconcile_updates",
      "search_miniapps",
      "get_miniapp_details",
      "install_miniapp",
      "update_miniapp",
    ])
    expect(result.candidateCount).toBe(2)
    expect(result.checkedAt).toBeGreaterThan(0)
    expect(scheduled).toBe(1)
    expect(refreshCalls).toEqual([{query: "camera", refreshAutomaticCatalog: true}])
  })

  test("exposes catalog-backed search, details, and install actions without accepting bundle metadata", async () => {
    const actionHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    let installed = false
    let installDescriptor: Record<string, unknown> | undefined
    const catalogApp = {
      packageName: "com.example.notes",
      name: "Notes",
      subtitle: "Remember things",
      description: "Capture notes on your glasses.",
      categories: ["productivity"],
      privacyPolicyUrl: "https://example.test/privacy",
      supportUrl: null,
      websiteUrl: null,
      reviewTier: "verified",
      featured: true,
      iconUrl: null,
      coverUrl: null,
      screenshotUrls: [],
      selectedTrack: "stable",
      preferredTrack: "stable",
      betaAccess: null,
      availableTracks: ["stable"],
      release: {
        id: "release-notes",
        version: "2.0.0",
        track: "stable",
        installable: true,
        bundleUrl: "https://core.example.test/notes.zip",
        bundleSha256: "a".repeat(64),
        manifestSha256: null,
        publishedAt: null,
        permissions: [],
        hardwareRequirements: [],
        minHostVersion: null,
        sdkVersion: "0.3.0",
      },
    }
    const installedRows = () =>
      installed
        ? [
            {
              packageName: catalogApp.packageName,
              name: catalogApp.name,
              version: catalogApp.release.version,
              running: false,
              system: false,
              compatibility: {isCompatible: true, warnings: []},
              storeOwnerPackageName: "com.mentra.store",
            },
          ]
        : []
    const session = {
      auth: {
        getCoreUrl: async () => "https://core.example.test",
        fetch: async (url: string) => {
          const parsed = new URL(url)
          return parsed.pathname.endsWith(`/${catalogApp.packageName}`)
            ? Response.json({app: catalogApp})
            : Response.json({apps: [catalogApp], page: 1, hasMore: false})
        },
      },
      miniapps: {
        onInstallProgress: () => () => undefined,
        checkInstallCompatibility: async () => ({compatible: true}),
        list: async () => installedRows(),
        install: async (descriptor: Record<string, unknown>) => {
          installDescriptor = descriptor
          installed = true
        },
      },
      actions: {
        handle: (
          id: string,
          handler: (params: Record<string, unknown>, context: {callerPackageName: string}) => Promise<unknown>,
        ) => {
          actionHandlers.set(id, handler)
          return () => undefined
        },
      },
      ui: {send: () => undefined, onOpen: () => () => undefined, handle: () => () => undefined},
    } as unknown as MiniappSession
    new StoreController(session).start()

    const mentraAi = {callerPackageName: "com.mentra.ai"}
    const search = (await actionHandlers.get("search_miniapps")?.({query: "notes", limit: 3}, mentraAi)) as {
      results: Array<Record<string, unknown>>
    }
    expect(search.results[0]).toMatchObject({packageName: catalogApp.packageName, installed: false, compatible: true})
    expect(search.results[0]).not.toHaveProperty("bundleUrl")

    const details = (await actionHandlers.get("get_miniapp_details")?.(
      {packageName: catalogApp.packageName},
      mentraAi,
    )) as Record<string, unknown>
    expect(details).toMatchObject({packageName: catalogApp.packageName, description: catalogApp.description})
    expect(details).not.toHaveProperty("bundleUrl")

    await expect(
      actionHandlers.get("install_miniapp")?.(
        {packageName: catalogApp.packageName},
        {callerPackageName: "com.mentra.notes"},
      ),
    ).rejects.toThrow("not authorized")
    await expect(
      actionHandlers.get("update_miniapp")?.(
        {packageName: catalogApp.packageName},
        {callerPackageName: "com.mentra.notes"},
      ),
    ).rejects.toThrow("not authorized")
    expect(installDescriptor).toBeUndefined()

    const result = (await actionHandlers.get("install_miniapp")?.(
      {
        packageName: catalogApp.packageName,
        bundleUrl: "https://attacker.invalid/ignored.zip",
      },
      mentraAi,
    )) as Record<string, unknown>
    expect(result).toMatchObject({status: "installed", packageName: catalogApp.packageName, version: "2.0.0"})
    expect(installDescriptor).toMatchObject({
      packageName: catalogApp.packageName,
      bundleUrl: catalogApp.release.bundleUrl,
      bundleSha256: catalogApp.release.bundleSha256,
    })
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
        track: "stable",
        installable: true,
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

  test("carries beta through the host install descriptor", async () => {
    let descriptor: Record<string, unknown> | undefined
    const session = {
      miniapps: {
        install: async (input: Record<string, unknown>) => {
          descriptor = input
        },
      },
      ui: {send: () => undefined},
    } as unknown as MiniappSession
    const controller = new StoreController(session) as unknown as TestController
    controller.refresh = async () => controller.snapshot

    await controller.install("com.example.preview", "", {
      packageName: "com.example.preview",
      release: {
        id: "release-beta",
        version: "2.0.0-beta.1",
        track: "beta",
        installable: true,
        bundleUrl: "https://example.test/preview.zip",
        bundleSha256: "a".repeat(64),
        hardwareRequirements: [],
      },
    } as unknown as StoreApp)

    expect(descriptor).toMatchObject({releaseId: "release-beta", channel: "beta"})
  })

  test("rejects failed mutations after publishing the error snapshot", async () => {
    const snapshots: StoreSnapshot[] = []
    const session = {
      miniapps: {
        uninstall: async () => {
          throw new Error("Host refused uninstall")
        },
      },
      ui: {
        send: (_channel: string, snapshot: StoreSnapshot) => snapshots.push(snapshot),
      },
    } as unknown as MiniappSession
    const controller = new StoreController(session) as unknown as TestController

    await expect(controller.uninstall("com.example.notes", "notes")).rejects.toThrow("Host refused uninstall")
    expect(controller.snapshot).toMatchObject({operation: null, error: "Host refused uninstall"})
    expect(snapshots.at(-1)).toMatchObject({operation: null, error: "Host refused uninstall"})
  })

  test("continues automatic updates after one candidate fails", async () => {
    const session = {ui: {send: () => undefined}} as unknown as MiniappSession
    const controller = new StoreController(session) as unknown as TestController
    controller.snapshot = {
      ...controller.snapshot,
      installed: [
        {packageName: "com.example.broken", version: "1.0.0"},
        {packageName: "com.example.healthy", version: "1.0.0"},
      ] as StoreSnapshot["installed"],
    }
    const candidates = [
      {packageName: "com.example.broken", name: "Broken", release: {version: "2.0.0"}},
      {packageName: "com.example.healthy", name: "Healthy", release: {version: "2.0.0"}},
    ] as StoreApp[]
    controller.automaticUpdateCandidates = () => candidates
    const attempted: string[] = []
    controller.install = async (packageName) => {
      attempted.push(packageName)
      if (packageName === "com.example.broken") throw new Error("bad bundle")
      return controller.snapshot
    }

    await controller.scheduleAutomaticUpdates()

    expect(attempted).toEqual(["com.example.broken", "com.example.healthy"])
    expect(controller.snapshot.error).toContain("Broken: bad bundle")
  })

  test("does not install a discoverable beta offer before enrollment", async () => {
    let installs = 0
    const session = {
      miniapps: {
        install: async () => {
          installs += 1
        },
      },
      ui: {send: () => undefined},
    } as unknown as MiniappSession
    const controller = new StoreController(session) as unknown as TestController

    await expect(
      controller.install("com.example.preview", "", {
        packageName: "com.example.preview",
        name: "Preview",
        betaAccess: "invited",
        release: {
          id: "release-beta",
          version: "2.0.0-beta.1",
          track: "beta",
          installable: false,
          bundleUrl: null,
          bundleSha256: null,
        },
      } as unknown as StoreApp),
    ).rejects.toThrow("Join the private beta")

    expect(installs).toBe(0)
  })

  test("changes track through authenticated Core state and refreshes the automatic catalog", async () => {
    let request: {url: string; init?: RequestInit} | undefined
    const session = {
      auth: {
        getCoreUrl: async () => "https://core.example.test",
        fetch: async (url: string, init?: RequestInit) => {
          request = {url, init}
          return Response.json({app: {}})
        },
      },
      ui: {send: () => undefined},
    } as unknown as MiniappSession
    const controller = new StoreController(session) as unknown as TestController
    let refreshArgs: unknown[] = []
    controller.refresh = async (...args) => {
      refreshArgs = args
      return controller.snapshot
    }

    await controller.setTrack("com.example.preview", "beta", "preview")

    expect(request?.url).toBe("https://core.example.test/api/store/apps/com.example.preview/track")
    expect(request?.init).toMatchObject({method: "POST", body: JSON.stringify({track: "beta"})})
    expect(refreshArgs).toEqual(["preview", true, true])
  })
})

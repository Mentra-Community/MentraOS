import {describe, expect, test} from "bun:test"

import type {ClientApp} from "../../types/applet"
import {
  buildMiniappDiagnosticContext,
  buildMiniappManifestSnapshot,
  type MiniappRuntimeDiagnosticSnapshot,
} from "../miniappDiagnostics"

function app(overrides: Partial<ClientApp>): ClientApp {
  return {
    packageName: "com.example.miniapp",
    name: "Example",
    webviewUrl: "",
    logoUrl: "",
    type: "standard",
    permissions: [],
    running: true,
    foregrounded: false,
    healthy: true,
    hardwareRequirements: [],
    offline: false,
    offlineRoute: "",
    loading: false,
    local: true,
    hidden: false,
    ...overrides,
  }
}

const runtime = (overrides?: Partial<MiniappRuntimeDiagnosticSnapshot>): MiniappRuntimeDiagnosticSnapshot => ({
  connectedApps: [],
  subscriptionsByStream: {},
  resources: {
    display: {},
    camera: {},
    video: {},
    stream: {},
    cameraFov: {},
  },
  ...overrides,
})

describe("miniapp diagnostics", () => {
  test("keeps routing/build manifest fields and excludes arbitrary content", () => {
    const manifest = buildMiniappManifestSnapshot(
      {
        packageName: "com.mentra.ai",
        name: "Mentra AI",
        version: "1.4.9",
        sdkVersion: "0.3.0",
        minHostVersion: "2.12.0",
        type: "standard",
        entry: {background: "background/index.js", ui: "ui/index.html"},
        permissions: [{type: "MICROPHONE", required: true, description: "free-form"}],
        hardwareRequirements: [{type: "MICROPHONE", level: "REQUIRED", description: "free-form"}],
        actions: [{id: "summarize", description: "free-form", parameters: {secret: "nope"}}],
        backendUrl: "https://private.example",
        apiKey: "must-not-leak",
      },
      {packageName: "fallback"},
    )

    expect(manifest).toEqual({
      packageName: "com.mentra.ai",
      name: "Mentra AI",
      version: "1.4.9",
      sdkVersion: "0.3.0",
      minHostVersion: "2.12.0",
      type: "standard",
      entry: {background: "background/index.js", ui: "ui/index.html"},
      permissions: [{type: "MICROPHONE", required: true}],
      hardwareRequirements: [{type: "MICROPHONE", level: "REQUIRED"}],
      actionIds: ["summarize"],
    })
    expect(JSON.stringify(manifest)).not.toContain("must-not-leak")
    expect(JSON.stringify(manifest)).not.toContain("private.example")
    expect(JSON.stringify(manifest)).not.toContain("free-form")
  })

  test("includes every running manifest, live subscriptions, release identity, and interaction order", () => {
    const apps = [
      app({packageName: "com.mentra.ai", name: "Mentra AI", version: "1.4.9", foregrounded: true}),
      app({
        packageName: "com.mentra.notes",
        name: "Mentra Notes",
        version: "1.0.11",
        running: false,
      }),
      app({
        packageName: "com.example.dev",
        name: "Dev Miniapp",
        version: undefined,
        isMiniappDev: true,
        devUrl: "http://192.168.1.2:3140",
      }),
    ]
    const runtimeSnapshot = runtime({
      connectedApps: [
        {
          packageName: "com.mentra.ai",
          handshakeComplete: true,
          subscriptions: ["button_press", "transcription:auto"],
          lastMessageAgeMs: 25,
          requestedLocationRate: null,
          hasActiveSpeakerStream: false,
        },
        {
          packageName: "com.example.dev",
          handshakeComplete: true,
          subscriptions: ["location_stream"],
          lastMessageAgeMs: 50,
          requestedLocationRate: "high",
          hasActiveSpeakerStream: false,
          manifest: buildMiniappManifestSnapshot(
            {
              packageName: "com.example.dev",
              version: "0.4.0",
              sdkVersion: "0.3.0",
              actions: [{id: "dev_action"}],
            },
            {packageName: "com.example.dev"},
          ),
        },
      ],
      subscriptionsByStream: {
        "button_press": ["com.mentra.ai"],
        "transcription:auto": ["com.mentra.ai"],
        "location_stream": ["com.example.dev"],
      },
    })

    const context = buildMiniappDiagnosticContext({
      apps,
      foregroundedPackage: "com.mentra.ai",
      runtime: runtimeSnapshot,
      getLastOpenedAtMs: (candidate) =>
        candidate.packageName === "com.mentra.notes" ? 300 : candidate.packageName === "com.mentra.ai" ? 200 : 100,
      getManifest: (candidate) =>
        candidate.packageName === "com.mentra.ai"
          ? {packageName: candidate.packageName, version: candidate.version, sdkVersion: "0.3.0"}
          : undefined,
      getReleaseIdentity: (candidate) =>
        candidate.packageName === "com.mentra.ai"
          ? {source: "store", bundleSha256: "abc123", channel: "stable", ignored: "no"}
          : undefined,
    }) as {
      running: string[]
      foregroundedPackage: string
      mostRecentlyInteractedPackage: string
      recentlyInteracted: Array<{packageName: string}>
      runningMiniapps: Array<Record<string, unknown>>
    }

    expect(context.running).toEqual(["com.mentra.ai", "com.example.dev"])
    expect(context.foregroundedPackage).toBe("com.mentra.ai")
    expect(context.mostRecentlyInteractedPackage).toBe("com.mentra.notes")
    expect(context.recentlyInteracted.map((recent) => recent.packageName)).toEqual([
      "com.mentra.notes",
      "com.mentra.ai",
      "com.example.dev",
    ])
    expect(context.runningMiniapps[0]).toMatchObject({
      packageName: "com.mentra.ai",
      version: "1.4.9",
      executionMode: "installed_bundle",
      foregrounded: true,
      manifest: {packageName: "com.mentra.ai", version: "1.4.9", sdkVersion: "0.3.0"},
      releaseIdentity: {source: "store", bundleSha256: "abc123", channel: "stable"},
      runtime: {handshakeComplete: true, subscriptions: ["button_press", "transcription:auto"]},
    })
    expect(context.runningMiniapps[1]).toMatchObject({
      packageName: "com.example.dev",
      version: "0.4.0",
      executionMode: "dev_server",
      manifest: {
        packageName: "com.example.dev",
        version: "0.4.0",
        sdkVersion: "0.3.0",
        actionIds: ["dev_action"],
      },
    })
  })
})

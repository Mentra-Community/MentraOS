/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {MiniappsModule} from "./miniapps"

function mockSession(result?: unknown) {
  const requests: Array<Record<string, unknown>> = []
  const requestOptions: Array<{timeoutMs?: number} | undefined> = []
  const session = {
    sendRequest: (payload: Record<string, unknown>, options?: {timeoutMs?: number}) => {
      requests.push(payload)
      requestOptions.push(options)
      return Promise.resolve(result)
    },
  } as unknown as MiniappSession
  return {session, requests, requestOptions}
}

describe("MiniappsModule Store operations", () => {
  test("sends a backend-neutral install request", async () => {
    const result = {
      packageName: "com.example.weather",
      version: "1.2.0",
      installedByStore: "com.mentra.store",
    }
    const {session, requests, requestOptions} = mockSession(result)
    const miniapps = new MiniappsModule(session)

    await expect(
      miniapps.install({
        packageName: "com.example.weather",
        version: "1.2.0",
        bundleUrl: "https://store.example/bundle.zip",
        bundleSha256: "a".repeat(64),
        minHostVersion: "2.13.0",
        sdkVersion: "0.3.0",
        releaseId: "rel_123",
        channel: "stable",
      }),
    ).resolves.toEqual(result)
    expect(requests).toEqual([
      {
        type: MiniappRequestType.MINIAPPS_INSTALL,
        packageName: "com.example.weather",
        version: "1.2.0",
        bundleUrl: "https://store.example/bundle.zip",
        bundleSha256: "a".repeat(64),
        minHostVersion: "2.13.0",
        sdkVersion: "0.3.0",
        releaseId: "rel_123",
        channel: "stable",
      },
    ])
    expect(requestOptions).toEqual([{timeoutMs: 0}])
  })

  test("sends an uninstall request", async () => {
    const {session, requests} = mockSession()
    await new MiniappsModule(session).uninstall("com.example.weather")
    expect(requests).toEqual([{type: MiniappRequestType.MINIAPPS_UNINSTALL, packageName: "com.example.weather"}])
  })

  test("fans host install progress out to subscribers", () => {
    const {session} = mockSession()
    const miniapps = new MiniappsModule(session)
    const received: unknown[] = []
    const unsubscribe = miniapps.onInstallProgress((progress) => received.push(progress))
    miniapps._deliverInstallProgress({packageName: "com.example.weather", version: "1.2.0", phase: "verifying"})
    unsubscribe()
    miniapps._deliverInstallProgress({packageName: "com.example.weather", version: "1.2.0", phase: "complete"})
    expect(received).toEqual([{packageName: "com.example.weather", version: "1.2.0", phase: "verifying"}])
  })
})

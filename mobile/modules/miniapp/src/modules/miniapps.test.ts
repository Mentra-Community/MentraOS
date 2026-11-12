/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {type InstallMiniappResult, MiniappsModule} from "./miniapps"

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

describe("MiniappsModule installs", () => {
  test("installs a miniapp URL, with no request timeout", async () => {
    const result = {status: "installed", packageName: "com.example.weather", version: "1.2.0"}
    const {session, requests, requestOptions} = mockSession(result)
    const installed: InstallMiniappResult = await new MiniappsModule(session).install({
      url: "https://weather.example.com/",
    })
    expect(installed).toEqual(result)
    expect(requests).toEqual([{type: MiniappRequestType.MINIAPPS_INSTALL, url: "https://weather.example.com/"}])
    expect(requestOptions).toEqual([{timeoutMs: 0}])
  })

  test("sends only the URL, whatever else the caller passes", async () => {
    const {session, requests} = mockSession({status: "opened", packageName: "com.example.weather", version: "1.2.0"})
    const request = {url: "https://weather.example.com/", bundleUrl: "https://store.example/bundle.zip"}
    await new MiniappsModule(session).install(request)
    expect(requests).toEqual([{type: MiniappRequestType.MINIAPPS_INSTALL, url: "https://weather.example.com/"}])
  })

  test("sends the package the person agreed to, when the caller names it", async () => {
    const {session, requests} = mockSession({status: "installed", packageName: "com.example.weather", version: "1.2.0"})
    await new MiniappsModule(session).install({url: "https://weather.example.com/", packageName: "com.example.weather"})
    expect(requests).toEqual([
      {type: MiniappRequestType.MINIAPPS_INSTALL, url: "https://weather.example.com/", packageName: "com.example.weather"},
    ])
  })

  test("sends an uninstall request", async () => {
    const {session, requests} = mockSession()
    await new MiniappsModule(session).uninstall("com.example.weather")
    expect(requests).toEqual([{type: MiniappRequestType.MINIAPPS_UNINSTALL, packageName: "com.example.weather"}])
  })

  test("preflights host, SDK, and glasses hardware compatibility", async () => {
    const result = {compatible: false, blocker: "hardware", reason: "Camera required"}
    const {session, requests} = mockSession(result)
    await expect(
      new MiniappsModule(session).checkInstallCompatibility({
        minHostVersion: "3.0.0",
        sdkVersion: null,
        hardwareRequirements: [{type: "CAMERA", level: "REQUIRED"}],
      }),
    ).resolves.toEqual(result)
    expect(requests).toEqual([
      {
        type: MiniappRequestType.MINIAPPS_INSTALL_CHECK,
        minHostVersion: "3.0.0",
        sdkVersion: undefined,
        hardwareRequirements: [{type: "CAMERA", level: "REQUIRED"}],
      },
    ])
  })
})

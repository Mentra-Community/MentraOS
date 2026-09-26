/// <reference types="bun-types" />
// eslint-disable-next-line import/no-unresolved
import {describe, expect, mock, test} from "bun:test"

function fakeEngine() {
  return {
    router: {logRing: {snapshot: () => []}, onCrashloop: null as unknown, onRestartToast: null as unknown},
    uiRouter: {bindWebView() {}, unbindWebView() {}, notifyReopen() {}},
    crashController: {},
  }
}

let current = fakeEngine()
const installed: unknown[] = []

mock.module("react-native", () => ({Platform: {OS: "android"}}))
mock.module("@sentry/react-native", () => ({captureMessage() {}, addBreadcrumb() {}}))
mock.module("@mentra/engine", () => ({engine: {miniapps: {list: () => []}}}))
mock.module("@mentra/engine-host-internal", () => ({
  ensureMiniappEngine: () => current,
  getMiniappEngine: () => current,
}))
mock.module("@/services/streamPreview", () => ({
  installStreamPreviewCoordinator: (uiRouter: unknown) => installed.push(uiRouter),
}))
mock.module("@/utils/AlertUtils", () => ({default: () => {}}))

const {bootstrapMentraJS} = await import("./mentraJsBootstrap")

describe("bootstrapMentraJS", () => {
  test("wires the stream-preview channel into a rebuilt engine after logout", () => {
    const first = current
    bootstrapMentraJS()
    bootstrapMentraJS()
    expect(installed).toEqual([first.uiRouter])

    // engine.stop() drops the singletons; the next engine.start() builds new routers.
    current = fakeEngine()
    bootstrapMentraJS()
    expect(installed).toEqual([first.uiRouter, current.uiRouter])
    expect(typeof current.router.onCrashloop).toBe("function")
    expect(typeof current.router.onRestartToast).toBe("function")
  })
})

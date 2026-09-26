import {createRequire} from "node:module"
import {expect, mock, test} from "bun:test"
import TestRenderer, {act} from "react-test-renderer"
import type {FirmwareProvider, FirmwareSnapshot, FirmwareTarget} from "../../ota/types"
import {FirmwareUpdateService} from "../../ota/UpdateService"
import {RevisionedSnapshot} from "../../ota/RevisionedSnapshot"
import {DeviceIntegrationRegistry} from "../../devices/types"

const rendererRequire = createRequire(require.resolve("react-test-renderer"))
const React = rendererRequire("react") as typeof import("react")
mock.module("react", () => React)
mock.module("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
}))
mock.module("react-native-safe-area-context", () => ({SafeAreaView: "SafeAreaView"}))
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true

const target: FirmwareTarget = {integrationId: "test.fourth", deviceId: "fourth-native", displayName: "Fourth glasses"}
const state = new RevisionedSnapshot<FirmwareSnapshot>({
  target,
  flowId: "fourth-flow",
  revision: 0,
  attemptId: null,
  nativeSessionId: null,
  phase: "available",
  active: false,
  safeToRelease: true,
  offer: {id: "fourth-offer", required: false, observedVersion: "1", targetVersion: "2"},
  error: null,
  presentation: {
    title: {text: "Fourth-device firmware"},
    busy: false,
    success: false,
    actions: [{id: "install", label: {text: "Install fourth update"}}],
  },
})
let failOpen = false
let installs = 0
let disposed = 0
const provider: FirmwareProvider = {
  target,
  snapshot: state.snapshot,
  subscribe: state.subscribe,
  open: async () => {
    if (failOpen) throw new Error("Native updater is unavailable")
  },
  perform: async (request) => {
    if (request.action === "install") {
      installs++
      state.publish({
        ...state.snapshot(),
        active: true,
        safeToRelease: false,
        phase: "installing",
        presentation: {title: {text: "Fourth update running"}, busy: true, success: false, actions: [], progress: 31},
      })
    }
    return {kind: "none"}
  },
  suspendNewWork() {},
  dispose() {
    disposed++
  },
}
const service = new FirmwareUpdateService(
  new DeviceIntegrationRegistry([
    {
      id: target.integrationId,
      models: [target.displayName],
      firmware: {entryPoints: ["settings", "recovery"], createProvider: () => provider},
    },
  ]),
)
let resolveFailure = false
mock.module("../../facades/firmwareUpdates", () => ({
  firmwareUpdateService: service,
  firmwareUpdates: {
    currentTarget: async () => {
      if (resolveFailure) throw new Error("No current device")
      return target
    },
    assertSafeToRelease: service.assertSafeToRelease.bind(service),
    snapshot: service.snapshot.bind(service),
    subscribe: service.subscribe.bind(service),
    open: service.open.bind(service),
    perform: service.perform.bind(service),
  },
}))
const {FirmwareUpdateFlow} = await import("../FirmwareUpdateFlow")

test("a fourth provider renders and runs through generic UI, then reattaches without another install", async () => {
  const finished = mock(() => {})
  let view!: TestRenderer.ReactTestRenderer
  await act(async () => {
    view = TestRenderer.create(<FirmwareUpdateFlow target={target} entryPoint="settings" onFinished={finished} />)
  })
  expect(JSON.stringify(view.toJSON())).toContain("Fourth-device firmware")
  const button = view.root.findByType("Pressable" as never)
  await act(async () => {
    button.props.onPress()
  })
  expect(installs).toBe(1)
  expect(JSON.stringify(view.toJSON())).toContain("Fourth update running")
  await act(async () => {
    view.unmount()
  })
  expect(disposed).toBe(0)
  await act(async () => {
    view = TestRenderer.create(<FirmwareUpdateFlow entryPoint="recovery" onFinished={finished} />)
  })
  expect(JSON.stringify(view.toJSON())).toContain("31")
  expect(installs).toBe(1)
  expect(finished).not.toHaveBeenCalled()
  await act(async () => {
    view.unmount()
  })
})

test("a failed pairing target lookup cancels setup only when retained work is safe", async () => {
  state.publish({...state.snapshot(), active: true, safeToRelease: false})
  await service.open(target, {entryPoint: "recovery"})
  resolveFailure = true
  const finished = mock(() => {})
  let view!: TestRenderer.ReactTestRenderer
  await act(async () => {
    view = TestRenderer.create(<FirmwareUpdateFlow entryPoint="pairing" onFinished={finished} />)
  })
  const close = view.root.findAllByType("Pressable" as never)[1]!
  await act(async () => {
    close.props.onPress()
  })
  expect(finished).not.toHaveBeenCalled()
  state.publish({...state.snapshot(), active: false, safeToRelease: true})
  await act(async () => {
    close.props.onPress()
  })
  expect(finished).toHaveBeenCalledWith({kind: "finished", outcome: "cancelled"})
  await act(async () => {
    view.unmount()
  })
  resolveFailure = false
})

test("a provider-open failure offers Close and releases the safe idle provider", async () => {
  failOpen = true
  state.publish({
    ...state.snapshot(),
    active: false,
    safeToRelease: true,
    phase: "idle",
    presentation: {title: {text: "Firmware"}, busy: false, success: false, actions: []},
  })
  const finished = mock(() => {})
  const before = disposed
  let view!: TestRenderer.ReactTestRenderer
  await act(async () => {
    view = TestRenderer.create(<FirmwareUpdateFlow target={target} entryPoint="settings" onFinished={finished} />)
  })
  expect(JSON.stringify(view.toJSON())).toContain("Native updater is unavailable")
  const close = view.root.findAllByType("Pressable" as never)[1]!
  await act(async () => {
    close.props.onPress()
  })
  expect(finished).toHaveBeenCalledTimes(1)
  expect(disposed).toBe(before + 1)
  await act(async () => {
    view.unmount()
  })
  failOpen = false
})

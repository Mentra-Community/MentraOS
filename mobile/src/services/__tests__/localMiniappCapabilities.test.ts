/* eslint-disable no-restricted-imports, import/first */
import {MiniappRequestType, MiniappResponseType, parseEnvelope, serializeEnvelope} from "@mentra/miniapp"

jest.mock("react-native-share", () => ({__esModule: true, default: {open: jest.fn()}}))
jest.unmock("../../../modules/engine/src/services/LocalMiniappRuntime")

import {ISLAND_SETTINGS_KEYS} from "../../../modules/engine/src/runtime/config"
import {cloudClientService} from "../../../modules/engine/src/services/CloudClientService"
import localMiniappRuntime from "../../../modules/engine/src/services/LocalMiniappRuntime"
import {useSettingsStore} from "../../../modules/engine/src/stores/settings"
import {DeviceTypes} from "../../../modules/engine/src/types"

describe("LocalMiniappRuntime capability updates", () => {
  const packageName = "com.example.capability-subscriber"
  const sent: string[] = []
  let originalWearable: unknown

  beforeEach(() => {
    sent.length = 0
    originalWearable = useSettingsStore.getState().getSetting(ISLAND_SETTINGS_KEYS.defaultWearable)
    setDefaultWearable(DeviceTypes.SIMULATED)
    jest.spyOn(cloudClientService, "getMiniappAuthToken").mockResolvedValue(null as never)
    localMiniappRuntime.registerApp(packageName, (raw) => sent.push(raw))
  })

  afterEach(() => {
    localMiniappRuntime.unregisterApp(packageName)
    setDefaultWearable(originalWearable)
    jest.restoreAllMocks()
  })

  it("refreshes a handshook session when pairing promotes a different wearable", async () => {
    await connect("connect-1")

    const ack = payloads().find((payload) => payload.type === MiniappResponseType.CONNECT_ACK)
    expect((ack?.capabilities as {modelName?: string})?.modelName).toBe(DeviceTypes.SIMULATED)

    sent.length = 0
    setDefaultWearable(DeviceTypes.G2)

    const update = payloads().find((payload) => payload.type === MiniappResponseType.CAPABILITIES_UPDATE)
    expect(update?.capabilities).toMatchObject({
      modelName: DeviceTypes.G2,
      hasDisplay: true,
      display: {canPosition: true},
    })
  })

  it("uses the latest wearable in CONNECT_ACK when pairing changes during auth", async () => {
    let finishAuth!: (value: null) => void
    jest
      .mocked(cloudClientService.getMiniappAuthToken)
      .mockReturnValueOnce(new Promise<null>((resolve) => (finishAuth = resolve)) as never)

    const connected = connect("connect-during-auth")
    setDefaultWearable(DeviceTypes.G2)
    finishAuth(null)
    await connected

    const ack = payloads().find((payload) => payload.type === MiniappResponseType.CONNECT_ACK)
    expect(ack?.capabilities).toMatchObject({
      modelName: DeviceTypes.G2,
      hasDisplay: true,
      display: {canPosition: true},
    })
  })

  it("ignores a stale CONNECT completion after the app is replaced", async () => {
    let finishOldAuth!: (value: null) => void
    jest
      .mocked(cloudClientService.getMiniappAuthToken)
      .mockReturnValueOnce(new Promise<null>((resolve) => (finishOldAuth = resolve)) as never)

    localMiniappRuntime.handleRawMessage(
      packageName,
      serializeEnvelope({payload: {type: MiniappRequestType.CONNECT}, requestId: "old-connect"}),
    )

    const replacementSent: string[] = []
    localMiniappRuntime.registerApp(packageName, (raw) => replacementSent.push(raw))
    finishOldAuth(null)
    await expect(localMiniappRuntime.waitForConnect(packageName, 25)).rejects.toThrow("did not connect")
    expect(replacementSent).toEqual([])

    await connect("replacement-connect")
  })

  it("invalidates an in-flight CONNECT when crash recovery resets the handshake", async () => {
    let finishOldAuth!: (value: null) => void
    jest
      .mocked(cloudClientService.getMiniappAuthToken)
      .mockReturnValueOnce(new Promise<null>((resolve) => (finishOldAuth = resolve)) as never)

    localMiniappRuntime.handleRawMessage(
      packageName,
      serializeEnvelope({payload: {type: MiniappRequestType.CONNECT}, requestId: "pre-reset-connect"}),
    )
    localMiniappRuntime.resetHandshake(packageName)

    const replacementWait = localMiniappRuntime.waitForConnect(packageName, 25)
    finishOldAuth(null)
    await expect(replacementWait).rejects.toThrow("did not connect")
    expect(payloads().find((payload) => payload.type === MiniappResponseType.CONNECT_ACK)).toBeUndefined()
  })

  it("reports a display-less wearable and stops updates after the last app unregisters", async () => {
    await connect("display-less-connect")
    sent.length = 0

    setDefaultWearable(DeviceTypes.NONE)
    const update = payloads().find((payload) => payload.type === MiniappResponseType.CAPABILITIES_UPDATE)
    expect(update?.capabilities).toMatchObject({modelName: DeviceTypes.NONE, hasDisplay: false})

    sent.length = 0
    localMiniappRuntime.unregisterApp(packageName)
    setDefaultWearable(DeviceTypes.G2)
    expect(sent).toEqual([])
  })

  async function connect(requestId: string): Promise<void> {
    const connected = localMiniappRuntime.waitForConnect(packageName, 1_000)
    localMiniappRuntime.handleRawMessage(
      packageName,
      serializeEnvelope({payload: {type: MiniappRequestType.CONNECT}, requestId}),
    )
    await connected
  }

  function payloads(): Array<Record<string, unknown>> {
    return sent
      .map((raw) => parseEnvelope(raw)?.payload)
      .filter((payload): payload is Record<string, unknown> => typeof payload === "object" && payload !== null)
  }

  function setDefaultWearable(value: unknown): void {
    useSettingsStore.setState((state) => ({
      settings: {...state.settings, [ISLAND_SETTINGS_KEYS.defaultWearable]: value},
    }))
  }
})

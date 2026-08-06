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
    const connected = localMiniappRuntime.waitForConnect(packageName, 1_000)
    localMiniappRuntime.handleRawMessage(
      packageName,
      serializeEnvelope({payload: {type: MiniappRequestType.CONNECT}, requestId: "connect-1"}),
    )
    await connected

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

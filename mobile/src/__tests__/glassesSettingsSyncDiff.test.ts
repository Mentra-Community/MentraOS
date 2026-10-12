// Imports the real GlassesSettingsSync by path (not via "@mentra/engine",
// which jest mocks) so the actual diff logic runs under the mobile jest CI
// runner.
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {
  clampDisplaySettingsForModel,
  diffBluetoothSettingsForPush,
  pushAllBluetoothSettings,
  pushDeviceSettingsOnConnect,
  startGlassesSettingsSync,
  stopGlassesSettingsSync,
  stripPairingIdentity,
} from "../../modules/engine/src/services/GlassesSettingsSync"
import {PAIRING_IDENTITY_KEYS, SETTINGS, useSettingsStore} from "../../modules/engine/src/stores/settings"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"
import {pairing} from "../../modules/engine/src/facades/pairing"

describe("diffBluetoothSettingsForPush", () => {
  it("pushes changed non-identity keys only", () => {
    const previous = {brightness: 50, sensing_enabled: true}
    const next = {brightness: 80, sensing_enabled: true}
    expect(diffBluetoothSettingsForPush(next, previous)).toEqual({brightness: 80})
  })

  it("returns empty when nothing changed", () => {
    const settings = {brightness: 50}
    expect(diffBluetoothSettingsForPush(settings, {...settings})).toEqual({})
  })

  it("never pushes pairing-identity keys, even when they changed", () => {
    // Identity is native-authoritative and reaches native only via the explicit
    // seeds. Relaying an echoed identity change back through the change-push
    // closes a feedback loop: two values in flight (boot demotion crossing a
    // native promotion) chase each other through push→apply→echo→push forever
    // and flap the home pairing card.
    const previous = Object.fromEntries(PAIRING_IDENTITY_KEYS.map((key) => [key, ""]))
    const next = Object.fromEntries(PAIRING_IDENTITY_KEYS.map((key) => [key, "Even Realities G2"]))
    expect(diffBluetoothSettingsForPush(next, previous)).toEqual({})
  })

  it("covers the full identity group", () => {
    // The oscillation fix only holds if every identity key is in the list.
    expect(PAIRING_IDENTITY_KEYS.sort()).toEqual(
      [
        SETTINGS.pending_wearable.key,
        SETTINGS.default_wearable.key,
        SETTINGS.device_name.key,
        SETTINGS.device_address.key,
        SETTINGS.project_name.key,
        SETTINGS.default_controller.key,
        SETTINGS.pending_controller.key,
        SETTINGS.controller_device_name.key,
        SETTINGS.controller_address.key,
      ].sort(),
    )
  })

  it("still pushes a mixed diff minus the identity part", () => {
    const previous = {brightness: 50, default_wearable: ""}
    const next = {brightness: 80, default_wearable: "Even Realities G2"}
    expect(diffBluetoothSettingsForPush(next, previous)).toEqual({brightness: 80})
  })
})

describe("stripPairingIdentity", () => {
  it("removes every identity key and keeps the rest — the on-connect replay set", () => {
    // While connected, NATIVE owns the identity it promoted at device-ready;
    // the on-connect replay carrying a mid-relay JS snapshot overwrote a
    // just-promoted identity with pre-promotion empties (Mentra Live pairing
    // wiped itself right after succeeding).
    const settings: Record<string, unknown> = {brightness: 80, gallery_mode: true}
    for (const key of PAIRING_IDENTITY_KEYS) settings[key] = "stale"
    expect(stripPairingIdentity(settings)).toEqual({brightness: 80, gallery_mode: true})
  })
})

describe("display settings sent to each model", () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    useGlassesStore.getState().reset()
    const {setSetting} = useSettingsStore.getState()
    await setSetting("default_wearable", "NIMO", false)
    await setSetting("dashboard_depth", 10, false)
    await setSetting("dashboard_height", 10, false)
    await setSetting("head_up_angle", 90, false)
  })

  afterEach(() => {
    stopGlassesSettingsSync()
    jest.useRealTimers()
  })

  it("seeds the selected G1 within its limits before connecting, despite saved NIMO identity", async () => {
    await pairing.pair({id: "g1", name: "G1", model: "Even Realities G1"})
    expect(BluetoothSdk.updateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({dashboard_depth: 3, dashboard_height: 8, head_up_angle: 60}),
    )
    expect((BluetoothSdk.updateBluetoothSettings as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (BluetoothSdk.connect as jest.Mock).mock.invocationCallOrder[0],
    )
    expect(useSettingsStore.getState().getSetting("dashboard_depth")).toBe(10)
  })

  it("preserves the wider NIMO preference when reconnecting to NIMO", async () => {
    await pushAllBluetoothSettings()
    expect(BluetoothSdk.updateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({dashboard_depth: 10, dashboard_height: 10, head_up_angle: 90}),
    )
  })

  it("uses the connected model during replay even before the saved identity catches up", async () => {
    useGlassesStore.setState({connection: {state: "connected", fullyBooted: true}, deviceModel: "Even Realities G1"})
    await pushDeviceSettingsOnConnect()
    const patch = (BluetoothSdk.updateBluetoothSettings as jest.Mock).mock.calls[0][0]
    expect(patch).toMatchObject({dashboard_depth: 3, dashboard_height: 8, head_up_angle: 60})
    expect(patch).not.toHaveProperty("default_wearable")
  })

  it("clamps changed settings at flush time using the current model", async () => {
    jest.useFakeTimers()
    startGlassesSettingsSync()
    await useSettingsStore.getState().setSetting("dashboard_depth", 9, false)
    useGlassesStore.setState({connection: {state: "connected", fullyBooted: true}, deviceModel: "Even Realities G1"})
    jest.advanceTimersByTime(300)
    expect(BluetoothSdk.updateBluetoothSettings).toHaveBeenLastCalledWith(expect.objectContaining({dashboard_depth: 3}))
  })

  it("omits unsupported controls and leaves other settings unchanged", () => {
    const settings = {dashboard_depth: 10, dashboard_height: 10, head_up_angle: 90, brightness: 50}
    expect(clampDisplaySettingsForModel(settings, "AR99")).toEqual({brightness: 50})
    expect(settings.dashboard_depth).toBe(10)
    expect(clampDisplaySettingsForModel({dashboard_depth: 0, dashboard_height: -1}, "Even Realities G1")).toEqual({
      dashboard_depth: 1,
      dashboard_height: 1,
    })
  })
})

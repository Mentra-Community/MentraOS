// Imports the real GlassesSettingsSync by path (not via "@mentra/engine",
// which jest mocks) so the actual diff logic runs under the mobile jest CI
// runner.
import {diffBluetoothSettingsForPush, stripPairingIdentity} from "../../modules/engine/src/services/GlassesSettingsSync"
import {PAIRING_IDENTITY_KEYS, SETTINGS} from "../../modules/engine/src/stores/settings"

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

import {afterEach, describe, expect, test} from "bun:test"
import {
  appendPendingTelemetry,
  deriveDeviceKey,
  fingerprintFor,
  meaningfulTransitions,
  pendingTelemetryFor,
  posthogPropertiesFor,
  shouldRecordConnectedAt,
  SUPPORT_PENDING_TELEMETRY_LIMIT,
  type SupportStateInput,
} from "./support-profile.service"

const savedSecret = process.env.SUPPORT_DEVICE_ID_HMAC_KEY

afterEach(() => {
  if (savedSecret === undefined) delete process.env.SUPPORT_DEVICE_ID_HMAC_KEY
  else process.env.SUPPORT_DEVICE_ID_HMAC_KEY = savedSecret
})

describe("support profile privacy and transitions", () => {
  test("derives a stable keyed device id without retaining the serial", () => {
    process.env.SUPPORT_DEVICE_ID_HMAC_KEY = "test-support-profile-secret"
    const first = deriveDeviceKey("SERIAL-123", "Mentra Live")
    const second = deriveDeviceKey("SERIAL-123", "Mentra Live")

    expect(first).toBe(second)
    expect(first).toStartWith("hd_")
    expect(first).not.toContain("SERIAL-123")
    expect(deriveDeviceKey("SERIAL-456", "Mentra Live")).not.toBe(first)
  })

  test("fingerprint excludes raw hardware identity but distinguishes devices", () => {
    process.env.SUPPORT_DEVICE_ID_HMAC_KEY = "test-support-profile-secret"
    const first = input({hardwareId: "SERIAL-123"})
    const second = input({hardwareId: "SERIAL-456"})
    const fingerprint = fingerprintFor(first)

    expect(fingerprint).not.toContain("SERIAL-123")
    expect(fingerprintFor(second)).not.toBe(fingerprint)
  })

  test("emits only meaningful connection, version, and failure transitions", () => {
    const previous = profile({connectionState: "connected", appVersion: "1.0.0"})
    const unchanged = profile({connectionState: "connected", appVersion: "1.0.0"})
    expect(meaningfulTransitions(previous, unchanged)).toEqual([])

    const changed = profile({
      connectionState: "disconnected",
      appVersion: "1.1.0",
      failureCode: "ble_timeout",
    })
    expect(meaningfulTransitions(previous, changed)).toEqual([
      "support_glasses_disconnected",
      "support_software_changed",
      "support_failure_observed",
    ])
  })

  test("never mirrors the derived device id or serial into PostHog properties", () => {
    const properties = posthogPropertiesFor({
      host: {
        phonePlatform: "android",
        phoneModel: "Pixel",
        connectionState: "connected",
        observedAt: new Date("2026-08-11T12:00:00.000Z"),
      },
      currentDeviceKey: "hd_private-derived-id",
      devices: [{deviceKey: "hd_private-derived-id", model: "Mentra Live", firmwareVersion: "1.2.3"}],
    })
    const serialized = JSON.stringify(properties)

    expect(serialized).not.toContain("hd_private-derived-id")
    expect(serialized).not.toContain("serial")
    expect(properties.support_glasses_model).toBe("Mentra Live")
  })

  test("preserves last-connected time across heartbeats and advances it on transitions", () => {
    expect(shouldRecordConnectedAt("connected", "device-1", "connected", "device-1")).toBe(false)
    expect(shouldRecordConnectedAt("disconnected", "device-1", "connected", "device-1")).toBe(true)
    expect(shouldRecordConnectedAt("connected", "device-1", "connected", "device-2")).toBe(true)
  })

  test("persists transition material with the profile write for outbox repair", () => {
    const next = profile({connectionState: "connected", appVersion: "1.0.0"})
    const pending = pendingTelemetryFor(null, next, "fingerprint-1", "revision-1")

    expect(pending).toMatchObject({
      transitionId: "revision-1",
      fingerprint: "fingerprint-1",
      events: ["support_profile_created"],
    })
  })

  test("bounds durable transition repair state and keeps repeated snapshots distinct", () => {
    const next = profile({connectionState: "connected", appVersion: "1.0.0"})
    let pending: ReturnType<typeof appendPendingTelemetry> = []
    for (let revision = 0; revision < SUPPORT_PENDING_TELEMETRY_LIMIT + 5; revision += 1) {
      pending = appendPendingTelemetry(
        pending,
        pendingTelemetryFor(null, next, "same-fingerprint", `revision-${revision}`),
      )
    }

    expect(pending).toHaveLength(SUPPORT_PENDING_TELEMETRY_LIMIT)
    expect(pending[0]?.transitionId).toBe("revision-5")
    expect(pending.at(-1)?.transitionId).toBe(`revision-${SUPPORT_PENDING_TELEMETRY_LIMIT + 4}`)
  })

  test("migrates staged pending transitions on the next canonical write", () => {
    const migrated = appendPendingTelemetry(
      {
        fingerprint: "legacy-fingerprint",
        events: ["support_profile_created"],
        eventAt: "2026-08-11T12:00:00.000Z",
        properties: {},
      } as any,
      null,
    )

    expect(migrated).toEqual([
      {
        transitionId: "2026-08-11T12:00:00.000Z:legacy-fingerprint",
        fingerprint: "legacy-fingerprint",
        events: ["support_profile_created"],
        eventAt: "2026-08-11T12:00:00.000Z",
        properties: {},
      },
    ])
  })
})

function input(device: {hardwareId: string}): SupportStateInput {
  return {
    observedAt: "2026-08-11T12:00:00.000Z",
    host: {phonePlatform: "ios", connectionState: "connected"},
    device: {...device, model: "Mentra Live"},
  }
}

function profile(host: {connectionState: string; appVersion: string; failureCode?: string}) {
  return {
    host: {...host, failureStage: null, observedAt: new Date("2026-08-11T12:00:00.000Z")},
    devices: [],
    currentDeviceKey: null,
  }
}

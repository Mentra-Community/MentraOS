/**
 * @fileoverview Mentra Bluetooth SDK startup update check.
 *
 *   POST /api/client/bluetooth-sdk/update-check
 *     — the SDK reports its version and host app identity; Core answers
 *       whether a newer SDK release exists on the SDK's release channel
 *       (`latest`, `beta` or `dev`) and records the check in PostHog so Mentra
 *       can count active installs per customer app.
 *
 * The SDK calls this once per start, from inside customer apps, with a
 * 4-second timeout and no retry. The response is the flat
 * `{status, channel, latestVersion, minimumSupportedVersion}` object the SDK
 * clients parse directly. A malformed body gets HTTP 400
 * `{"error":"invalid_request"}` and records nothing.
 *
 * This endpoint is public and unauthenticated by design: the SDK runs in
 * third-party apps whose users have no Mentra account, and the request
 * carries only install and SDK identity, never user data. It reads only
 * public release information (npm dist-tags) and never awaits the PostHog
 * capture, so it answers within the dist-tag fetch timeout.
 *
 * Spec: notes/superpowers/specs/2026-10-11-bluetooth-sdk-live-telemetry-and-update-check.md
 *       ("Startup update check" → "Core route")
 */

import {Hono} from "hono"
import {bodyLimit} from "hono/body-limit"
import {BluetoothSdkUpdateService, parseUpdateCheckRequest} from "../../services/bluetooth-sdk-update.service"
import type {AppEnv} from "../../types/hono.types"

// Every field is capped at 128 characters, so a valid body is far smaller.
const MAX_BODY_BYTES = 16 * 1024
const INVALID_REQUEST = {error: "invalid_request"} as const

export function createBluetoothSdkApi(service = new BluetoothSdkUpdateService()) {
  const app = new Hono<AppEnv>()

  app.post(
    "/update-check",
    bodyLimit({maxSize: MAX_BODY_BYTES, onError: (c) => c.json(INVALID_REQUEST, 400)}),
    async (c) => {
      let body: unknown
      try {
        body = JSON.parse(await c.req.text())
      } catch {
        return c.json(INVALID_REQUEST, 400)
      }
      const request = parseUpdateCheckRequest(body)
      if (!request) return c.json(INVALID_REQUEST, 400)

      const result = await service.check(request)
      // Fire-and-forget: `record` never rejects, and the SDK's answer must
      // not wait on analytics.
      void service.record(request, result)
      return c.json(result)
    },
  )

  return app
}

export default createBluetoothSdkApi()

import {createHmac} from "node:crypto"
import {afterEach, describe, expect, test} from "bun:test"
import {createApp} from "../app"

const originalSecret = process.env.MENTRA_SERVICE_AUTH_SECRET

afterEach(() => {
  if (originalSecret === undefined) delete process.env.MENTRA_SERVICE_AUTH_SECRET
  else process.env.MENTRA_SERVICE_AUTH_SECRET = originalSecret
})

describe("Store dev-attestation service boundary", () => {
  test("returns 400 instead of throwing for authenticated malformed JSON", async () => {
    process.env.MENTRA_SERVICE_AUTH_SECRET = "test-service-secret"
    const body = "{not-json"
    const timestamp = String(Date.now())
    const signature = createHmac("sha256", process.env.MENTRA_SERVICE_AUTH_SECRET)
      .update(`${timestamp}\n${body}`)
      .digest("base64url")

    const response = await createApp({readinessChecks: []}).request("/api/internal/dev-attestations/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mentra-service-timestamp": timestamp,
        "x-mentra-service-signature": signature,
      },
      body,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({error: "invalid_request"})
  })

  test("rejects a body whose service signature does not match", async () => {
    process.env.MENTRA_SERVICE_AUTH_SECRET = "test-service-secret"
    const response = await createApp({readinessChecks: []}).request("/api/internal/dev-attestations/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mentra-service-timestamp": String(Date.now()),
        "x-mentra-service-signature": "invalid",
      },
      body: "{}",
    })

    expect(response.status).toBe(401)
  })
})

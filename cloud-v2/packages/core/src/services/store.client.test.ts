import {afterEach, expect, spyOn, test} from "bun:test"
import {createHmac} from "node:crypto"
import {verifyStoreDevAttestation} from "./store.client"

const savedUrl = process.env.MENTRA_STORE_INTERNAL_URL
const savedSecret = process.env.MENTRA_SERVICE_AUTH_SECRET
let fetchSpy: ReturnType<typeof spyOn> | undefined
const attestation = {
  packageName: "com.example.app",
  devServerUrl: "http://localhost:8081",
  nonce: "test",
  expiresAt: "2026-09-21T00:00:00Z",
  signingKeyId: "key",
  signature: "signed",
}
afterEach(() => {
  fetchSpy?.mockRestore()
  if (savedUrl === undefined) delete process.env.MENTRA_STORE_INTERNAL_URL
  else process.env.MENTRA_STORE_INTERNAL_URL = savedUrl
  if (savedSecret === undefined) delete process.env.MENTRA_SERVICE_AUTH_SECRET
  else process.env.MENTRA_SERVICE_AUTH_SECRET = savedSecret
})
test("fails closed without calling the removed in-cluster Store alias", async () => {
  delete process.env.MENTRA_STORE_INTERNAL_URL
  process.env.MENTRA_SERVICE_AUTH_SECRET = "test-secret"
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response())
  await expect(verifyStoreDevAttestation(attestation.packageName, attestation)).rejects.toMatchObject({
    code: "store_unavailable",
    status: 503,
  })
  expect(fetchSpy).not.toHaveBeenCalled()
})
test("signs the exact request body sent to the configured external Store", async () => {
  process.env.MENTRA_STORE_INTERNAL_URL = "https://store.test.example/"
  process.env.MENTRA_SERVICE_AUTH_SECRET = "test-secret"
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response())
  await verifyStoreDevAttestation(attestation.packageName, attestation)
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  expect(url).toBe("https://store.test.example/api/internal/dev-attestations/verify")
  const headers = new Headers(init.headers)
  const expected = createHmac("sha256", "test-secret")
    .update(`${headers.get("x-mentra-service-timestamp")}\n${init.body}`)
    .digest("base64url")
  expect(headers.get("x-mentra-service-signature")).toBe(expected)
})

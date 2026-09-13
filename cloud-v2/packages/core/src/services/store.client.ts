import {createHmac} from "node:crypto"

export interface StoreDevAttestation {
  packageName: string
  devServerUrl: string
  nonce: string
  expiresAt: string
  signingKeyId: string
  signature: string
}

export class StoreServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function verifyStoreDevAttestation(packageName: string, attestation: StoreDevAttestation): Promise<void> {
  const storeUrl = (process.env.MENTRA_STORE_INTERNAL_URL ?? "http://store:3003").replace(/\/+$/, "")
  const secret = (process.env.MENTRA_SERVICE_AUTH_SECRET ?? process.env.WORKOS_API_KEY)?.trim()
  if (!secret) throw new StoreServiceError("store_unavailable", "Store service authentication is not configured", 503)
  const body = JSON.stringify({packageName, attestation})
  const timestamp = String(Date.now())
  const signature = createHmac("sha256", secret).update(`${timestamp}\n${body}`).digest("base64url")
  const response = await fetch(`${storeUrl}/api/internal/dev-attestations/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mentra-service-timestamp": timestamp,
      "x-mentra-service-signature": signature,
    },
    body,
  })
  if (response.ok) return
  const payload = (await response.json().catch(() => ({}))) as {error?: string; error_description?: string}
  throw new StoreServiceError(
    payload.error ?? "store_unavailable",
    payload.error_description ?? "Store service rejected the dev attestation",
    response.status,
  )
}

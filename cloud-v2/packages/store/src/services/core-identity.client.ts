/** Resolve an account email to Core's opaque Mentra user identity. */
export async function resolveMentraUserByEmail(email: string): Promise<string | null> {
  const {createHmac} = await import("node:crypto")
  const coreUrl = (process.env.MENTRA_CORE_INTERNAL_URL ?? process.env.MENTRA_CORE_URL)?.trim().replace(/\/+$/, "")
  const secret = (process.env.MENTRA_SERVICE_AUTH_SECRET ?? process.env.WORKOS_API_KEY)?.trim()
  if (!coreUrl || !secret) throw new Error("Store-to-Core identity resolution is not configured")
  const normalizedEmail = email.trim().toLowerCase()
  const timestamp = String(Date.now())
  const signature = createHmac("sha256", secret).update(`${timestamp}\n${normalizedEmail}`).digest("base64url")
  const response = await fetch(`${coreUrl}/api/internal/identity/resolve-email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mentra-service-timestamp": timestamp,
      "x-mentra-service-signature": signature,
    },
    body: JSON.stringify({email: normalizedEmail}),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Core identity resolution failed (${response.status})`)
  const body = (await response.json()) as {mentraUserId?: string}
  return body.mentraUserId ?? null
}

/**
 * Public ElevenLabs ConvAI config — same defaults as the RN
 * react-native-elevenlabs-audio example. Secrets (API key) stay on the
 * local signing server; only agent ID + signed-URL endpoint are baked in.
 *
 * IMPORTANT: use `process.env.MENTRA_PUBLIC_*` (dot access, not `process.env?.`).
 * Bun.build `define` only replaces that exact member expression. Optional
 * chaining leaves a live `process` reference, and the miniapp JSContext has
 * no `process` global — which threw when ElevenLabsController constructed.
 */

declare const process: {
  env: {
    MENTRA_PUBLIC_ELEVENLABS_AGENT_ID: string
    MENTRA_PUBLIC_ELEVENLABS_SIGNED_URL_ENDPOINT: string
  }
}

export const DEFAULT_ELEVENLABS_AGENT_ID = "agent_0301ks3wg64pf9evgxqa6dw34t1f"
/** Fallback only — build.ts normally inlines the Mac LAN IP instead of localhost. */
export const DEFAULT_ELEVENLABS_SIGNED_URL_ENDPOINT = "http://localhost:8788/signed-url"

export function getElevenLabsConfig(): {agentId: string; signedUrlEndpoint: string} {
  const agentId = process.env.MENTRA_PUBLIC_ELEVENLABS_AGENT_ID || DEFAULT_ELEVENLABS_AGENT_ID
  const signedUrlEndpoint =
    process.env.MENTRA_PUBLIC_ELEVENLABS_SIGNED_URL_ENDPOINT || DEFAULT_ELEVENLABS_SIGNED_URL_ENDPOINT
  return {agentId, signedUrlEndpoint}
}

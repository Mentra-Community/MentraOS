# Soniox WebSocket authentication

`@soniox/node` is pinned to 2.3.0 and patched through Bun's
`patchedDependencies`. That release still authenticates STT WebSockets by
sending `api_key` in the start message. Soniox retires that method on January
15, 2027: https://soniox.com/docs/guides/migrate-websocket-authentication

The repository root, Cloud V2, and SDK package manifests register the same patch,
so every workspace installation that includes cloud-runtime applies it.

The patch changes the ESM and CommonJS STT transports to send the
`soniox-api-key` and API key WebSocket subprotocols when connecting, and removes
`api_key` from the start message. Soniox supports this connection authentication
on servers as well as browsers. It works with the SDK's standard WebSocket API
on both Bun and Node without introducing a runtime-specific header overload.
Every replacement STT session uses the same connection path.

TTS is untouched; the Mentra cloud TTS service uses ElevenLabs.

Remove this patch and the version pin when upgrading to an SDK release that
authenticates STT at connection time. Run `soniox.auth.test.ts` and the real
`tests/soniox.integration.test.ts` to verify the replacement. The Docker image
must copy the patches before its frozen dependency installation.

# Spike: Soniox Fallback API Keys

## Problem

Legacy Cloud v1 currently constructs Soniox transcription and translation
providers from `SONIOX_API_KEY`. When that Soniox org/key hits an account-level
limit, every new Soniox transcription or translation stream in production fails
through the same exhausted credential. The existing provider fallback machinery
only switches between provider types. It does not support multiple Soniox
credentials.

## Observed Code Path

- `cloud/packages/cloud/src/services/session/transcription/types.ts`
  reads `SONIOX_API_KEY` into `DEFAULT_TRANSCRIPTION_CONFIG.soniox.apiKey`.
- `SonioxTranscriptionProvider` initializes one Soniox SDK client with that key.
- `TranscriptionManager` creates one Soniox provider for non-China deployments.
- Stream retry logic retries the same Soniox provider/key after 429, 408, and
  server errors.
- `cloud/packages/cloud/src/services/session/translation/types.ts` also reads
  `SONIOX_API_KEY` into `DEFAULT_TRANSLATION_CONFIG.soniox.apiKey`.
- `TranslationManager` retries translation streams, but without multiple Soniox
  credentials it retries the same exhausted key.

## Important Constraint

Do not configure local max-concurrent limits per key. Soniox keys may be shared
across pods or environments, so a local counter is incomplete and can make a key
look available when another process already consumed its concurrency quota. The
source of truth is Soniox accepting or rejecting a stream.

## Failure Classes

- Spend or account quota exhausted: long cooldown. This may not recover until
  billing quota resets or the org is changed.
- Request rate limited: short cooldown.
- Concurrent stream limit: very short cooldown. Capacity may return as soon as
  another stream closes, possibly in another process.
- Invalid/auth key: disable for this process.
- Network/server/transient errors: short cooldown.

## Scope

This hotfix targets Cloud v1 transcription and translation streams that use
Soniox.

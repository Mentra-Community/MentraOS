# 033 — Soniox Model Update

Update the default Soniox STT model from `stt-rt-v3-preview` to `stt-rt-v4`, and add an environment variable so the model can be changed without code changes.

## Context

Soniox releases new models regularly. Currently the model name is hardcoded as a fallback default in multiple files. Updating it requires a code change and redeploy. We should make this configurable via an env var so we can swap models by updating a Porter environment variable.

## Current State

The model is set in three places, all using the same pattern — `this.config.model || "stt-rt-v3-preview"`:

| File                                                                          | Line | Usage                                               |
| ----------------------------------------------------------------------------- | ---- | --------------------------------------------------- |
| `src/services/session/transcription/providers/SonioxTranscriptionProvider.ts` | ~497 | `model: this.config.model \|\| "stt-rt-v3-preview"` |
| `src/services/session/translation/providers/SonioxTranslationProvider.ts`     | ~323 | `model: this.config.model \|\| "stt-rt-v3-preview"` |
| `src/services/session/transcription/types.ts`                                 | ~110 | Comment: `Default: 'stt-rt-v3-preview'`             |

The `SonioxProviderConfig` interface in `types.ts` already has an optional `model` field:

```
interface SonioxProviderConfig {
  apiKey: string;
  endpoint: string;
  model?: string;
  maxConnections?: number;
}
```

So the plumbing for config-driven model selection already exists. It's just that nothing reads from an env var, and the hardcoded default is outdated.

## Changes

### 1. Add `SONIOX_MODEL` env var

Read `process.env.SONIOX_MODEL` when constructing the Soniox provider config (wherever `SonioxProviderConfig` is built — likely in `TranscriptionManager.initializeProviders()` and `TranslationManager.initializeProviders()`).

### 2. Update the hardcoded fallback default

In both `SonioxTranscriptionProvider.ts` and `SonioxTranslationProvider.ts`, change:

```
model: this.config.model || "stt-rt-v3-preview"
```

to:

```
model: this.config.model || "stt-rt-v4"
```

### 3. Update the comment in `types.ts`

Change the `SonioxProviderConfig` comment from `Default: 'stt-rt-v3-preview'` to `Default: 'stt-rt-v4'`.

### 4. Add to Porter environment

Add `SONIOX_MODEL` to the Porter environment group (or `porter.yaml` env) with value `stt-rt-v4`. Future model updates are just an env var change in Porter — no code change, no redeploy needed.

## Priority

The env var part is the higher priority — it makes future model updates trivial. The default update from v3 to v4 is the immediate need.

## Checklist

- [ ] Add `SONIOX_MODEL` env var reading in transcription manager config
- [ ] Add `SONIOX_MODEL` env var reading in translation manager config
- [ ] Update default fallback to `stt-rt-v4` in `SonioxTranscriptionProvider.ts`
- [ ] Update default fallback to `stt-rt-v4` in `SonioxTranslationProvider.ts`
- [ ] Update comment in `types.ts`
- [ ] Add `SONIOX_MODEL=stt-rt-v4` to Porter environment
- [ ] Test transcription with v4 model
- [ ] Test translation with v4 model

# Spec: Fix ElevenLabs TTS Pronunciation ("in" → "inches")

## Overview

**What this doc covers:** Fix for ElevenLabs TTS pronouncing "in" as "inches" (and likely other common words being misinterpreted as unit abbreviations) by upgrading from the Flash model to Turbo and making TTS parameters configurable via env vars.

**Why this doc exists:** Users report that TTS consistently says "inches" instead of "in" — e.g., "it's in the box" becomes "it's inches the box." This has been confirmed across multiple users and persists after restarts.

**Who should read this:** Cloud engineers, anyone working on TTS or audio.

---

## The Problem in 30 Seconds

ElevenLabs' TTS API has built-in text normalization that expands abbreviations, numbers, and units. The word "in" is the standard abbreviation for inches, and the model (`eleven_flash_v2_5`) aggressively expands it to "inches" even when it's clearly a preposition.

This is worse on Flash v2.5 because it's a smaller model — ElevenLabs' own docs say smaller models "cannot generalize" text normalization as well as larger models. Flash v2.5 doesn't have enough context awareness to distinguish "in" (preposition) from "in" (unit).

Two problems:

1. `eleven_flash_v2_5` is the smallest/cheapest model in ElevenLabs' lineup — it prioritizes latency (~75ms) over quality and contextual understanding. It's too dumb to know "in" is a preposition, not a unit abbreviation.
2. The model ID and text normalization setting were hardcoded with no env var override, so fixing this required a code deploy.

---

## Fix

Two changes:

### 1. Upgrade model from Flash to Turbo

Switch the default model from `eleven_flash_v2_5` to `eleven_turbo_v2_5`:

|                   | Flash v2.5 (old)   | Turbo v2.5 (new)      |
| ----------------- | ------------------ | --------------------- |
| **Latency**       | ~75ms              | ~250-300ms            |
| **Price**         | Same               | Same                  |
| **Languages**     | 32                 | 32                    |
| **Char limit**    | 40,000             | 40,000                |
| **Normalization** | Poor (small model) | Better (larger model) |
| **Quality**       | Lower              | Higher                |

The latency increase (~75ms → ~250-300ms) is acceptable for glasses TTS — users won't notice ~200ms extra on a spoken response. Turbo's better contextual understanding should fix the "in" → "inches" issue on its own — it's a larger model that can actually tell when "in" is a preposition vs. a unit.

### 2. Explicitly set text normalization to `"auto"`

Add `apply_text_normalization: "auto"` to the ElevenLabs API request body. This is a root-level parameter (not inside `voice_settings`) that accepts three values:

| Value    | Behavior                                                         |
| -------- | ---------------------------------------------------------------- |
| `"auto"` | Model decides contextually whether to normalize (**our choice**) |
| `"on"`   | Always normalize (force expand abbreviations, numbers, etc.)     |
| `"off"`  | Never normalize (read text exactly as-is)                        |

With `"auto"`, the Turbo model intelligently decides when to expand — so `$50` still becomes "fifty dollars" and `123` becomes "one hundred twenty-three," but "in" stays "in" because the model has enough context to know it's a preposition.

If Turbo still says "inches" with `"auto"`, we switch to `"off"` via the `ELEVENLABS_TEXT_NORMALIZATION` env var in Doppler — no code deploy needed.

### 3. Make everything configurable via env vars

All TTS parameters are now overridable via Doppler without a code deploy:

| Env var                         | Default                | Purpose                                       |
| ------------------------------- | ---------------------- | --------------------------------------------- |
| `ELEVENLABS_DEFAULT_MODEL_ID`   | `eleven_turbo_v2_5`    | Model selection                               |
| `ELEVENLABS_TEXT_NORMALIZATION` | `auto`                 | Text normalization mode (`auto`, `on`, `off`) |
| `ELEVENLABS_DEFAULT_VOICE_ID`   | `8IRrZoKuYTPnpLc6lM6a` | Voice (already existed)                       |
| `ELEVENLABS_DEFAULT_SPEED`      | `1.13`                 | Speed (already existed)                       |
| `ELEVENLABS_DEFAULT_STABILITY`  | `0.68`                 | Stability (already existed)                   |
| `ELEVENLABS_DEFAULT_SIMILARITY` | `0.75`                 | Similarity boost (already existed)            |
| `ELEVENLABS_DEFAULT_STYLE`      | `0.0`                  | Style (already existed)                       |

---

## Changes

Two files carry the TTS endpoint (Hono routes and legacy Express routes):

### `cloud/packages/cloud/src/api/hono/routes/audio.routes.ts`

- Add `modelId` and `textNormalization` to `ELEVENLABS_DEFAULTS` (configurable via env vars)
- Replace hardcoded `"eleven_flash_v2_5"` with `ELEVENLABS_DEFAULTS.modelId`
- Add `apply_text_normalization: ELEVENLABS_DEFAULTS.textNormalization` to request body

### `cloud/packages/cloud/src/routes/audio.routes.ts`

- Add `MODEL_ID` and `TEXT_NORMALIZATION` to `ELEVENLABS_DEFAULTS`
- Add `getDefaultModelId()` and `getDefaultTextNormalization()` helpers
- Replace hardcoded `"eleven_flash_v2_5"` with `getDefaultModelId()`
- Add `apply_text_normalization: getDefaultTextNormalization()` to request body

---

## Rollback

Everything is controllable via Doppler, no code deploy needed:

- **Turbo causes issues?** Set `ELEVENLABS_DEFAULT_MODEL_ID=eleven_flash_v2_5` to revert to Flash.
- **Still says "inches" on Turbo?** Set `ELEVENLABS_TEXT_NORMALIZATION=off` to disable all normalization.
- **Both?** Set both env vars.

## Future Considerations

- **Eleven v3:** The newest ElevenLabs model — most expressive, 70+ languages, audio tags for emotion. Has a 5,000 character limit (vs 40,000 for Turbo) and untested latency. Worth evaluating when we want richer TTS. Can be tried by setting `ELEVENLABS_DEFAULT_MODEL_ID=eleven_v3` in Doppler.
- **Pronunciation dictionary:** ElevenLabs supports pronunciation dictionaries with alias rules (e.g., force "in" to be read as-is). Overkill for now but available if we hit more targeted pronunciation issues.

---

## Verification

After deploying, test with phrases that triggered the bug:

- "it's in the box" — should say "in", not "inches"
- "I'm interested in that" — should say "in", not "inches"
- "come in" — should say "in", not "inches"

Also spot-check that normal TTS still sounds correct — numbers spoken naturally, no weird artifacts from disabling normalization.

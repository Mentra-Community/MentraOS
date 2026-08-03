# 021 - Typed Language Subscriptions (End-to-End Language Contract)

**Status:** Spike complete. Typed-SDK milestone (WP1 registry, WP2 SDK
validation, WP3 engine handler + NACK, captions migration) implemented on
`isaiah/os-1746-captions-language-hints`. Loud-cloud milestone (WP4 per-sub
verdicts, WP5 stream.error) pending. Note: the full engine test suite has 13
pre-existing failures on origin/dev (PhoneCameraFovCoordinator +
AudioCloudUplink native-mock ordering, unrelated to this work).

Linear: [OS-1746](https://linear.app/mentralabs/issue/OS-1746/captions-language-hints-might-be-broken)
(captions language hints), related [OS-1762](https://linear.app/mentralabs/issue/OS-1762/translation-stops-after-settings-change-translation-transcription)
(translation stops after settings change).

## Goal

Make it impossible for a miniapp developer to construct a transcription or
translation subscription that silently fails. Every language value that crosses
a layer boundary is either valid by construction (typed against one canonical
registry) or rejected loudly at the boundary it crossed (thrown error, rejected
promise, or async error event). No layer may silently default, silently drop,
or silently die.

## Spike Findings (2026-07-21 bugbash, Pixel 8 + dev build + cloud dev)

User action: open Captions, pick French in the language sheet. Result: captions
stop entirely. Four independent defects fired, in order:

### 1. Captions miniapp: every picked language becomes en-US

`miniapps/captions/src/ui/lib/languages.ts` stores bare ISO 639-1 codes
("fr"). `miniapps/captions/src/core/languageLocale.ts` switches on English
display names ("French") with `default: return "en-US"`. The two registries
never agreed, so `languageToLocale("fr")` fell through to en-US. Picking ANY
language subscribed to English transcription.

Evidence: Metro log shows `SUBSCRIBE from com.mentra.captions:
[transcription:en-US]` after selecting French.

Fixed in captions 1.0.12 (code-to-locale map added), but the structural fix is
to delete per-miniapp mapping tables entirely (see spec).

### 2. Miniapp SDK / phone runtime: language hints are a silent no-op

`session.transcription.configure({languageHints})` sends a
`TRANSCRIPTION_CONFIG` one-shot (`sendOneShot`, fire-and-forget). The engine's
request dispatcher has no handler for it. The message vanishes. No error is
possible by construction because one-shots have no response path.

### 3. Cloud runtime: BCP-47 tag passed raw to Soniox kills the stream

`createProvider` passes the subscription's language code straight into the
Soniox session config as `language_hints: ["en-US"]`. Soniox rejects BCP-47
tags. Verified empirically against the live Soniox API:

```
[hints=en-US] ERROR: Invalid language hint.   (session enters error state, 0 tokens)
[hints=en]    accepted
```

The provider dies at connect. The self-heal reconnect recreates it with the
same bad config, so the stream is wedged permanently. The subscription REST
write had already returned 200, and no error flows back to the phone or the
miniapp. This is why the phone received zero transcripts (`cloud_recv` lines
absent in Metro log while the en-US subscription was active).

This is very likely also the mechanism behind OS-1762 (translation stops after
a settings change lands on a specific source language).

Fixed on branch `isaiah/os-1746-captions-language-hints`
(`soniox.ts` strips the region: `en-US` becomes `en`).

### 4. Cloud runtime: resolvedLanguage echoes the detected code, breaking routing

`result.ts` `resolvedLanguage()` returned `detected ?? source.code` for
specific-language subscriptions, violating its own docstring. Soniox always
runs language identification and reports bare codes, observed live on the
wire: `lang=ro`, `lang=en`, `lang=bs` during an auto session. The phone routes
transcripts to miniapp handlers by exact stream key
(`transcription:<resolvedLanguage>`), so a subscription to `en-US` whose
results come back tagged `en` matches zero handlers. Auto mode survives only
because `transcription:auto` subscribers receive every language key.

Fixed on the same branch (`result.ts` echoes the subscription's own code for
specific mode; unit tests in `result.test.ts` pin the contract). Without this
fix, repairing defect 3 alone would still leave specific-language captions
dead.

### Failure-mode summary

| Layer | Defect | Failure mode |
|---|---|---|
| Miniapp UI/mapping | two disagreeing language registries | silent wrong behavior |
| SDK + phone runtime | unhandled one-shot config | silent drop |
| Cloud worker + Soniox | invalid hint format | silent stream death, wedged self-heal |
| Cloud result mapping | contract violation on resolvedLanguage | silent routing mismatch |

Four defects, four layers, zero errors surfaced anywhere. That is the actual
bug.

## Spec

### S1. One canonical language registry

The protocol package (`@mentra/cloud-protocol`) exports the single source of
truth:

- `SUPPORTED_TRANSCRIPTION_LANGUAGES`: readonly array of BCP-47 tags the
  platform accepts for specific-language subscriptions ("en-US", "fr-FR", ...).
- `SUPPORTED_LANGUAGE_HINTS`: readonly array of bare ISO 639-1 codes the STT
  provider accepts as hints ("en", "fr", ...).
- Derived literal-union types `TranscriptionLanguage` and `LanguageHint`.
- Helpers: `isTranscriptionLanguage(x)`, `toLanguageHint(tag)` (region strip),
  `suggestLanguage(x)` (nearest valid tag, for error messages).

Everything downstream imports from here: miniapp SDK types, miniapp UI pickers
(list derived from the registry, never hand-maintained), engine validation,
cloud-side validation, provider config. Per-miniapp mapping tables
(`languageToLocale.ts` and friends) are deleted.

### S2. SDK surface is typed and validating

- `transcription.forLanguage(language: TranscriptionLanguage | TranscriptionLanguage[], handler)`.
  Compile-time union type plus runtime validation that THROWS
  `MiniappValidationError` with a suggestion ("unknown language \"fr\", did
  you mean \"fr-FR\"?"). Runtime validation is mandatory because miniapps may
  be plain JS or cast through any.
- `transcription.configure(config: {languageHints?: LanguageHint[]})` validates
  the same way and RETURNS A PROMISE (see S3).
- Same treatment for `translation.fromTo/to/on` source and target params.

### S3. No fire-and-forget for fallible operations

- `configure()` moves from `sendOneShot` to `sendRequest` and resolves/rejects
  on the phone runtime's REQUEST_RESULT.
- The engine's request dispatcher NACKs unknown request types instead of
  ignoring them. An unimplemented handler becomes a rejected promise on first
  call instead of a permanent silent gap.
- The engine implements the `TRANSCRIPTION_CONFIG` handler: hints merge into
  the cloud subscription set (auto-mode subscription gains
  `{mode: "auto", hints: [...]}`) and flow to the provider config.

### S4. Subscription writes return per-subscription verdicts

The subscription REST endpoint (`POST /api/audio/subscriptions`) validates
each subscription against the registry and provider capability BEFORE
accepting, and the response body reports it:

```json
{ "accepted": [ ... ], "rejected": [ { "subscription": ..., "reason": "unsupported language tag \"xx-YY\"" } ] }
```

The cloud-client surfaces rejections; the engine maps them back to the owning
miniapp as an error event on the session. A write with zero accepted
subscriptions is a 422, not a 200.

### S5. Async stream errors flow downstream

Provider-level failures that happen after the REST write (Soniox config
rejection, key exhaustion, terminal reconnect give-up) are pushed on the
WebSocket as a `stream.error` message carrying the subscription identity and
reason. The engine forwards it to subscribed miniapps (`onError` on the
session), so a dead stream is observable in miniapp code and in Metro logs
within one second of it dying, instead of by noticing silence.

### S6. Defense in depth stays

The provider config keeps the region-strip normalization (defect 3 fix) and
`result.ts` keeps the subscription-echo contract (defect 4 fix) even after
upstream validation exists. Validation prevents; normalization and the pinned
contract contain.

## Design Notes

- **Registry contents**: seed `SUPPORTED_TRANSCRIPTION_LANGUAGES` from the 63
  codes the captions UI offers today, crossed with what Soniox stt-rt-v4
  actually supports (verify against Soniox docs during implementation; the
  spike verified only the hint FORMAT, not per-language coverage).
- **Wire compatibility**: stream keys stay `transcription:<tag>`; no protocol
  version bump needed for S1-S3. S4 changes only a response body that clients
  currently ignore (backward compatible). S5 adds a new push message type;
  older phone builds ignore unknown message types by design (verify in
  `runtime.ts` dispatch).
- **Where validation lives phone-side**: `MiniappSession._subscribe` stays
  dumb; validation belongs in the typed module methods (`transcription.*`,
  `translation.*`) so `events.subscribe` remains the untyped escape hatch.
- **Migration**: bundled miniapps (captions, translation, teleprompter, merge)
  move to registry-derived pickers in the same PR that deletes their mapping
  tables, so the two-registries failure mode cannot regrow.

## Work Packages

1. **WP1 registry + types** (protocol package): S1, plus unit tests. Small.
2. **WP2 SDK validation** (miniapp package): S2, S3 client half (configure to
   sendRequest). Small.
3. **WP3 engine** (engine package): S3 server half (NACK unknown request
   types, implement TRANSCRIPTION_CONFIG, hints into cloud subs). Medium.
4. **WP4 cloud validation + verdicts** (runtime + cloud-client): S4. Medium.
5. **WP5 stream.error push** (runtime + cloud-client + engine): S5. Medium,
   touches wire protocol.
6. **WP6 miniapp migration** (miniapps/*): delete mapping tables, adopt
   registry pickers. Small per miniapp.

WP1-WP3 land together as the "typed SDK" milestone (prevents defects 1 and 2
recurring). WP4-WP5 land as the "loud cloud" milestone (prevents defect 3's
silence). WP6 rides along with WP1.

Already landed on `isaiah/os-1746-captions-language-hints` (pre-spec hotfixes):
soniox hint normalization, result.ts contract fix + tests, captions 1.0.12
code-to-locale map, metro singleton guard.

## Verification Plan

- Unit: registry helpers; SDK validation throws with suggestions; result.ts
  contract (exists); engine NACK on unknown request type.
- Integration (local runtime + harness): subscribe `fr-FR`, stream French WAV,
  assert transcripts arrive tagged `fr-FR`; subscribe with an invalid tag via
  the untyped escape hatch, assert 422/verdict rejection and miniapp onError;
  kill a Soniox session with a forced bad config, assert `stream.error`
  arrives.
- Device e2e (Pixel 8 + dev build): captions French pick renders captions;
  captions hint set while auto still renders and hints reach the provider
  config (runtime log).

## Open Questions

1. Should bare codes ("fr") be accepted by `forLanguage` and canonicalized to
   the default locale, or strictly rejected? Leaning: accept and canonicalize
   (matches user intent, one less migration hazard), but the canonicalization
   table then lives in the registry, nowhere else.
2. Does translation share the same registry or need a pair-capability matrix
   (source x target support differs per provider)? Likely needs the matrix;
   scope it in WP4.
3. `stream.error` delivery guarantees: fire-and-forget push, or retained in
   Redis so a reconnecting phone learns its stream died while it was away?

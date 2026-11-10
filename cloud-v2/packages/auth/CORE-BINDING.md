# Core binding: each miniapp backend trusts exactly its own Core

## Problem

Every Mentra Core (prod, staging, dev, debug, and each Private Cloud) signs
miniapp tokens with its own key, but one sign-in account works on all of
Mentra's hosted Cores, so the same person has the same `sub` everywhere. By
default `@mentra/auth` tried every hosted Core's key set and accepted the
shared issuer `cloud-core`, and our backends' settings widened that further
(Notes trusted all four Cores in production, LinkLingo always added the dev
Core). A token from a development Core, whose keys and accounts are looser,
was therefore accepted by a production backend as that production user, with
whatever `features` the development Core put in it.

## Rule

A miniapp backend trusts exactly one Core: the one whose Mentra App it serves.

- **The key set pins the Core.** Each Core signs with its own key, so a
  verifier that tries one Core's key set alone already refuses every other
  Core's token. This is the isolation; the issuer below only names it.
- **Tokens can name their Core.** Core puts `CLOUD_CORE_ISSUER` in the `iss`
  of every token it signs, miniapp tokens included: `cloud-core` by default, or
  the Core's origin, such as `https://core.mentraglass.com`. Core refuses to
  start when it is set to anything else, including an origin with a trailing
  slash or capitals, which a bound backend would never match. Hosted Mentra
  Cores keep the default for now (see Transition).
- **Backends bind to a Core URL.** `coreUrl`, or `MENTRA_CORE_URL`, is the
  Core's public URL, the same name Mentra's CLI and tools use for "the Core".
  From it the verifier derives the only key set it tries
  (`<core>/.well-known/jwks.json`) and the issuers it accepts: that URL, or
  the default `cloud-core`. Both checks must pass, so a token from another Core
  fails on its signature whatever issuer it names, and a token of this Core
  naming another issuer fails too.
- **One setting, no lists.** A binding refuses to be combined with
  `jwksUrl(s)`, `issuer`, `MENTRA_AUTH_JWKS_URL(S)` or
  `MENTRA_AUTH_ISSUER(S)`: there is nothing to pick between, so a stale list
  can't widen it. Mentra's backends pass `requireCoreUrl: true` and refuse to
  start without a Core, instead of falling back to every Core.
- **Self-hosted deployments follow.** A Private Cloud sets only its Core URL:
  its Core names itself by it (the Azure reference already sets
  `CLOUD_CORE_ISSUER` to its Core's origin), and each customer-variant backend (`{packageName, backendUrl}`)
  gets `MENTRA_CORE_URL` beside its `PACKAGE_NAME` and `PUBLIC_BASE_URL`, from
  the same prebuilt image.
- **Checked where it is configured.** The Doppler-to-Porter contract requires
  `MENTRA_CORE_URL` in every Mentra miniapp backend's group.

## Transition

1. **Now.** Our backends bind to their Core. Hosted Mentra Cores keep issuing
   `cloud-core`, which a bound backend accepts from its own Core's key set
   only, so this needs no Core change and no ordering between deploys.
2. **This `@mentra/auth` release** also accepts a Core's own name from that
   Core's key set: an unbound verifier keeps its issuers (`cloud-core` by
   default, or `MENTRA_AUTH_ISSUER(S)`), and each key set served at
   `<origin>/.well-known/jwks.json` also accepts `<origin>`. A token still
   never passes under another Core's name.
3. **Later, hosted Cores name themselves** by setting `CLOUD_CORE_ISSUER` to
   their origin. Not before third-party backends run a release from step 2:
   every published version before it accepts only `cloud-core` by default, so
   a hosted Core that renamed itself would break them. The issuer also covers
   Core's own access and refresh tokens, so the switch needs a short overlap
   in which Core's access-token verification (`packages/shared/src/auth.ts`)
   accepts both `cloud-core` and the origin, until tokens issued under
   `cloud-core` have expired; Runtime's `CLOUD_RUNTIME_AUTH_ISSUERS` must list
   the origin too. Private Clouds whose `CLOUD_CORE_ISSUER` is already their
   origin (the Azure reference) issue that name either way.
4. Once every Core names itself and old verifiers are gone, bound verifiers
   could stop accepting `cloud-core`. It costs nothing meanwhile: the key set
   already pins the Core.

## Third-party miniapps

Nothing breaks now: hosted Cores keep issuing `cloud-core` (see Transition). `jwksUrl(s)`, `issuer` and their environment variables work as
before, and an unconfigured backend still trusts every hosted Mentra Core; that
default is deprecated, and binding to a Core is the recommended setup. The one
new interaction: a backend that already has `MENTRA_CORE_URL` in its
environment for some other use is now bound to that Core, and refuses to start
if it also sets the JWKS or issuer settings.

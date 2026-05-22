/**
 * @fileoverview Hyphen-safe parser for legacy v2 SDK session IDs.
 *
 * The legacy v2 SDK sends a session ID of the form `<userId>-<packageName>`
 * in CONNECTION_INIT / RECONNECT messages, where `<userId>` is always an
 * email and `<packageName>` is the mini-app package identifier. This format
 * is ambiguous whenever either side contains a hyphen — e.g.
 *
 *     a-b@example.com-some-app-name
 *
 * The original parser used `sessionId.split("-")[0]` (later refactored to
 * `sessionId.slice(0, sessionId.indexOf("-"))`, same behavior) which always
 * took everything before the FIRST hyphen. For the example above that
 * extracts just `"a"`, the UserSession lookup fails, and the app gets a
 * 1008 "Session not found" close. Users with a hyphen in their email's
 * local-part OR domain have been silently broken since this code shipped.
 *
 * The SDK is frozen, so the wire format can't change. This parser fixes
 * the cloud-side disambiguation: enumerate every split position whose
 * userId-portion looks like an email (contains "@"), then prefer the
 * candidate whose userId-portion matches a live UserSession.
 *
 * SDK v3 doesn't use this parser — it sends userId via the `x-user-id`
 * header at upgrade time. This module is for legacy v2 SDK only and
 * exists at the service boundary, not in a domain library.
 *
 * See: cloud/issues/107-legacy-sessionid-hyphen-parse-bug/
 */

export interface ParsedLegacySessionId {
  userId: string;
  packageName: string;
}

/**
 * Parse a legacy v2 SDK session ID.
 *
 * @param sessionId       Raw session ID from CONNECTION_INIT / RECONNECT.
 * @param isActiveUserId  Optional callback to check whether a candidate
 *                        userId corresponds to a live UserSession. Used
 *                        to disambiguate when multiple split positions
 *                        produce email-shaped candidates. Tests can pass
 *                        a stub; production passes a wrapper around
 *                        `UserSession.getById`.
 *
 * @returns The parsed userId/packageName, or `undefined` when the string
 *          doesn't contain any `@`-bearing candidate (i.e. not a legacy
 *          session ID).
 *
 *          When `isActiveUserId` is provided and at least one candidate
 *          matches, the longest matching userId wins. When none match
 *          (real session-mid-creation race, or stale v2 SDK retry after
 *          the cloud disposed the session), a two-step fallback fires:
 *          first pick the shortest candidate whose userId ends in a
 *          TLD-shaped suffix (handles the common case of an email on a
 *          short TLD with hyphens in the local-part); if no candidate
 *          is TLD-shaped (long gTLDs like `.museum`, IP-domain emails,
 *          internationalized TLDs), fall back to the shortest
 *          `@`-bearing candidate — equivalent to the pre-fix
 *          "first hyphen after `@`" parse, which is correct for any
 *          non-hyphenated email regardless of TLD length.
 */
export function parseLegacySessionId(
  sessionId: string | undefined,
  isActiveUserId?: (userId: string) => boolean,
): ParsedLegacySessionId | undefined {
  if (!sessionId) {
    return undefined;
  }

  // Collect every split position whose userId-portion contains "@".
  // Active user IDs are always email addresses, so any candidate without
  // "@" can be discarded. Iterate left-to-right; the array is naturally
  // ordered shortest-userId first.
  const candidates: ParsedLegacySessionId[] = [];
  let sepIdx = sessionId.indexOf("-");
  while (sepIdx !== -1 && sepIdx < sessionId.length - 1) {
    const userId = sessionId.slice(0, sepIdx);
    const packageName = sessionId.slice(sepIdx + 1);
    if (userId.includes("@") && packageName.length > 0) {
      candidates.push({ userId, packageName });
    }
    sepIdx = sessionId.indexOf("-", sepIdx + 1);
  }

  if (candidates.length === 0) {
    return undefined;
  }

  // Prefer the longest userId that maps to a live UserSession. Iterating
  // longest-first handles the (very rare) case where a shorter `@`-bearing
  // prefix is also a valid email for a different live user. The lookup is
  // O(1) Map.get, so trying multiple candidates is microseconds total.
  if (isActiveUserId) {
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (isActiveUserId(candidates[i].userId)) {
        return candidates[i];
      }
    }
  }

  // No live UserSession matches any candidate (or no lookup was provided).
  // Pick the most-likely-correct split anyway: the caller still needs a
  // usable userId for error logs AND a correct packageName for any
  // downstream code that consumes the parsed package before the user
  // session is available (e.g. v3 SDK reconnect bootstrapping that calls
  // `validateApiKey(packageName, apiKey)` before resolving the session).
  //
  // Real emails almost always end with a TLD-shaped suffix (".com", ".io",
  // ".co.uk", etc.) while hyphen-suffixed package-name chunks rarely do.
  // Prefer the SHORTEST `@`-bearing candidate whose userId ends in a
  // TLD-shaped suffix. Shortest because the email is the FIRST TLD-shaped
  // substring scanning left-to-right — longer candidates have stretched
  // into the package name (e.g. for "a-b@example.com-some-app-name" the
  // candidates "a-b@example.com" and "a-b@example.com-some-app" both have
  // "@", but only the first ends in a TLD).
  for (const candidate of candidates) {
    if (TLD_SUFFIX.test(candidate.userId)) {
      return candidate;
    }
  }

  // No candidate ends in a TLD-shape. This is the path for:
  //   - long TLDs (.museum, .travel, .industries, .versicherung, ...)
  //   - IP-domain emails (user@192.168.1.1)
  //   - internationalized TLDs outside ASCII (.中国, Punycode xn--*)
  //
  // Fall back to the SHORTEST `@`-bearing candidate. This is equivalent to
  // "first hyphen after @" parsing — the original pre-fix behavior for
  // non-hyphenated emails — and is strictly no worse than pre-fix for
  // hyphen-in-local-part inputs (pre-fix would have returned a candidate
  // without "@" at all; here we guarantee the userId has "@"). It also
  // gives the longest possible packageName, which matters because the
  // package value feeds `validateApiKey` in the v3 reconnect bootstrap.
  //
  // Pathological case still unhandled: hyphen-in-DOMAIN + long-TLD + no
  // live session (e.g. `user@hyphen-domain.museum-pkg`). The only correct
  // resolution there is the Public Suffix List; tracked as a follow-up.
  return candidates[0];
}

// A TLD-shaped suffix is a dot followed by 2–5 ASCII letters. Covers all
// common real-world TLDs (com, org, net, uk, io, co, app, dev, glass,
// tech, world, ...) while excluding longer dot-letter chunks that are
// almost certainly subdomain words rather than TLDs (e.g.
// `user@sub.hyphen-domain.com`'s candidate `user@sub.hyphen` ends with
// `.hyphen` — 6 letters — which is a subdomain word and would be a
// false-positive TLD match without this bound).
//
// Trade-off: the rarest long TLDs (.museum, .travel, .coffee, ...) are
// not matched here. Users on those TLDs fall through to the
// longest-@-bearing fallback below, which preserves the prior behavior —
// not perfect but not a regression either.
const TLD_SUFFIX = /\.[a-zA-Z]{2,5}$/;

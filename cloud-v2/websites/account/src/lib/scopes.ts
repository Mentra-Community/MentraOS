/** The sign-in scopes, which a consent screen and Connected apps show as one line. */
const BASIC_SCOPES = new Set(["openid", "email", "profile"]);

export const BASIC_INFORMATION = "Read basic information";

/** What a client may see, in plain words: the sign-in scopes as one line, and any other scope by its name. */
export function describeScopes(scopes: readonly string[]): string[] {
  const others = scopes.filter((scope) => !BASIC_SCOPES.has(scope));
  return others.length < scopes.length ? [BASIC_INFORMATION, ...others] : others;
}

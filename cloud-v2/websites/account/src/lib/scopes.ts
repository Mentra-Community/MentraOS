/** What each scope lets a client see, in plain words. An unknown scope is shown by its name. */
export const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  openid: "See your Mentra account ID",
  email: "See your email address",
  profile: "See your name",
};

export function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS[scope] ?? scope;
}

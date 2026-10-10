/**
 * First-party OAuth clients (Mentra's own web clients in every environment)
 * are approved without a consent screen. The list is a public build-time
 * value: `FIRST_PARTY_CLIENT_IDS`, comma separated.
 */
export function parseFirstPartyClientIds(raw: string | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (id) ids.add(id);
  }
  return ids;
}

export function isFirstPartyClient(ids: ReadonlySet<string>, clientId: unknown): boolean {
  return typeof clientId === "string" && clientId !== "" && ids.has(clientId);
}

/**
 * @fileoverview MongoDB connection strings as Core's operator scripts check them.
 *
 * `isLocalMongoUrl` is the guard every script that writes behind an `--apply`
 * flag uses: such a script refuses any other URL unless the operator passes
 * `--i-understand-remote`. Development and tests never pass it.
 */

/** Exactly a loopback host, with an optional all-digit port: nothing else may follow the host or port. */
const LOCAL_HOST_PATTERN = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/

export type MongoUrlParts = {scheme: string; credentials: boolean; hosts: string[]; database: string}

/** Split a connection string, accepting the multi-host form `new URL` cannot parse. Null when it is not one. */
export function splitMongoUrl(value: string): MongoUrlParts | null {
  const match = /^(mongodb(?:\+srv)?):\/\/(?:([^@/?#]*)@)?([^/?#]+)(?:\/([^?#]*))?(?:\?[^#]*)?$/.exec(value)
  if (!match) return null
  return {
    scheme: match[1]!,
    credentials: match[2] !== undefined,
    hosts: match[3]!.split(",").map(host => host.toLowerCase()),
    database: match[4] ?? "",
  }
}

/** `mongodb://` on `127.0.0.1`, `localhost` or `[::1]` only (every listed host, optionally with a numeric port), no credentials. */
export function isLocalMongoUrl(value: string): boolean {
  const parts = splitMongoUrl(value)
  if (!parts || parts.scheme !== "mongodb" || parts.credentials) return false
  return parts.hosts.every(host => LOCAL_HOST_PATTERN.test(host))
}

/** Which database a URL names, for telling two URLs apart: its hosts and database name. */
export function databaseKey(parts: MongoUrlParts): string {
  return `${parts.hosts.join(",")}/${parts.database}`
}

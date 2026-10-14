/**
 * What makes two spellings of a Core URL the same Core. Shared by the Fleet queue (a partition is one account on one
 * Core) and the engine's Core client (which sends a partition only to its own Core). Pure: no storage, no runtime URL
 * parser.
 */

const DEFAULT_PORTS: Record<string, string> = {http: "80", https: "443"}
const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i

/**
 * One spelling per Core: lower-case scheme and host, no default port, no trailing slash, no query or fragment.
 * Hand-written so the partition key never depends on a runtime's URL implementation. The queue's partitions and
 * the guard that sends a partition only to its own Core use this one rule, so they always agree on what one Core is.
 */
export function normalizeCoreUrl(coreUrl: string): string {
  const trimmed = coreUrl.trim()
  const parts = URL_PARTS.exec(trimmed)
  if (!parts) return trimmed.replace(/\/+$/, "").toLowerCase()
  const scheme = parts[1].toLowerCase()
  const authority = parts[2]
  const at = authority.lastIndexOf("@")
  const userInfo = at >= 0 ? authority.slice(0, at + 1) : ""
  const hostAndPort = /^(.*?)(?::(\d*))?$/.exec(authority.slice(at + 1).toLowerCase())
  const host = hostAndPort?.[1] ?? ""
  const port = hostAndPort?.[2] ?? ""
  const keptPort = port === "" || port === DEFAULT_PORTS[scheme] ? "" : `:${port}`
  return `${scheme}://${userInfo}${host}${keptPort}${parts[3].replace(/\/+$/, "")}`
}

/** Whether two Core URLs name the same Core. */
export function sameCoreUrl(a: string, b: string): boolean {
  return normalizeCoreUrl(a) === normalizeCoreUrl(b)
}

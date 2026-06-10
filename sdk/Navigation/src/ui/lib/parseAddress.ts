/**
 * Group a Google `formatted_address` into display lines.
 *
 * Google returns a comma-joined string, most commonly:
 *   "1878 Fell St, San Francisco, CA 94102, USA"
 *   → street: "1878 Fell St"
 *   → locality: "San Francisco, CA 94102"   (city, state + zip)
 *   → country: "USA"
 *
 * The format isn't guaranteed — POIs may omit the street, some
 * countries put the postal code differently. So this is best-effort:
 * we split on commas, treat the last segment as the country, the
 * first as the street line, and collapse everything in between into a
 * single "city / state / zip" line. Anything that doesn't fit the
 * 3+ segment shape falls back to showing the raw segments stacked.
 */
export type AddressLines = {
  /** Street number + name, e.g. "1878 Fell St". May be empty for POIs. */
  street: string
  /** City + state/province + postal code, e.g. "San Francisco, CA 94102". */
  locality: string
  /** Country, e.g. "USA". May be empty. */
  country: string
}

export function parseAddress(address: string): AddressLines {
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)

  if (parts.length === 0) return {street: "", locality: "", country: ""}
  if (parts.length === 1) return {street: parts[0], locality: "", country: ""}
  if (parts.length === 2) return {street: parts[0], locality: parts[1], country: ""}

  // 3+ segments: first is street, last is country, the rest join into
  // the locality line (city + state + zip).
  const street = parts[0]
  const country = parts[parts.length - 1]
  const locality = parts.slice(1, -1).join(", ")
  return {street, locality, country}
}

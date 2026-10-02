/**
 * Return the notification blocklist after blocking or unblocking every package in
 * `packageNames`. Entries for other packages, including apps that are no longer
 * installed, are kept in their original order and duplicates are removed.
 */
export function setPackagesBlocked(blocklist: string[], packageNames: string[], blocked: boolean): string[] {
  const targets = new Set(packageNames)
  const others = blocklist.filter((packageName) => !targets.has(packageName))
  return [...new Set(blocked ? [...others, ...packageNames] : others)]
}

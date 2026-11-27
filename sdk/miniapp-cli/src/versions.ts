/**
 * The `versions` list of a served miniapp.json: the versions a phone may be
 * pinned to. One entry per version, highest version first, at most 50.
 *
 *   "versions": [
 *     {"version": "0.3.5", "url": "com.example.notes-0.3.5-9f2c0e1a.zip", "sha256": "9f2c0e1a…"},
 *     {"version": "0.3.4", "url": "com.example.notes-0.3.4-41ab77c3.zip", "sha256": "41ab77c3…"}
 *   ]
 *
 * `pack` writes it, and Mentra's first-party publisher
 * (.github/scripts/publish-miniapp-r2.ts) keeps the same list by the same
 * rules. That script is copied whole into other repositories, so it carries
 * its own copy of this logic; pack.test.ts holds the two to the same answers.
 */

/** One version a phone can be pinned to: its ZIP and that ZIP's SHA-256. */
export interface VersionEntry {
  version: string;
  /** The ZIP's URL, relative to the miniapp URL or absolute, as `bundle.url` is. */
  url: string;
  /** In lowercase hex. */
  sha256: string;
}

/** How many versions a served miniapp.json lists. */
export const MAX_VERSIONS = 50;

/** SemVer 2.0.0 (semver.org), as the `version` of a served miniapp.json must be. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isSemver(version: string): boolean {
  return SEMVER.test(version);
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Two runs of digits without leading zeros, as numbers of any size. */
function compareDigits(a: string, b: string): number {
  return a.length - b.length || compareText(a, b);
}

/**
 * SemVer precedence: above zero when `a` is the higher version. A prerelease
 * sorts below its release (`1.0.0-beta.1` is lower than `1.0.0` and higher
 * than `0.9.9`). Build metadata (`+…`) has no precedence, so two versions that
 * differ only there are put in plain text order to keep the list stable.
 */
export function compareVersions(a: string, b: string): number {
  const [, ...x] = SEMVER.exec(a) ?? [];
  const [, ...y] = SEMVER.exec(b) ?? [];
  for (let part = 0; part < 3; part++) {
    const order = compareDigits(x[part] ?? '', y[part] ?? '');
    if (order) return order;
  }
  const pre = x[3]?.split('.');
  const other = y[3]?.split('.');
  // A release is above its prereleases.
  if (pre && !other) return -1;
  if (!pre && other) return 1;
  if (pre && other) {
    for (let index = 0; index < Math.max(pre.length, other.length); index++) {
      const left = pre[index];
      const right = other[index];
      // The same so far: the one with more identifiers is higher.
      if (left === undefined) return -1;
      if (right === undefined) return 1;
      const order = compareIdentifiers(left, right);
      if (order) return order;
    }
  }
  return compareText(a, b);
}

/** Prerelease identifiers: numbers in number order, below any with a letter; those in ASCII order. */
function compareIdentifiers(a: string, b: string): number {
  const aIsNumber = /^\d+$/.test(a);
  const bIsNumber = /^\d+$/.test(b);
  if (aIsNumber && bIsNumber) return compareDigits(a, b);
  if (aIsNumber !== bIsNumber) return aIsNumber ? -1 : 1;
  return compareText(a, b);
}

/**
 * The list with `entry` in it: in place of an entry for the same version, with
 * the others kept, highest version first. Past {@link MAX_VERSIONS} the lowest
 * are dropped, but never `entry`: the build a miniapp.json serves is always one
 * a phone can be pinned to.
 */
export function mergeVersions(existing: VersionEntry[], entry: VersionEntry): VersionEntry[] {
  const seen = new Set([entry.version]);
  const others = existing.filter((other) => !seen.has(other.version) && seen.add(other.version));
  others.sort((a, b) => compareVersions(b.version, a.version));
  const kept = [entry, ...others.slice(0, MAX_VERSIONS - 1)];
  return kept.sort((a, b) => compareVersions(b.version, a.version));
}

function entryOf(value: unknown): VersionEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, url, sha256 } = value as Record<string, unknown>;
  if (typeof version !== 'string' || !isSemver(version)) return null;
  if (typeof url !== 'string' || url.trim() === '') return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) return null;
  return { version, url, sha256: sha256.toLowerCase() };
}

/**
 * The versions a served miniapp.json lists. One that has no list yet, written
 * before `versions` existed, offers the build it serves: its `version` and
 * `bundle`. Throws for a list that can't be read, so that a caller never
 * replaces a list it didn't understand with a shorter one.
 */
export function listedVersions(served: Record<string, unknown>): VersionEntry[] {
  if (!('versions' in served)) {
    const bundle = served.bundle as Record<string, unknown> | undefined;
    const entry = entryOf({ version: served.version, url: bundle?.url, sha256: bundle?.sha256 });
    return entry ? [entry] : [];
  }
  if (!Array.isArray(served.versions)) throw new Error('versions is not a list');
  return served.versions.map((value, index) => {
    const entry = entryOf(value);
    if (!entry) throw new Error(`versions[${index}] is not {version, url, sha256} with a SemVer version and a SHA-256`);
    return entry;
  });
}

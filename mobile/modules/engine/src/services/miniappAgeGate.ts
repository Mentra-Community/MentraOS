/**
 * The age gate (the distribution spec's "Age ratings"; App Store Review Guideline 4.7.5).
 *
 * A miniapp that declares an `ageRating` above the host app's own App Store rating (`hostAgeRating`) installs or opens
 * only for a person whose declared age is old enough. The first time that comes up, the host asks the person's age
 * (the `askDeclaredAge` seam) and Core keeps it on their account with the date they gave it. This phone keeps a copy
 * for that account, so later checks need no network. The person's age now is the declared age plus the whole years
 * since (`currentDeclaredAge`). The age is never sent to a miniapp.
 *
 * - A miniapp without a rating, or with one at or below the host's, is never gated. A rating that isn't one of
 *   Apple's categories counts as the highest, 18+.
 * - Without `hostAgeRating` nothing is gated. A host rating the engine can't read counts as the lowest, 4+.
 * - An install with a sheet is checked before the sheet (`installMiniapp`). Every launch is checked as its context
 *   spawns (`MiniappLauncher`): that is where headless installs (Fleet assignments, system miniapps) meet the gate.
 */
import {
  currentDeclaredAge,
  DECLARED_AGE_MAX,
  DECLARED_AGE_MIN,
  type DeclaredAge,
} from "@mentra/cloud-protocol/declared-age"
import {MINIAPP_AGE_RATINGS} from "@mentra/cloud-protocol/miniapp-url"

import {getConfigValues, getUiSeams} from "../runtime/bootstrap"

/**
 * `allowed`: the miniapp isn't gated, or the person is old enough. `too_young`: their declared age is below its
 * rating. `unknown`: they have declared no age and can't be asked now (nobody signed in, the miniapp is starting
 * without them, or the host can't ask). `cancelled`: they closed the question. `unavailable`: their age couldn't be
 * read from or kept on their account (offline).
 */
export type AgeGateVerdict = "allowed" | "too_young" | "unknown" | "cancelled" | "unavailable"

export interface AgeRatedMiniapp {
  packageName: string
  name: string
  /** What its `miniapp.json` declares as `ageRating`; null or absent when it declares none. */
  ageRating?: unknown
}

export interface MiniappAgeGateDependencies {
  hostAgeRating(): string | null | undefined
  /** The signed-in Core account, or null when nobody is signed in. Rejects when it can't be known yet. */
  account(): Promise<string | null>
  /** The copy this phone keeps, for `account` only. */
  cached(account: string): DeclaredAge | null
  cache(account: string, declared: DeclaredAge): void
  /** What Core keeps for `account`. Rejects when Core can't be reached or the account changed. */
  fetch(account: string): Promise<DeclaredAge>
  /** Keep `age` on `account`, dated now; resolves with what Core kept. */
  store(account: string, age: number): Promise<DeclaredAge>
  /** How the host asks the person's age, or null when it can't. Resolves null when they cancel. */
  asker(): (() => Promise<number | null>) | null
  now(): Date
  warn(message: string, error?: unknown): void
}

export interface MiniappAgeGate {
  /** The age needed to install or open a miniapp with this rating here, or null when it isn't gated. */
  requiredAge(ageRating: unknown): number | null
  /** Check the person against the miniapp's rating. `ask`: they're in front of the app and may be asked their age. */
  check(miniapp: AgeRatedMiniapp, options: {ask: boolean}): Promise<AgeGateVerdict>
}

const LOWEST_AGE = 4
const HIGHEST_AGE = 18
const KNOWN_RATINGS: readonly string[] = MINIAPP_AGE_RATINGS

/** The minimum age a miniapp's rating names, or null when it declares none. Any other value counts as 18+. */
export function ratingMinimumAge(ageRating: unknown): number | null {
  if (ageRating === undefined || ageRating === null) return null
  if (typeof ageRating === "string" && KNOWN_RATINGS.includes(ageRating)) return Number.parseInt(ageRating, 10)
  return HIGHEST_AGE
}

/** The rating to show for a miniapp's declared `ageRating`. */
export function displayedRating(ageRating: unknown): string {
  return typeof ageRating === "string" && KNOWN_RATINGS.includes(ageRating) ? ageRating : `${HIGHEST_AGE}+`
}

/** The minimum age of the host's own App Store rating ("12+" is 12), or null when it has none. */
export function hostMinimumAge(hostAgeRating: string | null | undefined): number | null {
  if (hostAgeRating === undefined || hostAgeRating === null) return null
  const match = /^\s*(\d{1,2})\+\s*$/.exec(hostAgeRating)
  return match ? Number(match[1]) : LOWEST_AGE
}

function isDeclared(declared: DeclaredAge | null): declared is {declaredAge: number; declaredAgeAt: string} {
  return typeof declared?.declaredAge === "number" && typeof declared.declaredAgeAt === "string"
}

/** Build the age gate over its dependencies. */
export function createMiniappAgeGate(deps: MiniappAgeGateDependencies): MiniappAgeGate {
  /** One question at a time per account: every check waiting on it shares the answer. */
  const asking = new Map<string, Promise<DeclaredAge | "cancelled" | "unavailable">>()

  const requiredAge = (ageRating: unknown): number | null => {
    const host = hostMinimumAge(deps.hostAgeRating())
    if (host === null) return null
    const required = ratingMinimumAge(ageRating)
    return required !== null && required > host ? required : null
  }

  /** The person's declared age: this phone's copy, else Core's. Null when they've declared none. */
  const declaredAge = async (account: string): Promise<DeclaredAge | null> => {
    const cached = deps.cached(account)
    if (isDeclared(cached)) return cached
    const fetched = await deps.fetch(account)
    if (!isDeclared(fetched)) return null
    deps.cache(account, fetched)
    return fetched
  }

  /**
   * Ask, unless a question for the account is open (its answer is shared) or one answered while this check was
   * reading Core: a read that started before that answer was kept may come back empty, and must not ask again.
   */
  const askOnce = (account: string, ask: () => Promise<number | null>) => {
    const pending = asking.get(account)
    if (pending) return pending
    const answered = deps.cached(account)
    if (isDeclared(answered)) return Promise.resolve(answered)
    const question = (async (): Promise<DeclaredAge | "cancelled" | "unavailable"> => {
      let age: number | null
      try {
        age = await ask()
      } catch (error) {
        deps.warn("The age question could not be shown", error)
        return "cancelled"
      }
      if (age === null) return "cancelled"
      if (!Number.isInteger(age) || age < DECLARED_AGE_MIN || age > DECLARED_AGE_MAX) {
        deps.warn(`The age question answered ${String(age)}, which is not an age`)
        return "cancelled"
      }
      try {
        const kept = await deps.store(account, age)
        if (!isDeclared(kept)) return "unavailable"
        deps.cache(account, kept)
        return kept
      } catch (error) {
        deps.warn("The declared age could not be kept on the account", error)
        return "unavailable"
      }
    })().finally(() => asking.delete(account))
    asking.set(account, question)
    return question
  }

  return {
    requiredAge,
    async check(miniapp, {ask}) {
      const required = requiredAge(miniapp.ageRating)
      if (required === null) return "allowed"

      let account: string | null
      try {
        account = await deps.account()
      } catch (error) {
        deps.warn(`The signed-in account is not known yet; ${miniapp.packageName} waits for it`, error)
        return "unavailable"
      }
      if (!account) return "unknown"

      let declared: DeclaredAge | null
      try {
        declared = await declaredAge(account)
      } catch (error) {
        deps.warn(`The declared age could not be read for ${miniapp.packageName}`, error)
        return "unavailable"
      }
      if (!isDeclared(declared)) {
        const asker = ask ? deps.asker() : null
        if (!asker) return "unknown"
        const answer = await askOnce(account, asker)
        if (answer === "cancelled" || answer === "unavailable") return answer
        declared = answer
      }
      if (!isDeclared(declared)) return "unknown"
      return currentDeclaredAge(declared.declaredAge, declared.declaredAgeAt, deps.now()) >= required
        ? "allowed"
        : "too_young"
    },
  }
}

// ---- The engine's age gate --------------------------------------------------------------------------------------

/** This phone's copy of the last signed-in account's declared age. */
const DECLARED_AGE_KEY = "miniapp_declared_age:v1"

interface CachedDeclaredAge extends DeclaredAge {
  account: string
}

// The Cloud Client and the phone's storage load when a gated miniapp is first checked, so the launcher and the
// installer, which every miniapp passes through, don't load them for miniapps without a rating.
const cloud = () => (require("./CloudClientService") as typeof import("./CloudClientService")).cloudClientService
const phoneStorage = () => (require("../utils/storage/storage") as typeof import("../utils/storage/storage")).storage

const engineDependencies: MiniappAgeGateDependencies = {
  hostAgeRating: () => getConfigValues().hostAgeRating,
  account: async () => {
    if (!cloud().hasCore()) return null
    return (await cloud().resolveCoreSession())?.mentraUserId ?? null
  },
  cached: (account) => {
    const stored = phoneStorage().load<CachedDeclaredAge>(DECLARED_AGE_KEY)
    if (!stored.is_ok() || stored.value?.account !== account) return null
    return {declaredAge: stored.value.declaredAge, declaredAgeAt: stored.value.declaredAgeAt}
  },
  cache: (account, declared) => {
    // Only the last account's copy is kept: another account's answer never stays on the phone.
    phoneStorage().save(DECLARED_AGE_KEY, {account, ...declared} satisfies CachedDeclaredAge)
  },
  fetch: (account) => cloud().core.account.declaredAge({expectedAccount: account}),
  store: (account, age) => cloud().core.account.setDeclaredAge(age, {expectedAccount: account}),
  asker: () => getUiSeams().askDeclaredAge ?? null,
  now: () => new Date(),
  warn: (message, error) => console.warn(`MiniappAgeGate: ${message}`, error ?? ""),
}

let engineGate: MiniappAgeGate | null = null

function gate(): MiniappAgeGate {
  engineGate ??= createMiniappAgeGate(engineDependencies)
  return engineGate
}

/** Whether this host gates miniapps by age rating at all: it set `hostAgeRating`. */
export function isMiniappAgeGateOn(): boolean {
  return hostMinimumAge(getConfigValues().hostAgeRating) !== null
}

/** The age needed to install or open a miniapp with this rating on this host, or null when it isn't gated. */
export function miniappRequiredAge(ageRating: unknown): number | null {
  return gate().requiredAge(ageRating)
}

/**
 * Check a miniapp against the person's declared age. `interactive`: the person is installing or opening it in front
 * of the app, so they may be asked their age, and are told why when the gate stops it (`showAgeRestricted`).
 * Otherwise nobody is asked or told.
 */
export async function checkMiniappAge(
  miniapp: AgeRatedMiniapp,
  options: {interactive: boolean},
): Promise<AgeGateVerdict> {
  const verdict = await gate().check(miniapp, {ask: options.interactive})
  if (options.interactive && (verdict === "too_young" || verdict === "unavailable")) {
    try {
      getUiSeams().showAgeRestricted?.({
        packageName: miniapp.packageName,
        name: miniapp.name,
        ageRating: displayedRating(miniapp.ageRating),
        reason: verdict,
      })
    } catch (error) {
      console.warn(`MiniappAgeGate: the notice for ${miniapp.packageName} could not be shown`, error)
    }
  }
  return verdict
}

/** Tests only: run the engine's checks over these dependencies; null restores the engine's own. */
export function setMiniappAgeGateDependenciesForTests(deps: MiniappAgeGateDependencies | null): void {
  engineGate = deps ? createMiniappAgeGate(deps) : null
}

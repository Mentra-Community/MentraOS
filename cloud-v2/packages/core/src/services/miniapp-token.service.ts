/**
 * @fileoverview What goes into a person's miniapp token, and minting it.
 *
 * `POST /api/client/auth/miniapp-token` (`api/client/auth.api.ts`) mints through `mintMiniappTokenFor`, and so
 * does anything else in Core that needs a person's token for a package, so every token for a person and a
 * package is decided by the same rules. Around the identity (`sub`, `tenantId`, `aud`) a token carries:
 *
 *  - `email` and `email_verified`: the verified account email. Best effort: a slow or failing lookup mints
 *    the token without them.
 *  - `features`: the licensed features the person holds for the package (`licenses/features.service.ts`).
 *    Required: a token missing paid features would lock the person out of what they bought.
 *  - `workspaceId`: the person's workspace, only when that workspace assigned the package through Fleet
 *    (`workspaces/assigned-packages.service.ts`). Required for the same reason: a company's miniapp that
 *    admits only its workspace would turn its own members away. While a workspace is assigning a package
 *    (Fleet's registry check), the caller names that workspace itself (`assigningWorkspaceId`), and nothing
 *    is looked up.
 *  - `workspaceRole`: the person's role in that workspace (member, developer, admin or owner), from the same
 *    lookup, so a company's miniapp can show an admin what a member doesn't see. Only beside `workspaceId`,
 *    and absent while a workspace is assigning the package: that check needs no role.
 *  - `workspaceName`: that workspace's name, for the miniapp to show. Only beside `workspaceId`, and best
 *    effort, like the email: a slow or failing lookup mints the token without it.
 *  - `localBuild: true`: the token is for a local or development build. Such a token never names a
 *    workspace, so no workspace is looked up for it.
 *
 * Each lookup gets {@link MINIAPP_LOOKUP_DEADLINE_MS}, and they run side by side. A required lookup that fails,
 * or outlasts its deadline, mints nothing (`MiniappTokenUnavailableError`) and the phone asks again.
 */

import {createLogger} from "@mentra/cloud-shared"
import {trustedAccountEmail} from "./account/trusted-email.service"
import {featuresFor} from "./licenses/features.service"
import {issueMiniappToken} from "./session.service"
import {assigningMembership, workspaceNameOf, type AssigningMembership} from "./workspaces/assigned-packages.service"

/** How long each lookup a miniapp token waits for may take. */
export const MINIAPP_LOOKUP_DEADLINE_MS = 1_500

/** Why no token was minted: a lookup the token cannot do without did not answer. */
export type MiniappTokenUnavailableCode = "features_unavailable" | "workspace_unavailable"

/** A required lookup failed or outlasted its deadline. Answered as `503 {error: code}`; retryable. */
export class MiniappTokenUnavailableError extends Error {
  constructor(readonly code: MiniappTokenUnavailableCode) {
    super(code)
    this.name = "MiniappTokenUnavailableError"
  }
}

const logger = createLogger("core").child({service: "miniapp-token.service"})

/**
 * Mint the miniapp token for this person and package. `localBuild` marks a token for a local or development
 * build, which never names a workspace. `assigningWorkspaceId` is the workspace assigning the package right
 * now, which the caller has checked the person is an active member of: the token names it in place of the
 * one the assigned sets would. Throws `MiniappTokenUnavailableError` when the licensed features or the
 * assigning workspace cannot be read in time.
 */
export async function mintMiniappTokenFor(args: {
  mentraUserId: string
  tenantId: string
  packageName: string
  localBuild?: boolean
  assigningWorkspaceId?: string
  /** A miniapp website's token: it names the website (`client_id`) and lives `ttlSec`. */
  website?: {clientId: string; ttlSec: number}
}): Promise<{token: string; expiresAt: number}> {
  const {mentraUserId, packageName} = args
  const localBuild = args.localBuild === true
  // The email lookup never rejects, so abandoning it when a required lookup fails is safe.
  const emailLookup = miniappTokenEmail(mentraUserId)
  const workspaceLookup = (): Promise<AssigningMembership | null> | {workspaceId: string; role?: undefined} | null => {
    if (localBuild) return null
    if (args.assigningWorkspaceId) return {workspaceId: args.assigningWorkspaceId}
    return required("workspace_unavailable", "assigned workspace lookup", {mentraUserId, packageName}, () =>
      assigningMembership(mentraUserId, packageName),
    )
  }
  const [features, workspace] = await Promise.all([
    required("features_unavailable", "licensed features lookup", {mentraUserId, packageName}, () =>
      featuresFor({mentraUserId, packageName, now: new Date()}),
    ),
    workspaceLookup(),
  ])
  const workspaceName = workspace?.workspaceId ? await miniappTokenWorkspaceName(workspace.workspaceId) : null
  return issueMiniappToken({
    mentraUserId,
    tenantId: args.tenantId,
    packageName,
    email: await emailLookup,
    features,
    workspaceId: workspace?.workspaceId ?? null,
    workspaceRole: workspace?.role ?? null,
    workspaceName,
    localBuild,
    ...(args.website ? {websiteClientId: args.website.clientId, ttlSec: args.website.ttlSec} : {}),
  })
}

/** A lookup the token cannot do without: its answer, or `MiniappTokenUnavailableError` with `code`. */
async function required<T>(
  code: MiniappTokenUnavailableCode,
  what: string,
  context: {mentraUserId: string; packageName: string},
  start: () => Promise<T>,
): Promise<T> {
  try {
    return await withinDeadline(what, start)
  } catch (error) {
    logger.error({...context, error: (error as Error)?.message}, `miniapp token refused: ${what} unavailable`)
    throw new MiniappTokenUnavailableError(code)
  }
}

/**
 * Verified account email for the miniapp token's optional `email` claim. The
 * claim is best-effort: a slow or failing account lookup (user row or account
 * directory) must never block a miniapp from authenticating, so the whole
 * lookup races a deadline and degrades to a token without email.
 */
async function miniappTokenEmail(mentraUserId: string): Promise<string | null> {
  try {
    return await withinDeadline("account email lookup", (signal) => trustedAccountEmail(mentraUserId, {signal}))
  } catch (error) {
    logger.warn({mentraUserId, error: (error as Error)?.message}, "miniapp token issued without email claim")
    return null
  }
}

/**
 * The name of the workspace the token names, for its optional `workspaceName` claim. Best effort, like the
 * email: a slow or failing lookup mints the token without it.
 */
async function miniappTokenWorkspaceName(workspaceId: string): Promise<string | null> {
  try {
    return await withinDeadline("workspace name lookup", () => workspaceNameOf(workspaceId))
  } catch (error) {
    logger.warn({workspaceId, error: (error as Error)?.message}, "miniapp token issued without workspace name")
    return null
  }
}

/**
 * Run `start` and give it `MINIAPP_LOOKUP_DEADLINE_MS`. The signal it receives is aborted at the deadline,
 * for lookups that can stop. Rejects with the lookup's own error, or at the deadline with a timeout error;
 * the timer is always cleared. A lookup that outlasts its deadline is abandoned, and a later rejection of it
 * is swallowed rather than left unhandled.
 */
async function withinDeadline<T>(what: string, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`${what} exceeded ${MINIAPP_LOOKUP_DEADLINE_MS}ms`))
    }, MINIAPP_LOOKUP_DEADLINE_MS)
  })
  try {
    const lookup = start(controller.signal)
    // Abandoned on purpose when the deadline wins: whatever it later settles with is not an error to report.
    lookup.catch(() => {})
    return await Promise.race([lookup, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @fileoverview Workspace credential (`msk_`) and operator key (`mak_`) integration tests.
 *
 * These run the real services, models and transactions against a local replica
 * set. The interesting cases are the ones that pin who a key still acts for:
 * demoting or removing the creator, an operator key whose creator stops being an
 * Organization Admin, a migrated creator who has not signed in yet, and a key
 * presented under a prefix or environment it was not issued with.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27031 bun test tests/workspace-credentials.integration.test.ts`
 */

import {createHash, randomBytes} from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {listWorkspaceAudit} from "../packages/core/src/services/workspaces/audit.service"
import {
  createOperatorKey,
  createWorkspaceCredential,
  isCredentialToken,
  listOperatorKeys,
  listWorkspaceCredentials,
  mintServiceCredential,
  revokeCredential,
  validateCredentialToken,
} from "../packages/core/src/services/workspaces/credential.service"
import {
  changeRole,
  createWorkspace,
  deleteWorkspace,
  getActiveMembership,
  getWorkspace,
  leaveWorkspace,
  removeMember,
  WorkspaceError,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

const MODELS = [
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  AccessCredentialModel,
  WorkspaceAuditEventModel,
  WorkspaceAuditCounterModel,
]

const ADMIN_EMAIL = "org-admin@example.test"
const SCOPE_ENV_KEYS = [
  "CLOUD_CORE_ADMIN_EMAILS",
  "CLOUD_CORE_ADMIN_EMAIL_DOMAINS",
  "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS",
  "CLOUD_CORE_ENVIRONMENT",
] as const
const savedEnv = Object.fromEntries(SCOPE_ENV_KEYS.map(key => [key, process.env[key]]))

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false

type UserActor = Actor & {kind: "user"}

function user(id: string, overrides: Partial<UserActor> = {}): UserActor {
  return {
    kind: "user",
    mentraUserId: id,
    email: `${id}@example.test`,
    emailVerified: true,
    isOrganizationAdmin: false,
    ...overrides,
  }
}

const orgAdmin = user("mu_org_admin", {email: ADMIN_EMAIL, isOrganizationAdmin: true})
const system: Actor = {kind: "system"}
const service: Actor = {kind: "service", service: "store", email: null}

let counter = 0
const nextId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** A credential id in ULID form (26 Crockford base32 characters). */
const ulid = () => Array.from(randomBytes(26), byte => CROCKFORD[byte % 32]).join("")

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex")

async function addMember(
  workspaceId: string,
  mentraUserId: string | null,
  role: string,
  fields: Record<string, unknown> = {},
) {
  const membershipId = `wm_${nextId()}`
  await WorkspaceMembershipModel.create({
    membershipId,
    workspaceId,
    mentraUserId,
    email: `${mentraUserId ?? "pending"}@example.test`,
    role,
    status: "active",
    startedAt: new Date(),
    ...fields,
  })
  return membershipId
}

async function membershipIdOf(workspaceId: string, mentraUserId: string): Promise<string> {
  const row = await getActiveMembership(workspaceId, mentraUserId)
  if (!row) throw new Error(`no active membership for ${mentraUserId}`)
  return row.membershipId
}

async function revisionOf(workspaceId: string): Promise<number> {
  const row = await getWorkspace(workspaceId)
  if (!row) throw new Error(`no workspace ${workspaceId}`)
  return row.authorizationRevision
}

/** A workspace owned by `owner`, with a developer, an admin and a member added. */
async function newWorkspace() {
  const owner = user("mu_owner")
  const workspaceId = (await createWorkspace(owner, {name: "Acme"})).workspaceId
  const developer = user("mu_developer")
  const admin = user("mu_admin")
  const member = user("mu_member")
  await addMember(workspaceId, developer.mentraUserId, "developer")
  await addMember(workspaceId, admin.mentraUserId, "admin")
  await addMember(workspaceId, member.mentraUserId, "member")
  return {workspaceId, owner, developer, admin, member}
}

function parse(token: string) {
  const match = /^(msk|mak)_([a-z0-9]+)_([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!match) throw new Error(`not a credential token: ${token}`)
  return {prefix: match[1]!, env: match[2]!, credentialId: match[3]!, secret: match[4]!}
}

/** Insert a credential row with a known secret and return its token, standing in for migrated rows. */
async function seedKey(fields: Record<string, unknown> = {}) {
  const credentialId = ulid()
  const secret = randomBytes(32).toString("base64url")
  const prefix = (fields.prefix as string | undefined) ?? "msk"
  const env = (fields.env as string | undefined) ?? "local"
  await AccessCredentialModel.create({
    credentialId,
    prefix,
    credentialKind: prefix === "mak" ? "organization" : "workspace",
    name: "seeded",
    env,
    hash: sha256Hex(secret),
    last4: secret.slice(-4),
    scopes: ["miniapps.publish"],
    ...fields,
  })
  return {credentialId, secret, token: `${prefix}_${env}_${credentialId}.${secret}`}
}

async function thrown(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error("expected the call to throw")
}

async function expectError(fn: () => Promise<unknown>, code: string, status: number) {
  const err = await thrown(fn)
  expect(err).toBeInstanceOf(WorkspaceError)
  expect({code: err.code, status: err.status}).toEqual({code, status})
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("condition not met in time")
}

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("workspace-credentials")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  await Promise.all(MODELS.map(model => model.init()))
})

afterAll(async () => {
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  process.env.CLOUD_CORE_ADMIN_EMAILS = ADMIN_EMAIL
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
  delete process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS
  delete process.env.CLOUD_CORE_ENVIRONMENT
})

afterEach(() => {
  for (const key of SCOPE_ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

describe("createWorkspaceCredential", () => {
  test("round trip: the token validates to a credential principal bound to the creator's membership", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const before = await revisionOf(workspaceId)

    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "  CI key  "})

    const parts = parse(token)
    expect(parts).toMatchObject({prefix: "msk", env: "local", credentialId: credential.credentialId})
    expect(credential).toEqual({
      credentialId: parts.credentialId,
      prefix: "msk",
      name: "CI key",
      display: `msk_local_…${parts.secret.slice(-4)}`,
      workspaceId,
      scopes: ["miniapps.publish"],
      packageNames: [],
      createdByEmail: "mu_developer@example.test",
      issuedByService: null,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: expect.any(String),
    })
    expect(JSON.stringify(credential)).not.toContain(parts.secret)

    // Only the SHA-256 hex of the secret is stored, with the creator's membership.
    const row = await AccessCredentialModel.findOne({credentialId: parts.credentialId}).lean()
    expect(row).toMatchObject({
      prefix: "msk",
      credentialKind: "workspace",
      workspaceId,
      name: "CI key",
      env: "local",
      hash: sha256Hex(parts.secret),
      last4: parts.secret.slice(-4),
      scopes: ["miniapps.publish"],
      packageNames: [],
      createdByMembershipId: await membershipIdOf(workspaceId, "mu_developer"),
      createdByMentraUserId: "mu_developer",
      createdByEmail: "mu_developer@example.test",
      issuedByService: null,
      revokedAt: null,
    })
    expect(JSON.stringify(row)).not.toContain(parts.secret)

    expect(await validateCredentialToken(token)).toEqual({
      kind: "credential",
      credentialId: parts.credentialId,
      credentialKind: "workspace",
      workspaceId,
      scopes: ["miniapps.publish"],
      packageNames: [],
      label: "CI key",
    })
    // Keys do not change who holds which role, so they leave the revision alone.
    expect(await revisionOf(workspaceId)).toBe(before)
  })

  test("records a credential.created audit event that never carries the token or its hash", async () => {
    const {workspaceId, developer} = await newWorkspace()

    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {
      name: "CI key",
      packageNames: ["com.acme.app"],
    })

    const events = (await listWorkspaceAudit(workspaceId, {limit: 50})).filter(e => e.action === "credential.created")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      workspaceId,
      actor: {kind: "user", mentraUserId: "mu_developer", email: "mu_developer@example.test"},
      target: {credentialId: credential.credentialId, prefix: "msk", workspaceId},
    })
    const serialized = JSON.stringify(events[0])
    const {secret} = parse(token)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(sha256Hex(secret))
    expect(serialized).not.toContain(token)
  })

  test("owner, admin and developer may create; member, non-member and service may not", async () => {
    const {workspaceId, owner, admin, developer, member} = await newWorkspace()

    for (const actor of [owner, admin, developer]) {
      const {token} = await createWorkspaceCredential(actor, workspaceId, {name: `by ${actor.mentraUserId}`})
      expect(await validateCredentialToken(token)).not.toBeNull()
    }
    await expectError(() => createWorkspaceCredential(member, workspaceId, {name: "no"}), "forbidden", 403)
    await expectError(() => createWorkspaceCredential(user("mu_stranger"), workspaceId, {name: "no"}), "forbidden", 403)
    await expectError(() => createWorkspaceCredential(service, workspaceId, {name: "no"}), "forbidden", 403)
    expect(await AccessCredentialModel.countDocuments({})).toBe(3)
  })

  test("an organization admin or the system cannot mint a key that has no membership to stand on", async () => {
    const {workspaceId} = await newWorkspace()

    await expectError(() => createWorkspaceCredential(orgAdmin, workspaceId, {name: "no"}), "forbidden", 403)
    await expectError(() => createWorkspaceCredential(system, workspaceId, {name: "no"}), "forbidden", 403)
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)

    // A member-role organization admin would hold a key that can never publish.
    await addMember(workspaceId, orgAdmin.mentraUserId, "member")
    await expectError(() => createWorkspaceCredential(orgAdmin, workspaceId, {name: "no"}), "forbidden", 403)

    // As a developer-or-better member the same person can.
    const adminMembership = await membershipIdOf(workspaceId, orgAdmin.mentraUserId)
    await WorkspaceMembershipModel.updateOne({membershipId: adminMembership}, {$set: {role: "developer"}})
    const {token} = await createWorkspaceCredential(orgAdmin, workspaceId, {name: "ok"})
    expect(await validateCredentialToken(token)).not.toBeNull()
  })

  test("unknown and deleted workspaces are refused", async () => {
    const {workspaceId, owner, developer} = await newWorkspace()
    await expectError(() => createWorkspaceCredential(developer, "ws_missing", {name: "k"}), "not_found", 404)
    await expectError(() => createWorkspaceCredential(developer, "", {name: "k"}), "not_found", 404)

    await deleteWorkspace(owner, workspaceId, {confirmName: "Acme", ownedPackageCount: async () => 0})
    await expectError(() => createWorkspaceCredential(developer, workspaceId, {name: "k"}), "workspace_deleted", 410)
  })

  test("validates the name, package names and expiry", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const create = (input: Parameters<typeof createWorkspaceCredential>[2]) =>
      createWorkspaceCredential(developer, workspaceId, input)

    await expectError(() => create({name: "   "}), "invalid_request", 400)
    await expectError(() => create({name: "x".repeat(81)}), "invalid_request", 400)
    await expectError(() => create({name: 5 as unknown as string}), "invalid_request", 400)
    await expectError(() => create({name: "k", packageNames: ["Com.Acme.App"]}), "invalid_request", 400)
    await expectError(() => create({name: "k", packageNames: ["acme"]}), "invalid_request", 400)
    await expectError(() => create({name: "k", packageNames: ["com..acme"]}), "invalid_request", 400)
    await expectError(
      () => create({name: "k", packageNames: ["com.acme.app", 7 as unknown as string]}),
      "invalid_request",
      400,
    )
    await expectError(
      () => create({name: "k", packageNames: "com.acme.app" as unknown as string[]}),
      "invalid_request",
      400,
    )
    await expectError(() => create({name: "k", packageNames: [`com.${"a".repeat(125)}`]}), "invalid_request", 400)
    const tooMany = Array.from({length: 51}, (_, i) => `com.acme.app${i}`)
    await expectError(() => create({name: "k", packageNames: tooMany}), "invalid_request", 400)
    await expectError(() => create({name: "k", expiresAt: new Date(Date.now() - 1000)}), "invalid_request", 400)
    await expectError(() => create({name: "k", expiresAt: new Date("not a date")}), "invalid_request", 400)
    await expectError(() => create({name: "k", expiresAt: "2999-01-01" as unknown as Date}), "invalid_request", 400)
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)

    const maxed = Array.from({length: 50}, (_, i) => `com.acme.app${i}`)
    const expiresAt = new Date(Date.now() + 3_600_000)
    const {credential} = await create({name: "k", packageNames: maxed, expiresAt})
    expect(credential.packageNames).toEqual(maxed)
    expect(credential.expiresAt).toBe(expiresAt.toISOString())
    // Duplicates collapse; the order of first appearance is kept.
    const deduped = await create({name: "k", packageNames: ["com.acme.b", "com.acme.a", "com.acme.b"]})
    expect(deduped.credential.packageNames).toEqual(["com.acme.b", "com.acme.a"])
    expect(await create({name: "k", expiresAt: null})).toBeTruthy()
  })

  test("a package-restricted key carries its package names on the principal", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(developer, workspaceId, {
      name: "app key",
      packageNames: ["com.acme.app", "com.acme.other"],
    })
    expect(await validateCredentialToken(token)).toMatchObject({
      packageNames: ["com.acme.app", "com.acme.other"],
      scopes: ["miniapps.publish"],
    })
  })

  test("new tokens carry the first configured environment label", async () => {
    process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS = "Prod, staging"
    const {workspaceId, developer} = await newWorkspace()

    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})

    expect(parse(token).env).toBe("prod")
    expect(credential.display).toBe(`msk_prod_…${parse(token).secret.slice(-4)}`)
    expect(await validateCredentialToken(token)).not.toBeNull()
  })

  test("creating a key concurrently with the creator leaving leaves no working key", async () => {
    for (let round = 0; round < 3; round++) {
      await Promise.all(MODELS.map(model => model.deleteMany({})))
      const {workspaceId, developer} = await newWorkspace()

      const [created, left] = await Promise.allSettled([
        createWorkspaceCredential(developer, workspaceId, {name: "racy"}),
        leaveWorkspace(developer, workspaceId),
      ])

      expect(left.status).toBe("fulfilled")
      if (created.status === "fulfilled") {
        // The key won the race, so leaving must have revoked it.
        expect(await validateCredentialToken(created.value.token)).toBeNull()
        expect(await AccessCredentialModel.countDocuments({revokedAt: null})).toBe(0)
      } else {
        expect((created.reason as WorkspaceError).code).toBe("forbidden")
      }
    }
  })
})

describe("validateCredentialToken", () => {
  test("malformed input is null and never throws", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    const {prefix, env, credentialId, secret} = parse(token)

    const bad = [
      "",
      "msk_",
      "Bearer " + token,
      ` ${token}`,
      `${token}\n`,
      `${token}x`,
      token.slice(0, -1),
      `${prefix}_${env}_${credentialId.toLowerCase()}.${secret}`,
      `${prefix}_${env}_${credentialId}-${secret}`,
      `${prefix}_${env}.${credentialId}.${secret}`,
      `xxx_${env}_${credentialId}.${secret}`,
      `${prefix}__${credentialId}.${secret}`,
      `${prefix}_${env.toUpperCase()}_${credentialId}.${secret}`,
      "a".repeat(5000),
    ]
    for (const candidate of bad) expect(await validateCredentialToken(candidate)).toBeNull()
    expect(await validateCredentialToken(undefined as unknown as string)).toBeNull()
    expect(await validateCredentialToken(null as unknown as string)).toBeNull()
    expect(await validateCredentialToken(42 as unknown as string)).toBeNull()
    expect(await validateCredentialToken({} as unknown as string)).toBeNull()
  })

  test("a tampered secret or credential id is null", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    const {prefix, env, credentialId, secret} = parse(token)

    const flipped = (secret[0] === "A" ? "B" : "A") + secret.slice(1)
    expect(await validateCredentialToken(`${prefix}_${env}_${credentialId}.${flipped}`)).toBeNull()
    const otherSecret = randomBytes(32).toString("base64url")
    expect(await validateCredentialToken(`${prefix}_${env}_${credentialId}.${otherSecret}`)).toBeNull()
    expect(await validateCredentialToken(`${prefix}_${env}_${ulid()}.${secret}`)).toBeNull()
    // The untouched token still works.
    expect(await validateCredentialToken(token)).not.toBeNull()
  })

  test("a wrong environment is null, both unconfigured and bound to the stored row", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    const {prefix, credentialId, secret} = parse(token)

    // Not a configured environment at all.
    expect(await validateCredentialToken(`${prefix}_prod_${credentialId}.${secret}`)).toBeNull()

    // Configured, but not the environment the row was issued under.
    process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS = "local,prod"
    expect(await validateCredentialToken(`${prefix}_prod_${credentialId}.${secret}`)).toBeNull()
    expect(await validateCredentialToken(token)).not.toBeNull()

    // The row's environment no longer being configured also invalidates it.
    process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS = "prod"
    expect(await validateCredentialToken(token)).toBeNull()
  })

  test("a token presented under the other prefix is null", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    const {env, credentialId, secret} = parse(token)

    // The hash covers only the secret, so the prefix must be bound to the row or a workspace key could
    // be presented as an operator key.
    expect(await validateCredentialToken(`mak_${env}_${credentialId}.${secret}`)).toBeNull()

    const operator = await createOperatorKey(orgAdmin, {name: "ops", scopes: ["organization.incidents.read"]})
    const op = parse(operator.token)
    expect(await validateCredentialToken(`msk_${op.env}_${op.credentialId}.${op.secret}`)).toBeNull()
    expect(await validateCredentialToken(operator.token)).not.toBeNull()
  })

  test("a key of a workspace that is no longer active is null, member and service keys alike", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const member = await createWorkspaceCredential(developer, workspaceId, {name: "member key"})
    const service = await mintServiceCredential("store", {
      workspaceId,
      name: "Publish com.acme.app",
      packageNames: ["com.acme.app"],
      actorEmail: "staff@example.test",
    })
    expect(await validateCredentialToken(member.token)).not.toBeNull()
    expect(await validateCredentialToken(service.token)).not.toBeNull()

    // Deletion revokes every key; a row written around it (a migration re-run, say) must still not resolve.
    await WorkspaceModel.updateOne({workspaceId}, {$set: {status: "deleted", deletedAt: new Date()}})

    expect(await validateCredentialToken(member.token)).toBeNull()
    expect(await validateCredentialToken(service.token)).toBeNull()
  })

  test("a revoked key is null", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    expect(await validateCredentialToken(token)).not.toBeNull()

    await revokeCredential(developer, credential.credentialId)

    expect(await validateCredentialToken(token)).toBeNull()
  })

  test("an expired key is null", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {
      name: "k",
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    expect(await validateCredentialToken(token)).not.toBeNull()

    await AccessCredentialModel.updateOne(
      {credentialId: credential.credentialId},
      {$set: {expiresAt: new Date(Date.now() - 1)}},
    )

    expect(await validateCredentialToken(token)).toBeNull()
  })

  test("demoting the creator to member makes the key invalid, and restoring the role revives it", async () => {
    const {workspaceId, owner, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    const membershipId = await membershipIdOf(workspaceId, "mu_developer")
    expect(await validateCredentialToken(token)).not.toBeNull()

    await changeRole(owner, workspaceId, membershipId, "member", await revisionOf(workspaceId))
    // `miniapps.publish` is no longer in the role, so the intersection is empty.
    expect(await validateCredentialToken(token)).toBeNull()

    // Same membership generation, so the permissions are live again.
    await changeRole(owner, workspaceId, membershipId, "developer", await revisionOf(workspaceId))
    expect(await validateCredentialToken(token)).not.toBeNull()
  })

  test("removing the creator invalidates the key and a later rejoin does not revive it", async () => {
    const {workspaceId, owner, developer} = await newWorkspace()
    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    const membershipId = await membershipIdOf(workspaceId, "mu_developer")

    await removeMember(owner, workspaceId, membershipId, await revisionOf(workspaceId))
    expect(await validateCredentialToken(token)).toBeNull()

    // Rejoining is a new membership generation; the old key does not come back.
    const rejoined = await addMember(workspaceId, "mu_developer", "developer")
    expect(rejoined).not.toBe(membershipId)
    expect(await validateCredentialToken(token)).toBeNull()

    // Even with the revocation undone, the ended membership is what the key points at.
    await AccessCredentialModel.updateOne({credentialId: credential.credentialId}, {$set: {revokedAt: null}})
    expect(await validateCredentialToken(token)).toBeNull()
  })

  test("a key whose creator membership is pending (migrated, not signed in yet) validates", async () => {
    const {workspaceId} = await newWorkspace()
    const pendingMembership = await addMember(workspaceId, null, "developer", {pendingWorkosUserId: "user_workos_1"})
    const {credentialId, token} = await seedKey({workspaceId, createdByMembershipId: pendingMembership})

    expect(await validateCredentialToken(token)).toEqual({
      kind: "credential",
      credentialId,
      credentialKind: "workspace",
      workspaceId,
      scopes: ["miniapps.publish"],
      packageNames: [],
      label: "seeded",
    })

    // A pending creator below developer has nothing to publish with.
    await WorkspaceMembershipModel.updateOne({membershipId: pendingMembership}, {$set: {role: "member"}})
    expect(await validateCredentialToken(token)).toBeNull()
  })

  test("a migrated key with neither a creator nor a service is invalid", async () => {
    const {workspaceId} = await newWorkspace()
    const {token} = await seedKey({workspaceId})
    expect(await validateCredentialToken(token)).toBeNull()
  })

  test("a key pointing at a missing membership, or one in another workspace, is invalid", async () => {
    const {workspaceId} = await newWorkspace()
    const other = await createWorkspace(user("mu_other_owner"), {name: "Other"})
    const missing = await seedKey({workspaceId, createdByMembershipId: "wm_missing"})
    expect(await validateCredentialToken(missing.token)).toBeNull()

    const foreign = await membershipIdOf(other.workspaceId, "mu_other_owner")
    const crossed = await seedKey({workspaceId, createdByMembershipId: foreign})
    expect(await validateCredentialToken(crossed.token)).toBeNull()
  })

  test("the key is limited to what the creator's role grants, never more than its own scopes", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const membershipId = await membershipIdOf(workspaceId, developer.mentraUserId)
    // Scopes beyond the creator's role (or unknown to any role) drop out of the intersection.
    const {token} = await seedKey({
      workspaceId,
      createdByMembershipId: membershipId,
      scopes: ["miniapps.publish", "workspace.delete", "organization.workspaces.administer"],
    })
    expect(await validateCredentialToken(token)).toMatchObject({scopes: ["miniapps.publish"]})

    const none = await seedKey({workspaceId, createdByMembershipId: membershipId, scopes: ["workspace.delete"]})
    expect(await validateCredentialToken(none.token)).toBeNull()
  })

  test("a service credential is limited to its package names and ignores memberships", async () => {
    const {workspaceId, owner} = await newWorkspace()
    const {credential, token} = await mintServiceCredential("store", {
      workspaceId,
      name: "Publish com.acme.app",
      packageNames: ["com.acme.app"],
      actorEmail: "staff@example.test",
    })

    expect(await validateCredentialToken(token)).toEqual({
      kind: "credential",
      credentialId: credential.credentialId,
      credentialKind: "workspace",
      workspaceId,
      scopes: ["miniapps.publish"],
      packageNames: ["com.acme.app"],
      label: "Publish com.acme.app",
    })

    // The key does not depend on anyone's membership.
    await removeMember(
      owner,
      workspaceId,
      await membershipIdOf(workspaceId, "mu_developer"),
      await revisionOf(workspaceId),
    )
    expect(await validateCredentialToken(token)).not.toBeNull()

    // A service key without package names is not a valid service key.
    const unrestricted = await seedKey({workspaceId, issuedByService: "store", packageNames: []})
    expect(await validateCredentialToken(unrestricted.token)).toBeNull()
  })

  test("the label falls back to credential:<id> when the stored name is empty", async () => {
    const {workspaceId} = await newWorkspace()
    const {credentialId, token} = await seedKey({workspaceId, issuedByService: "store", packageNames: ["com.a.b"]})
    // `name` is required on insert, so blank it afterwards, as a hand-edited row would be.
    await AccessCredentialModel.updateOne({credentialId}, {$set: {name: ""}})
    expect(await validateCredentialToken(token)).toMatchObject({label: `credential:${credentialId}`})
  })

  test("lastUsedAt is written when null or older than a minute, and not more often", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    const lastUsed = async () =>
      (await AccessCredentialModel.findOne({credentialId: credential.credentialId}).lean())!.lastUsedAt
    const updateOne = spyOn(AccessCredentialModel, "updateOne")
    try {
      await validateCredentialToken(token)
      expect(updateOne).toHaveBeenCalledTimes(1)
      await waitFor(async () => (await lastUsed()) !== null)
      const first = (await lastUsed())!

      // Used a moment ago: no write.
      await validateCredentialToken(token)
      await validateCredentialToken(token)
      expect(updateOne).toHaveBeenCalledTimes(1)
      expect((await lastUsed())!.getTime()).toBe(first.getTime())

      // Used long ago: written again.
      const stale = new Date(Date.now() - 120_000)
      await AccessCredentialModel.updateOne({credentialId: credential.credentialId}, {$set: {lastUsedAt: stale}})
      updateOne.mockClear()
      await validateCredentialToken(token)
      expect(updateOne).toHaveBeenCalledTimes(1)
      await waitFor(async () => (await lastUsed())!.getTime() > stale.getTime())

      // An invalid token never touches lastUsedAt.
      updateOne.mockClear()
      await validateCredentialToken(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)
      expect(updateOne).not.toHaveBeenCalled()
    } finally {
      updateOne.mockRestore()
    }
  })

  test("the lastUsedAt write is atomic: it never overwrites a use another request recorded in between", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    const lastUsed = async () =>
      (await AccessCredentialModel.findOne({credentialId: credential.credentialId}).lean())!.lastUsedAt
    const concurrent = new Date(Date.now() - 1000)
    const original = AccessCredentialModel.updateOne.bind(AccessCredentialModel)
    let writes = 0
    const updateOne = spyOn(AccessCredentialModel, "updateOne").mockImplementation(((...args: [any, any, any]) => {
      writes += 1
      // Another request records this key's use after this one decided to, and before its write lands.
      return AccessCredentialModel.collection
        .updateOne({credentialId: credential.credentialId}, {$set: {lastUsedAt: concurrent}})
        .then(() => original(...args))
    }) as never)
    try {
      expect(await validateCredentialToken(token)).not.toBeNull()
      await waitFor(async () => writes === 1)
      await new Promise(resolve => setTimeout(resolve, 100))
      // The guarded write found a use within the last minute and changed nothing.
      expect((await lastUsed())!.getTime()).toBe(concurrent.getTime())
    } finally {
      updateOne.mockRestore()
    }
  })

  test("a failing lastUsedAt write does not fail validation or leak a rejection", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    const updateOne = spyOn(AccessCredentialModel, "updateOne").mockImplementation((() =>
      Promise.reject(new Error("write failed"))) as never)
    try {
      expect(await validateCredentialToken(token)).not.toBeNull()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(updateOne).toHaveBeenCalledTimes(1)
    } finally {
      updateOne.mockRestore()
    }
  })

  test("a lastUsedAt write does not touch updatedAt or open a transaction", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    const before = (await AccessCredentialModel.findOne({credentialId: credential.credentialId}).lean())!

    const startSession = spyOn(AccessCredentialModel.db, "startSession")
    try {
      await validateCredentialToken(token)
      await waitFor(
        async () =>
          (await AccessCredentialModel.findOne({credentialId: credential.credentialId}).lean())!.lastUsedAt !== null,
      )
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      startSession.mockRestore()
    }
    const after = (await AccessCredentialModel.findOne({credentialId: credential.credentialId}).lean())!
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
  })
})

describe("mintServiceCredential", () => {
  test("records the service and the staff member, has no membership, and audits as the service", async () => {
    const {workspaceId} = await newWorkspace()
    const before = await revisionOf(workspaceId)

    const {credential, token} = await mintServiceCredential("store", {
      workspaceId,
      name: "Publish com.acme.app",
      packageNames: ["com.acme.app"],
      actorEmail: "staff@example.test",
    })

    expect(credential).toMatchObject({
      prefix: "msk",
      workspaceId,
      scopes: ["miniapps.publish"],
      packageNames: ["com.acme.app"],
      createdByEmail: "staff@example.test",
      issuedByService: "store",
      expiresAt: null,
    })
    expect(await AccessCredentialModel.findOne({credentialId: credential.credentialId}).lean()).toMatchObject({
      credentialKind: "workspace",
      createdByMembershipId: null,
      createdByMentraUserId: null,
      issuedByService: "store",
      hash: sha256Hex(parse(token).secret),
    })
    expect(await revisionOf(workspaceId)).toBe(before)

    const events = (await listWorkspaceAudit(workspaceId, {limit: 50})).filter(e => e.action === "credential.created")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      workspaceId,
      actor: {kind: "service", service: "store", email: "staff@example.test"},
      target: {credentialId: credential.credentialId, prefix: "msk", workspaceId},
    })
    expect(JSON.stringify(events[0])).not.toContain(parse(token).secret)
  })

  test("validates its inputs and the workspace", async () => {
    const {workspaceId, owner} = await newWorkspace()
    const input = {workspaceId, name: "k", packageNames: ["com.acme.app"], actorEmail: "staff@example.test"}

    await expectError(() => mintServiceCredential("", input), "invalid_request", 400)
    await expectError(() => mintServiceCredential("  ", input), "invalid_request", 400)
    await expectError(() => mintServiceCredential(undefined as unknown as string, input), "invalid_request", 400)
    await expectError(() => mintServiceCredential("store", {...input, packageNames: []}), "invalid_request", 400)
    await expectError(
      () => mintServiceCredential("store", {...input, packageNames: ["Not A Package"]}),
      "invalid_request",
      400,
    )
    await expectError(() => mintServiceCredential("store", {...input, name: " "}), "invalid_request", 400)
    await expectError(() => mintServiceCredential("store", {...input, actorEmail: ""}), "invalid_request", 400)
    await expectError(() => mintServiceCredential("store", {...input, workspaceId: "ws_missing"}), "not_found", 404)
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)

    await deleteWorkspace(owner, workspaceId, {confirmName: "Acme", ownedPackageCount: async () => 0})
    await expectError(() => mintServiceCredential("store", input), "workspace_deleted", 410)
  })
})

describe("createOperatorKey", () => {
  test("an organization admin gets a mak_ key that validates with exactly its scopes", async () => {
    const {credential, token} = await createOperatorKey(orgAdmin, {
      name: "Incident reader",
      scopes: ["organization.incidents.read", "organization.testing.read"],
    })

    const parts = parse(token)
    expect(parts).toMatchObject({prefix: "mak", env: "local", credentialId: credential.credentialId})
    expect(credential).toEqual({
      credentialId: parts.credentialId,
      prefix: "mak",
      name: "Incident reader",
      display: `mak_local_…${parts.secret.slice(-4)}`,
      workspaceId: null,
      scopes: ["organization.incidents.read", "organization.testing.read"],
      packageNames: [],
      createdByEmail: ADMIN_EMAIL,
      issuedByService: null,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: expect.any(String),
    })
    expect(await AccessCredentialModel.findOne({credentialId: parts.credentialId}).lean()).toMatchObject({
      prefix: "mak",
      credentialKind: "organization",
      workspaceId: null,
      hash: sha256Hex(parts.secret),
      createdByMentraUserId: "mu_org_admin",
      createdByEmail: ADMIN_EMAIL,
      createdByMembershipId: null,
      issuedByService: null,
    })

    expect(await validateCredentialToken(token)).toEqual({
      kind: "credential",
      credentialId: parts.credentialId,
      credentialKind: "organization",
      workspaceId: null,
      scopes: ["organization.incidents.read", "organization.testing.read"],
      packageNames: [],
      label: "Incident reader",
    })
  })

  test("audits with no workspace and never the token", async () => {
    const {credential, token} = await createOperatorKey(orgAdmin, {
      name: "ops",
      scopes: ["organization.incidents.read"],
    })

    const events = await WorkspaceAuditEventModel.find({action: "credential.created"}).lean()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      workspaceId: null,
      actor: {kind: "user", mentraUserId: "mu_org_admin", email: ADMIN_EMAIL},
      target: {credentialId: credential.credentialId, prefix: "mak"},
    })
    const {secret} = parse(token)
    expect(JSON.stringify(events[0])).not.toContain(secret)
    expect(JSON.stringify(events[0])).not.toContain(sha256Hex(secret))
  })

  test("stops validating immediately once the creator's email leaves the admin allowlist", async () => {
    const {token} = await createOperatorKey(orgAdmin, {name: "ops", scopes: ["organization.incidents.read"]})
    expect(await validateCredentialToken(token)).not.toBeNull()

    process.env.CLOUD_CORE_ADMIN_EMAILS = "someone-else@example.test"
    expect(await validateCredentialToken(token)).toBeNull()

    // Nothing was cached or revoked: restoring the allowlist restores the key.
    process.env.CLOUD_CORE_ADMIN_EMAILS = ADMIN_EMAIL
    expect(await validateCredentialToken(token)).not.toBeNull()

    // A listed domain counts too.
    process.env.CLOUD_CORE_ADMIN_EMAILS = ""
    process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "example.test"
    expect(await validateCredentialToken(token)).not.toBeNull()
    delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
    expect(await validateCredentialToken(token)).toBeNull()
  })

  test("rejects non-admins and non-user actors", async () => {
    const input = {name: "ops", scopes: ["organization.incidents.read"] as const}
    await expectError(() => createOperatorKey(user("mu_dev"), {...input, scopes: [...input.scopes]}), "forbidden", 403)
    await expectError(
      () => createOperatorKey(system as UserActor, {...input, scopes: [...input.scopes]}),
      "forbidden",
      403,
    )
    await expectError(
      () => createOperatorKey(service as UserActor, {...input, scopes: [...input.scopes]}),
      "forbidden",
      403,
    )
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })

  test("an admin without an email cannot mint a key that could never validate", async () => {
    await expectError(
      () =>
        createOperatorKey(user("mu_noemail", {isOrganizationAdmin: true, email: null}), {
          name: "ops",
          scopes: ["organization.incidents.read"],
        }),
      "invalid_request",
      400,
    )
  })

  test("scopes must be a non-empty subset of the operator scopes: no workspace administration", async () => {
    const create = (scopes: string[]) =>
      createOperatorKey(orgAdmin, {name: "ops", scopes: scopes as Parameters<typeof createOperatorKey>[1]["scopes"]})

    await expectError(() => create(["organization.workspaces.administer"]), "invalid_request", 400)
    await expectError(
      () => create(["organization.incidents.read", "organization.workspaces.administer"]),
      "invalid_request",
      400,
    )
    await expectError(() => create(["organization.credentials.manage"]), "invalid_request", 400)
    await expectError(() => create(["miniapps.publish"]), "invalid_request", 400)
    await expectError(() => create([]), "invalid_request", 400)
    await expectError(() => create("organization.incidents.read" as unknown as string[]), "invalid_request", 400)
    await expectError(
      () => createOperatorKey(orgAdmin, {name: " ", scopes: ["organization.incidents.read"]}),
      "invalid_request",
      400,
    )
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)

    const {credential} = await create([
      "organization.testing.manage",
      "organization.testing.manage",
      "organization.supportProfiles.read",
    ])
    expect(credential.scopes).toEqual(["organization.testing.manage", "organization.supportProfiles.read"])
  })

  test("expiry must be in the future and is enforced", async () => {
    await expectError(
      () =>
        createOperatorKey(orgAdmin, {
          name: "ops",
          scopes: ["organization.incidents.read"],
          expiresAt: new Date(Date.now() - 1000),
        }),
      "invalid_request",
      400,
    )
    const expiresAt = new Date(Date.now() + 3_600_000)
    const {credential, token} = await createOperatorKey(orgAdmin, {
      name: "ops",
      scopes: ["organization.incidents.read"],
      expiresAt,
    })
    expect(credential.expiresAt).toBe(expiresAt.toISOString())
    expect(await validateCredentialToken(token)).not.toBeNull()
    await AccessCredentialModel.updateOne(
      {credentialId: credential.credentialId},
      {$set: {expiresAt: new Date(Date.now() - 1)}},
    )
    expect(await validateCredentialToken(token)).toBeNull()
  })

  test("a row whose credential kind does not match its prefix is invalid", async () => {
    const {workspaceId} = await newWorkspace()
    const mislabelled = await seedKey({
      prefix: "mak",
      credentialKind: "workspace",
      workspaceId,
      createdByEmail: ADMIN_EMAIL,
      scopes: ["organization.incidents.read"],
    })
    expect(await validateCredentialToken(mislabelled.token)).toBeNull()
    const other = await seedKey({
      prefix: "msk",
      credentialKind: "organization",
      issuedByService: "store",
      packageNames: ["com.a.b"],
    })
    expect(await validateCredentialToken(other.token)).toBeNull()
  })
})

describe("revokeCredential", () => {
  test("a developer revokes their own key; another developer cannot", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const second = user("mu_second_dev")
    await addMember(workspaceId, second.mentraUserId, "developer")
    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})

    await expectError(() => revokeCredential(second, credential.credentialId), "forbidden", 403)
    expect(await validateCredentialToken(token)).not.toBeNull()

    const before = await revisionOf(workspaceId)
    await revokeCredential(developer, credential.credentialId)

    expect(await validateCredentialToken(token)).toBeNull()
    expect(await AccessCredentialModel.findOne({credentialId: credential.credentialId}).lean()).toMatchObject({
      revokedAt: expect.any(Date),
    })
    expect(await revisionOf(workspaceId)).toBe(before)
  })

  test("a pending role change keeps its expected revision across a key mint, a service mint and a revoke", async () => {
    const {workspaceId, owner, developer, member} = await newWorkspace()
    const revision = await revisionOf(workspaceId)

    const {credential} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    await mintServiceCredential("store", {
      workspaceId,
      name: "Publish com.acme.app",
      packageNames: ["com.acme.app"],
      actorEmail: "staff@example.test",
    })
    await revokeCredential(developer, credential.credentialId)

    const memberId = await membershipIdOf(workspaceId, member.mentraUserId)
    await changeRole(owner, workspaceId, memberId, "developer", revision)
    expect((await getActiveMembership(workspaceId, member.mentraUserId))?.role).toBe("developer")
  })

  test("admins, owners and organization admins can revoke any workspace key; members and strangers cannot", async () => {
    const {workspaceId, owner, admin, developer, member} = await newWorkspace()
    const make = async () =>
      (await createWorkspaceCredential(developer, workspaceId, {name: "k"})).credential.credentialId

    for (const actor of [admin, owner, orgAdmin, system]) {
      const credentialId = await make()
      await revokeCredential(actor, credentialId)
      expect(await AccessCredentialModel.findOne({credentialId}).lean()).toMatchObject({revokedAt: expect.any(Date)})
    }

    const keep = await make()
    for (const actor of [member, user("mu_stranger"), service]) {
      await expectError(() => revokeCredential(actor, keep), "forbidden", 403)
    }
    expect(await AccessCredentialModel.findOne({credentialId: keep}).lean()).toMatchObject({revokedAt: null})
  })

  test("an admin can revoke a service-issued key; a developer cannot", async () => {
    const {workspaceId, admin, developer} = await newWorkspace()
    const {credential} = await mintServiceCredential("store", {
      workspaceId,
      name: "k",
      packageNames: ["com.acme.app"],
      actorEmail: "staff@example.test",
    })

    await expectError(() => revokeCredential(developer, credential.credentialId), "forbidden", 403)
    await revokeCredential(admin, credential.credentialId)
    expect(await AccessCredentialModel.findOne({credentialId: credential.credentialId}).lean()).toMatchObject({
      revokedAt: expect.any(Date),
    })
  })

  test("a creator who was demoted below developer can no longer revoke their own key", async () => {
    const {workspaceId, owner, developer} = await newWorkspace()
    const {credential} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    await changeRole(
      owner,
      workspaceId,
      await membershipIdOf(workspaceId, "mu_developer"),
      "member",
      await revisionOf(workspaceId),
    )

    await expectError(() => revokeCredential(developer, credential.credentialId), "forbidden", 403)
    await revokeCredential(owner, credential.credentialId)
  })

  test("audits credential.revoked once, and revoking again is a quiet no-op", async () => {
    const {workspaceId, admin, developer} = await newWorkspace()
    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})

    await revokeCredential(admin, credential.credentialId)
    const revision = await revisionOf(workspaceId)
    await revokeCredential(admin, credential.credentialId)

    expect(await revisionOf(workspaceId)).toBe(revision)
    const events = (await listWorkspaceAudit(workspaceId, {limit: 50})).filter(e => e.action === "credential.revoked")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      workspaceId,
      actor: {kind: "user", mentraUserId: "mu_admin"},
      target: {credentialId: credential.credentialId, prefix: "msk", workspaceId},
    })
    expect(JSON.stringify(events[0])).not.toContain(parse(token).secret)
  })

  test("an unknown credential is not_found", async () => {
    await expectError(() => revokeCredential(orgAdmin, ulid()), "not_found", 404)
    await expectError(() => revokeCredential(orgAdmin, ""), "not_found", 404)
    await expectError(() => revokeCredential(orgAdmin, {$ne: null} as unknown as string), "not_found", 404)
  })

  test("a deleted workspace's key can no longer be revoked: deletion already did", async () => {
    const {workspaceId, owner, developer} = await newWorkspace()
    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    await deleteWorkspace(owner, workspaceId, {confirmName: "Acme", ownedPackageCount: async () => 0})

    expect(await validateCredentialToken(token)).toBeNull()
    await expectError(() => revokeCredential(owner, credential.credentialId), "workspace_deleted", 410)
  })

  test("operator keys are revoked by organization admins only, with no workspace on the event", async () => {
    const {workspaceId, owner} = await newWorkspace()
    const {credential, token} = await createOperatorKey(orgAdmin, {
      name: "ops",
      scopes: ["organization.incidents.read"],
    })

    // Workspace owners and operators' own non-admin selves have no say over organization keys.
    await expectError(() => revokeCredential(owner, credential.credentialId), "forbidden", 403)
    await expectError(
      () => revokeCredential(user("mu_dev", {isOrganizationAdmin: false}), credential.credentialId),
      "forbidden",
      403,
    )
    await expectError(() => revokeCredential(service, credential.credentialId), "forbidden", 403)
    expect(await validateCredentialToken(token)).not.toBeNull()

    const revision = await revisionOf(workspaceId)
    await revokeCredential(orgAdmin, credential.credentialId)

    expect(await validateCredentialToken(token)).toBeNull()
    expect(await revisionOf(workspaceId)).toBe(revision)
    const events = await WorkspaceAuditEventModel.find({action: "credential.revoked"}).lean()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      workspaceId: null,
      actor: {kind: "user", mentraUserId: "mu_org_admin"},
      target: {credentialId: credential.credentialId, prefix: "mak"},
    })

    // Revoking again changes nothing.
    await revokeCredential(orgAdmin, credential.credentialId)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "credential.revoked"})).toBe(1)
  })
})

describe("listing", () => {
  test("listWorkspaceCredentials lists live keys, newest first, without secrets", async () => {
    const {workspaceId, developer, admin} = await newWorkspace()
    const first = await createWorkspaceCredential(developer, workspaceId, {name: "first"})
    const second = await createWorkspaceCredential(admin, workspaceId, {name: "second", packageNames: ["com.acme.app"]})
    const revoked = await createWorkspaceCredential(developer, workspaceId, {name: "revoked"})
    await revokeCredential(developer, revoked.credential.credentialId)
    const elsewhere = await createWorkspace(user("mu_other"), {name: "Other"})
    await createWorkspaceCredential(user("mu_other"), elsewhere.workspaceId, {name: "elsewhere"})
    await createOperatorKey(orgAdmin, {name: "ops", scopes: ["organization.incidents.read"]})

    const listed = await listWorkspaceCredentials(workspaceId)

    expect(listed.map(view => view.name)).toEqual(["second", "first"])
    expect(listed[0]).toEqual(second.credential)
    expect(listed[1]).toEqual(first.credential)
    const serialized = JSON.stringify(listed)
    for (const {token} of [first, second, revoked]) {
      expect(serialized).not.toContain(parse(token).secret)
      expect(serialized).not.toContain(sha256Hex(parse(token).secret))
    }
    expect(serialized).not.toContain("hash")
    expect(await listWorkspaceCredentials("ws_missing")).toEqual([])
    expect(await listWorkspaceCredentials("")).toEqual([])
  })

  test("listing orders by creation time, then id: a backdated key sorts by its own createdAt, not its insertion order", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const inserted = []
    for (const name of ["a", "b", "c"]) inserted.push(await createWorkspaceCredential(developer, workspaceId, {name}))
    // "b" was inserted after "a" but created (as a migrated key may claim) the longest ago; "a" and "c" tie
    // on createdAt, so insertion order (the id) breaks the tie, newest first.
    const created = new Date("2026-01-01T00:00:00.000Z")
    const [a, b, c] = inserted.map(entry => entry.credential.credentialId)
    const later = new Date(created.getTime() + 60_000)
    await AccessCredentialModel.collection.updateOne({credentialId: a}, {$set: {createdAt: later}})
    await AccessCredentialModel.collection.updateOne({credentialId: b}, {$set: {createdAt: created}})
    await AccessCredentialModel.collection.updateOne({credentialId: c}, {$set: {createdAt: later}})

    expect((await listWorkspaceCredentials(workspaceId)).map(view => view.name)).toEqual(["c", "a", "b"])

    const keys = []
    for (const name of ["ops-a", "ops-b"]) {
      keys.push(await createOperatorKey(orgAdmin, {name, scopes: ["organization.incidents.read"]}))
    }
    await AccessCredentialModel.collection.updateOne(
      {credentialId: keys[1]!.credential.credentialId},
      {$set: {createdAt: created}},
    )
    expect((await listOperatorKeys()).map(view => view.name)).toEqual(["ops-a", "ops-b"])
  })

  test("listWorkspaceCredentials can be limited to the keys one membership created", async () => {
    const {workspaceId, developer, admin} = await newWorkspace()
    const mine = await createWorkspaceCredential(developer, workspaceId, {name: "mine"})
    await createWorkspaceCredential(admin, workspaceId, {name: "theirs"})
    await mintServiceCredential("store", {
      workspaceId,
      name: "Publish com.acme.app",
      packageNames: ["com.acme.app"],
      actorEmail: "staff@example.test",
    })

    const own = await listWorkspaceCredentials(workspaceId, {
      createdByMembershipId: await membershipIdOf(workspaceId, developer.mentraUserId),
    })

    expect(own).toEqual([mine.credential])
    expect(await listWorkspaceCredentials(workspaceId, {createdByMembershipId: null})).toEqual([])
  })

  test("listWorkspaceCredentials shows lastUsedAt once the key has been used", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {credential, token} = await createWorkspaceCredential(developer, workspaceId, {name: "k"})
    await validateCredentialToken(token)
    await waitFor(async () => (await listWorkspaceCredentials(workspaceId))[0]!.lastUsedAt !== null)
    const [view] = await listWorkspaceCredentials(workspaceId)
    expect(view!.credentialId).toBe(credential.credentialId)
    expect(new Date(view!.lastUsedAt!).getTime()).toBeLessThanOrEqual(Date.now())
  })

  test("listOperatorKeys lists live operator keys only", async () => {
    const {workspaceId, developer} = await newWorkspace()
    await createWorkspaceCredential(developer, workspaceId, {name: "workspace key"})
    const keep = await createOperatorKey(orgAdmin, {name: "keep", scopes: ["organization.incidents.read"]})
    const gone = await createOperatorKey(orgAdmin, {name: "gone", scopes: ["organization.testing.read"]})
    await revokeCredential(orgAdmin, gone.credential.credentialId)

    const listed = await listOperatorKeys()

    expect(listed).toEqual([keep.credential])
    const serialized = JSON.stringify(listed)
    expect(serialized).not.toContain(parse(keep.token).secret)
    expect(serialized).not.toContain("hash")
  })
})

describe("isCredentialToken", () => {
  test("claims every msk_ and mak_ bearer, valid or not, and nothing else", () => {
    const valid = `msk_local_${ulid()}.${"A".repeat(43)}`
    for (const token of [valid, valid.replace("msk_", "mak_"), "msk_garbage", "mak_", "msk_local_x.y"]) {
      expect({token, claimed: isCredentialToken(token)}).toEqual({token, claimed: true})
    }
    for (const token of ["", "eyJhbGciOi.payload.signature", "Bearer msk_x", "xmsk_x", "msk", "MSK_x", "mskx_y"]) {
      expect({token, claimed: isCredentialToken(token)}).toEqual({token, claimed: false})
    }
    for (const notAString of [undefined, null, 42, {}]) expect(isCredentialToken(notAString)).toBe(false)
  })
})

/**
 * Starts Core against a real database the way a deployment does. CI uses it to
 * check that Core installs and upgrades on Azure Cosmos DB, which Private Cloud
 * uses (see the `cosmos-upgrade` job in .github/workflows/cloud-v2-validation.yml).
 *
 *   bun database-upgrade-check.ts start <cloud-v2 checkout> <mongo url>
 *     Start that checkout's Core, startup migrations and indexes included,
 *     require /ready, then stop it. Core logs a collection or index its
 *     database refuses and carries on, so /ready alone proves little about them.
 *   bun database-upgrade-check.ts verify <mongo url>
 *     Require what the current Core builds at startup that a database can
 *     refuse (REQUIRED below), then delete a throwaway account the way Core does
 *     and require its `user.deleted` tombstone on the change feed (see
 *     `verifyAccountDeletion`). Run it after `start` of the current checkout, on
 *     a fresh and on an upgraded database; not after a base branch's `start`.
 *   bun database-upgrade-check.ts seed <mongo url>
 *     Put one document in every empty collection, so the next start meets
 *     populated collections, as an upgrade of a running deployment does.
 *   bun database-upgrade-check.ts drop <mongo url>
 *   bun database-upgrade-check.ts sweep <mongo url>
 *     Drop this database, or every `ci-<epoch seconds>-…` database older than six hours.
 */

import {randomUUID} from "node:crypto"
import {join, resolve} from "node:path"
import {pathToFileURL} from "node:url"
import mongoose from "mongoose"

const SWEEP_AGE_MS = 6 * 60 * 60 * 1000

/**
 * What Core's startup must have built, though it only logs a failure to: the change feed's counter
 * collection, and the plain (not unique: a unique index cannot be added to a populated collection)
 * index on `workspace_audit_events.seq` that the feed sorts and pages by. Azure Cosmos DB for MongoDB
 * (RU) needs that index to sort at all.
 */
const REQUIRED = {
  collections: ["workspace_audit_counters"],
  indexes: [{collection: "workspace_audit_events", key: {seq: 1}}],
}

interface CoreModule {
  startCore(options: {port: number; mongoUrl: string}): Promise<{url: string; stop(): Promise<void>}>
}

async function start(checkout: string, mongoUrl: string): Promise<void> {
  const entry = pathToFileURL(join(resolve(checkout), "packages/core/src/index.ts")).href
  const {startCore} = (await import(entry)) as CoreModule
  const core = await startCore({port: 0, mongoUrl})
  try {
    const response = await fetch(`${core.url}/ready`)
    const body = await response.text()
    if (!response.ok) throw new Error(`Core /ready answered ${response.status}: ${body}`)
    console.log(`Core from ${checkout} is ready: ${body}`)
  } finally {
    await core.stop()
  }
}

async function withDatabase(mongoUrl: string, run: (db: mongoose.mongo.Db) => Promise<void>): Promise<void> {
  const connection = await mongoose.createConnection(mongoUrl, {serverSelectionTimeoutMS: 30_000}).asPromise()
  try {
    await run(connection.db!)
  } finally {
    await connection.close()
  }
}

async function verifySchema(db: mongoose.mongo.Db): Promise<void> {
  const problems: string[] = []
  const existing = new Set((await db.listCollections({}, {nameOnly: true}).toArray()).map(({name}) => name))
  for (const name of REQUIRED.collections) {
    if (!existing.has(name)) problems.push(`collection ${name} does not exist`)
  }
  for (const {collection, key} of REQUIRED.indexes) {
    const indexes = existing.has(collection) ? await db.collection(collection).indexes() : []
    const found = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key))
    if (!found) problems.push(`${collection} has no index on ${JSON.stringify(key)}`)
    else if (found.unique) problems.push(`${collection}'s index on ${JSON.stringify(key)} is unique`)
  }
  if (problems.length > 0) {
    throw new Error(
      `Core started on ${db.databaseName}, but its startup did not build what it needs: ${problems.join("; ")}. ` +
        "Core logs a refused collection or index (\"failed to create workspace collection indexes\") and keeps going, " +
        "so look for that line in the log above. The database probably refused it.",
    )
  }
  console.log(`${db.databaseName} has ${REQUIRED.collections.join(", ")} and an index on ${REQUIRED.indexes.map(i => `${i.collection}${JSON.stringify(i.key)}`).join(", ")}`)
}

/**
 * Delete a throwaway account the way Core does, on this database, and require its `user.deleted` tombstone.
 *
 * The tombstone is what tells a service that keeps data about a person (Fleet) to delete it, so an account
 * deletion that cannot record one must fail loudly here, not in production. Azure Cosmos DB for MongoDB
 * commits a transaction within one collection and fails one across two, and the tombstone's transaction
 * touches the feed's counter and its events: there, `removeDeletedUserFromWorkspaces` recognizes the refusal
 * and records the tombstone without a transaction, a path no test could run against Cosmos itself. On a
 * replica set the same call takes the transactional path. Either way the feed must end with exactly one
 * `user.deleted` event for the person, carrying a numeric `seq`.
 *
 * The person is a real `users` row (what account deletion acts on); they belong to no workspace, so the
 * tombstone is the whole of their deletion, as it is for most accounts. The row and the event are removed
 * afterwards, so a database that is kept (a local one) is left as it was, but for one step of the feed's
 * counter; `seq` numbers may skip, which the feed allows.
 */
async function verifyAccountDeletion(mongoUrl: string): Promise<void> {
  // Core's own modules, loaded here and one after the other: `start` loads another checkout's Core, which
  // `verify` must not touch, and the logger every one of them imports has a top-level await, so importing
  // them at once races it.
  const {findOrCreateUser} = await import("../services/user.service")
  const {UserModel} = await import("../models/user.model")
  const {WorkspaceAuditEventModel} = await import("../models/workspace-audit-event.model")
  const {removeDeletedUserFromWorkspaces} = await import("../services/workspaces/account-deletion.service")
  const {USER_DELETED_ACTION} = await import("@mentra/workspace-contract")

  // No index or collection building: `start` built what the database accepts, and a model's own attempt to
  // create the rest on connect is not what is under test (and a refused one must not change this run).
  await mongoose.connect(mongoUrl, {serverSelectionTimeoutMS: 30_000, autoIndex: false, autoCreate: false})
  const database = mongoose.connection.name
  let mentraUserId: string | null = null
  try {
    const user = await findOrCreateUser({tenantId: "database-upgrade-check", tenantUserId: `check-${randomUUID()}`})
    mentraUserId = user.mentraUserId
    const tombstones = () =>
      WorkspaceAuditEventModel.find({
        workspaceId: null,
        action: USER_DELETED_ACTION,
        "target.mentraUserId": mentraUserId,
      }).lean()

    try {
      await removeDeletedUserFromWorkspaces(mentraUserId)
    } catch (error) {
      throw new Error(
        `Deleting a throwaway account on ${database} failed instead of recording its user.deleted tombstone: ` +
          `${error instanceof Error ? error.message : String(error)}. Account deletion must work on every database ` +
          "a deployment uses; a Private Cloud on Azure Cosmos DB for MongoDB cannot run a transaction across collections.",
        {cause: error},
      )
    }

    const events = await tombstones()
    const seqs = events.map(event => event.seq)
    if (events.length !== 1) {
      throw new Error(
        `Deleting a throwaway account on ${database} recorded ${events.length} user.deleted events for it; ` +
          "exactly one is required, or a service that keeps data about the person is never told to delete it (or is told twice).",
      )
    }
    if (typeof seqs[0] !== "number" || !Number.isFinite(seqs[0])) {
      throw new Error(
        `The user.deleted event for a deleted throwaway account on ${database} has no numeric seq (${JSON.stringify(seqs[0])}); ` +
          "the change feed only serves events that have one, so a service would never see it.",
      )
    }
    console.log(`${database}: deleting an account recorded one user.deleted event, seq ${seqs[0]}`)
  } finally {
    // Whatever happened, leave neither the throwaway person nor an event naming them behind.
    if (mentraUserId) {
      await WorkspaceAuditEventModel.deleteMany({
        workspaceId: null,
        action: USER_DELETED_ACTION,
        "target.mentraUserId": mentraUserId,
      }).catch(error => console.error(`could not remove the throwaway account's tombstone: ${error}`))
      await UserModel.deleteOne({mentraUserId}).catch(error =>
        console.error(`could not remove the throwaway account ${mentraUserId}: ${error}`),
      )
    }
    await mongoose.disconnect()
  }
}

async function verify(mongoUrl: string): Promise<void> {
  await withDatabase(mongoUrl, verifySchema)
  await verifyAccountDeletion(mongoUrl)
}

async function seed(db: mongoose.mongo.Db): Promise<void> {
  for (const {name} of await db.listCollections({}, {nameOnly: true}).toArray()) {
    if (name.startsWith("system.")) continue
    const collection = db.collection(name)
    if (await collection.countDocuments({}, {limit: 1})) continue
    await collection.insertOne({ciUpgradeSeed: true})
    console.log(`seeded ${name}`)
  }
}

async function sweep(db: mongoose.mongo.Db): Promise<void> {
  const {databases} = await db.admin().listDatabases({nameOnly: true})
  for (const {name} of databases as Array<{name: string}>) {
    const created = Number(/^ci-(\d+)-/.exec(name)?.[1]) * 1000
    if (!created || Date.now() - created < SWEEP_AGE_MS) continue
    await db.client.db(name).dropDatabase()
    console.log(`dropped stale ${name}`)
  }
}

const [command, ...args] = process.argv.slice(2)
try {
  if (command === "start" && args.length === 2) await start(args[0]!, args[1]!)
  else if (command === "verify" && args.length === 1) await verify(args[0]!)
  else if (command === "seed" && args.length === 1) await withDatabase(args[0]!, seed)
  else if (command === "drop" && args.length === 1) await withDatabase(args[0]!, db => db.dropDatabase().then(() => {}))
  else if (command === "sweep" && args.length === 1) await withDatabase(args[0]!, sweep)
  else throw new Error("usage: database-upgrade-check.ts start <cloud-v2 checkout> <mongo url> | verify|seed|drop|sweep <mongo url>")
  // Core's background timers and driver sockets would keep the process alive.
  process.exit(0)
} catch (error) {
  console.error(error)
  process.exit(1)
}

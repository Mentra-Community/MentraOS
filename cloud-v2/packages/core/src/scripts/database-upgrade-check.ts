/**
 * Starts Core against a real database the way a deployment does. CI uses it to
 * check that Core installs and upgrades on Azure Cosmos DB, which Private Cloud
 * uses (see the `cosmos-upgrade` job in .github/workflows/cloud-v2-validation.yml).
 *
 *   bun database-upgrade-check.ts start <cloud-v2 checkout> <mongo url>
 *     Start that checkout's Core, startup migrations and indexes included,
 *     require /ready, then stop it.
 *   bun database-upgrade-check.ts seed <mongo url>
 *     Put one document in every empty collection, so the next start meets
 *     populated collections, as an upgrade of a running deployment does.
 *   bun database-upgrade-check.ts drop <mongo url>
 *   bun database-upgrade-check.ts sweep <mongo url>
 *     Drop this database, or every `ci-<epoch seconds>-…` database older than six hours.
 */

import {join, resolve} from "node:path"
import {pathToFileURL} from "node:url"
import mongoose from "mongoose"

const SWEEP_AGE_MS = 6 * 60 * 60 * 1000

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
  else if (command === "seed" && args.length === 1) await withDatabase(args[0]!, seed)
  else if (command === "drop" && args.length === 1) await withDatabase(args[0]!, db => db.dropDatabase().then(() => {}))
  else if (command === "sweep" && args.length === 1) await withDatabase(args[0]!, sweep)
  else throw new Error("usage: database-upgrade-check.ts start <cloud-v2 checkout> <mongo url> | seed|drop|sweep <mongo url>")
  // Core's background timers and driver sockets would keep the process alive.
  process.exit(0)
} catch (error) {
  console.error(error)
  process.exit(1)
}

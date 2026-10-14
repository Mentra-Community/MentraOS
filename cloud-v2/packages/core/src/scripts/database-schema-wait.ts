/**
 * @fileoverview Wait for a database to finish building the collections and indexes Core's startup
 * asked of it, then say what is still missing.
 *
 * Azure Cosmos DB for MongoDB builds an index in the background: `createIndex` answers, Core reports
 * ready, and `listIndexes` does not show the index until the build completes, a second or more later.
 * A check that lists indexes right after startup therefore fails on a database that is only slow, so
 * `database-upgrade-check.ts verify` polls (every {@link SCHEMA_POLL_INTERVAL_MS}, for at most
 * {@link SCHEMA_WAIT_TIMEOUT_MS}) and fails on what is still missing at the deadline. An index that
 * exists but is unique is not slow, it is wrong, and no wait turns it plain: that fails at once.
 */

/** How often to look again for what is not built yet. */
export const SCHEMA_POLL_INTERVAL_MS = 2_000
/** How long to wait for a missing collection or index before failing on it. */
export const SCHEMA_WAIT_TIMEOUT_MS = 120_000

export interface RequiredSchema {
  collections: readonly string[]
  /** Plain (not unique) indexes on exactly this key. */
  indexes: ReadonlyArray<{collection: string; key: Record<string, 1 | -1>}>
}

/** What the database lists right now: the collections that exist and the indexes that are built. */
export interface SchemaReader {
  collectionNames(): Promise<string[]>
  indexes(collection: string): Promise<Array<{key: Record<string, unknown>; unique?: boolean}>>
}

export interface WaitForSchemaOptions {
  /** Names the database in messages. */
  label: string
  intervalMs?: number
  timeoutMs?: number
  /** Replaceable so a test need not wait. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (message: string) => void
}

interface Findings {
  /** Not there (yet): the collection or index is not listed. A slow build looks like this. */
  missing: string[]
  /** There, but unique. No wait fixes it. */
  unique: string[]
}

async function look(reader: SchemaReader, required: RequiredSchema): Promise<Findings> {
  const existing = new Set(await reader.collectionNames())
  const missing: string[] = []
  const unique: string[] = []
  for (const name of required.collections) {
    if (!existing.has(name)) missing.push(`collection ${name} does not exist`)
  }
  for (const {collection, key} of required.indexes) {
    const indexes = existing.has(collection) ? await reader.indexes(collection) : []
    const found = indexes.find((index) => JSON.stringify(index.key) === JSON.stringify(key))
    if (!found) missing.push(`${collection} has no index on ${JSON.stringify(key)}`)
    else if (found.unique) unique.push(`${collection}'s index on ${JSON.stringify(key)} is unique`)
  }
  return {missing, unique}
}

/** Seconds, to a tenth: "0 s", "1.2 s", "120 s". */
function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`
}

/**
 * Return once every required collection and index is listed (and no required index is unique);
 * throw when one is still missing after `timeoutMs`, or as soon as one is unique.
 */
export async function waitForSchema(
  reader: SchemaReader,
  required: RequiredSchema,
  options: WaitForSchemaOptions,
): Promise<{waitedMs: number}> {
  const {label} = options
  const intervalMs = options.intervalMs ?? SCHEMA_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? SCHEMA_WAIT_TIMEOUT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const log = options.log ?? console.log
  const startedAt = now()
  const refusal =
    'Core logs a refused collection or index ("failed to create workspace collection indexes") and keeps going, ' +
    "so look for that line in the log above."

  for (let announced = false; ; announced = true) {
    const {missing, unique} = await look(reader, required)
    const waitedMs = now() - startedAt
    if (missing.length === 0 && unique.length === 0) {
      if (announced) log(`${label} built what Core needs after ${seconds(waitedMs)}`)
      return {waitedMs}
    }
    if (unique.length > 0) {
      throw new Error(
        `Core started on ${label}, but its startup did not build what it needs: ${[...unique, ...missing].join("; ")}. ` +
          `A unique index does not become a plain one by waiting, so this stopped after ${seconds(waitedMs)} ` +
          `rather than the ${seconds(timeoutMs)} it allows for a missing one. ${refusal} The database probably refused it.`,
      )
    }
    if (waitedMs >= timeoutMs) {
      throw new Error(
        `Core started on ${label}, but its startup did not build what it needs, and it was still missing after ` +
          `waiting ${seconds(waitedMs)} (looking every ${seconds(intervalMs)}; Azure Cosmos DB builds indexes in the ` +
          `background): ${missing.join("; ")}. ${refusal} The database probably refused it.`,
      )
    }
    if (!announced) {
      log(
        `${label} is not fully built yet (${missing.join("; ")}); looking every ${seconds(intervalMs)} for up to ${seconds(timeoutMs)}`,
      )
    }
    // Never sleep past the deadline: the last look is made at it.
    await sleep(Math.min(intervalMs, timeoutMs - waitedMs))
  }
}

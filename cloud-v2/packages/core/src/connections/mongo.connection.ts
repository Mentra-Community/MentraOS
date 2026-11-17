/**
 * @fileoverview MongoDB connection management for cloud-core.
 *
 * Single global Mongoose connection. Connect on boot, expose a readiness
 * check, disconnect on shutdown. Models register against `mongoose.connection`
 * implicitly via `mongoose.model(...)` in `models/*.model.ts`.
 */

import mongoose, { type ClientSession } from "mongoose";
import { createLogger, type ReadinessCheck } from "@mentra/cloud-shared";

const logger = createLogger("core").child({ component: "mongo" });

/**
 * Connect to MongoDB. Idempotent: calling twice with the same URI is a no-op.
 * Throws on initial connection failure; reconnects automatically thereafter
 * (Mongoose's built-in behavior).
 */
export async function connectMongo(uri: string): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    logger.warn("connectMongo called while already connected; ignoring");
    return;
  }

  mongoose.connection.on("connected", () => {
    logger.info("mongo connected");
  });
  mongoose.connection.on("disconnected", () => {
    logger.warn("mongo disconnected");
  });
  mongoose.connection.on("error", (err) => {
    logger.error({ err }, "mongo connection error");
  });

  await mongoose.connect(uri, {
    // Fail fast on initial connect; afterwards Mongoose auto-retries.
    serverSelectionTimeoutMS: 10_000,
    // Built below, one model at a time, instead of all at once on connect.
    autoCreate: false,
    autoIndex: false,
  });
  await buildModelCollections();
}

/** The part of a Mongoose instance `buildModelCollections` reads. */
export type ModelRegistry = {
  modelNames(): string[];
  model(name: string): {
    schema: { get(option: string): unknown };
    createCollection(): Promise<unknown>;
    createIndexes(): Promise<unknown>;
  };
};

/**
 * Build every registered model's collection and indexes, one model at a time, rather than all at once
 * on connect as Mongoose would, so startup's load on the database stays small and predictable. A model whose
 * schema turns `autoCreate` or `autoIndex` off (a collection Core only reads) is left alone. A failed build
 * is logged and does not throw: the startup migrations build the workspace models again, and decide
 * whether Core starts, as before.
 */
export async function buildModelCollections(registry: ModelRegistry = mongoose): Promise<void> {
  for (const name of registry.modelNames()) {
    const model = registry.model(name);
    try {
      if (model.schema.get("autoCreate") !== false) await model.createCollection();
      if (model.schema.get("autoIndex") !== false) await model.createIndexes();
    } catch (err) {
      logger.warn({ model: name, error: (err as Error)?.message }, "automatic collection or index build failed");
    }
  }
}

/** Close the Mongo connection. Call from graceful-shutdown handlers. */
export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}

/**
 * Readiness check for `/ready`. Considers Mongo healthy iff the driver
 * reports `connected` (readyState 1). A `ping` admin command would be more
 * thorough but adds a round-trip per probe; the driver's readyState flips
 * promptly on disconnect, which is good enough for k8s readiness.
 */
export const mongoReadinessCheck: ReadinessCheck = {
  name: "mongo",
  check: () => mongoose.connection.readyState === 1,
};

/**
 * How many `cause`s down the classifiers below look. Real chains are one or two deep (`withTransaction`
 * wraps the failure once); the cap only stops a cause that leads back to itself, which would otherwise
 * overflow the stack and hide the error being classified behind a RangeError.
 */
const MAX_CAUSE_DEPTH = 5;

/** Whether `matches` holds for `err` or any of its `cause`s, down to {@link MAX_CAUSE_DEPTH}. */
function someInCauseChain(err: unknown, matches: (candidate: Error) => boolean): boolean {
  let candidate: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (!(candidate instanceof Error)) return false;
    if (matches(candidate)) return true;
    candidate = candidate.cause;
  }
  return false;
}

/**
 * True only for the two known "this deployment cannot run transactions"
 * failures, as opposed to a failure of the work inside the transaction or of
 * the deployment (a failover, a network error, a timeout, a write conflict that
 * outlasted `withTransaction`'s retries). `withTransaction` wraps the first
 * failure in a new Error that names the requirement and keeps the original as
 * its `cause`, so the wrapper is recognized too:
 *
 * - a standalone `mongod` answers the first transactional write with
 *   `IllegalOperation` (code 20) and a message starting "Transaction numbers
 *   are only allowed on a replica set member or mongos";
 * - the driver raises `MongoCompatibilityError` ("Current topology does not
 *   support sessions") before sending anything when the topology rules
 *   sessions out.
 *
 * The first one surfaces from the callback's own write, so errors cannot be
 * told apart by where they were thrown. Matching the error name or code plus
 * the exact message prefix keeps unrelated errors from being reclassified.
 */
export function isTransactionsUnsupportedError(err: unknown): boolean {
  return someInCauseChain(err, (candidate) => {
    if ((candidate as { code?: unknown }).code === 20) {
      return /^Transaction numbers are only allowed on a replica set member or mongos/.test(candidate.message);
    }
    return (
      candidate.name === "MongoCompatibilityError" &&
      /^Current topology does not support sessions/.test(candidate.message)
    );
  });
}

/**
 * Run `fn` inside a MongoDB transaction and commit when it resolves.
 *
 * Every write that must be atomic has to pass the supplied `session`. The
 * transaction uses snapshot reads and majority writes; the driver retries
 * `fn` (and the commit) on transient transaction errors, so `fn` must be safe
 * to run more than once and must not perform external side effects.
 *
 * Transactions need a replica set (or mongos). Against a standalone `mongod`
 * this throws an Error that names that requirement instead of the server's
 * "Transaction numbers..." message.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.connection.startSession();
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    );
    return result;
  } catch (err) {
    if (isTransactionsUnsupportedError(err)) {
      throw new Error(
        "MongoDB transactions require a replica set: start mongod with --replSet (see docker-compose.test.yml) " +
          "or point MONGO_URL at a replica set such as Atlas.",
        { cause: err },
      );
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

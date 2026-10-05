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
  });
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
 * Server errors that mean "this deployment cannot run transactions", as opposed
 * to a failure inside the transaction itself. A standalone `mongod` answers the
 * first write of a transaction with `IllegalOperation` (code 20) and the
 * "Transaction numbers..." message; drivers raise the "does not support" forms
 * before sending anything when the topology rules sessions out.
 */
function isTransactionsUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return (
    /Transaction numbers are only allowed on a replica set member or mongos/i.test(message) ||
    /topology does not support (sessions|transactions)/i.test(message) ||
    /does not support transactions/i.test(message)
  );
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

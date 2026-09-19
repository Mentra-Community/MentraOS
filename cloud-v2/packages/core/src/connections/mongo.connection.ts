/**
 * @fileoverview MongoDB connection management for cloud-core.
 *
 * Single global Mongoose connection. Connect on boot, expose a readiness
 * check, disconnect on shutdown. Models register against `mongoose.connection`
 * implicitly via `mongoose.model(...)` in `models/*.model.ts`.
 */

import mongoose from "mongoose";
import { createLogger, type ReadinessCheck } from "@mentra/cloud-shared";

// Import every model so it is registered on the connection before we sync
// indexes. Models otherwise register lazily on first import (from API
// handlers), which happens after connect — too late for the sync below to see
// them. Keep this list in step with `models/*.model.ts`.
import "../models/oem.model";
import "../models/refresh-token.model";
import "../models/revoked-jti.model";
import "../models/seen-jti.model";
import "../models/user.model";

const logger = createLogger("core").child({ component: "mongo" });

/**
 * Connect to MongoDB. Idempotent: calling twice with the same URI is a no-op.
 * Throws on initial connection failure; reconnects automatically thereafter
 * (Mongoose's built-in behavior). Also throws (aborting boot) if a declared
 * unique index can't be built against existing data — see `syncIndexes`.
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

  await syncIndexes();
}

/**
 * Reconcile each model's indexes with its schema: create missing indexes and
 * **drop indexes that the schema no longer declares**. This is the safeguard
 * that keeps a renamed/removed index from lingering in the database after a
 * deploy. `mongoose.connect`'s `autoIndex` only *creates* indexes; it never
 * drops obsolete ones, so a field rename (e.g. `tenantId` → `oemId`) leaves the
 * old unique index in place and every insert that doesn't populate the old
 * fields collides on `{null, null}` → E11000. `syncIndexes()` removes the
 * orphaned index so the schema is the single source of truth.
 *
 * Failure handling is split by blast radius. `model.syncIndexes()` drops
 * obsolete indexes *before* creating missing ones, so if a declared unique
 * index can't be built — existing rows already violate it (duplicate keys,
 * E11000) — the old index is gone and the collection is left with **no**
 * uniqueness guarantee. Application code depends on those guarantees:
 * `findOrCreateUser()` leans on the `{oemId, oemUserId}` unique index to dedupe
 * concurrent token exchanges, so silently booting without it lets two races
 * mint two user records for the same person. Therefore:
 *
 * - **Duplicate-key failures (E11000) abort boot.** A declared unique index
 *   could not be built against current data — a data-integrity hole we must not
 *   serve traffic on. Migrate the offending rows, then redeploy.
 * - **Every other failure is best-effort** (logged, boot continues). A stale or
 *   un-dropped index is a latent issue, not a reason to refuse traffic, and one
 *   model's transient hiccup shouldn't abort the rest.
 */
async function syncIndexes(): Promise<void> {
  for (const [name, model] of Object.entries(mongoose.models)) {
    try {
      const dropped = await model.syncIndexes();
      logger.info({ model: name, droppedIndexes: dropped }, "synced indexes");
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        logger.error(
          { err, model: name },
          "index sync hit a duplicate-key error: a declared unique index could " +
            "not be built against existing data, leaving uniqueness unenforced. " +
            "Aborting boot — migrate the duplicate rows and redeploy.",
        );
        throw err;
      }
      logger.error({ err, model: name }, "index sync failed (continuing)");
    }
  }
}

/**
 * Mongo duplicate-key error (E11000). During index sync this surfaces when a
 * unique index can't be created because existing documents already violate it.
 */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
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

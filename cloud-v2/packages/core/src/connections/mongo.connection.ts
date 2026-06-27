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
 * Best-effort: a sync failure is logged but does not block boot — a stale index
 * is a latent data issue, not a reason to refuse traffic. Per-model so one
 * model's failure doesn't abort the rest.
 */
async function syncIndexes(): Promise<void> {
  for (const [name, model] of Object.entries(mongoose.models)) {
    try {
      const dropped = await model.syncIndexes();
      logger.info({ model: name, droppedIndexes: dropped }, "synced indexes");
    } catch (err) {
      logger.error({ err, model: name }, "index sync failed (continuing)");
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

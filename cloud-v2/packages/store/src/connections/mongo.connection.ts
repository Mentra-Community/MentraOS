/**
 * @fileoverview MongoDB connection management for cloud-core.
 *
 * Single global Mongoose connection. Connect on boot, expose a readiness
 * check, disconnect on shutdown. Models register against `mongoose.connection`
 * implicitly via `mongoose.model(...)` in `models/*.model.ts`.
 */

import mongoose from "mongoose"
import {createLogger, type ReadinessCheck} from "@mentra/cloud-shared"

const logger = createLogger("store").child({component: "mongo"})

/**
 * Connect to MongoDB. Idempotent: calling twice with the same URI is a no-op.
 * Throws on initial connection failure; reconnects automatically thereafter
 * (Mongoose's built-in behavior).
 */
export async function connectMongo(uri: string): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    logger.warn("connectMongo called while already connected; ignoring")
    return
  }

  mongoose.connection.on("connected", () => {
    logger.info("mongo connected")
  })
  mongoose.connection.on("disconnected", () => {
    logger.warn("mongo disconnected")
  })
  mongoose.connection.on("error", (err) => {
    logger.error({err}, "mongo connection error")
  })

  await mongoose.connect(uri, {
    // Fail fast on initial connect; afterwards Mongoose auto-retries.
    serverSelectionTimeoutMS: 10_000,
  })
}

/** Close the Mongo connection. Call from graceful-shutdown handlers. */
export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) return
  await mongoose.disconnect()
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
}

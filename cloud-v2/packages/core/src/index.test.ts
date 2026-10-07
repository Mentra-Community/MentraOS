/**
 * @fileoverview `startCore` runs its boot-time configuration checks without a Mongo.
 *
 * The WorkOS warning condition itself is covered by `services/workspaces/identity-link.startup-warning.test.ts`;
 * this pins that the real boot path calls the check, exactly once, and that a deployed Core without a
 * usable organization id refuses to start (so the deploy fails its health check instead of serving 500s).
 * Mongo, the startup migrations and the background workers that read Mongo are stubbed, so nothing here
 * connects to any database.
 */

import {afterEach, beforeEach, expect, spyOn, test} from "bun:test"
import * as mongoConnection from "./connections/mongo.connection"
import * as httpServer from "./http-server"
import {startCore} from "./index"
import * as startupMigrations from "./migrations/startup.migrations"
import * as frameworkRunSummary from "./services/framework-run-summary.service"
import * as routineWorkNotification from "./services/routine-work-notification"
import * as identityLink from "./services/workspaces/identity-link.service"

const ENV_KEYS = [
  "CLOUD_CORE_ENVIRONMENT",
  "CLOUD_CORE_ORGANIZATION_ID",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let restore: Array<() => void> = []
let disconnectSpy: ReturnType<typeof spyOn<typeof mongoConnection, "disconnectMongo">>

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.WORKOS_API_KEY = "sk_test"
  process.env.WORKOS_CLIENT_ID = "client_test"
  process.env.WORKOS_COOKIE_PASSWORD = "test-cookie-password-with-at-least-32-characters"
  const connect = spyOn(mongoConnection, "connectMongo").mockResolvedValue(undefined as never)
  const disconnect = spyOn(mongoConnection, "disconnectMongo").mockResolvedValue(undefined as never)
  disconnectSpy = disconnect
  const migrate = spyOn(startupMigrations, "runStartupMigrations").mockResolvedValue(undefined as never)
  const backfill = spyOn(frameworkRunSummary, "startFrameworkRunSummaryBackfill").mockReturnValue(async () => {})
  const reporting = spyOn(routineWorkNotification, "startRoutineWorkReporting").mockReturnValue(async () => {})
  restore = [
    () => connect.mockRestore(),
    () => disconnect.mockRestore(),
    () => migrate.mockRestore(),
    () => backfill.mockRestore(),
    () => reporting.mockRestore(),
  ]
})

afterEach(() => {
  for (const undo of restore) undo()
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

test("booting a deployed Core with WorkOS and no GoTrue admin runs the warning check once", async () => {
  process.env.CLOUD_CORE_ENVIRONMENT = "dev"
  process.env.CLOUD_CORE_ORGANIZATION_ID = "boot-warning-test"
  const check = spyOn(identityLink, "warnIfWorkosIdentitiesStaySeparate")
  try {
    const core = await startCore({port: 0, mongoUrl: "mongodb://127.0.0.1:1/unused"})
    try {
      expect(check).toHaveBeenCalledTimes(1)
      expect(check.mock.results[0]?.value).toBe(true)
    } finally {
      await core.stop()
    }
  } finally {
    check.mockRestore()
  }
})

test("a local Core boots with the check run and no warning", async () => {
  const check = spyOn(identityLink, "warnIfWorkosIdentitiesStaySeparate")
  try {
    const core = await startCore({port: 0, mongoUrl: "mongodb://127.0.0.1:1/unused"})
    try {
      expect(check).toHaveBeenCalledTimes(1)
      expect(check.mock.results[0]?.value).toBe(false)
    } finally {
      await core.stop()
    }
  } finally {
    check.mockRestore()
  }
})

test("a deployed Core without CLOUD_CORE_ORGANIZATION_ID refuses to start before serving", async () => {
  process.env.CLOUD_CORE_ENVIRONMENT = "prod"
  const serve = spyOn(httpServer, "serveCore")
  try {
    await expect(startCore({port: 0, mongoUrl: "mongodb://127.0.0.1:1/unused"})).rejects.toThrow(
      /CLOUD_CORE_ORGANIZATION_ID is required/,
    )
    expect(serve).not.toHaveBeenCalled()
    expect(disconnectSpy).toHaveBeenCalledTimes(1)
  } finally {
    serve.mockRestore()
  }
})

test("a deployed Core with a malformed CLOUD_CORE_ORGANIZATION_ID refuses to start before serving", async () => {
  process.env.CLOUD_CORE_ENVIRONMENT = "staging"
  process.env.CLOUD_CORE_ORGANIZATION_ID = "Not A Valid Id"
  const serve = spyOn(httpServer, "serveCore")
  try {
    await expect(startCore({port: 0, mongoUrl: "mongodb://127.0.0.1:1/unused"})).rejects.toThrow(
      /CLOUD_CORE_ORGANIZATION_ID must match/,
    )
    expect(serve).not.toHaveBeenCalled()
  } finally {
    serve.mockRestore()
  }
})

test("a local Core without CLOUD_CORE_ORGANIZATION_ID still boots (it defaults to local)", async () => {
  const core = await startCore({port: 0, mongoUrl: "mongodb://127.0.0.1:1/unused"})
  await core.stop()
})

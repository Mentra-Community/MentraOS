/**
 * @fileoverview `startCore` runs the boot warning about WorkOS without a Mongo.
 *
 * The condition itself is covered by `services/workspaces/identity-link.startup-warning.test.ts`; this
 * pins that the real boot path calls the check, exactly once. Mongo, the startup migrations and the
 * background workers that read Mongo are stubbed, so nothing here connects to any database.
 */

import {afterEach, beforeEach, expect, spyOn, test} from "bun:test"
import * as mongoConnection from "./connections/mongo.connection"
import {startCore} from "./index"
import * as startupMigrations from "./migrations/startup.migrations"
import * as frameworkRunSummary from "./services/framework-run-summary.service"
import * as routineWorkNotification from "./services/routine-work-notification"
import * as identityLink from "./services/workspaces/identity-link.service"

const ENV_KEYS = [
  "CLOUD_CORE_ENVIRONMENT",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let restore: Array<() => void> = []

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.WORKOS_API_KEY = "sk_test"
  process.env.WORKOS_CLIENT_ID = "client_test"
  process.env.WORKOS_COOKIE_PASSWORD = "test-cookie-password-with-at-least-32-characters"
  const connect = spyOn(mongoConnection, "connectMongo").mockResolvedValue(undefined as never)
  const disconnect = spyOn(mongoConnection, "disconnectMongo").mockResolvedValue(undefined as never)
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

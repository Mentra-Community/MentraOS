import {createLogger} from "@mentra/cloud-shared"
import {SupportTelemetryOutboxModel} from "../models/support-telemetry-outbox.model"
import {UserModel} from "../models/user.model"
import {getUserById} from "./account/gotrue.client"

const logger = createLogger("core").child({service: "support-telemetry"})
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const LEASE_MS = 30_000
const POLL_MS = 10_000
let timer: ReturnType<typeof setInterval> | null = null
let draining = false

export async function enqueueSupportTelemetry(input: {
  mentraUserId: string
  transitionKey: string
  event: string
  eventAt: Date
  properties: Record<string, unknown>
}): Promise<void> {
  if (!posthogApiKey()) return
  const now = new Date()
  await SupportTelemetryOutboxModel.updateOne(
    {transitionKey: input.transitionKey},
    {
      $setOnInsert: {
        ...input,
        availableAt: now,
        expiresAt: new Date(now.getTime() + OUTBOX_TTL_MS),
      },
    },
    {upsert: true},
  )
  void drainSupportTelemetryOutbox()
}

/** Start the persistent delivery loop. Canonical support-profile writes never depend on it. */
export function startSupportTelemetryWorker(): void {
  if (timer || !posthogApiKey()) return
  timer = setInterval(() => void drainSupportTelemetryOutbox(), POLL_MS)
  timer.unref?.()
  void drainSupportTelemetryOutbox()
}

export function stopSupportTelemetryWorker(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export async function drainSupportTelemetryOutbox(): Promise<void> {
  if (draining || !posthogApiKey()) return
  draining = true
  try {
    for (let count = 0; count < 50; count += 1) {
      const now = new Date()
      const row = await SupportTelemetryOutboxModel.findOneAndUpdate(
        {
          deliveredAt: null,
          availableAt: {$lte: now},
          $or: [{leasedUntil: null}, {leasedUntil: {$lte: now}}],
        },
        {$set: {leasedUntil: new Date(now.getTime() + LEASE_MS)}},
        {sort: {createdAt: 1}, new: true},
      ).lean()
      if (!row) break

      try {
        const stillActive = await UserModel.exists({
          mentraUserId: row.mentraUserId,
          supportTelemetryDeletedAt: null,
        })
        if (!stillActive) {
          await SupportTelemetryOutboxModel.deleteOne({_id: row._id})
          continue
        }
        const email = await trustedEmail(row.mentraUserId)
        await sendCapture({
          distinctId: row.mentraUserId,
          event: row.event,
          eventAt: row.eventAt,
          properties: row.properties as Record<string, unknown>,
          email,
        })
        await SupportTelemetryOutboxModel.updateOne(
          {_id: row._id},
          {$set: {deliveredAt: new Date(), leasedUntil: null}},
        )
      } catch (error) {
        const attempts = row.attempts + 1
        const delayMs = Math.min(60 * 60 * 1_000, 5_000 * 2 ** Math.min(attempts, 8))
        await SupportTelemetryOutboxModel.updateOne(
          {_id: row._id},
          {
            $set: {availableAt: new Date(Date.now() + delayMs), leasedUntil: null},
            $inc: {attempts: 1},
          },
        )
        logger.warn({event: row.event, attempts, error: (error as Error)?.message}, "PostHog delivery failed")
      }
    }
  } finally {
    draining = false
  }
}

async function trustedEmail(mentraUserId: string): Promise<string | null> {
  const user = await UserModel.findOne({mentraUserId}).lean()
  if (!user || user.tenantId !== "mentra") return null
  const identity = await getUserById(user.tenantUserId).catch(() => null)
  return identity?.emailVerified ? identity.email : null
}

async function sendCapture(input: {
  distinctId: string
  event: string
  eventAt: Date
  properties: Record<string, unknown>
  email: string | null
}): Promise<void> {
  const key = posthogApiKey()
  if (!key) return
  const host = (process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com").replace(/\/+$/, "")
  const personProperties = {
    ...input.properties,
    ...(input.email ? {email: input.email} : {}),
  }
  const response = await fetch(`${host}/capture/`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      api_key: key,
      event: input.event,
      timestamp: input.eventAt.toISOString(),
      properties: {
        distinct_id: input.distinctId,
        $process_person_profile: true,
        $set: personProperties,
        ...input.properties,
      },
    }),
  })
  if (!response.ok) throw new Error(`PostHog capture returned ${response.status}`)
}

function posthogApiKey(): string | null {
  return process.env.POSTHOG_API_KEY?.trim() || null
}

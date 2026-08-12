import {createLogger} from "@mentra/cloud-shared"
import {SupportTelemetryOutboxModel} from "../models/support-telemetry-outbox.model"
import {UserModel} from "../models/user.model"
import {getUserById} from "./account/gotrue.client"

const logger = createLogger("core").child({service: "support-telemetry"})
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const LEASE_MS = 30_000
const POLL_MS = 10_000
const CAPTURE_TIMEOUT_MS = 15_000
const DELIVERY_LEASE_MS = CAPTURE_TIMEOUT_MS + 5_000
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
  const active = await UserModel.exists({
    mentraUserId: input.mentraUserId,
    supportTelemetryDeletedAt: null,
  })
  if (!active) return
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
  // Close the check/write race with account deletion: whichever operation
  // happens second removes the row.
  const stillActive = await UserModel.exists({
    mentraUserId: input.mentraUserId,
    supportTelemetryDeletedAt: null,
  })
  if (!stillActive) {
    await SupportTelemetryOutboxModel.deleteOne({transitionKey: input.transitionKey})
    return
  }
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
          expiresAt: {$gt: now},
          availableAt: {$lte: now},
          $or: [{leasedUntil: null}, {leasedUntil: {$lte: now}}],
        },
        {$set: {leasedUntil: new Date(now.getTime() + LEASE_MS)}},
        {sort: {createdAt: 1}, new: true},
      ).lean()
      if (!row) break
      let activeRowLeaseUntil = row.leasedUntil

      const leaseStartedAt = new Date()
      const deliveryLease = await UserModel.findOneAndUpdate(
        {
          mentraUserId: row.mentraUserId,
          supportTelemetryDeletedAt: null,
          $or: [
            {supportTelemetryDeliveryLeaseUntil: null},
            {supportTelemetryDeliveryLeaseUntil: {$lte: leaseStartedAt}},
          ],
        },
        {$set: {supportTelemetryDeliveryLeaseUntil: new Date(leaseStartedAt.getTime() + DELIVERY_LEASE_MS)}},
        {new: true},
      ).lean()
      if (!deliveryLease) {
        const active = await UserModel.exists({
          mentraUserId: row.mentraUserId,
          supportTelemetryDeletedAt: null,
        })
        if (!active) await SupportTelemetryOutboxModel.deleteOne({_id: row._id})
        else {
          // Another worker owns this user's delivery lease. Release this row
          // for a later pass rather than dropping it.
          await SupportTelemetryOutboxModel.updateOne(
            {_id: row._id, leasedUntil: activeRowLeaseUntil},
            {$set: {leasedUntil: null, availableAt: new Date(Date.now() + 1_000)}},
          )
        }
        continue
      }
      let activeLeaseUntil = deliveryLease.supportTelemetryDeliveryLeaseUntil
      try {
        const email = await trustedEmail(row.mentraUserId)
        const renewedRowLeaseUntil = new Date(Date.now() + LEASE_MS)
        const renewedRow = await SupportTelemetryOutboxModel.findOneAndUpdate(
          {_id: row._id, deliveredAt: null, leasedUntil: activeRowLeaseUntil},
          {$set: {leasedUntil: renewedRowLeaseUntil}},
          {new: true},
        ).lean()
        if (!renewedRow) continue
        activeRowLeaseUntil = renewedRow.leasedUntil

        // Identity lookup and row renewal can be slow, so renew the user lease
        // last, immediately before capture. The compare-and-set also rechecks
        // the tombstone and abandons capture after deletion starts.
        const renewedLeaseUntil = new Date(Date.now() + DELIVERY_LEASE_MS)
        const renewedLease = await UserModel.findOneAndUpdate(
          {
            mentraUserId: row.mentraUserId,
            supportTelemetryDeletedAt: null,
            supportTelemetryDeliveryLeaseUntil: activeLeaseUntil,
          },
          {$set: {supportTelemetryDeliveryLeaseUntil: renewedLeaseUntil}},
          {new: true},
        ).lean()
        if (!renewedLease) {
          const active = await UserModel.exists({
            mentraUserId: row.mentraUserId,
            supportTelemetryDeletedAt: null,
          })
          if (!active) await SupportTelemetryOutboxModel.deleteOne({_id: row._id})
          else {
            await SupportTelemetryOutboxModel.updateOne(
              {_id: row._id, leasedUntil: activeRowLeaseUntil},
              {$set: {leasedUntil: null, availableAt: new Date(Date.now() + 1_000)}},
            )
          }
          continue
        }
        activeLeaseUntil = renewedLease.supportTelemetryDeliveryLeaseUntil
        await sendCapture({
          distinctId: row.mentraUserId,
          event: row.event,
          eventAt: row.eventAt,
          transitionKey: row.transitionKey,
          properties: row.properties as Record<string, unknown>,
          email,
        })
        await SupportTelemetryOutboxModel.updateOne(
          {_id: row._id, leasedUntil: activeRowLeaseUntil},
          {$set: {deliveredAt: new Date(), leasedUntil: null}},
        )
      } catch (error) {
        if (error instanceof PermanentCaptureError) {
          await SupportTelemetryOutboxModel.deleteOne({_id: row._id, leasedUntil: activeRowLeaseUntil})
          logger.error({event: row.event, status: error.status}, "dropping permanently rejected PostHog event")
          continue
        }
        const attempts = row.attempts + 1
        const delayMs = Math.min(60 * 60 * 1_000, 5_000 * 2 ** Math.min(attempts, 8))
        await SupportTelemetryOutboxModel.updateOne(
          {_id: row._id, leasedUntil: activeRowLeaseUntil},
          {
            $set: {availableAt: new Date(Date.now() + delayMs), leasedUntil: null},
            $inc: {attempts: 1},
          },
        )
        logger.warn({event: row.event, attempts, error: (error as Error)?.message}, "PostHog delivery failed")
      } finally {
        await UserModel.updateOne(
          {
            mentraUserId: row.mentraUserId,
            supportTelemetryDeliveryLeaseUntil: activeLeaseUntil,
          },
          {$set: {supportTelemetryDeliveryLeaseUntil: null}},
        ).catch((error) =>
          logger.warn({error: (error as Error)?.message}, "support telemetry delivery lease release deferred"),
        )
      }
    }
  } catch (error) {
    logger.warn({error: (error as Error)?.message}, "support telemetry drain deferred")
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
  transitionKey: string
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
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      api_key: key,
      event: input.event,
      timestamp: input.eventAt.toISOString(),
      properties: {
        distinct_id: input.distinctId,
        $insert_id: input.transitionKey,
        $process_person_profile: true,
        $set: personProperties,
        ...input.properties,
      },
    }),
  })
  if (!response.ok) {
    if (isPermanentCaptureStatus(response.status)) {
      throw new PermanentCaptureError(response.status)
    }
    throw new Error(`PostHog capture returned ${response.status}`)
  }
}

export function isPermanentCaptureStatus(status: number): boolean {
  // Authentication, authorization, routing and throttling failures can be
  // repaired operationally. Only payload-specific rejections are terminal.
  return status === 400 || status === 413 || status === 422
}

/** Prevent account deletion from returning while a capture is still in flight. */
export async function waitForSupportTelemetryDeliveries(mentraUserId: string): Promise<void> {
  for (;;) {
    const user = await UserModel.findOne({mentraUserId}).select({supportTelemetryDeliveryLeaseUntil: 1}).lean()
    const leasedUntil = user?.supportTelemetryDeliveryLeaseUntil
    if (!leasedUntil || leasedUntil.getTime() <= Date.now()) return
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, leasedUntil.getTime() - Date.now())))
  }
}

class PermanentCaptureError extends Error {
  constructor(readonly status: number) {
    super(`PostHog permanently rejected capture with ${status}`)
  }
}

function posthogApiKey(): string | null {
  return process.env.POSTHOG_API_KEY?.trim() || null
}

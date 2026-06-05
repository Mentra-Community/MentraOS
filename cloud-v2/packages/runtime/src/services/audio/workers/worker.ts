/**
 * @fileoverview Audio worker — per-CPU thread that owns a slice of users.
 *
 * What this worker does:
 *   1. Maintains its own ioredis streams client.
 *   2. Receives `ATTACH_USER` / `DETACH_USER` postMessages from the main
 *      thread when ownership changes.
 *   3. Runs an XREADGROUP loop for the streams of its currently-assigned
 *      users; for each entry it decodes the audio (LC3 to PCM, or passes
 *      raw PCM through), feeds it to that user's transcription/translation
 *      providers, ACKs the entry, and emits results back to the main thread.
 *   4. Runs an XAUTOCLAIM loop for failover replay — entries stuck in a
 *      dead consumer's PEL get picked up here.
 *
 * Two kinds of message go back to the main thread:
 *   - TRANSCRIPT: real provider output (text), one per result event.
 *   - TRANSCRIPT_STUB: one per stream entry, regardless of subscriptions.
 *     It reports "audio reached a worker and decoded to N PCM bytes" and is
 *     what the routing/failover tests assert against without needing a
 *     provider in the loop.
 *
 * Spec: cloud-v2/docs/issues/002-cloud-runtime/design.md ("Workers handle
 * their own stream reads.")
 */

import {Redis} from "ioredis"
import {AUDIO_STREAM_GROUP, audioStreamKey} from "../../session/stream"
import {LC3Decoder} from "./lc3"
import {createMockProvider} from "../providers/mock"
import {createSonioxProvider} from "../providers/soniox"
import type {TranscriptionProvider, TranscriptEvent} from "../providers/provider"
import type {AudioSubscription, LanguageSource, TranscriptionSubscription} from "../../session/subscriptions"

// === Worker IPC types ===

export interface AttachUserMessage {
  type: "ATTACH_USER"
  mentraUserId: string
}
export interface DetachUserMessage {
  type: "DETACH_USER"
  mentraUserId: string
}
export interface UpdateSubscriptionsMessage {
  type: "UPDATE_SUBSCRIPTIONS"
  mentraUserId: string
  subs: AudioSubscription[]
}
export interface ShutdownMessage {
  type: "SHUTDOWN"
}
export type WorkerInMessage = AttachUserMessage | DetachUserMessage | UpdateSubscriptionsMessage | ShutdownMessage

/**
 * Emitted per Redis Stream entry to signal "audio reached a worker and was
 * decoded." Useful for testing the routing layer without a provider in the
 * loop. Real transcript text comes via TranscriptMessage below.
 */
export interface TranscriptStubMessage {
  type: "TRANSCRIPT_STUB"
  mentraUserId: string
  seq: number
  /** Length of the raw LC3 payload bytes (before decode). */
  payloadLen: number
  /** Length of the decoded PCM (Int16 mono) in bytes. 0 if decode failed. */
  pcmBytesLen: number
  audioSessionId: string
  /** Where this entry came from — "live" = new XREADGROUP, "replay" = XAUTOCLAIM */
  origin: "live" | "replay"
}

/**
 * Emitted by transcription/translation providers. `kind` discriminates:
 *   - "transcription": text is in the source language
 *   - "translation": text is in the TARGET language; `sourceLanguage` is set
 * Same shape for both so clients can route via a single handler.
 */
export interface TranscriptMessage {
  type: "TRANSCRIPT"
  kind: "transcription" | "translation"
  mentraUserId: string
  text: string
  isFinal: boolean
  /** Language of the emitted text. */
  language?: string
  /** For translation: the source-audio language (may be `"auto"`). */
  sourceLanguage?: string
  /** Audio timeline window in milliseconds. */
  startMs?: number
  endMs?: number
  /** Provider that produced this — `"mock"`, `"soniox"`, etc. */
  source: string
  /**
   * The subscription that produced this transcript. Carried through so the
   * main thread can build the v2 `stream.transcript` / `stream.translation`
   * result (which echoes the subscription back to the client) without
   * re-deriving it from the language fields.
   */
  subscription: AudioSubscription
}

export interface WorkerReadyMessage {
  type: "WORKER_READY"
}
export type WorkerOutMessage = TranscriptStubMessage | TranscriptMessage | WorkerReadyMessage

// === Worker state ===

const ownedUsers = new Set<string>()
/** Per-user LC3 decoder. Created on ATTACH_USER, disposed on DETACH_USER. */
const decoders = new Map<string, LC3Decoder>()
/**
 * Per-user transcription providers, keyed by subscription identity. A user
 * can have multiple active subscriptions; we keep one provider instance per
 * unique transcription sub.
 *
 * For translation subs, we currently track the sub but don't open a
 * provider — translation lands in a follow-up iteration.
 */
const userProviders = new Map<string, Map<string, TranscriptionProvider>>()
/** Most recently received subscription list per user, for reconciliation. */
const userSubs = new Map<string, AudioSubscription[]>()
let running = true

/**
 * Which provider to use. Defaults to "mock" so e2e tests don't need a
 * Soniox API key. Real Soniox lands behind `"soniox"` when the next
 * iteration's wrapper is built and `SONIOX_API_KEY` is present.
 */
const PROVIDER_KIND = process.env.AUDIO_PROVIDER ?? "mock"

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379"
const WORKER_ID = process.env.WORKER_ID ?? "worker"
const POD_ID = process.env.POD_ID ?? "pod"
/**
 * Consumer name combines pod + worker so the consumer-group view in Redis
 * shows distinct entries per worker. Useful for ops + lets XAUTOCLAIM
 * reassign entries from a dead worker to a peer on the same pod.
 */
const CONSUMER_NAME = `${POD_ID}:${WORKER_ID}`

const XREAD_COUNT_PER_STREAM = 100
const XREAD_BLOCK_MS = 1000
const XAUTOCLAIM_COUNT = 500
const XAUTOCLAIM_MIN_IDLE_MS = 5_000
const XAUTOCLAIM_LOOP_INTERVAL_MS = 2_000

// Note: we DO want offline queue here, unlike the audio-ingress XADD path.
// Worker clients do control operations (xgroup, xack, xautoclaim, xreadgroup);
// briefly queueing those while the socket finishes connecting is harmless.
// The "don't silently buffer audio for a dead Redis" rationale that drives
// enableOfflineQueue:false in redis.connection.ts only applies to the
// main-thread XADD path.
const streamsClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
})

const mainClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
})

// === Receive assignments from main thread ===

declare const self: Worker

/**
 * Users whose consumer group has been ensured. We only XREADGROUP for users
 * in this set — the unfiltered `ownedUsers` set gets users added the moment
 * ATTACH_USER arrives, but the group-create is async; gating the read loop
 * on this set avoids the NOGROUP race.
 */
const readyUsers = new Set<string>()

async function handleAttach(mentraUserId: string): Promise<void> {
  ownedUsers.add(mentraUserId)
  // Decoder is needed for any audio activity; create it eagerly so the very
  // first packet has somewhere to land. Providers are NOT created until the
  // phone sends a SUBSCRIBE (or never, if they only want raw audio
  // routing).
  if (!decoders.has(mentraUserId)) {
    try {
      decoders.set(mentraUserId, await LC3Decoder.create(20))
    } catch (err) {
      console.error("[audio-worker] LC3Decoder.create failed:", err)
    }
  }
  const ok = await ensureConsumerGroup(mentraUserId)
  if (ok && ownedUsers.has(mentraUserId)) {
    readyUsers.add(mentraUserId)
  }
}

/**
 * Reconcile a user's active providers against a fresh subscription list.
 * Closes providers whose subscriptions disappeared; opens providers for
 * new subs. Idempotent for unchanged subs (no recreation).
 */
async function handleUpdateSubscriptions(mentraUserId: string, subs: AudioSubscription[]): Promise<void> {
  userSubs.set(mentraUserId, subs)

  const existing = userProviders.get(mentraUserId) ?? new Map<string, TranscriptionProvider>()
  userProviders.set(mentraUserId, existing)

  // Compute desired set: one entry per subscription, transcription AND
  // translation. They share the provider interface; output messages
  // carry a `kind` discriminator so the client knows which is which.
  const desired = new Map<string, AudioSubscription>()
  for (const sub of subs) {
    desired.set(subscriptionKeyFor(sub), sub)
  }

  // Close providers whose subs are gone.
  for (const [key, provider] of existing) {
    if (!desired.has(key)) {
      existing.delete(key)
      provider.close().catch((err) => {
        console.error("[audio-worker] provider close failed:", err)
      })
    }
  }

  // Open providers for new subs.
  for (const [key, sub] of desired) {
    if (existing.has(key)) continue
    try {
      const provider = await createProvider(mentraUserId, sub)
      existing.set(key, provider)
    } catch (err) {
      console.error("[audio-worker] provider create failed:", err)
    }
  }
}

function subscriptionKeyFor(sub: AudioSubscription): string {
  if (sub.kind === "transcription") {
    return `t:${langKey(sub.language)}`
  }
  return `x:${langKey(sub.source)}>${sub.target}`
}

function langKey(lang: LanguageSource): string {
  if (lang.mode === "specific") return `s:${lang.code}`
  const hints = lang.hints ? [...lang.hints].sort().join(",") : ""
  return `a:${hints}`
}

function langCode(lang: LanguageSource): string {
  return lang.mode === "specific" ? lang.code : "auto"
}

async function createProvider(mentraUserId: string, sub: AudioSubscription): Promise<TranscriptionProvider> {
  const isTranslation = sub.kind === "translation"
  const sourceLanguage = isTranslation ? langCode(sub.source) : undefined
  const target = isTranslation ? sub.target : undefined
  // Provider scope = user + sub identity, for log clarity and as the mock's
  // text-content prefix so multiple subs from the same user produce distinct
  // transcripts.
  const scope = isTranslation
    ? `${mentraUserId}:${sourceLanguage}>${target}`
    : `${mentraUserId}:${langCode((sub as TranscriptionSubscription).language)}`
  const providerLanguage = isTranslation ? (target as string) : langCode((sub as TranscriptionSubscription).language)

  const onTranscript = (event: TranscriptEvent) => {
    const out: TranscriptMessage = {
      type: "TRANSCRIPT",
      kind: sub.kind,
      mentraUserId,
      text: event.text,
      isFinal: event.isFinal,
      // For transcription: text is in the source/auto language.
      // For translation: text is in the target language.
      language: event.language ?? providerLanguage,
      sourceLanguage,
      startMs: event.startMs,
      endMs: event.endMs,
      source: PROVIDER_KIND,
      subscription: sub,
    }
    self.postMessage(out)
  }
  const onError = (err: Error) => {
    console.error(`[audio-worker] provider(${PROVIDER_KIND}) error for ${mentraUserId}:`, err)
  }

  switch (PROVIDER_KIND) {
    case "mock":
      return createMockProvider({
        scope,
        language: providerLanguage,
        onTranscript,
        onError,
      })
    case "soniox":
      return createSonioxProvider({
        scope,
        // Soniox: source language config in either case. For translation
        // subs we additionally pass `targetLanguage` — Soniox does the
        // translation in-session and we filter result tokens accordingly.
        language: isTranslation ? (sourceLanguage as string) : langCode((sub as TranscriptionSubscription).language),
        targetLanguage: isTranslation ? (target as string) : undefined,
        onTranscript,
        onError,
      })
    default:
      throw new Error(`unknown AUDIO_PROVIDER: ${PROVIDER_KIND}`)
  }
}

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data
  switch (msg.type) {
    case "ATTACH_USER":
      void handleAttach(msg.mentraUserId)
      break
    case "DETACH_USER": {
      ownedUsers.delete(msg.mentraUserId)
      readyUsers.delete(msg.mentraUserId)
      decoders.delete(msg.mentraUserId)
      userSubs.delete(msg.mentraUserId)
      const providers = userProviders.get(msg.mentraUserId)
      if (providers) {
        userProviders.delete(msg.mentraUserId)
        for (const provider of providers.values()) {
          provider.close().catch((err) => {
            console.error("[audio-worker] provider close failed:", err)
          })
        }
      }
      break
    }
    case "UPDATE_SUBSCRIPTIONS":
      void handleUpdateSubscriptions(msg.mentraUserId, msg.subs)
      break
    case "SHUTDOWN":
      running = false
      void shutdown()
      break
  }
}

async function ensureConsumerGroup(mentraUserId: string): Promise<boolean> {
  try {
    // Group start = `0` (beginning of stream) rather than `$` (end of stream
    // = new entries only). Reason: UDP ingress may have XADDed packets to
    // the stream BEFORE the worker finished creating the group (the assign
    // happens at WS-open time, but UDP packets can arrive within
    // milliseconds of connection.ack reaching the client). `$` would
    // silently skip those entries. `0` delivers everything that's in the
    // stream — `MAXLEN ~ 1000` keeps the backlog bounded so this isn't
    // unbounded replay.
    await mainClient.xgroup("CREATE", audioStreamKey(mentraUserId), AUDIO_STREAM_GROUP, "0", "MKSTREAM")
    return true
  } catch (err) {
    const msg = (err as Error).message ?? ""
    // BUSYGROUP = "already exists" — that's success for our purposes.
    if (msg.includes("BUSYGROUP")) return true
    console.error("[audio-worker] xgroup create failed:", err)
    return false
  }
}

// === Main loops ===

async function freshReadLoop(): Promise<void> {
  while (running) {
    // Only stream-read for users whose consumer group has been verified to
    // exist. A user that JUST ATTACHed but hasn't finished XGROUP CREATE
    // yet skips this iteration; they're picked up once group-ensure resolves.
    const users = [...readyUsers]
    if (users.length === 0) {
      await Bun.sleep(100)
      continue
    }

    // STREAMS k1 k2 k3 ... > > > ... — one `>` per stream means
    // "give me entries no one in this group has seen yet."
    const streams = users.map(audioStreamKey)
    const ids = users.map(() => ">")

    try {
      const result = (await streamsClient.xreadgroup(
        "GROUP",
        AUDIO_STREAM_GROUP,
        CONSUMER_NAME,
        "COUNT",
        XREAD_COUNT_PER_STREAM,
        "BLOCK",
        XREAD_BLOCK_MS,
        "STREAMS",
        ...streams,
        ...ids,
      )) as Array<[string, Array<[string, string[]]>]> | null

      if (result) await processBatch(result, "live")
    } catch (err) {
      const msg = (err as Error).message ?? ""
      // NOGROUP can happen if a stream got DEL'd out from under us (tests
      // wipe Redis between cases; production this would only happen if
      // someone manually nuked a stream key). Re-ensure groups for all
      // currently-owned users — the next iteration picks up cleanly.
      // We DON'T remove the user from readyUsers because the user is
      // still legitimately owned; the stream just needs recreating.
      if (msg.includes("NOGROUP")) {
        for (const userId of [...readyUsers]) {
          await ensureConsumerGroup(userId)
        }
        continue
      }
      console.error("[audio-worker] xreadgroup failed:", err)
      await Bun.sleep(500)
    }
  }
}

async function autoclaimLoop(): Promise<void> {
  while (running) {
    for (const userId of readyUsers) {
      try {
        await drainAutoclaim(userId)
      } catch (err) {
        console.error("[audio-worker] autoclaim failed:", err)
      }
    }
    await Bun.sleep(XAUTOCLAIM_LOOP_INTERVAL_MS)
  }
}

async function drainAutoclaim(userId: string): Promise<void> {
  let cursor = "0-0"
  while (running) {
    let result: [string, Array<[string, string[]]>, string[]] | null = null
    try {
      // XAUTOCLAIM <key> <group> <consumer> <min-idle-ms> <start-id> COUNT N
      // Returns [next-cursor, [[id, [field, value, ...]], ...]]
      result = (await mainClient.xautoclaim(
        audioStreamKey(userId),
        AUDIO_STREAM_GROUP,
        CONSUMER_NAME,
        XAUTOCLAIM_MIN_IDLE_MS,
        cursor,
        "COUNT",
        XAUTOCLAIM_COUNT,
      )) as [string, Array<[string, string[]]>, string[]]
    } catch (err) {
      const msg = (err as Error).message ?? ""
      // Stream got dropped; re-ensure and bail. Next loop iteration retries.
      if (msg.includes("NOGROUP")) {
        await ensureConsumerGroup(userId)
        return
      }
      throw err
    }

    if (!result) return
    const [nextCursor, entries] = result

    if (entries.length === 0) return
    await processBatch([[audioStreamKey(userId), entries]], "replay")

    if (nextCursor === "0-0") return // Redis convention: done.
    cursor = nextCursor
  }
}

async function processBatch(
  result: Array<[string, Array<[string, string[]]>]>,
  origin: "live" | "replay",
): Promise<void> {
  for (const [streamKey, entries] of result) {
    const mentraUserId = streamKey.replace(/^audio:/, "")
    const decoder = decoders.get(mentraUserId)

    for (const [entryId, fields] of entries) {
      const map = fieldArrayToMap(fields)
      const seq = Number(map.seq ?? 0)
      const audioSessionId = map.audioSessionId ?? ""

      // Recover binary LC3 bytes from the base64 we encoded on XADD.
      const lc3Bytes = typeof map.payload === "string" ? Buffer.from(map.payload, "base64") : Buffer.alloc(0)
      const payloadLen = lc3Bytes.byteLength

      // Decode LC3 → Int16 PCM, then feed to each subscribed transcription
      // provider for this user. If the user has no subscriptions, decode
      // still happens (so TRANSCRIPT_STUB is accurate) but no provider
      // events fire — which is the correct behavior for a session that
      // hasn't asked to be transcribed.
      let pcmBytesLen = 0
      if (decoder && payloadLen > 0) {
        const pcm = decoder.decode(new Uint8Array(lc3Bytes.buffer, lc3Bytes.byteOffset, payloadLen))
        if (pcm) {
          pcmBytesLen = pcm.byteLength
          const providers = userProviders.get(mentraUserId)
          if (providers) {
            for (const provider of providers.values()) {
              try {
                provider.writeAudio(pcm)
              } catch (err) {
                console.error("[audio-worker] provider.writeAudio failed:", err)
              }
            }
          }
        }
      }

      const out: TranscriptStubMessage = {
        type: "TRANSCRIPT_STUB",
        mentraUserId,
        seq,
        payloadLen,
        pcmBytesLen,
        audioSessionId,
        origin,
      }
      self.postMessage(out)

      // ACK so Redis can stop tracking this in our consumer's PEL.
      try {
        await streamsClient.xack(streamKey, AUDIO_STREAM_GROUP, entryId)
      } catch (err) {
        console.error("[audio-worker] xack failed:", err)
      }
    }
  }
}

function fieldArrayToMap(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < fields.length; i += 2) {
    out[fields[i]!] = fields[i + 1]!
  }
  return out
}

// === Lifecycle ===

async function shutdown(): Promise<void> {
  try {
    await Promise.all([streamsClient.quit().catch(() => undefined), mainClient.quit().catch(() => undefined)])
  } catch {
    /* ignore */
  }
}

// Boot: wait for BOTH Redis clients to be `ready` before announcing
// WORKER_READY. ioredis with `enableOfflineQueue: false` rejects commands
// during the connecting phase, so any ATTACH_USER that arrives before the
// clients are up would hit "Stream isn't writeable."
async function bootstrap(): Promise<void> {
  await Promise.all([waitForReady(streamsClient), waitForReady(mainClient)])
  self.postMessage({type: "WORKER_READY"} satisfies WorkerReadyMessage)
  void freshReadLoop()
  void autoclaimLoop()
}

function waitForReady(client: Redis): Promise<void> {
  if (client.status === "ready") return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onReady = () => {
      client.off("error", onError)
      resolve()
    }
    const onError = (err: Error) => {
      client.off("ready", onReady)
      reject(err)
    }
    client.once("ready", onReady)
    client.once("error", onError)
  })
}

void bootstrap()

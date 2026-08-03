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
import {createLogger} from "@mentra/cloud-shared"
import {AUDIO_STREAM_GROUP, audioStreamKey} from "../../session/stream"
import {CONTROL_STREAM_GROUP, controlStreamKey} from "../../session/control-stream"
import type {SubscriptionRecord} from "../../session/subscriptions-store"
import {LC3Decoder} from "./lc3"
import {createMockProvider} from "../providers/mock"
import {createSonioxProvider} from "../providers/soniox"
import type {TranscriptionProvider, TranscriptEvent} from "../providers/provider"
import {
  subscriptionKey,
  type AudioSubscription,
  type LanguageSource,
  type TranscriptionSubscription,
} from "../../session/subscriptions"

const logger = createLogger("runtime").child({module: "audio-worker"})

// === Worker IPC types ===

export interface AttachUserMessage {
  type: "ATTACH_USER"
  mentraUserId: string
}
export interface DetachUserMessage {
  type: "DETACH_USER"
  mentraUserId: string
}
/**
 * Tell the worker to reconcile a user's subscriptions. This is a NUDGE, not a
 * payload: the worker re-reads the `{user:X}:subscriptions` Redis key (the
 * source of truth) and reconciles its provider set from that. The main thread
 * sends this after seeding the key at `connection.init`; the same reconcile
 * also fires when the worker reads a control-stream entry. Keeping the subs out
 * of the message is deliberate: there is exactly one source of truth (the key),
 * so no path can hand the worker a snapshot that disagrees with it.
 */
export interface UpdateSubscriptionsMessage {
  type: "UPDATE_SUBSCRIPTIONS"
  mentraUserId: string
}
/** Audio codec for a user's stream. Set from the client's connection.init. */
export type AudioCodec = "lc3" | "pcm"
export type Lc3FrameSizeBytes = 20 | 40 | 60
export interface SetCodecMessage {
  type: "SET_CODEC"
  mentraUserId: string
  codec: AudioCodec
  frameSizeBytes?: Lc3FrameSizeBytes
}
export interface ShutdownMessage {
  type: "SHUTDOWN"
}
export type WorkerInMessage =
  | AttachUserMessage
  | DetachUserMessage
  | UpdateSubscriptionsMessage
  | SetCodecMessage
  | ShutdownMessage

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
  /**
   * Stable id correlating interim + final results for one utterance. The
   * client updates a single card in place across interims and commits it on
   * the final. Undefined for providers that don't track utterances.
   */
  utteranceId?: string
  /** Speaker id if the provider reports diarization. */
  speakerId?: string
  /** Language of the emitted text. */
  language?: string
  /**
   * For translation: the source-audio language — the provider's DETECTED
   * language when it reports one, else the subscription's (may be `"auto"`).
   */
  sourceLanguage?: string
  /** For translation: source-language text of the same window, if available. */
  originalText?: string
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

export interface UdpLivenessAckMessage {
  type: "UDP_LIVENESS_ACK"
  mentraUserId: string
  sessionTag: number
  audioSessionId: string
  probeId: string
  receivedAt: number
}

export type WorkerOutMessage =
  | TranscriptStubMessage
  | TranscriptMessage
  | UdpLivenessAckMessage
  | WorkerReadyMessage

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
const userProviderCreates = new Map<string, Map<string, Promise<TranscriptionProvider>>>()
/** Most recently received subscription list per user, for reconciliation. */
const userSubs = new Map<string, AudioSubscription[]>()
/**
 * Per-user audio codec. "lc3" (default) decodes each stream entry through the
 * LC3 decoder; "pcm" treats the payload as raw Int16 mono PCM and feeds it to
 * providers without decoding. Set from the client's connection.init.
 */
const userCodecs = new Map<string, AudioCodec>()
const userLc3FrameSizes = new Map<string, Lc3FrameSizeBytes>()
let running = true

/**
 * Which transcription provider to use. Defaults to the real Soniox provider, so
 * production is real unless told otherwise. Tests can override this when they
 * exercise routing / scaling / failover without depending on transcription.
 */
const PROVIDER_KIND = process.env.AUDIO_PROVIDER ?? "soniox"

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
const XREAD_IDLE_SLEEP_MS = 50
/** Both control and audio reads poll per-user (one stream per command) to stay
 *  Redis Cluster-safe; this is the idle backoff when no control stream had
 *  entries this pass. */
const CONTROL_IDLE_SLEEP_MS = 100
const XAUTOCLAIM_COUNT = 500
const XAUTOCLAIM_MIN_IDLE_MS = 0
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

// Dedicated client for the control-stream read so control polling + XACKs
// don't serialize behind the audio read's per-user XREADGROUPs (and vice versa).
const controlClient = new Redis(REDIS_URL, {
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

/** Users whose control-stream consumer group has been ensured. */
const controlReadyUsers = new Set<string>()

async function handleAttach(mentraUserId: string): Promise<void> {
  ownedUsers.add(mentraUserId)
  // Decoder is needed for any audio activity; create it eagerly so the very
  // first packet has somewhere to land. Providers are NOT created until the
  // subscription set names one (or never, if the session only wants raw audio
  // routing).
  if (!decoders.has(mentraUserId)) {
    try {
      decoders.set(mentraUserId, await LC3Decoder.create(userLc3FrameSizes.get(mentraUserId) ?? 20))
    } catch (err) {
      logger.error({err}, "LC3Decoder.create failed")
    }
  }
  const ok = await ensureConsumerGroup(mentraUserId)
  // Control-stream group too, so subscription-change nudges for this user land
  // in our consumer once we own them. Independent of the audio group result;
  // we still want to read control even if the audio stream isn't ready yet.
  await ensureControlConsumerGroup(mentraUserId)
  if (ok && ownedUsers.has(mentraUserId)) {
    readyUsers.add(mentraUserId)
  }
  // Reconcile from the subscription key on attach/ownership-acquire. A takeover
  // worker inherits the live subscription set from the key, so providers come
  // back up without waiting for the next REST write. The key is the source of
  // truth; a missing key means "no subscriptions yet" (empty set).
  await reconcileFromKey(mentraUserId)
}

/**
 * Read the user's authoritative subscription set from the Redis key and
 * reconcile providers against it. The key is the single source of truth; this
 * runs on attach, on a control-stream nudge, and on the main thread's
 * post-seed nudge. A missing key reconciles to an empty set.
 */
async function reconcileFromKey(mentraUserId: string): Promise<void> {
  let subs: AudioSubscription[] = []
  try {
    const raw = await mainClient.get(subscriptionsKey(mentraUserId))
    if (raw) {
      const record = JSON.parse(raw) as SubscriptionRecord
      subs = record.subscriptions ?? []
    }
  } catch (err) {
    logger.error({err}, "reconcileFromKey read failed")
    return
  }
  await reconcileProviders(mentraUserId, subs)
}

/** Subscription key, mirrored from `subscriptions-store.ts` (hash-tagged per user). */
function subscriptionsKey(mentraUserId: string): string {
  return `{user:${mentraUserId}}:subscriptions`
}

/**
 * Reconcile a user's active providers against a fresh subscription list.
 * Closes providers whose subscriptions disappeared; opens providers for
 * new subs. Idempotent for unchanged subs (no recreation).
 */
async function reconcileProviders(mentraUserId: string, subs: AudioSubscription[]): Promise<void> {
  userSubs.set(mentraUserId, subs)

  const existing = userProviders.get(mentraUserId) ?? new Map<string, TranscriptionProvider>()
  userProviders.set(mentraUserId, existing)
  const creating = userProviderCreates.get(mentraUserId) ?? new Map<string, Promise<TranscriptionProvider>>()
  userProviderCreates.set(mentraUserId, creating)

  // Compute desired set: one entry per subscription, transcription AND
  // translation. They share the provider interface; output messages
  // carry a `kind` discriminator so the client knows which is which.
  const desired = new Map<string, AudioSubscription>()
  for (const sub of subs) {
    desired.set(subscriptionKey(sub), sub)
  }

  // Close providers whose subs are gone.
  for (const [key, provider] of existing) {
    if (!desired.has(key)) {
      existing.delete(key)
      provider.close().catch((err) => {
        logger.error({err}, "provider close failed")
      })
    }
  }

  // Open providers for new subs.
  for (const [key, sub] of desired) {
    if (existing.has(key)) continue
    const pending = creating.get(key)
    if (pending) {
      try {
        const provider = await pending
        if (shouldKeepProvider(mentraUserId, key) && !existing.has(key)) {
          existing.set(key, provider)
        } else if (!existing.has(key)) {
          provider.close().catch((err) => {
            logger.error({err}, "provider close failed")
          })
        }
      } catch (err) {
        logger.error({err}, "provider create failed")
      }
      continue
    }

    const creation = createProvider(mentraUserId, sub)
    creating.set(key, creation)
    try {
      const provider = await creation
      if (shouldKeepProvider(mentraUserId, key) && !existing.has(key)) {
        existing.set(key, provider)
      } else {
        provider.close().catch((err) => {
          logger.error({err}, "provider close failed")
        })
      }
    } catch (err) {
      logger.error({err}, "provider create failed")
    } finally {
      if (creating.get(key) === creation) creating.delete(key)
      if (creating.size === 0) userProviderCreates.delete(mentraUserId)
    }
  }
}

function shouldKeepProvider(mentraUserId: string, key: string): boolean {
  if (!ownedUsers.has(mentraUserId)) return false
  if (!userProviders.has(mentraUserId)) return false
  const subs = userSubs.get(mentraUserId) ?? []
  return subs.some((sub) => subscriptionKey(sub) === key)
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
  // Detection hints only exist on an auto-mode transcription source; carry them
  // to the provider so `configure({languageHints})` actually biases Soniox
  // (issue 021). A specific language ignores them — the language is the hint.
  const languageHints =
    !isTranslation && sub.kind === "transcription" && sub.language.mode === "auto"
      ? sub.language.hints
      : undefined

  const onTranscript = (event: TranscriptEvent) => {
    const out: TranscriptMessage = {
      type: "TRANSCRIPT",
      kind: sub.kind,
      mentraUserId,
      text: event.text,
      isFinal: event.isFinal,
      utteranceId: event.utteranceId,
      speakerId: event.speakerId,
      // For transcription: text is in the source/auto language.
      // For translation: text is in the target language.
      language: event.language ?? providerLanguage,
      // Detected source language wins over the subscription's static value
      // (often "auto"), so clients can show what was actually spoken.
      sourceLanguage: event.sourceLanguage ?? sourceLanguage,
      originalText: event.originalText,
      startMs: event.startMs,
      endMs: event.endMs,
      source: PROVIDER_KIND,
      subscription: sub,
    }
    self.postMessage(out)
  }
  const onError = (err: Error) => {
    logger.error({err, mentraUserId}, `provider(${PROVIDER_KIND}) error`)
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
        languageHints,
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
    case "SET_CODEC":
      userCodecs.set(msg.mentraUserId, msg.codec)
      if (msg.frameSizeBytes) {
        userLc3FrameSizes.set(msg.mentraUserId, msg.frameSizeBytes)
        const existing = decoders.get(msg.mentraUserId)
        if (existing && existing.frameBytes !== msg.frameSizeBytes) {
          void LC3Decoder.create(msg.frameSizeBytes)
            .then((decoder) => {
              decoders.set(msg.mentraUserId, decoder)
            })
            .catch((err) => {
              logger.error({err}, "LC3Decoder.create failed")
            })
        }
      }
      break
    case "DETACH_USER": {
      ownedUsers.delete(msg.mentraUserId)
      readyUsers.delete(msg.mentraUserId)
      controlReadyUsers.delete(msg.mentraUserId)
      decoders.delete(msg.mentraUserId)
      userLc3FrameSizes.delete(msg.mentraUserId)
      userSubs.delete(msg.mentraUserId)
      userCodecs.delete(msg.mentraUserId)
      userProviderCreates.delete(msg.mentraUserId)
      const providers = userProviders.get(msg.mentraUserId)
      if (providers) {
        userProviders.delete(msg.mentraUserId)
        for (const provider of providers.values()) {
          provider.close().catch((err) => {
            logger.error({err}, "provider close failed")
          })
        }
      }
      break
    }
    case "UPDATE_SUBSCRIPTIONS":
      // Nudge: re-read the subscription key and reconcile. The message carries
      // no subs on purpose; the key is the source of truth.
      void reconcileFromKey(msg.mentraUserId)
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
    logger.error({err}, "xgroup create failed")
    return false
  }
}

async function ensureControlConsumerGroup(mentraUserId: string): Promise<boolean> {
  try {
    // Start at `0` rather than `$`: UDP liveness ACKs can be published by a
    // non-owner pod milliseconds after connection.ack, before the owner worker
    // has finished creating this group. Starting at `$` would skip that ACK
    // forever. Control streams are bounded and nudges are idempotent, so
    // replaying a tiny backlog is safer than missing a liveness result.
    await controlClient.xgroup("CREATE", controlStreamKey(mentraUserId), CONTROL_STREAM_GROUP, "0", "MKSTREAM")
    controlReadyUsers.add(mentraUserId)
    return true
  } catch (err) {
    const msg = (err as Error).message ?? ""
    if (msg.includes("BUSYGROUP")) {
      controlReadyUsers.add(mentraUserId)
      return true
    }
    logger.error({err}, "control xgroup create failed")
    return false
  }
}

// === Main loops ===

/**
 * Read the control stream for owned users and reconcile on each nudge. Separate
 * from the audio loop (and on its own Redis client) so subscription changes are
 * never stuck behind the blocking audio read, and the audio hot path never has
 * to branch on control entries.
 */
async function controlReadLoop(): Promise<void> {
  while (running) {
    const users = [...controlReadyUsers]
    if (users.length === 0) {
      await Bun.sleep(100)
      continue
    }

    let sawEntries = false
    for (const userId of users) {
      try {
        // One stream per command: Redis Cluster requires all keys in a command
        // to share a hash slot, and each user's control stream hashes to that
        // user. A per-user read avoids CROSSSLOT (mirrors freshReadLoop).
        const result = (await controlClient.xreadgroup(
          "GROUP",
          CONTROL_STREAM_GROUP,
          CONSUMER_NAME,
          "COUNT",
          100,
          "STREAMS",
          controlStreamKey(userId),
          ">",
        )) as Array<[string, Array<[string, string[]]>]> | null

        if (!result) continue
        sawEntries = true

        for (const [streamKey, entries] of result) {
          const mentraUserId = controlUserFromKey(streamKey)
          let shouldReconcile = false

          for (const [, fields] of entries) {
            const map = fieldArrayToMap(fields)
            switch (map.kind) {
              case "subscriptions-changed":
                // Reconcile once per batch, not once per entry: every subscription
                // entry is the same "re-read the key" nudge.
                shouldReconcile = true
                break
              case "udp-liveness-ack":
                logger.debug(
                  {
                    mentraUserId,
                    sessionTag: map.sessionTag,
                    probeId: map.probeId,
                  },
                  "udp liveness ack control received",
                )
                self.postMessage({
                  type: "UDP_LIVENESS_ACK",
                  mentraUserId,
                  sessionTag: Number(map.sessionTag ?? 0),
                  audioSessionId: map.audioSessionId ?? "",
                  probeId: map.probeId ?? "",
                  receivedAt: Number(map.receivedAt ?? Date.now()),
                } satisfies UdpLivenessAckMessage)
                break
            }
          }

          if (shouldReconcile) await reconcileFromKey(mentraUserId)

          for (const [entryId] of entries) {
            try {
              await controlClient.xack(streamKey, CONTROL_STREAM_GROUP, entryId)
            } catch (err) {
              logger.error({err}, "control xack failed")
            }
          }
        }
      } catch (err) {
        const msg = (err as Error).message ?? ""
        if (msg.includes("NOGROUP")) {
          await ensureControlConsumerGroup(userId)
          continue
        }
        logger.error({err}, "control xreadgroup failed")
        await Bun.sleep(500)
      }
    }
    if (!sawEntries) await Bun.sleep(CONTROL_IDLE_SLEEP_MS)
  }
}

/** Recover the user id from a `{user:X}:control` stream key. */
function controlUserFromKey(streamKey: string): string {
  return streamKey.replace(/^\{user:/, "").replace(/\}:control$/, "")
}

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

    let sawEntries = false
    for (const userId of users) {
      try {
        // One stream per command: Redis Cluster requires all keys in a command
        // to share a hash slot, and each user's audio stream intentionally
        // hashes to that user. A per-user read avoids CROSSSLOT while keeping
        // the worker's ownership set unchanged.
        const result = (await streamsClient.xreadgroup(
          "GROUP",
          AUDIO_STREAM_GROUP,
          CONSUMER_NAME,
          "COUNT",
          XREAD_COUNT_PER_STREAM,
          "STREAMS",
          audioStreamKey(userId),
          ">",
        )) as Array<[string, Array<[string, string[]]>]> | null

        if (result) {
          sawEntries = true
          await processBatch(result, "live")
        }
      } catch (err) {
        const msg = (err as Error).message ?? ""
        // NOGROUP can happen if a stream got DEL'd out from under us (tests
        // wipe Redis between cases; production this would only happen if
        // someone manually nuked a stream key). Re-ensure this user's group;
        // the next iteration picks up cleanly.
        if (msg.includes("NOGROUP")) {
          await ensureConsumerGroup(userId)
          continue
        }
        logger.error({err}, "xreadgroup failed")
        await Bun.sleep(500)
      }
    }
    if (!sawEntries) await Bun.sleep(XREAD_IDLE_SLEEP_MS)
  }
}

async function autoclaimLoop(): Promise<void> {
  while (running) {
    for (const userId of readyUsers) {
      try {
        await drainAutoclaim(userId)
      } catch (err) {
        logger.error({err}, "autoclaim failed")
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
    // Stream keys are `{user:X}:audio` (hash-tagged so a user's keys share a
    // cluster shard — see audioStreamKey). The old `audio:X` parse silently
    // produced a mangled user id, so decoder/provider lookups missed and every
    // frame was dropped on the floor (providers saw "No audio received").
    const keyMatch = /^\{user:(.+)\}:audio$/.exec(streamKey)
    const mentraUserId = keyMatch ? keyMatch[1]! : streamKey.replace(/^audio:/, "")
    const decoder = decoders.get(mentraUserId)
    const codec = userCodecs.get(mentraUserId) ?? "lc3"

    for (const [entryId, fields] of entries) {
      const map = fieldArrayToMap(fields)
      const seq = Number(map.seq ?? 0)
      const audioSessionId = map.audioSessionId ?? ""

      // Recover the binary payload from the base64 we encoded on XADD.
      const payloadBytes = typeof map.payload === "string" ? Buffer.from(map.payload, "base64") : Buffer.alloc(0)
      const payloadLen = payloadBytes.byteLength

      // Turn the payload into Int16 mono PCM, then feed it to each subscribed
      // provider for this user. For "lc3" we decode; for "pcm" the payload
      // already IS PCM, so we wrap it as Int16 directly (no encoder needed on
      // the sending side — handy for tests and raw-PCM clients).
      //
      // If the user has no subscriptions, the PCM is computed (so the
      // TRANSCRIPT_STUB byte count is accurate) but no provider fires — the
      // correct behavior for a session that hasn't asked to be transcribed.
      let pcm: Int16Array | null = null
      if (payloadLen > 0) {
        if (codec === "pcm") {
          // Align to Int16 (drop a trailing odd byte if present).
          const usableSamples = Math.floor(payloadLen / 2)
          pcm = new Int16Array(payloadBytes.buffer, payloadBytes.byteOffset, usableSamples)
        } else if (decoder) {
          pcm = decoder.decode(new Uint8Array(payloadBytes.buffer, payloadBytes.byteOffset, payloadLen))
        }
      }

      let pcmBytesLen = 0
      if (pcm) {
        pcmBytesLen = pcm.byteLength
        const providers = userProviders.get(mentraUserId)
        if (providers) {
          for (const provider of providers.values()) {
            try {
              provider.writeAudio(pcm)
            } catch (err) {
              logger.error({err}, "provider.writeAudio failed")
            }
          }
        }
      }

      // One log per ~5s of audio (every 128th entry) so the feed path is
      // observable without flooding: payload size, codec, decode result, and
      // how many providers the PCM actually reached.
      if (seq % 128 === 0) {
        logger.info(
          {
            user: mentraUserId.slice(-6),
            seq,
            payloadBytes: payloadLen,
            codec,
            hasDecoder: decoders.has(mentraUserId),
            pcmBytes: pcmBytesLen,
            providers: userProviders.get(mentraUserId)?.size ?? 0,
          },
          "feed",
        )
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
        logger.error({err}, "xack failed")
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
    await Promise.all([
      streamsClient.quit().catch(() => undefined),
      mainClient.quit().catch(() => undefined),
      controlClient.quit().catch(() => undefined),
    ])
  } catch {
    /* ignore */
  }
}

// Boot: wait for BOTH Redis clients to be `ready` before announcing
// WORKER_READY. ioredis with `enableOfflineQueue: false` rejects commands
// during the connecting phase, so any ATTACH_USER that arrives before the
// clients are up would hit "Stream isn't writeable."
async function bootstrap(): Promise<void> {
  await Promise.all([waitForReady(streamsClient), waitForReady(mainClient), waitForReady(controlClient)])
  self.postMessage({type: "WORKER_READY"} satisfies WorkerReadyMessage)
  void freshReadLoop()
  void autoclaimLoop()
  void controlReadLoop()
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

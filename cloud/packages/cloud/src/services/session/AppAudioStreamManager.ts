/**
 * AppAudioStreamManager — per-user manager for audio output streaming.
 *
 * Follows the same pattern as AudioManager, TranscriptionManager, etc.:
 * - One instance per UserSession (state is isolated per user)
 * - Constructed in UserSession constructor, disposed in UserSession.dispose()
 * - ZERO global/static state
 *
 * ## Auto-reconnect design
 *
 * The SDK developer creates a stream, writes audio chunks whenever they have
 * them, and calls end() when done. Gaps of any duration between writes are
 * fine — the developer never thinks about phone connectivity.
 *
 * Behind the scenes, the phone plays audio via an HTTP chunked GET to the
 * relay URL. If no data arrives for a while (conversational gap), ExoPlayer
 * closes the HTTP connection. That's fine — when the SDK writes new audio:
 *
 *   1. Cloud buffers the chunks
 *   2. Cloud creates a fresh TransformStream (new readable for the phone)
 *   3. Cloud sends AUDIO_PLAY_REQUEST to the phone (via the glasses WS)
 *   4. Phone does HTTP GET to the same relay URL
 *   5. Cloud flushes the buffer into the new stream and resumes piping
 *
 * The stream URL is stable for its entire lifetime. The phone can reconnect
 * to it any number of times. The SDK never knows or cares.
 *
 * Flow:
 *   1. SDK sends AUDIO_STREAM_START → handler calls this.createStream()
 *   2. SDK sends WS binary frames (streamId + MP3 data) → handler calls this.writeToStream()
 *   3. Phone GETs /api/audio/stream/:userId/:streamId → route calls claimStream()
 *   4. Phone disconnects (gap) → writeToStream detects it, buffers, triggers reconnect
 *   5. Phone GETs same URL again → route calls claimStream() again → buffer flushed
 *   6. SDK sends AUDIO_STREAM_END → handler calls this.endStream()
 *
 * The cloud does ZERO transcoding. It just pipes bytes. If the SDK sends MP3,
 * the phone gets MP3.
 *
 * See: cloud/issues/041-sdk-audio-output-streaming/
 */

import type { Logger } from "pino";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Callback the manager uses to send an AUDIO_PLAY_REQUEST to the phone.
 * Injected by the UserSession constructor so the manager stays decoupled
 * from WebSocket internals.
 */
export type SendPlayRequestFn = (streamId: string, streamUrl: string, packageName: string) => boolean;

export interface ActiveStream {
  /** Unique stream ID (UUID) */
  streamId: string;

  /** Package name of the SDK app that created this stream */
  packageName: string;

  /** The stable relay URL the phone GETs — never changes for the stream's lifetime */
  streamUrl: string | null;

  /** MIME type (default: audio/mpeg) */
  contentType: string;

  /** Creation timestamp */
  createdAt: number;

  /** Epoch ms of last data write from the SDK — used for abandon timeout */
  lastWriteTime: number;

  /**
   * Whether the SDK has called endStream(). Once true, no more writes are
   * accepted and the stream will be cleaned up after the phone finishes
   * playing any buffered audio.
   */
  ended: boolean;

  // ─── Phone connection state ──────────────────────────────────────────

  /**
   * The writable side of the current TransformStream piping to the phone.
   * null when no phone reader is connected.
   */
  writer: WritableStreamDefaultWriter<Uint8Array> | null;

  /**
   * The readable side of the current TransformStream — returned to the
   * HTTP route handler when the phone connects. null when no phone reader
   * is connected (or between reconnections).
   */
  readable: ReadableStream<Uint8Array> | null;

  /**
   * Audio chunks received from the SDK while no phone reader is connected.
   * Flushed into the writer as soon as the phone reconnects.
   */
  pendingChunks: Uint8Array[];

  /**
   * True when we've already sent an AUDIO_PLAY_REQUEST and are waiting
   * for the phone to connect. Prevents duplicate requests.
   */
  reconnecting: boolean;

  /** Cleanup timer — abandon timeout for truly dead streams */
  timer: ReturnType<typeof setTimeout> | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * How long (ms) a stream can exist after the last SDK write before being
 * cleaned up as abandoned. This is a safety net for crashed apps or
 * forgotten streams — NOT for conversational gaps (those are handled by
 * the reconnect mechanism).
 *
 * 60 seconds is generous. A developer who hasn't written audio for a full
 * minute has almost certainly moved on.
 */
const ABANDON_TIMEOUT_MS = 60_000;

/**
 * How long (ms) a freshly created stream can exist without the phone ever
 * connecting. If the phone never GETs the relay URL, something is wrong.
 */
const INITIAL_CLAIM_TIMEOUT_MS = 15_000;

/**
 * Maximum number of bytes to buffer while waiting for the phone to reconnect.
 * Prevents unbounded memory growth if the phone is truly gone. At 128kbps
 * MP3, 2MB ≈ ~125 seconds of audio — way more than we'd ever buffer in
 * practice (typically <1 second during reconnection).
 */
const MAX_PENDING_BYTES = 2 * 1024 * 1024;

/**
 * How long (ms) to wait after triggering a phone reconnect before giving up
 * and dropping the buffered audio. If the phone can't reconnect in 10 seconds,
 * the connection is likely truly dead.
 */
const RECONNECT_TIMEOUT_MS = 10_000;

// ─── Manager Class ───────────────────────────────────────────────────────────

export class AppAudioStreamManager {
  private readonly logger: Logger;
  private readonly userId: string;
  private readonly sendPlayRequest: SendPlayRequestFn;

  /** This user's active streams (typically 0 or 1) */
  private streams = new Map<string, ActiveStream>();

  private disposed = false;

  constructor(userId: string, logger: Logger, sendPlayRequest: SendPlayRequestFn) {
    this.userId = userId;
    this.sendPlayRequest = sendPlayRequest;
    this.logger = logger.child({ service: "AppAudioStreamManager" });
  }

  // ─── Stream Lifecycle ────────────────────────────────────────────────────

  /**
   * Create a new streaming relay for this user.
   *
   * Called when the cloud receives AUDIO_STREAM_START from the SDK.
   * The stream doesn't have a phone reader yet — that happens when the
   * phone GETs the relay URL.
   */
  createStream(streamId: string, packageName: string, contentType: string = "audio/mpeg"): boolean {
    if (this.disposed) {
      this.logger.warn({ streamId }, "Cannot create stream — manager disposed");
      return false;
    }

    if (this.streams.has(streamId)) {
      this.logger.warn({ streamId }, "Stream already exists for this user, ignoring duplicate");
      return false;
    }

    // DON'T create a TransformStream yet — the phone hasn't connected.
    // Any SDK writes before the phone GETs the relay URL go into pendingChunks
    // and get flushed when claimStream() creates the first TransformStream.
    // Creating one here would waste it: claimStream() closes the old writer
    // and creates a fresh one, silently discarding any queued data.

    const stream: ActiveStream = {
      streamId,
      packageName,
      streamUrl: null, // Set after handleAudioStreamStart builds the URL
      contentType,
      createdAt: Date.now(),
      lastWriteTime: Date.now(),
      ended: false,

      writer: null,
      readable: null,
      pendingChunks: [],
      reconnecting: false,

      timer: null,
    };

    // Start initial claim timeout — if the phone never connects, clean up.
    // writer starts null, so we check that it's STILL null after the timeout
    // (claimStream sets it to a real writer when the phone connects).
    stream.timer = setTimeout(() => {
      if (!stream.writer) {
        this.logger.warn({ streamId, packageName }, "Stream never claimed by phone, cleaning up");
        this.destroyStream(streamId);
      }
    }, INITIAL_CLAIM_TIMEOUT_MS);

    this.streams.set(streamId, stream);

    this.logger.debug({ streamId, packageName, contentType }, "Stream relay created");
    return true;
  }

  /**
   * Set the stable relay URL for a stream. Called by handleAudioStreamStart
   * after building the URL from the cloud's public hostname.
   */
  setStreamUrl(streamId: string, streamUrl: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.streamUrl = streamUrl;
    }
  }

  /**
   * Claim a stream for HTTP reading (called when the phone connects).
   *
   * This can be called MULTIPLE TIMES for the same streamId — that's the
   * whole point. First call is the initial connection. Subsequent calls
   * are reconnections after gaps.
   *
   * Returns { readable, contentType } for the HTTP response, or null if
   * the stream doesn't exist or has ended.
   */
  claimStream(streamId: string): { readable: ReadableStream<Uint8Array>; contentType: string } | null {
    const stream = this.streams.get(streamId);
    if (!stream) return null;

    // If the stream has ended and there's nothing left to play, reject
    if (stream.ended && stream.pendingChunks.length === 0) {
      return null;
    }

    // Cancel any existing timers (initial claim timeout, reconnect timeout, abandon)
    this.clearTimer(stream);

    // If there's an old writer from a previous phone connection, close it
    // gracefully. The old HTTP response will end.
    if (stream.writer) {
      try {
        stream.writer.close().catch(() => {});
      } catch {
        // Already closed
      }
    }

    // Create a fresh TransformStream for this phone connection
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    stream.writer = writer;
    stream.readable = readable;
    stream.reconnecting = false;

    this.logger.debug(
      { streamId, pendingChunks: stream.pendingChunks.length },
      "Phone connected to audio stream relay",
    );

    // Flush any audio that arrived while the phone was disconnected
    if (stream.pendingChunks.length > 0) {
      this.flushPendingChunks(stream);
    }

    // If the stream was already ended by the SDK, close the writer after
    // flushing so the phone gets all remaining audio and then the HTTP
    // response ends cleanly.
    if (stream.ended) {
      writer.close().catch(() => {});
      // Clean up the stream entry after a short delay to let the HTTP
      // response drain
      setTimeout(() => this.streams.delete(streamId), 1000);
    } else {
      // Start the abandon timeout (resets on each write from the SDK)
      this.resetAbandonTimer(streamId, stream);
    }

    return { readable, contentType: stream.contentType };
  }

  /**
   * Write audio data to a stream.
   *
   * Called when the cloud receives a WS binary frame from the SDK.
   * If the phone is connected, pipes directly. If not, buffers and
   * triggers a reconnect.
   */
  async writeToStream(streamId: string, data: Uint8Array): Promise<boolean> {
    const stream = this.streams.get(streamId);
    if (!stream || stream.ended) return false;

    stream.lastWriteTime = Date.now();

    // Happy path: phone is connected, pipe directly
    if (stream.writer) {
      try {
        await stream.writer.write(data);
        this.resetAbandonTimer(streamId, stream);
        return true;
      } catch {
        // Writer failed — phone disconnected. Fall through to reconnect path.
        this.logger.debug({ streamId }, "Phone reader disconnected, switching to buffer + reconnect");
        stream.writer = null;
        stream.readable = null;
      }
    }

    // Phone is not connected — buffer the chunk and trigger reconnect
    this.bufferChunk(stream, data);
    this.triggerReconnect(stream);
    return true;
  }

  /**
   * End a stream gracefully.
   *
   * Called when the cloud receives AUDIO_STREAM_END from the SDK.
   * If the phone is connected, closes the writer (HTTP response ends,
   * ExoPlayer finishes buffered audio). If not, marks as ended so the
   * next phone connection gets the remaining buffer and then closes.
   */
  async endStream(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) return;

    this.logger.debug({ streamId }, "Audio stream end requested");
    stream.ended = true;
    this.clearTimer(stream);

    if (stream.writer) {
      try {
        await stream.writer.close();
      } catch {
        // Already closed
      }
      // Clean up after a short delay to let HTTP response drain
      setTimeout(() => this.streams.delete(streamId), 1000);
    } else if (stream.pendingChunks.length > 0) {
      // There's buffered audio but no phone reader. The next claimStream()
      // call will flush it and then close. If the phone never reconnects,
      // the reconnect timeout will clean up.
      if (!stream.reconnecting) {
        this.triggerReconnect(stream);
      }
    } else {
      // No writer, no pending audio — just clean up
      this.streams.delete(streamId);
    }
  }

  /**
   * Destroy a stream immediately (interrupt/timeout/dispose).
   *
   * Aborts the writer (if any) which causes the HTTP response to end
   * abruptly, and drops any pending audio.
   */
  destroyStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;

    this.logger.debug({ streamId }, "Stream destroyed");
    this.clearTimer(stream);
    stream.pendingChunks = [];

    if (stream.writer) {
      try {
        stream.writer.abort("Stream destroyed");
      } catch {
        // Already closed
      }
    }

    this.streams.delete(streamId);
  }

  // ─── Query Methods ───────────────────────────────────────────────────────

  hasStream(streamId: string): boolean {
    return this.streams.has(streamId);
  }

  getStreamCount(): number {
    return this.streams.size;
  }

  // ─── Dispose ─────────────────────────────────────────────────────────────

  /**
   * Dispose — destroy all streams for this user.
   * Called by UserSession.dispose(). After this, the manager is dead.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const streamId of this.streams.keys()) {
      this.destroyStream(streamId);
    }

    this.logger.debug("AppAudioStreamManager disposed");
  }

  // ─── Internal: Buffering ─────────────────────────────────────────────────

  /**
   * Add a chunk to the pending buffer, enforcing the max size limit.
   * If the buffer is full, drop the oldest chunks to make room.
   */
  private bufferChunk(stream: ActiveStream, data: Uint8Array): void {
    const currentSize = stream.pendingChunks.reduce((sum, c) => sum + c.length, 0);

    if (currentSize + data.length > MAX_PENDING_BYTES) {
      // Drop oldest chunks until there's room
      let freed = 0;
      while (stream.pendingChunks.length > 0 && freed < data.length) {
        const dropped = stream.pendingChunks.shift()!;
        freed += dropped.length;
      }
      this.logger.debug(
        { streamId: stream.streamId, freedBytes: freed },
        "Dropped oldest audio chunks to stay within buffer limit",
      );
    }

    stream.pendingChunks.push(data);
  }

  /**
   * Flush all pending chunks into the current writer.
   * Called when the phone (re)connects and there's buffered audio.
   */
  private flushPendingChunks(stream: ActiveStream): void {
    if (!stream.writer || stream.pendingChunks.length === 0) return;

    const chunks = stream.pendingChunks;
    stream.pendingChunks = [];

    const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
    this.logger.debug(
      { streamId: stream.streamId, chunks: chunks.length, totalBytes },
      "Flushing buffered audio to phone",
    );

    // Write all buffered chunks. We don't await each one individually —
    // the WritableStream queues them internally.
    for (const chunk of chunks) {
      stream.writer.write(chunk).catch(() => {
        // If write fails during flush, the phone disconnected again.
        // The next writeToStream() call will detect it and re-buffer.
      });
    }
  }

  // ─── Internal: Phone Reconnection ────────────────────────────────────────

  /**
   * Tell the phone to reconnect to the stream relay.
   *
   * Sends an AUDIO_PLAY_REQUEST through the glasses WS. The phone starts
   * a new ExoPlayer instance that does HTTP GET to the same relay URL.
   * The HTTP route calls claimStream() which creates a fresh TransformStream
   * and flushes the buffer.
   */
  private triggerReconnect(stream: ActiveStream): void {
    if (stream.reconnecting) return; // Already in progress
    if (!stream.streamUrl) {
      this.logger.warn({ streamId: stream.streamId }, "Cannot reconnect — no stream URL set");
      return;
    }

    stream.reconnecting = true;

    this.logger.debug({ streamId: stream.streamId }, "Triggering phone reconnect to audio stream");

    const sent = this.sendPlayRequest(stream.streamId, stream.streamUrl, stream.packageName);

    if (!sent) {
      // Glasses WS is not connected — can't reach the phone.
      // The audio will stay buffered. If the glasses reconnect and the
      // SDK writes more audio, we'll try again.
      stream.reconnecting = false;
      this.logger.debug({ streamId: stream.streamId }, "Could not send play request (glasses WS not open)");
      return;
    }

    // Start a reconnect timeout — if the phone doesn't connect within
    // RECONNECT_TIMEOUT_MS, drop the buffer and give up on this reconnect
    // attempt. The next SDK write will try again.
    this.clearTimer(stream);
    stream.timer = setTimeout(() => {
      if (stream.reconnecting) {
        this.logger.warn({ streamId: stream.streamId }, "Phone reconnect timed out");
        stream.reconnecting = false;
        // Don't destroy the stream — the SDK might write more audio later
        // and we'll try reconnecting again. But do clear the buffer to
        // prevent unbounded growth for truly dead connections.
        stream.pendingChunks = [];

        // If the stream was already ended, clean up entirely
        if (stream.ended) {
          this.streams.delete(stream.streamId);
        }
      }
    }, RECONNECT_TIMEOUT_MS);
  }

  // ─── Internal: Timers ────────────────────────────────────────────────────

  /**
   * Reset the abandon timer. Fires when the SDK hasn't written any audio
   * for ABANDON_TIMEOUT_MS — indicates the stream is truly dead (app
   * crashed, developer forgot to call end(), etc.).
   */
  private resetAbandonTimer(streamId: string, stream: ActiveStream): void {
    this.clearTimer(stream);

    stream.timer = setTimeout(() => {
      this.logger.warn({ streamId }, "Stream abandoned (no writes for 60s), cleaning up");
      this.destroyStream(streamId);
    }, ABANDON_TIMEOUT_MS);
  }

  private clearTimer(stream: ActiveStream): void {
    if (stream.timer) {
      clearTimeout(stream.timer);
      stream.timer = null;
    }
  }
}

// ─── Binary Frame Parser ─────────────────────────────────────────────────────

/**
 * Parse a binary WS frame into streamId + audio data.
 *
 * Binary frame protocol:
 *   [36 bytes: streamId as ASCII UUID] [N bytes: audio data]
 *
 * Returns null if the frame is too small or the header isn't a valid UUID.
 */
export function parseBinaryFrame(data: Buffer | Uint8Array): { streamId: string; audioData: Uint8Array } | null {
  if (data.length <= 36) {
    return null;
  }

  // First 36 bytes are the streamId (UUID as ASCII: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
  const streamId = new TextDecoder().decode(data.slice(0, 36));

  // Basic UUID format validation
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(streamId)) {
    return null;
  }

  const audioData =
    data instanceof Buffer ? new Uint8Array(data.buffer, data.byteOffset + 36, data.length - 36) : data.slice(36);

  return { streamId, audioData };
}

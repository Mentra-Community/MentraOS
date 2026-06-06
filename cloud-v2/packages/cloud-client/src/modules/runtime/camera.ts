/**
 * @fileoverview Camera: the managed-photo and managed-stream features, each a
 * REST request followed by awaiting the matching WebSocket push.
 *
 * Both flows are client-initiated REST on the runtime domain (any pod serves
 * them, no coupling to the audio session). The cloud is not in the image byte
 * path: it brokers a presigned upload and notifies the phone over the WebSocket
 * when capture completes. So each request here records a pending promise keyed by
 * `requestId` and resolves it when the matching push arrives, or rejects it on an
 * error push or a timeout.
 *
 * See docs/issues/002-cloud-runtime/camera/spec.md and
 * docs/issues/004-cloud-client/design.md ("Managed photo and stream").
 *
 * NOTE (endpoints TBD): the camera REST endpoints are not finalized server-side.
 * The paths below match the camera spec's current draft; treat them as
 * provisional until the camera service is built. The request/await shape is the
 * stable part.
 */
import type { HttpClient } from "../../http";
import type { CloudToClientMessage } from "@mentra/cloud-runtime/protocol";

/** Provisional REST paths from the camera spec draft (see file note above). */
const PHOTO_PATH = "/api/camera/photo";
const STREAM_PATH = "/api/camera/stream";

/** How long to wait for the completion push before failing a managed request. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Options for a managed photo capture.
 *
 * Mirrors the camera spec's `POST /api/camera/photo` body. All fields optional so
 * a caller can take a default photo with `requestPhoto({})`.
 */
export interface PhotoOptions {
  size?: "small" | "medium" | "large" | "full";
  compress?: "none" | "medium" | "heavy";
  saveToGallery?: boolean;
  sound?: boolean;
}

/** Options for provisioning a managed stream. Shape firms up with the service. */
export interface StreamOptions {
  /** Optional region hint so the cloud provisions a nearby ingest endpoint. */
  region?: string;
}

/**
 * A provisioned managed stream.
 *
 * `ingest` is where the glasses/phone push frames; `playback` is where viewers
 * watch. Both are left as open records because the provider (Cloudflare Stream by
 * default) is swappable per region and its exact field shapes are not finalized.
 */
export interface ManagedStream {
  streamId: string;
  ingest: Record<string, unknown>;
  playback: Record<string, unknown>;
}

/** What `requestPhoto` resolves to once the cloud confirms the photo is ready. */
export interface PhotoResult {
  requestId: string;
  readUrl: string;
}

export interface CameraDeps {
  http: HttpClient;
}

/**
 * A request that has been sent over REST and is waiting for its WebSocket push.
 *
 * The resolve/reject pair drives the promise the caller is awaiting; the timer is
 * tracked so it can be cleared the moment the push lands (and so a settled
 * request never fires a late timeout).
 */
interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A photo push from the cloud. Declared structurally here because the photo event
 * types are not yet in the protocol's validated message union (the camera service
 * is unbuilt). `handlePush` checks `type` before reading these, so an unrelated
 * message is never misread as a photo push.
 */
interface PhotoReadyPush {
  type: "photo.ready";
  payload: { requestId: string; readUrl: string };
}
interface PhotoErrorPush {
  type: "photo.error";
  payload: { requestId: string; reason: string };
}

export class Camera {
  private readonly http: HttpClient;

  /** In-flight photo requests, keyed by the `requestId` the cloud assigned. */
  private readonly pendingPhotos = new Map<string, Pending<PhotoResult>>();

  constructor(deps: CameraDeps) {
    this.http = deps.http;
  }

  /**
   * Request a managed photo and resolve once the cloud pushes `photo.ready`.
   *
   * The POST returns immediately with the `requestId` and the presigned
   * `readUrl`; the actual capture happens out of band on the glasses, so we
   * record a pending promise and wait for the `photo.ready` push (or reject on
   * `photo.error` / timeout). We register the pending entry keyed by the returned
   * `requestId` so a push that races ahead of our bookkeeping cannot be missed:
   * the POST has already resolved by the time we await it, so the key exists
   * before any push can be processed for it.
   */
  async requestPhoto(opts: PhotoOptions): Promise<PhotoResult> {
    const { requestId } = await this.http.post<{
      requestId: string;
      uploadUrl: string;
      readUrl: string;
    }>(PHOTO_PATH, opts);

    return new Promise<PhotoResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the entry first so the rejection cannot race a late push.
        this.pendingPhotos.delete(requestId);
        reject(new Error(`Managed photo ${requestId} timed out`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingPhotos.set(requestId, { resolve, reject, timer });
    });
  }

  /**
   * Provision a managed stream over REST.
   *
   * Unlike a photo, provisioning is fully answered by the REST response (ingest +
   * playback coordinates), so there is no push to await here. The client owns the
   * lifecycle from this point and polls/stops over REST.
   */
  async startStream(opts: StreamOptions): Promise<ManagedStream> {
    return await this.http.post<ManagedStream>(STREAM_PATH, opts);
  }

  /**
   * Stop a managed stream by id. The DELETE is the lifecycle end; the cloud tears
   * down the provider stream.
   */
  async stopStream(streamId: string): Promise<void> {
    await this.http.post<void>(`${STREAM_PATH}/${encodeURIComponent(streamId)}/stop`);
  }

  /**
   * Route an inbound WebSocket push to the pending request it completes.
   *
   * Called for every cloud-to-client message; it only acts on photo pushes and
   * ignores everything else, so the runtime can hand it the whole message stream
   * without pre-filtering. A push whose `requestId` has no pending entry (a late
   * duplicate after a timeout, say) is dropped harmlessly.
   */
  handlePush(msg: CloudToClientMessage): void {
    // `type` is a safe discriminant to read on any validated message. The photo
    // payloads are not yet in the protocol union, so we narrow structurally.
    const type = (msg as { type: string }).type;

    if (type === "photo.ready") {
      const { requestId, readUrl } = (msg as unknown as PhotoReadyPush).payload;
      const pending = this.takePending(requestId);
      pending?.resolve({ requestId, readUrl });
      return;
    }

    if (type === "photo.error") {
      const { requestId, reason } = (msg as unknown as PhotoErrorPush).payload;
      const pending = this.takePending(requestId);
      pending?.reject(new Error(`Managed photo ${requestId} failed: ${reason}`));
    }
  }

  /**
   * Remove and return the pending entry for `requestId`, clearing its timeout.
   *
   * Pulling the entry out before settling guarantees a request settles exactly
   * once: a duplicate push for the same id finds nothing left to settle.
   */
  private takePending(requestId: string): Pending<PhotoResult> | undefined {
    const pending = this.pendingPhotos.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pendingPhotos.delete(requestId);
    return pending;
  }
}

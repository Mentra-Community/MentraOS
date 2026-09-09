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
 * Only managed photo awaits a push (`photo.ready` / `photo.error`); managed
 * stream is fully answered by the REST response, so it just returns the
 * provisioned coordinates.
 *
 * See docs/issues/002-cloud-runtime/camera/spec.md and
 * docs/issues/004-cloud-client/design.md ("Camera").
 */
import type { HttpClient } from "../../http";
import { systemTimers, type CloudClientTimers } from "../../timers";
import type {
  CloudToClientMessage,
  PhotoOptions,
  StreamOptions,
  ManagedStream,
  StreamStatusResult,
} from "@mentra/cloud-protocol";

// The camera wire types are canonical in the protocol package (the cloud server
// uses the same ones); re-export them so a host gets them from this module.
export type {
  PhotoOptions,
  StreamOptions,
  ManagedStream,
  StreamStatusResult,
} from "@mentra/cloud-protocol";

const PHOTO_PATH = "/api/camera/photo";
const STREAM_PATH = "/api/camera/stream";

/** How long to wait for the completion push before failing a photo request. */
const REQUEST_TIMEOUT_MS = 30_000;

/** What `requestPhoto` resolves to once the cloud confirms the photo is ready. */
export interface PhotoResult {
  requestId: string;
  readUrl: string;
}

export interface CameraDeps {
  http: HttpClient;
  timers?: CloudClientTimers;
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
  timer: unknown;
}

export class Camera {
  private readonly http: HttpClient;
  private readonly timers: CloudClientTimers;

  /** In-flight photo requests, keyed by the `requestId` the cloud assigned. */
  private readonly pendingPhotos = new Map<string, Pending<PhotoResult>>();

  constructor(deps: CameraDeps) {
    this.http = deps.http;
    this.timers = deps.timers ?? systemTimers;
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
    const { requestId } = await this.startPhoto(opts);
    return this.awaitPhotoReady(requestId);
  }

  /**
   * Step 1 of the managed-photo flow: presign and return the coordinates.
   * Hosts that act as the DEVICE side too (a phone driving glasses over BLE)
   * need the uploadUrl to deliver the captured bytes themselves before the
   * `photo.ready` push can fire; plain consumers can keep using
   * {@link requestPhoto}, which composes both steps.
   */
  async startPhoto(opts: PhotoOptions): Promise<{
    requestId: string;
    uploadUrl: string;
    readUrl: string;
  }> {
    return await this.http.post<{
      requestId: string;
      uploadUrl: string;
      readUrl: string;
    }>(PHOTO_PATH, opts);
  }

  /** Step 2: resolve when the cloud pushes `photo.ready` for the request. */
  awaitPhotoReady(requestId: string): Promise<PhotoResult> {
    return new Promise<PhotoResult>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
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
   * The provider's view of a managed stream's ingest: is the device's push
   * arriving? Clients poll this to surface what the far end of the pipe sees.
   */
  async streamStatus(streamId: string): Promise<StreamStatusResult> {
    return await this.http.get<StreamStatusResult>(
      `${STREAM_PATH}/${encodeURIComponent(streamId)}`,
    );
  }

  /**
   * Stop a managed stream by id. `DELETE /api/camera/stream/:id` is the
   * lifecycle end; the cloud tears down the provider stream.
   */
  async stopStream(streamId: string): Promise<void> {
    await this.http.delete<void>(`${STREAM_PATH}/${encodeURIComponent(streamId)}`);
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
    // photo.ready / photo.error are in the validated message union, so the
    // discriminant narrows `msg.payload` to the typed camera payloads with no
    // cast. Any other message type is ignored here.
    if (msg.type === "photo.ready") {
      const { requestId, readUrl } = msg.payload;
      const pending = this.takePending(requestId);
      pending?.resolve({ requestId, readUrl });
      return;
    }

    if (msg.type === "photo.error") {
      const { requestId, reason } = msg.payload;
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
    this.timers.clearTimeout(pending.timer);
    this.pendingPhotos.delete(requestId);
    return pending;
  }
}

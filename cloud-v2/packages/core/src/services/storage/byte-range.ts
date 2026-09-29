/**
 * @fileoverview Single HTTP byte ranges for private media responses.
 *
 * Shared by the test-run asset route (streamed from storage) and the incident
 * report artifact route (a bounded in-memory payload). Multipart ranges are
 * deliberately unsupported.
 */

export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Inclusive end offset. */
  end: number;
}

/** A Range header that is malformed or cannot be satisfied (HTTP 416). */
export class ByteRangeError extends Error {}

/** Single HTTP byte range, inclusive. Invalid or multipart ranges are rejected. */
export function parseSingleByteRange(header: string | null, size: number): ByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new ByteRangeError("invalid byte range");
  const suffix = match[1] === "";
  const a = Number(match[1] || match[2]);
  const b = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || (suffix && a === 0)) throw new ByteRangeError("invalid byte range");
  const start = suffix ? Math.max(0, size - a) : a;
  const end = suffix ? size - 1 : Math.min(b, size - 1);
  if (start >= size || start > end) throw new ByteRangeError("unsatisfiable byte range");
  return { start, end };
}

/**
 * Respond with an in-memory payload, honoring one Range (206, or 416 with
 * `bytes *\/size`), If-Range against the strong `ETag` in `headers`, and HEAD.
 * Any other If-Range value serves the full payload. `headers` carries the
 * caller's content and security headers; lengths are always exact.
 */
export function bufferedRangeResponse(request: Request, bytes: Uint8Array, headers: Headers): Response {
  const size = bytes.byteLength;
  const out = new Headers(headers);
  out.set("accept-ranges", "bytes");
  const ifRange = request.headers.get("if-range");
  const etag = out.get("etag");
  let range: ByteRange | undefined;
  try {
    range = parseSingleByteRange(!ifRange || (etag !== null && ifRange === etag) ? request.headers.get("range") : null, size);
  } catch (error) {
    if (!(error instanceof ByteRangeError)) throw error;
    out.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers: out });
  }
  const start = range?.start ?? 0;
  const length = range ? range.end - range.start + 1 : size;
  out.set("content-length", String(length));
  if (range) out.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  return new Response(request.method === "HEAD" ? null : bodyView(bytes, start, length), { status: range ? 206 : 200, headers: out });
}

/**
 * The requested bytes as a view over a plain ArrayBuffer, which a Response
 * body accepts. A view over an ArrayBuffer is reused at its own offset
 * without copying; any other backing store (e.g. SharedArrayBuffer) is
 * copied into a new ArrayBuffer.
 */
function bodyView(bytes: Uint8Array, start: number, length: number): Uint8Array<ArrayBuffer> {
  const { buffer } = bytes;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer, bytes.byteOffset + start, length);
  const copy = new Uint8Array(length);
  copy.set(bytes.subarray(start, start + length));
  return copy;
}

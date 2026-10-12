/**
 * @fileoverview Single HTTP byte ranges for private media responses.
 *
 * Shared by the test-run asset route (streamed from storage) and the incident
 * report artifact route (also streamed from storage). Multipart ranges are
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
 * Stream a stat-verified object, honoring one Range (206, or 416 with
 * `bytes *\/size`), If-Range against the strong `ETag` in `headers`, and HEAD.
 * HEAD and invalid ranges do not open a body. `headers` carries the caller's
 * content and security headers; lengths are always exact.
 */
export async function streamedRangeResponse(
  request: Request,
  size: number,
  headers: Headers,
  stream: (range?: ByteRange) => Promise<ReadableStream<Uint8Array> | Blob>,
): Promise<Response> {
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
  const length = range ? range.end - range.start + 1 : size;
  out.set("content-length", String(length));
  if (range) out.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  let body = request.method === "HEAD" ? null : await stream(range);
  if (!range && request.headers.has("range") && body instanceof Blob) {
    // Bun otherwise applies the original Range again to a full-file Blob,
    // overriding the 200 required when If-Range did not match. Keep it lazy.
    body = body.stream().pipeThrough(new TransformStream());
  }
  return new Response(body, { status: range ? 206 : 200, headers: out });
}

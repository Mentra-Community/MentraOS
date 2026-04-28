export function estimateStringBytes(value?: string | null): number {
  if (!value) return 0;
  return Buffer.byteLength(value, "utf8");
}

export function estimateJsonBytes(value: unknown): number {
  if (value === undefined || value === null) return 0;

  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

export function sumEstimatedBytes<T>(items: Iterable<T>, estimate: (item: T) => number): number {
  let total = 0;
  for (const item of items) {
    total += estimate(item);
  }
  return total;
}

export function estimateArrayBufferBytes(value: ArrayBuffer | ArrayBufferView | Buffer | null | undefined): number {
  if (!value) return 0;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

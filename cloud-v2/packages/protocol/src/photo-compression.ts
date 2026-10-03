/** Photo compression is identical on the wire and in every SDK; omitted means none. */
export const photoCompressionValues = ["none", "low", "medium", "high"] as const;
export type PhotoCompression = (typeof photoCompressionValues)[number];

/** Validate without coercing aliases, casing, null, or unknown values. */
export function parsePhotoCompression(value: unknown = "none"): PhotoCompression {
  if (typeof value === "string" && photoCompressionValues.includes(value as PhotoCompression)) {
    return value as PhotoCompression;
  }
  throw new TypeError(`Invalid photo compression ${JSON.stringify(value)}. Expected none, low, medium, or high.`);
}

const SECRET_KEYS = new Set([
  "token",
  "apiKey",
  "api_key",
  "hashedApiKey",
  "authorization",
  "MENTRA_CLI_TOKEN",
  "MENTRA_AGENT_API_KEY",
  "MENTRA_ADMIN_JWT",
  "MENTRA_ADMIN_TOKEN",
]);

export function redactSecrets<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactSecrets(val);
      }
    }
    return out as T;
  }
  return value;
}

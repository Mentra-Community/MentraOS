/** Retain bounded OTA protocol codes; free-form device errors can contain signed URLs. */
export function redactOtaDiagnosticError(value: unknown): unknown {
  return typeof value === "string" && value && !/^[a-zA-Z0-9_:-]{1,100}$/.test(value) ? "[REDACTED]" : value
}

export function isG2RecoveryError(
  error: unknown,
): error is "errors:g2LeftArmUnavailable" | "errors:g2RightArmUnavailable" | "errors:g2ConnectionTimedOut" {
  return (
    error === "errors:g2LeftArmUnavailable" ||
    error === "errors:g2RightArmUnavailable" ||
    error === "errors:g2ConnectionTimedOut"
  )
}

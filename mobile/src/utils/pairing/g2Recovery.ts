import {translate} from "@/i18n"

export function getG2ResetInstructions(): string {
  return `${translate("pairing:g2ResetInstructions")}\n\n${translate("pairing:g2ResetOlderHardware")}`
}

export function isG2RecoveryError(
  error: unknown,
): error is "errors:g2LeftArmUnavailable" | "errors:g2RightArmUnavailable" | "errors:g2ConnectionTimedOut" {
  return (
    error === "errors:g2LeftArmUnavailable" ||
    error === "errors:g2RightArmUnavailable" ||
    error === "errors:g2ConnectionTimedOut"
  )
}

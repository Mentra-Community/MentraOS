import {Text} from "@/components/ignite"

/** The native G2 session applies the delay and clears this when both arms connect. */
export default function G2ConnectionProgress({missingArm}: {missingArm?: "left" | "right" | null}) {
  if (!missingArm) return null
  return (
    <Text
      accessibilityLiveRegion="polite"
      className="text-sm text-muted-foreground"
      tx={missingArm === "left" ? "pairing:g2WaitingForLeft" : "pairing:g2WaitingForRight"}
    />
  )
}

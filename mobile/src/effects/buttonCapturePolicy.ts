/**
 * Mentra Live owns its hardware button natively only when no miniapp has an
 * active button_press subscription. Running a miniapp alone does not transfer
 * button ownership.
 */
export function shouldUseMentraLiveNativeCapture(buttonPressSubscribers: readonly string[]): boolean {
  return buttonPressSubscribers.length === 0
}

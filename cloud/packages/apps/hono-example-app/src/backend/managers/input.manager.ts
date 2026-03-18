import type { AppSession } from "@mentra/sdk"
import type { UserSession } from "../UserSession"

/**
 * All supported touchpad gestures on the glasses.
 */
export const GESTURES = [
  "single_tap",
  "double_tap",
  "triple_tap",
  "long_press",
  "forward_swipe",
  "backward_swipe",
  "up_swipe",
  "down_swipe",
] as const

export type GestureName = (typeof GESTURES)[number]

/**
 * InputManager — handles all physical input from the glasses (buttons + touchpad).
 *
 * Registers listeners on the AppSession and routes events to the
 * appropriate manager (e.g. single_tap → photo.takePhoto()).
 */
export class InputManager {
  constructor(private userSession: UserSession) {}

  /** Wire up all button and touch listeners on the glasses session */
  setup(session: AppSession): void {
    this.setupButtons(session)
    this.setupTouch(session)
  }

  /** Button press handlers */
  private setupButtons(session: AppSession): void {
    session.events.onButtonPress(async (button) => {
      if (button.pressType === "long") {
        // Reserved for future use
        return
      }

      // Quick press — take a photo
      await this.userSession.photo.takePhoto()
    })
  }

  /** Touchpad gesture handlers */
  private setupTouch(session: AppSession): void {
    session.events.onTouchEvent("single_tap", async () => {
      await this.userSession.photo.takePhoto()
    })

    session.events.onTouchEvent("double_tap", () => {})
    session.events.onTouchEvent("triple_tap", () => {})
    session.events.onTouchEvent("long_press", () => {})
    session.events.onTouchEvent("forward_swipe", () => {})
    session.events.onTouchEvent("backward_swipe", () => {})
    session.events.onTouchEvent("up_swipe", () => {})
    session.events.onTouchEvent("down_swipe", () => {})
  }
}

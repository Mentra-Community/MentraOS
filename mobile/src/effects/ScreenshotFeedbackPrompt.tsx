import {useEffect, useRef} from "react"
import {Platform} from "react-native"
import CrustModule from "@mentra/crust"
import * as ScreenCapture from "expo-screen-capture"

import {useNavigationStore} from "@/stores/navigation"
import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

export const FEEDBACK_ROUTE = "/miniapps/settings/feedback"

/** How many feedback forms are mounted. The form opens on the root stack or inside a hosted miniapp
 * (Settings, Feedback), whose screens never reach the root route history, so the form counts itself. */
let feedbackFormsOpen = 0

/** For the feedback form: while it's mounted, screenshots don't bring up the feedback prompt. */
export function useFeedbackFormOpen() {
  useEffect(() => {
    feedbackFormsOpen++
    return () => {
      feedbackFormsOpen--
    }
  }, [])
}

export const isFeedbackFormOpen = () => feedbackFormsOpen > 0

/** After the prompt shows, further screenshots stay quiet this long, whatever the answer. */
export const SCREENSHOT_PROMPT_COOLDOWN_MS = 5 * 60_000

export interface ScreenshotPromptState {
  /** The prompt is on screen now. */
  open: boolean
  /** When the prompt last showed, or null if it hasn't this session. */
  lastShownAtMs: number | null
}

/**
 * Whether a screenshot should bring up the feedback prompt: not while it's already up, not while the
 * feedback form is open, and at most once per cooldown, so a burst of screenshots shows it once.
 */
export function shouldPromptForScreenshot(state: ScreenshotPromptState, formOpen: boolean, nowMs: number): boolean {
  if (state.open) return false
  if (formOpen) return false
  if (state.lastShownAtMs !== null && nowMs - state.lastShownAtMs < SCREENSHOT_PROMPT_COOLDOWN_MS) return false
  return true
}

/**
 * Beta builds on iOS: a screenshot asks the person to file feedback in the app instead. Only a
 * screenshot the person took counts: while the screen is recorded or mirrored (iPhone Mirroring,
 * AirPlay), screenshot events are ignored.
 */
export function ScreenshotFeedbackPrompt() {
  const {getCurrentRoute, push} = useNavigationStore.getState()
  const stateRef = useRef<ScreenshotPromptState>({open: false, lastShownAtMs: null})

  useEffect(() => {
    if (Platform.OS !== "ios") return

    let cancelled = false
    let subscription: ReturnType<typeof ScreenCapture.addScreenshotListener> | null = null

    const onScreenshot = async () => {
      const state = stateRef.current
      if (!shouldPromptForScreenshot(state, isFeedbackFormOpen(), Date.now())) return
      // Hold the slot while the capture state is read, so events arriving meanwhile don't stack.
      state.open = true
      try {
        const captured = await CrustModule.isScreenCaptured().catch(() => false)
        if (captured) {
          console.log("FEEDBACK: screenshot event while the screen is captured or mirrored - not prompting")
          return
        }
        if (cancelled || isFeedbackFormOpen()) return
        state.lastShownAtMs = Date.now()
        const result = await showAlert({
          title: translate("warning:screenshotFeedbackTitle"),
          message: translate("warning:screenshotFeedbackMessage"),
          buttons: [
            {text: translate("common:ignore"), style: "cancel"},
            {text: translate("feedback:giveFeedback"), style: "default"},
          ],
        })

        if (result === 1 && !isFeedbackFormOpen()) {
          push(FEEDBACK_ROUTE, {
            triggerSource: "screenshot_feedback_prompt",
            triggerReason: "screenshot_detected",
            sourceRoute: getCurrentRoute() ?? undefined,
          })
        }
      } finally {
        state.open = false
      }
    }

    CrustModule.isBetaBuild().then((isBeta) => {
      if (!isBeta || cancelled) return
      subscription = ScreenCapture.addScreenshotListener(() => void onScreenshot())
    })

    return () => {
      cancelled = true
      subscription?.remove()
    }
  }, [getCurrentRoute, push])

  return null
}

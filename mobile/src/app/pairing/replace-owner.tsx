import BluetoothSdk, {type ConfirmReplaceOwnerResultEvent, type PairFailureEvent} from "@mentra/bluetooth-sdk"
import {engine} from "@mentra/engine"
import {useLocalSearchParams} from "expo-router"
import {useCallback, useEffect, useRef, useState} from "react"
import {View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate, type TxKeyPath} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {
  classifyReplaceOwnerResult,
  REPLACE_OWNER_CONFIRM_TIMEOUT_MS,
  REPLACE_OWNER_ERROR_TX,
  REPLACE_OWNER_LINK_LOST_GRACE_MS,
  REPLACE_OWNER_ROUTE,
  type ReplaceOwnerError,
} from "@/utils/pairing/replaceOwner"

/**
 * Ownership transfer: the glasses kept their current owner and refuse to bond
 * anyone until this phone confirms. Reached from the pairing loading screen
 * (pushed on top of it) when `pairing_info.awaiting_confirm` is true.
 *
 * Confirming pops back to the loading screen, which carries on exactly as in
 * the normal flow: the bond follows, `owner_committed` arrives, glasses ready.
 * The native layer holds the secure bond wait while `awaiting_confirm` is true,
 * so this screen can wait for the user without a failure timeout.
 */
export default function ReplaceOwnerScreen() {
  const {deviceModel} = useLocalSearchParams<{deviceModel?: string; deviceName?: string}>()
  const [phase, setPhase] = useState<"idle" | "busy" | "error">("idle")
  const [error, setError] = useState<ReplaceOwnerError | null>(null)
  const phaseRef = useRef<"idle" | "busy" | "error">("idle")
  const leftRef = useRef(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const linkLostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const linkState = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  ).state

  const updatePhase = useCallback((next: "idle" | "busy" | "error") => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const clearConfirmTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const showError = useCallback(
    (next: ReplaceOwnerError) => {
      clearConfirmTimeout()
      setError(next)
      updatePhase("error")
    },
    [clearConfirmTimeout, updatePhase],
  )

  /** Back to the loading screen underneath, which continues the normal bonding flow. */
  const continuePairing = useCallback(() => {
    if (leftRef.current) return
    leftRef.current = true
    clearConfirmTimeout()
    console.log("PAIRFLOW: replace_owner_continue")
    useNavigationStore.getState().goBack()
  }, [clearConfirmTimeout])

  /** The pairing window closed under us: same exit as the loading screen's pair failure. */
  const leaveToFailure = useCallback(
    (reason: string) => {
      const {getCurrentRoute, replace} = useNavigationStore.getState()
      // The loading screen underneath also reacts to pair_failure and may already have left.
      if (leftRef.current || getCurrentRoute() !== REPLACE_OWNER_ROUTE) return
      leftRef.current = true
      clearConfirmTimeout()
      console.log(`PAIRFLOW: replace_owner_fail reason=${reason} model=${deviceModel ?? ""}`)
      void engine.pairing.abandonAttempt().catch((cleanupError) => {
        console.warn("Pairing failure cleanup failed:", cleanupError)
      })
      replace("/pairing/failure", {error: "errors:pairingCouldNotStart", deviceModel})
    },
    [clearConfirmTimeout, deviceModel],
  )

  const handleCancel = useCallback(() => {
    if (leftRef.current) return
    leftRef.current = true
    clearConfirmTimeout()
    console.log(`PAIRFLOW: replace_owner_cancel model=${deviceModel ?? ""}`)
    void engine.pairing.abandonAttempt().catch((cleanupError) => {
      console.warn("Pairing cancellation cleanup failed:", cleanupError)
    })
    // Pop this screen. The loading screen is only underneath during an explicit pair.
    const {goBack, getPreviousRoute} = useNavigationStore.getState()
    const underLoading = getPreviousRoute() === "/pairing/loading"
    goBack()
    if (underLoading) goBack()
  }, [clearConfirmTimeout, deviceModel])

  const handleConfirm = useCallback(() => {
    if (leftRef.current || phaseRef.current === "busy") return
    console.log("PAIRFLOW: replace_owner_confirm")
    setError(null)
    updatePhase("busy")
    clearConfirmTimeout()
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null
      if (phaseRef.current === "busy") showError("timeout")
    }, REPLACE_OWNER_CONFIRM_TIMEOUT_MS)
    engine.pairing.confirmReplaceOwner().catch((confirmError: unknown) => {
      console.warn("confirmReplaceOwner failed:", confirmError)
      if (leftRef.current) return
      showError("failed")
    })
  }, [clearConfirmTimeout, showError, updatePhase])

  useEffect(() => {
    const resultSub = BluetoothSdk.addListener(
      "confirm_replace_owner_result",
      (event: ConfirmReplaceOwnerResultEvent) => {
        if (leftRef.current) return
        console.log(`PAIRFLOW: replace_owner_result ok=${event.ok} reason=${event.reason ?? ""}`)
        const action = classifyReplaceOwnerResult(event)
        if (action.kind === "continue") {
          continuePairing()
          return
        }
        showError(action.error)
      },
    )
    const failureSub = engine.pairing.onPairFailure((event: PairFailureEvent) => {
      leaveToFailure(event.error)
    })
    return () => {
      resultSub.remove()
      failureSub()
      clearConfirmTimeout()
    }
  }, [clearConfirmTimeout, continuePairing, leaveToFailure, showError])

  // The loading screen's readiness wait is aborted while it is unfocused, so a
  // dropped link (window closed, glasses left) would otherwise strand this screen.
  useEffect(() => {
    if (linkState !== "disconnected") {
      if (linkLostTimerRef.current) {
        clearTimeout(linkLostTimerRef.current)
        linkLostTimerRef.current = null
      }
      return
    }
    const timer = setTimeout(() => {
      linkLostTimerRef.current = null
      leaveToFailure("link_lost")
    }, REPLACE_OWNER_LINK_LOST_GRACE_MS)
    linkLostTimerRef.current = timer
    return () => {
      clearTimeout(timer)
      if (linkLostTimerRef.current === timer) linkLostTimerRef.current = null
    }
  }, [leaveToFailure, linkState])

  focusEffectPreventBack(handleCancel)

  const busy = phase === "busy"
  const inError = phase === "error" && error !== null

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header leftIcon="chevron-left" onLeftPress={handleCancel} />
      <View className="flex-1 px-4">
        <View className="flex-1 justify-center gap-4">
          <Text
            tx="pairing:replaceOwnerTitle"
            preset="heading"
            className="text-[28px] font-bold text-center text-text"
          />
          <Text tx="pairing:replaceOwnerBody" className="text-[16px] text-center leading-6 text-text-dim" />
          {busy && <Text tx="pairing:replaceOwnerWaiting" className="text-[14px] text-center text-text-dim" />}
          {inError && (
            <Text
              text={translate(REPLACE_OWNER_ERROR_TX[error] as TxKeyPath)}
              className="text-[14px] text-center leading-5 text-text-dim"
            />
          )}
        </View>
        <View className="w-full gap-3">
          {inError ? (
            <Button tx="common:tryAgain" preset="primary" onPress={handleConfirm} className="w-full" />
          ) : (
            <Button
              tx="pairing:replaceOwnerConfirm"
              preset="primary"
              onPress={handleConfirm}
              disabled={busy}
              className="w-full"
            />
          )}
          <Button tx="common:cancel" preset="secondary" onPress={handleCancel} className="w-full" />
        </View>
      </View>
    </Screen>
  )
}

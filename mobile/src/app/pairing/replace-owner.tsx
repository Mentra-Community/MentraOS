import {type PairFailureEvent} from "@mentra/bluetooth-sdk"
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
  REPLACE_OWNER_ERROR_TX,
  REPLACE_OWNER_LINK_LOST_GRACE_MS,
  REPLACE_OWNER_ROUTE,
} from "@/utils/pairing/replaceOwner"
import {
  getReplaceOwnerConfirmState,
  resetReplaceOwnerConfirm,
  setReplaceOwnerContinue,
  startReplaceOwnerConfirm,
  subscribeReplaceOwnerConfirm,
} from "@/utils/pairing/replaceOwnerConfirm"

/**
 * Ownership transfer: the glasses kept their current owner and refuse to bond
 * anyone until this phone confirms. Reached from the pairing loading screen
 * (pushed on top of it) when `pairing_info.awaiting_confirm` is true.
 *
 * Tapping Replace owner pops back to the loading screen right away, because the
 * glasses ask iOS to pair as soon as they accept the confirm and that prompt must
 * appear over the loading screen. The confirm itself is owned by
 * `replaceOwnerConfirm`, which brings this screen back with the reason if it fails.
 * The loading screen carries on as in the normal flow: the bond follows,
 * `owner_committed` arrives, glasses ready. The native layer holds the secure bond
 * wait while `awaiting_confirm` is true, so this screen can wait without a timeout.
 */
export default function ReplaceOwnerScreen() {
  const {deviceModel, deviceName} = useLocalSearchParams<{deviceModel?: string; deviceName?: string}>()
  const [confirmState, setConfirmState] = useState(getReplaceOwnerConfirmState)
  const leftRef = useRef(false)
  const linkLostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const linkState = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  ).state

  useEffect(() => subscribeReplaceOwnerConfirm(setConfirmState), [])

  /** Back to the loading screen underneath, which continues the normal bonding flow. */
  const continuePairing = useCallback(() => {
    if (leftRef.current) return
    leftRef.current = true
    console.log("PAIRFLOW: replace_owner_continue")
    useNavigationStore.getState().goBack()
  }, [])

  /** The pairing window closed under us: same exit as the loading screen's pair failure. */
  const leaveToFailure = useCallback(
    (reason: string) => {
      const {getCurrentRoute, replace} = useNavigationStore.getState()
      // The loading screen underneath also reacts to pair_failure and may already have left.
      if (leftRef.current || getCurrentRoute() !== REPLACE_OWNER_ROUTE) return
      leftRef.current = true
      resetReplaceOwnerConfirm()
      console.log(`PAIRFLOW: replace_owner_fail reason=${reason} model=${deviceModel ?? ""}`)
      void engine.pairing.abandonAttempt().catch((cleanupError) => {
        console.warn("Pairing failure cleanup failed:", cleanupError)
      })
      replace("/pairing/failure", {error: "errors:pairingCouldNotStart", deviceModel})
    },
    [deviceModel],
  )

  const handleCancel = useCallback(() => {
    if (leftRef.current) return
    leftRef.current = true
    resetReplaceOwnerConfirm()
    console.log(`PAIRFLOW: replace_owner_cancel model=${deviceModel ?? ""}`)
    void engine.pairing.abandonAttempt().catch((cleanupError) => {
      console.warn("Pairing cancellation cleanup failed:", cleanupError)
    })
    // Pop this screen. The loading screen is only underneath during an explicit pair.
    const {goBack, getPreviousRoute} = useNavigationStore.getState()
    const underLoading = getPreviousRoute() === "/pairing/loading"
    goBack()
    if (underLoading) goBack()
  }, [deviceModel])

  const handleConfirm = useCallback(() => {
    if (leftRef.current || getReplaceOwnerConfirmState().phase === "busy") return
    startReplaceOwnerConfirm({deviceModel, deviceName})
    // Pop first so the iOS pairing prompt, which follows the confirm, lands on the loading
    // screen. Without it underneath (reconnect flow) stay and pop when the result arrives.
    const {goBack, getPreviousRoute} = useNavigationStore.getState()
    if (getPreviousRoute?.() === "/pairing/loading") {
      leftRef.current = true
      goBack()
    }
  }, [deviceModel, deviceName])

  useEffect(() => {
    setReplaceOwnerContinue(continuePairing)
    const failureSub = engine.pairing.onPairFailure((event: PairFailureEvent) => {
      leaveToFailure(event.error)
    })
    return () => {
      setReplaceOwnerContinue(null)
      failureSub()
    }
  }, [continuePairing, leaveToFailure])

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

  const {phase, error} = confirmState
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
